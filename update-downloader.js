/**
 * AGNES 2.5 - 更新包下载 (桌面端「检查到新版本 → 自动下载 → 安装重启」用)
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 三件事, 都好单独测:
 *   1) downloadToFile:    单线程下载 (带进度/重定向/超时/取消)
 *   2) downloadMultipart: 4 线程分块下载 —— 每段一个 .part 文件, 全部到齐后按顺序合并
 *   3) downloadUpdate:    先试分块, 服务器不支持 Range 或分块失败就回退成单线程重来
 *
 * 两条路径都遵守同一套"落地"规矩, 这样界面拿到的路径一定指向完整、可信的文件:
 *   · 全程只写 .part 临时文件, 校验通过后才改名成正式文件 (中途断电/被杀不会留下假安装包)
 *   · 边下边算 SHA256, 清单里给了期望值就比对, 不符即删文件报错
 *   · 失败/取消一律把临时文件清干净, 不留垃圾
 *
 * 最后还有个 looksLikeInstaller: 确认下下来的确实像个 Windows 安装包 (PE 头 + 体积),
 * 免得把 404 页面、被劫持的 HTML 当成安装包拿去执行。
 * 刻意不依赖 electron, 纯 Node 就能跑 (回归测试直接起个本地 HTTP 服务验证)。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 20000;    // 连上/等首个响应
const IDLE_TIMEOUT_MS = 60000;       // 下载中途完全没数据 (断网/被墙) 就放弃
const PROGRESS_MIN_INTERVAL_MS = 200; // 进度回调节流: 别把 IPC 打爆
const MIN_INSTALLER_BYTES = 1024 * 1024;  // 小于 1MB 的"安装包"必有问题

const PART_SUFFIX = '.part';         // 所有临时文件都用 .part 结尾 (合并前不出现正式文件)
const MULTIPART_THREADS = 4;         // 分块下载线程数
const MULTIPART_MIN_BYTES = 4 * 1024 * 1024;  // 小于这个体积不值得开多线程 (调度开销 > 收益)

/** 从下载地址里取文件名 (中文名是百分号编码的, 要解回来) */
function fileNameFromUrl(url) {
    let last = '';
    try {
        last = decodeURIComponent(String(new URL(url).pathname).split('/').filter(Boolean).pop() || '');
    } catch (_) { last = ''; }
    last = last.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    if (!last) return 'agnes-update-setup.exe';
    return /\.exe$/i.test(last) ? last : `${last}.exe`;
}

/** 下下来的东西像不像安装包: PE 头 (MZ) + 体积下限 */
function looksLikeInstaller(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return false; }
    if (!stat.isFile() || stat.size < MIN_INSTALLER_BYTES) return false;
    let head = Buffer.alloc(2);
    try {
        const fd = fs.openSync(filePath, 'r');
        try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    } catch (_) { return false; }
    return head.toString('latin1') === 'MZ';
}

/** 把清单里的 sha256 归一化 (容忍前后空白、"sha256:" 前缀、大写); 没给返回 '' */
function normalizeSha256(value) {
    return String(value == null ? '' : value).trim().replace(/^sha256:/i, '').replace(/\s+/g, '').toLowerCase();
}

/** 流式计算文件 SHA256 (安装包可能上百 MB, 不整块读进内存) */
function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', (chunk) => hash.update(chunk));
        rs.on('error', (e) => reject(new Error('读取文件失败: ' + e.message)));
        rs.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * 删掉某个目标文件下载过程中可能留下的所有 .part 临时文件。
 * 分块下载有 4 个分段文件 + 1 个合并用文件, 出错回退前必须清干净, 否则下一轮
 * 会把上一次的半截分段当成"已下好的部分"。
 */
function cleanupParts(destPath) {
    const dir = path.dirname(destPath);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    // 只认 "<目标文件名>.part" 与 "<目标文件名>.part<序号>", 别的文件一律不碰
    const base = path.basename(destPath) + PART_SUFFIX;
    for (const name of names) {
        if (!name.startsWith(base)) continue;
        const tail = name.slice(base.length);
        if (tail !== '' && !/^\d+$/.test(tail)) continue;
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* 没落地就算了 */ }
    }
}

/**
 * 发一个 GET 并把响应交给 onResponse(res, finalUrl); 自动跟随 3xx。
 * 下载站常把 /data/xxx.exe 指到对象存储, 所以重定向逻辑两条路径都要有, 抽出来复用。
 * @returns {{abort: Function}} 调用方可随时掐断 (取消/超时)
 */
function httpGet(startUrl, headers, { redirectsLeft = MAX_REDIRECTS, onResponse, onError }) {
    let req = null;
    let aborted = false;
    const go = (current, left) => {
        if (aborted) return;
        let u;
        try { u = new URL(current); } catch (_) { return onError(new Error('下载地址不合法')); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return onError(new Error('只支持 http/https 下载地址'));
        const transport = u.protocol === 'https:' ? https : http;
        try {
            req = transport.get(u, { headers }, (res) => {
                if (aborted) { try { res.destroy(); } catch (_) { /* 已结束 */ } return; }
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (left <= 0) return onError(new Error('重定向次数过多'));
                    // Location 可能是畸形串 (见过把 URL 写坏的站点), 解析失败就报错退出,
                    // 不能让异常从回调里抛出去 —— 那会直接掀掉整个主进程
                    let next = null;
                    try { next = new URL(res.headers.location, u).toString(); } catch (_) { return onError(new Error('重定向地址不合法')); }
                    return go(next, left - 1);
                }
                onResponse(res, u.toString());
            });
        } catch (e) {
            return onError(new Error('连接失败: ' + e.message));
        }
        req.on('error', (e) => { if (!aborted) onError(new Error('连接失败: ' + e.message)); });
    };
    go(startUrl, redirectsLeft);
    return { abort: () => { aborted = true; try { if (req) req.destroy(); } catch (_) { /* 已结束 */ } } };
}

/** 造一个带 HTTP 状态码的错误, 便于上层判断"回退单线程还有没有意义" (404 就没意义) */
function httpError(status, message) {
    const err = new Error(message || ('HTTP ' + status));
    err.httpStatus = status;
    return err;
}

/**
 * 探测目标是否支持 Range, 顺带拿到重定向后的最终地址与总大小。
 * 用 "Range: bytes=0-0" 而不是 HEAD: 不少下载站/对象存储不支持 HEAD, 但支持 GET+Range。
 * @returns {Promise<{finalUrl:string, size:number|null, acceptRanges:boolean}>}
 */
function probeRange(url, opts = {}) {
    const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let cancelTimer = null;
        let handle = null;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (cancelTimer) clearInterval(cancelTimer);
            if (handle) handle.abort();
            fn(value);
        };
        const fail = (err) => finish(reject, err);

        timer = setTimeout(() => fail(new Error('连接更新源超时')), connectTimeoutMs);
        // 探测阶段也要能立刻取消, 不能等 20 秒超时 (否则用户会觉得"取消没反应")
        cancelTimer = setInterval(() => {
            if (isCancelled()) fail(new Error('已取消下载'));
        }, 200);

        handle = httpGet(url, { 'User-Agent': 'AgnesVideoUpdater', Range: 'bytes=0-0' }, {
            onError: fail,
            onResponse: (res, finalUrl) => {
                const len = parseInt(res.headers['content-length'], 10);
                if (res.statusCode === 206) {
                    // Content-Range: bytes 0-0/12345678  —— 总大小在斜杠后面
                    const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(res.headers['content-range'] || ''));
                    const total = m && m[3] !== '*' ? parseInt(m[3], 10) : NaN;
                    res.destroy();
                    if (!Number.isFinite(total) || total <= 0) {
                        // 206 但拿不到总大小: 按"不支持分块"处理 (单体体积算不出来就没法切段)
                        return finish(resolve, { finalUrl, size: null, acceptRanges: false });
                    }
                    return finish(resolve, { finalUrl, size: total, acceptRanges: true });
                }
                res.destroy();
                if (res.statusCode !== 200) return fail(httpError(res.statusCode));
                finish(resolve, {
                    finalUrl,
                    size: Number.isFinite(len) && len > 0 ? len : null,
                    acceptRanges: false,
                });
            },
        });
    });
}

/**
 * 单线程下载 url 到 destPath。
 * 先写 destPath + '.part', 校验通过才改名成 destPath —— 中途失败/取消不会留下假安装包。
 * @param {string} url
 * @param {string} destPath 目标文件绝对路径 (调用方保证目录已存在)
 * @param {{onProgress?:Function, isCancelled?:Function, connectTimeoutMs?:number, idleTimeoutMs?:number, expectedSha256?:string}} [opts]
 *        onProgress({received, total, percent, speed}) —— percent 在未知总大小时为 null
 *        expectedSha256 给了就比对, 不符即报错 (清单里的 sha256)
 * @returns {Promise<{path:string, bytes:number, sha256:string, threads:number, mode:string}>}
 */
function downloadToFile(url, destPath, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    const idleTimeoutMs = opts.idleTimeoutMs || IDLE_TIMEOUT_MS;
    const expected = normalizeSha256(opts.expectedSha256);
    const tempPath = destPath + PART_SUFFIX;

    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch (_) { return reject(new Error('下载地址不合法')); }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reject(new Error('只支持 http/https 下载地址'));
        }

        let received = 0;
        let total = null;
        let lastTick = Date.now();
        let lastBytes = 0;
        let lastEmit = 0;
        let settled = false;
        let activeReq = null;
        let connectTimer = null;
        let idleTimer = null;
        let cancelTimer = null;
        const hash = crypto.createHash('sha256');

        const cleanup = () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (idleTimer) clearTimeout(idleTimer);
            if (cancelTimer) clearInterval(cancelTimer);
            try { if (activeReq) activeReq.destroy(); } catch (_) { /* 已经结束 */ }
            // 先把写入流关掉再删: 反复失败重试时不能一直攒着没释放的文件句柄
            try { if (file) file.destroy(); } catch (_) { /* 已经结束 */ }
            try { fs.unlinkSync(tempPath); } catch (_) { /* 没落地就算了 */ }
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const done = (sha256) => {
            if (settled) return;
            settled = true;
            if (cancelTimer) clearInterval(cancelTimer);
            if (connectTimer) clearTimeout(connectTimer);
            if (idleTimer) clearTimeout(idleTimer);
            resolve({ path: destPath, bytes: received, sha256, threads: 1, mode: 'single' });
        };

        const emit = (force = false) => {
            const now = Date.now();
            if (!force && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
            const dt = now - lastTick;
            const speed = dt > 0 ? (received - lastBytes) / (dt / 1000) : 0;
            lastEmit = now;
            lastTick = now;
            lastBytes = received;
            try {
                onProgress({
                    received,
                    total,
                    percent: total ? Math.min(100, Math.round(received * 100 / total)) : null,
                    speed: Math.max(0, Math.round(speed)),
                    threads: 1,
                });
            } catch (_) { /* 回调里出错不影响下载 */ }
        };

        const file = fs.createWriteStream(tempPath);

        const request = (currentUrl, redirectsLeft) => {
            const u = new URL(currentUrl);
            const transport = u.protocol === 'https:' ? https : http;
            const req = transport.get(u, { headers: { 'User-Agent': 'AgnesVideoUpdater' } }, (res) => {
                // 重定向: 下载站常把 /data/xxx.exe 指到对象存储
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) return fail(new Error('重定向次数过多'));
                    let next = null;
                    try { next = new URL(res.headers.location, u).toString(); } catch (_) { return fail(new Error('重定向地址不合法')); }
                    return request(next, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(httpError(res.statusCode));
                }
                if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
                const len = parseInt(res.headers['content-length'], 10);
                total = Number.isFinite(len) && len > 0 ? len : null;
                emit(true);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    hash.update(chunk);
                    if (idleTimer) clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => fail(new Error('下载超时 (长时间没有数据)')), idleTimeoutMs);
                    emit();
                });
                res.on('error', (e) => fail(new Error('下载中断: ' + e.message)));
                res.pipe(file);
            });
            activeReq = req;
            req.on('error', (e) => fail(new Error('连接失败: ' + e.message)));
        };

        file.on('error', (e) => fail(new Error('写入失败: ' + e.message)));
        file.on('finish', () => {
            if (total && received !== total) {
                return fail(new Error(`下载不完整 (${received}/${total} 字节)`));
            }
            const sha256 = hash.digest('hex');
            if (expected && sha256 !== expected) {
                return fail(new Error('SHA256 校验失败: 下载到的文件与清单不一致，已丢弃'));
            }
            // 到这一步文件才真正可信: 改名成正式文件 (Windows 的 rename 会覆盖同名文件)
            try { fs.unlinkSync(destPath); } catch (_) { /* 本来就不存在 */ }
            try { fs.renameSync(tempPath, destPath); } catch (e) {
                return fail(new Error('保存更新包失败: ' + e.message));
            }
            emit(true);
            done(sha256);
        });

        // 连接/首字节超时 + 空闲超时 + 取消轮询
        connectTimer = setTimeout(() => fail(new Error('连接更新源超时')), connectTimeoutMs);
        idleTimer = setTimeout(() => fail(new Error('下载超时')), idleTimeoutMs);
        cancelTimer = setInterval(() => {
            if (isCancelled()) fail(new Error('已取消下载'));
        }, 200);

        request(url, MAX_REDIRECTS);
    });
}

/**
 * 等写入流真的把 fd 关掉再回调。
 * Windows 上文件还开着就删不掉 (EBUSY), 直接 destroy 后立刻 unlink 会静默失败,
 * 于是取消/失败的下载会在磁盘上留下 .part 垃圾 —— 必须等 'close'。
 */
function afterStreamClosed(file, cb) {
    if (!file) return cb();
    let closed = false;
    let done = false;
    file.on('close', () => { closed = true; });
    const once = () => { if (done) return; done = true; clearTimeout(timer); cb(); };
    const timer = setTimeout(once, 2000);   // 兜底: 万一 close 不来也别把整个下载卡死
    file.once('close', once);
    if (closed) return once();
    try { file.destroy(); } catch (_) { once(); }
}

/**
 * 下载一个分段到 partPath。
 * 必须严格确认服务器真的按我们要的范围返回了 206 —— 有些代理/站点会忽略 Range 直接给
 * 200 + 整个文件, 那样就会把完整文件塞进一个分段里, 合并出来是个坏包。
 * @param {{aborted:boolean, handles:Set}} [registry] 外部叫停用 (任一分段失败/用户取消时
 *        立刻掐断其余分段, 免得白下几十 MB, 也保证临时文件能干净删掉)
 * @returns {Promise<{received:number}>}
 */
function downloadChunk(finalUrl, partPath, start, end, opts) {
    const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    const idleTimeoutMs = opts.idleTimeoutMs || IDLE_TIMEOUT_MS;
    const isCancelled = opts.isCancelled;
    const onBytes = opts.onBytes;
    const registry = opts.registry || null;
    const expect = end - start + 1;
    const giveUp = () => (registry && registry.aborted) || isCancelled();

    return new Promise((resolve, reject) => {
        let received = 0;
        let settled = false;
        let handle = null;
        let file = null;
        let connectTimer = null;
        let idleTimer = null;
        let cancelTimer = null;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            clearTimeout(idleTimer);
            clearInterval(cancelTimer);
            if (registry) registry.handles.delete(abortThis);
            if (!err) return resolve({ received });
            if (handle) handle.abort();
            // 等 fd 关掉再删分段文件, 否则 Windows 上删不掉, 会留下半截 .part
            afterStreamClosed(file, () => {
                try { fs.unlinkSync(partPath); } catch (_) { /* 没落地就算了 */ }
                reject(giveUp() ? new Error('已取消下载') : err);
            });
        };
        const abortThis = () => finish(new Error('已取消下载'));
        if (registry) registry.handles.add(abortThis);

        handle = httpGet(finalUrl, {
            'User-Agent': 'AgnesVideoUpdater',
            Range: `bytes=${start}-${end}`,
        }, {
            onError: (e) => finish(giveUp() ? new Error('已取消下载') : e),
            onResponse: (res) => {
                if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
                if (res.statusCode !== 206) {
                    res.resume();
                    return finish(res.statusCode === 200
                        ? new Error('服务器未按分段返回数据 (要求 206, 实际 200)')
                        : httpError(res.statusCode));
                }
                // 确认返回的正是我们要的那一段, 否则写进去就是错位数据
                const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(res.headers['content-range'] || ''));
                if (!m || parseInt(m[1], 10) !== start || parseInt(m[2], 10) !== end) {
                    res.resume();
                    return finish(new Error('分段响应范围与请求不符'));
                }
                file = fs.createWriteStream(partPath);
                file.on('error', (e) => finish(new Error('写入失败: ' + e.message)));
                file.on('finish', () => {
                    if (received !== expect) {
                        return finish(new Error(`分段 ${start}-${end} 不完整 (${received}/${expect} 字节)`));
                    }
                    finish(null);
                });
                res.on('data', (chunk) => {
                    received += chunk.length;
                    onBytes(chunk.length);
                    if (idleTimer) clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => finish(new Error('下载超时 (长时间没有数据)')), idleTimeoutMs);
                });
                res.on('error', (e) => finish(new Error('下载中断: ' + e.message)));
                res.pipe(file);
            },
        });

        idleTimer = setTimeout(() => finish(new Error('下载超时')), idleTimeoutMs);
        cancelTimer = setInterval(() => {
            if (isCancelled()) finish(new Error('已取消下载'));
        }, 200);
    });
}

/** 按顺序把各分段拼成完整文件 (边拼边算 SHA256), 校验通过才改名成 destPath。 */
async function mergeParts(parts, destPath, total, expectedSha256) {
    const tempPath = destPath + PART_SUFFIX;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tempPath);
    let writeError = null;
    out.on('error', (e) => { writeError = e; });

    const bail = (err) => {
        try { out.destroy(); } catch (_) { /* 已结束 */ }
        try { fs.unlinkSync(tempPath); } catch (_) { /* 没落地就算了 */ }
        throw err;
    };

    // 写不进去 (磁盘满/权限) 时既可能触发 drain 也可能直接 error, 两个都要等, 否则会卡住
    const writeOut = (chunk) => new Promise((resolve, reject) => {
        if (out.write(chunk)) return resolve();
        const done = (fn, v) => { out.removeListener('drain', onDrain); out.removeListener('error', onError); fn(v); };
        const onDrain = () => done(resolve);
        const onError = (e) => done(reject, e);
        out.once('drain', onDrain);
        out.once('error', onError);
    });

    let written = 0;
    try {
        for (const part of parts) {
            for await (const chunk of fs.createReadStream(part.file)) {
                hash.update(chunk);
                written += chunk.length;
                await writeOut(chunk);
            }
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
        return bail(e instanceof Error ? e : new Error('合并分段失败: ' + e.message));
    }
    if (writeError) return bail(new Error('写入失败: ' + writeError.message));
    if (total && written !== total) {
        return bail(new Error(`合并后大小不对 (${written}/${total} 字节)`));
    }

    const sha256 = hash.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
        return bail(new Error('SHA256 校验失败: 下载到的文件与清单不一致，已丢弃'));
    }
    try { fs.unlinkSync(destPath); } catch (_) { /* 本来就不存在 */ }
    try { fs.renameSync(tempPath, destPath); } catch (e) {
        return bail(new Error('保存更新包失败: ' + e.message));
    }
    return { sha256, bytes: written };
}

/**
 * 多线程分块下载: 把文件切成 N 段, 每段写一个 .part, 全部到齐后合并成一个文件。
 * 只在服务器支持 Range 且体积够大时才可用, 否则抛 code='SKIP_MULTIPART' (这不是失败,
 * 只是这种场景不该走分块), 由 downloadUpdate 静默改走单线程。
 * @returns {Promise<{path:string, bytes:number, sha256:string, threads:number, mode:string}>}
 */
async function downloadMultipart(url, destPath, opts = {}) {
    const threads = Math.max(2, parseInt(opts.threads, 10) || MULTIPART_THREADS);
    const minBytes = Number.isFinite(opts.minBytes) ? opts.minBytes : MULTIPART_MIN_BYTES;
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const expected = normalizeSha256(opts.expectedSha256);

    const skip = (why) => {
        const e = new Error(why);
        e.code = 'SKIP_MULTIPART';
        return e;
    };
    const cancelledError = () => {
        const e = new Error('已取消下载');
        e.code = 'CANCELLED';
        return e;
    };

    if (isCancelled()) throw cancelledError();

    const probe = await probeRange(url, { connectTimeoutMs: opts.connectTimeoutMs, isCancelled });
    if (isCancelled()) throw cancelledError();
    if (!probe.acceptRanges) throw skip('服务器不支持 Range');
    if (!probe.size) throw skip('拿不到文件总大小');
    if (probe.size < minBytes) throw skip(`文件只有 ${probe.size} 字节, 不值得分块`);

    // 按平均值均分: 每段 floor(size/threads) 字节, 除不尽的余数 (size%threads 个字节) 摊给前几段。
    // 这样每段长度最多只差 1 字节, 不会有哪一段特别小、也不会剩下一截"多余出来"没下。
    // 段长必须由实际体积算出来 —— 每个版本打出来的包大小都不一样 (300MB~350MB 都见过),
    // 写死段长会让某一段特别大或干脆多出一段。
    const base = Math.floor(probe.size / threads);
    const remainder = probe.size % threads;
    const parts = [];
    let cursor = 0;
    for (let i = 0; i < threads && cursor < probe.size; i++) {
        const len = base + (i < remainder ? 1 : 0);
        if (len <= 0) break;   // 体积比线程数还小 (调用方把门槛调没了) 时会出现空段, 直接收尾
        parts.push({
            index: i + 1,
            start: cursor,
            end: cursor + len - 1,
            file: `${destPath}${PART_SUFFIX}${i + 1}`,
        });
        cursor += len;
    }

    // 进度是各段之和, 节流后往外报 (别把 IPC 打爆)
    let received = 0;
    let lastTick = Date.now();
    let lastBytes = 0;
    let lastEmit = 0;
    const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
        const dt = now - lastTick;
        const speed = dt > 0 ? (received - lastBytes) / (dt / 1000) : 0;
        lastEmit = now;
        lastTick = now;
        lastBytes = received;
        try {
            onProgress({
                received,
                total: probe.size,
                percent: Math.min(100, Math.round(received * 100 / probe.size)),
                speed: Math.max(0, Math.round(speed)),
                threads: parts.length,
            });
        } catch (_) { /* 回调里出错不影响下载 */ }
    };

    let merged = null;
    // 任一分段失败/用户取消时, 立刻掐断其余分段: 既省流量, 也保证临时文件能被干净删掉
    const registry = { aborted: false, handles: new Set(), abort() {
        this.aborted = true;
        for (const fn of this.handles) { try { fn(); } catch (_) { /* 已结束 */ } }
    } };
    const chunkPromises = parts.map((p) => downloadChunk(probe.finalUrl, p.file, p.start, p.end, {
        connectTimeoutMs: opts.connectTimeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
        isCancelled,
        registry,
        onBytes: (n) => { received += n; emit(); },
    }));

    try {
        emit(true);
        await Promise.all(chunkPromises);
        if (isCancelled()) throw cancelledError();
        emit(true);

        merged = await mergeParts(parts, destPath, probe.size, expected);
        if (isCancelled()) throw cancelledError();
    } catch (e) {
        registry.abort();
        // 等所有分段真的停下来 (fd 关掉、自己的 .part 删掉) 再往外抛,
        // 否则调用方紧接着清临时文件时, 文件还开着删不掉
        await Promise.allSettled(chunkPromises);
        // 取消要能被上层一眼认出来 (否则 downloadUpdate 会以为"失败了, 回退单线程重下")
        if (isCancelled()) throw cancelledError();
        throw e;
    } finally {
        cleanupParts(destPath);
    }

    return {
        path: destPath,
        bytes: merged.bytes,
        sha256: merged.sha256,
        threads: parts.length,
        mode: 'multi',
    };
}

/**
 * 下载更新包 (界面/主进程用这个): 先试 4 线程分块, 不行就回退单线程从头下一次。
 *
 * 回退的判定:
 *   · SKIP_MULTIPART      服务器不支持 Range / 文件太小 —— 正常情况, 静默走单线程
 *   · 用户点了取消        立刻结束, 绝不"取消了还偷偷重下" (那会让取消按钮看起来失灵)
 *   · 4xx (408/429 除外)  地址错/没权限, 回退重试也是同样结果 —— 直接报错, 不让用户白等
 *   · 其它 (超时/断流/分段坏掉)  → 回退单线程重来
 *
 * 注意: 回退是"重新下载", 已经下好的那部分分段会被清掉重来。分块下载的意义是跑满带宽、
 * 而不是断点续传, 所以宁可简单可靠 —— 半途复用分段会让"哪些段是可信的"变得很难判断。
 *
 * @returns {Promise<{path:string, bytes:number, sha256:string, threads:number, mode:string}>}
 */
async function downloadUpdate(url, destPath, opts = {}) {
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;

    if (opts.multipart !== false) {
        try {
            return await downloadMultipart(url, destPath, opts);
        } catch (e) {
            const cancelled = (e && e.code === 'CANCELLED') || isCancelled();
            if (cancelled) throw e;
            const status = e && e.httpStatus;
            const hardFail = Number.isFinite(status) && status >= 400 && status < 500
                && status !== 408 && status !== 429;
            if (hardFail) {
                cleanupParts(destPath);
                throw e;
            }
            if (e && e.code !== 'SKIP_MULTIPART') {
                console.warn(`[Update] 多线程下载失败, 回退单线程重试: ${e && e.message}`);
                if (typeof opts.onFallback === 'function') {
                    try { opts.onFallback(e); } catch (_) { /* 回调里出错不影响下载 */ }
                }
            }
            cleanupParts(destPath);
        }
    }

    const res = await downloadToFile(url, destPath, opts);
    return { ...res, threads: 1, mode: 'single' };
}

/**
 * 拉取并解析一个 JSON (更新清单 latest.json)。
 * 放在主进程做: 清单常托管在第三方站点, 很多站点不给 CORS 头 —— 渲染进程的 fetch
 * 会被浏览器同源策略直接拦掉 (实测自建下载站就是这样, 于是"站点优先"形同虚设),
 * 主进程走 Node 的 http 请求, 不受同源策略限制。
 * @param {string} url
 * @param {{timeoutMs?:number, maxBytes?:number}} [opts]
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
function fetchJson(url, opts = {}) {
    const timeoutMs = opts.timeoutMs || 8000;
    const maxBytes = opts.maxBytes || 2 * 1024 * 1024;   // 清单就几 KB, 给足余量即可
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch (_) { return reject(new Error('地址不合法')); }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reject(new Error('只支持 http/https 地址'));
        }
        let settled = false;
        let timer = null;
        let body = '';
        let activeReq = null;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { if (activeReq) activeReq.destroy(); } catch (_) { /* 已结束 */ }
            reject(err);
        };
        const done = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
        };
        const go = (current, redirectsLeft) => {
            const u = new URL(current);
            const transport = u.protocol === 'https:' ? https : http;
            const req = transport.get(u, { headers: { 'User-Agent': 'AgnesVideoUpdater', Accept: 'application/json' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) return fail(new Error('重定向次数过多'));
                    let next = null;
                    try { next = new URL(res.headers.location, u).toString(); } catch (_) { return fail(new Error('重定向地址不合法')); }
                    return go(next, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) { res.resume(); return fail(httpError(res.statusCode)); }
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > maxBytes) { fail(new Error('清单内容过大')); try { req.destroy(); } catch (_) {} }
                });
                res.on('end', () => {
                    try { done(JSON.parse(body)); } catch (_) { fail(new Error('清单不是合法 JSON')); }
                });
                res.on('error', (e) => fail(new Error('读取失败: ' + e.message)));
            });
            activeReq = req;
            req.on('error', (e) => fail(new Error('连接失败: ' + e.message)));
        };
        timer = setTimeout(() => fail(new Error('连接更新源超时')), timeoutMs);
        go(url, MAX_REDIRECTS);
    });
}

module.exports = {
    downloadToFile,
    downloadMultipart,
    downloadUpdate,
    fetchJson,
    fileNameFromUrl,
    looksLikeInstaller,
    sha256File,
    normalizeSha256,
    MIN_INSTALLER_BYTES,
    PART_SUFFIX,
    MULTIPART_THREADS,
    MULTIPART_MIN_BYTES,
};
