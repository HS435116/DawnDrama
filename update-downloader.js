/**
 * AGNES 2.5 - 更新包下载 (桌面端「检查到新版本 → 自动下载 → 安装重启」用)
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 只做两件事, 都好单独测:
 *   1) downloadToFile: 带进度/重定向/超时/取消地把更新包下到本地
 *   2) looksLikeInstaller: 确认下下来的确实像个 Windows 安装包 (PE 头 + 体积),
 *      免得把 404 页面、被劫持的 HTML 当成安装包拿去执行
 * 刻意不依赖 electron, 纯 Node 就能跑 (回归测试直接起个本地 HTTP 服务验证)。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 20000;    // 连上/等首个响应
const IDLE_TIMEOUT_MS = 60000;       // 下载中途完全没数据 (断网/被墙) 就放弃
const PROGRESS_MIN_INTERVAL_MS = 200; // 进度回调节流: 别把 IPC 打爆
const MIN_INSTALLER_BYTES = 1024 * 1024;  // 小于 1MB 的"安装包"必有问题

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

/**
 * 把 url 下载到 destPath。
 * @param {string} url
 * @param {string} destPath 目标文件绝对路径 (调用方保证目录已存在)
 * @param {{onProgress?:Function, isCancelled?:Function, connectTimeoutMs?:number, idleTimeoutMs?:number}} [opts]
 *        onProgress({received, total, percent, speed}) —— percent 在未知总大小时为 null
 * @returns {Promise<{path:string, bytes:number}>}
 */
function downloadToFile(url, destPath, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    const idleTimeoutMs = opts.idleTimeoutMs || IDLE_TIMEOUT_MS;

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

        const cleanup = () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (idleTimer) clearTimeout(idleTimer);
            if (cancelTimer) clearInterval(cancelTimer);
            try { if (activeReq) activeReq.destroy(); } catch (_) { /* 已经结束 */ }
            try { fs.unlinkSync(destPath); } catch (_) { /* 没落地就算了 */ }
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const done = () => {
            if (settled) return;
            settled = true;
            if (cancelTimer) clearInterval(cancelTimer);
            if (connectTimer) clearTimeout(connectTimer);
            if (idleTimer) clearTimeout(idleTimer);
            resolve({ path: destPath, bytes: received });
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
                });
            } catch (_) { /* 回调里出错不影响下载 */ }
        };

        const file = fs.createWriteStream(destPath);

        const request = (currentUrl, redirectsLeft) => {
            const u = new URL(currentUrl);
            const transport = u.protocol === 'https:' ? https : http;
            const req = transport.get(u, { headers: { 'User-Agent': 'AgnesVideoUpdater' } }, (res) => {
                // 重定向: 下载站常把 /data/xxx.exe 指到对象存储
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) return fail(new Error('重定向次数过多'));
                    const next = new URL(res.headers.location, u).toString();
                    return request(next, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(new Error('HTTP ' + res.statusCode));
                }
                if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
                const len = parseInt(res.headers['content-length'], 10);
                total = Number.isFinite(len) && len > 0 ? len : null;
                emit(true);
                res.on('data', (chunk) => {
                    received += chunk.length;
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
            emit(true);
            done();
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
                    return go(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
                }
                if (res.statusCode !== 200) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }
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

module.exports = { downloadToFile, fetchJson, fileNameFromUrl, looksLikeInstaller, MIN_INSTALLER_BYTES };
