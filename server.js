/* ============================================================
 * AGNES 2.5 批量视频生成器 — 后端服务器 (代理/存盘/作品库)
 * Copyright (c) 2026 @ 晨曦微光工作室
 * 本软件基于 MIT 许可证开源发布 (详见 LICENSE)
 * ============================================================ */
/**
 * AGNES 2.5 批量视频生成器 - 后端服务器
 *
 * 职责:
 *  1. 静态文件服务
 *  2. 通用 API 代理 /api/proxy —— 转发任意平台的请求，解决浏览器 CORS 限制
 *     (兼容火山方舟 / OpenAI 兼容站 / 任意自定义平台)
 *  3. /api/ark 旧版方舟代理 (向后兼容)
 *  4. /api/save-video —— 把平台返回的视频 URL 下载到本地 output/video 目录
 *  5. 作品库扫描 / 下载 / 删除
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { reclaimStaleInstance, waitPortFree, listeningPids, commandLine, isOurServer } = require('./port-utils');

const APP_VERSION = '2.8.2';

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ================= 页面心跳 & 关闭后自动释放端口 =================
// 关掉浏览器/应用窗口后把端口立刻还给系统, 下次启动就不会再撞端口。
// 前端每 15s 打一次心跳; 关闭页面时用 sendBeacon 明确告知, 服务器随即退出。
// 桌面端 (AGNES_DESKTOP=1) 的服务器与主进程同生命周期, 随应用退出, 不需要看门狗。
const HEARTBEAT_PATH = '/api/heartbeat';
// 页面"失联"多久后退出。
// 注意: 这个值必须足够大 —— 后台标签页的心跳会被浏览器节流到 ~1次/分钟,
// 标签页被冻结/丢弃时甚至完全停发; 阈值太小会把"还开着的页面"误判成已关闭,
// 服务器一退, 用户那边就变成"本地服务器未连接"(而启动窗口看起来一切正常)。
// 真正的"关闭页面"走 sendBeacon 明确通知, 那条路径是 CLOSE_GRACE_MS (15s), 不受此值影响。
const IDLE_EXIT_MS = Math.max(10000, parseInt(process.env.AGNES_IDLE_EXIT_MS, 10) || 600000); // 默认 10 分钟
const CLOSE_GRACE_MS = Math.max(2000, parseInt(process.env.AGNES_CLOSE_GRACE_MS, 10) || 15000); // 明确关闭后的宽限 (覆盖刷新/误跳转)

const pages = new Map();      // 页面 id -> 最后一次心跳时间
let everHeartbeat = false;    // 从未打开过页面 (纯 API 调用) 时绝不自动退出
let emptySince = 0;           // 页面列表变空的时刻
let emptyByClose = false;     // 变空是否因为页面明确关闭 (而非失联)
let inFlight = 0;             // 在途请求数: 合并/字幕烧录等长任务不能被"空闲退出"打断

// GET 用于周期心跳; POST 用于页面关闭时的 sendBeacon (它只能发 POST)
app.all(HEARTBEAT_PATH, (req, res) => {
    const id = String(req.query.id || 'default');
    if (req.query.closing) {
        pages.delete(id);
        if (pages.size === 0) { emptySince = Date.now(); emptyByClose = true; }
    } else {
        pages.set(id, Date.now());
        everHeartbeat = true;
        emptySince = 0;
        emptyByClose = false;
    }
    res.json({ ok: true, pages: pages.size, uptime: Math.round(process.uptime()) });
});

// 统计在途请求 (心跳本身不算)
app.use((req, res, next) => {
    if (req.path !== HEARTBEAT_PATH) {
        inFlight++;
        let counted = true;
        const dec = () => { if (counted) { counted = false; inFlight--; } };
        res.on('finish', dec);
        res.on('close', dec);
    }
    next();
});

// ================= 通用平台代理: /api/proxy?target=<encodeURIComponent(完整URL)> =================
// 前端把任意平台的完整 URL 编码后传入，服务器代为转发并原样返回响应。
// Authorization / X-* 自定义请求头原样透传。
// 代理超时: GET (提交/查询) 90s; POST (剧本AI chat 补全较慢) 放宽到 300s
const PROXY_TIMEOUT_GET_MS = 90 * 1000;
const PROXY_TIMEOUT_POST_MS = 300 * 1000;

/** 请求转发核心: /api/proxy 与旧版 /api/ark 共用 */
async function forwardRequest(req, res, targetUrl, fallbackAuth) {
    const headers = {};
    Object.keys(req.headers).forEach(h => {
        if (h === 'authorization' || h === 'content-type' || h === 'accept' || h.startsWith('x-')) {
            headers[h] = req.headers[h];
        }
    });
    if (!headers['user-agent']) headers['user-agent'] = 'AGNES-VideoGenerator/2.5';
    if (fallbackAuth && !headers['authorization']) headers['authorization'] = fallbackAuth;

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
        body = JSON.stringify(req.body ?? {});
    }

    const controller = new AbortController();
    const timeoutMs = ['GET', 'HEAD'].includes(req.method) ? PROXY_TIMEOUT_GET_MS : PROXY_TIMEOUT_POST_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(targetUrl, { method: req.method, headers, body, signal: controller.signal });
        res.status(resp.status);
        const contentType = resp.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        // 每次代理响应后关闭连接: 浏览器下次新建连接, 避免复用已被回收的 keep-alive 连接导致 "Failed to fetch"
        res.setHeader('Connection', 'close');
        const buf = Buffer.from(await resp.arrayBuffer());
        return res.send(buf);
    } catch (err) {
        // undici 的 "fetch failed" 只是个壳, 真正的原因 (DNS 解析不到 / 连接被拒 / 超时 / TLS失败)
        // 藏在 err.cause 里。不把它带出来, 日志里就只有一句 fetch failed, 完全无法定位。
        const causeCode = (err.cause && (err.cause.code || err.cause.errno || err.cause.message)) || '';
        const isTimeout = err.name === 'AbortError';
        const msg = isTimeout
            ? `代理请求超时 (${timeoutMs / 1000}s)`
            : `代理请求失败: ${err.message}${causeCode ? ` (${causeCode})` : ''}`;
        // 只有"连都没连上平台"这一类才敢自动重试: 请求根本没发出去, 重试不会重复创建任务。
        // 连接中途断开 (ECONNRESET/UND_ERR_SOCKET) 可能平台已经收到, 交给用户决定, 避免白耗配额。
        const safeToRetry = !isTimeout && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|EPROTO|CERT|HANDSHAKE/i.test(String(causeCode));
        console.error(`❌ [proxy] ${req.method} ${targetUrl} -> ${msg}${safeToRetry ? ' [可安全重试: 未连上平台]' : ''}`);
        res.setHeader('Connection', 'close');
        return res.status(502).json({ error: msg, target: targetUrl, cause: causeCode || undefined, safeToRetry });
    } finally {
        clearTimeout(timer);
    }
}

app.all('/api/proxy', async (req, res) => {
    const target = req.query.target;
    if (!target || !/^https?:\/\//i.test(target)) {
        return res.status(400).json({ error: '缺少有效的 target 参数 (需为 http/https 完整URL)' });
    }
    return forwardRequest(req, res, target);
});

// ================= 旧版方舟专用代理 (向后兼容: /api/ark/* -> ark /api/v3/*) =================
app.use('/api/ark', (req, res) => {
    const auth = req.headers['authorization'] || (process.env.ARK_API_KEY ? `Bearer ${process.env.ARK_API_KEY}` : null);
    // express 已剥掉挂载前缀, req.url 即 /api/ark 之后的路径
    const targetUrl = 'https://ark.cn-beijing.volces.com/api/v3' + req.url;
    return forwardRequest(req, res, targetUrl, auth);
});

// 健康检查 —— 前端据此判断"服务器模式"是否可用
app.get('/api/health', (req, res) => {
    res.json({ ok: true, server: true, version: APP_VERSION, proxyReady: true, outputDir: CONFIG.basePath });
});

// ================= 配置 =================
// 输出目录优先级: 环境变量 AGNES_OUTPUT_DIR > 用户设置文件 (agnes-data-dir.json) > 运行目录下 output/
// 该目录是全局唯一的保存根: 所有视频/图片都保存到 <basePath>/video|images/<标题>/ 下,
// 不再存在任何写死在代码里的备用目录。

// ================= 启动/关闭上报 =================
// 仅上报启动和关闭事件，统计用户数、版本分布；无其他行为追踪
const REPORT_ON = process.env.AGNES_REPORT_OFF ? false : true;
function reportEvent(name) {
    if (!REPORT_ON) return;
    try {
        const body = JSON.stringify({ name, data: { version: APP_VERSION, os: process.platform, browser: 'Electron' } });
        const url = new URL('http://78oq264463tb.vicp.fun/api/collect');
        const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3000 };
        const req = require('http').request(url, opts, res => res.resume());
        req.on('error', () => {});
        req.write(body);
        req.end();
    } catch (_) {}
}
setTimeout(() => reportEvent('app.start'), 2000);
const DATA_DIR_FILE = path.join(process.cwd(), 'agnes-data-dir.json');

const IMAGES_FOLDER = 'images';
const VIDEO_FOLDER = 'video';
const MANAGED_FOLDERS = [IMAGES_FOLDER, VIDEO_FOLDER];

/** 规范化用户填写的保存根目录; 非法时返回 '' */
function normalizeOutputDir(raw) {
    if (typeof raw !== 'string') return '';
    const dir = raw.trim().replace(/[\\/]+$/, '');
    if (!dir) return '';
    if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith('/')) return ''; // 必须是绝对路径
    // 作品库内部的 images/video 子目录不能当保存根, 否则会写出 video/video/... 的嵌套目录
    const segs = dir.split(/[\\/]+/).filter(Boolean);
    if (MANAGED_FOLDERS.includes(segs[segs.length - 1])) return '';
    return dir;
}

/**
 * 默认保存位置: 应用所在目录下的 output/
 *   · 服务器/开发模式: 本文件所在目录 (项目根) 下的 output/ —— 即 <项目目录>/output/
 *   · 桌面版: 由 electron-main 通过 AGNES_DEFAULT_OUTPUT_DIR 显式传入 (安装目录或用户数据目录)
 *   · 打包后 __dirname 位于 app.asar 内部 (不可写), 此时退回运行目录下的 output/
 * 用 __dirname 而不是 process.cwd(): 从任何目录启动, 默认保存位置都固定, 不依赖"当前工作目录"。
 */
const APP_ROOT = __dirname;
const DEFAULT_OUTPUT_DIR = (() => {
    const fromDesktop = (process.env.AGNES_DEFAULT_OUTPUT_DIR || '').trim();
    if (fromDesktop && path.isAbsolute(fromDesktop)) return fromDesktop.replace(/[\\/]+$/, '');
    const base = APP_ROOT.includes('app.asar') ? process.cwd() : APP_ROOT;
    return path.join(base, 'output');
})();

/**
 * 自愈: 旧版本或误操作可能把"剧集目录"设成了保存根 (如 output/某剧/video/第6集),
 * 这会让后续视频保存进 output/某剧/video/第6集/video/... 造成路径错乱。
 * 两类都不算合法保存根:
 *   1) 默认 output 根目录之下超过一级的路径;
 *   2) 路径以 video/<某集> 或 images/<某集> 结尾 —— 即保存根被设成了作品库内部目录
 *      (用户自定义的保存位置可能在任意盘符, 不能只看默认 output 根, 否则这条检测会漏掉)。
 */
function isPollutedOutputDir(dir) {
    const segs = String(dir).split(/[\\/]+/).filter(Boolean);
    // 规则 2: .../video/<某集> 或 .../images/<某集>
    if (segs.length >= 2 && MANAGED_FOLDERS.includes(segs[segs.length - 2].toLowerCase())) return true;
    // 规则 1: 默认 output 根之下超过一级
    const def = DEFAULT_OUTPUT_DIR;
    if (!dir.toLowerCase().startsWith(def.toLowerCase())) return false;
    const rel = dir.slice(def.length).replace(/^[\\/]+/, '');
    return rel.split(/[\\/]+/).filter(Boolean).length > 1;
}

function resolveOutputDir() {
    const fallback = DEFAULT_OUTPUT_DIR;
    let candidate = '';
    if (process.env.AGNES_OUTPUT_DIR) {
        candidate = normalizeOutputDir(process.env.AGNES_OUTPUT_DIR) || process.env.AGNES_OUTPUT_DIR.trim();
    } else {
        try {
            const saved = JSON.parse(fs.readFileSync(DATA_DIR_FILE, 'utf8'));
            if (saved && typeof saved.outputDir === 'string') candidate = saved.outputDir;
        } catch (_) { /* 无设置文件, 使用默认 */ }
    }
    if (!candidate) return fallback;
    const normalized = normalizeOutputDir(candidate);
    if (!normalized) {
        console.warn(`⚠️ 已忽略无效的保存位置设置: ${candidate} (需为绝对路径, 且不能是 ${MANAGED_FOLDERS.join('/')} 子目录)`);
        return fallback;
    }
    if (isPollutedOutputDir(normalized)) {
        console.warn(`⚠️ 检测到保存位置被设置成了作品库内部目录: ${normalized}`);
        console.warn(`   已自动回退到默认保存位置: ${fallback} (避免视频被嵌套保存)`);
        try { fs.writeFileSync(DATA_DIR_FILE, JSON.stringify({ outputDir: fallback }, null, 2)); } catch (_) {}
        return fallback;
    }
    return normalized;
}

const CONFIG = {
    basePath: resolveOutputDir(),
    imagesFolder: IMAGES_FOLDER,
    videoFolder: VIDEO_FOLDER
};

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// 更改保存位置 (设置页): 立即生效并持久化, 重启保留
app.post('/api/set-output-dir', (req, res) => {
    const raw = String((req.body || {}).dir || '');
    if (!raw.trim()) {
        return res.status(400).json({ error: '请填写有效的绝对路径 (如 D:\\Videos\\晨曦短剧)' });
    }
    if (raw.length > 260) {
        return res.status(400).json({ error: '路径过长 (上限 260 字符)' });
    }
    const dir = normalizeOutputDir(raw);
    if (!dir) {
        return res.status(400).json({
            error: `路径无效: 请填写绝对路径, 且不要选择作品库内部的 ${MANAGED_FOLDERS.join('/')} 子目录\n(作品会自动保存到 <保存位置>/${VIDEO_FOLDER}/<标题>/)`
        });
    }
    try {
        ensureDir(path.join(dir, CONFIG.imagesFolder));
        ensureDir(path.join(dir, CONFIG.videoFolder));
        CONFIG.basePath = dir;
        try { fs.writeFileSync(DATA_DIR_FILE, JSON.stringify({ outputDir: dir }, null, 2)); } catch (_) { /* 持久化失败不阻断 */ }
        console.log(`📁 输出目录已更改为: ${dir}`);
        res.json({ ok: true, outputDir: CONFIG.basePath });
    } catch (e) {
        res.status(500).json({ error: '目录创建失败: ' + e.message });
    }
});

function sanitizeFilename(name) {
    return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 50).trim() || '未命名';
}

// ================= 把平台生成的视频下载到本地 =================
/* 分段多连接下载。参数来自对本平台 CDN 的实测 (7.71MB 样本):
 *   · Accept-Ranges 支持良好 (206 + Content-Range)
 *   · 单连接被限速 ~0.5~1MB/s; 2~4 段收益最大 (17s -> 3~4s); 8 段以上反而劣化 (55s+)
 *   · 单客户端总带宽约 1.5~2.2MB/s —— 所以是"把带宽分给多个段", 而不是"开更多连接"
 * 另外这个 CDN 断流/卡住是常态 (terminated / 下载超时), 因此保留 .part 断点续传:
 * 失败后重试只补没收完的区间, 不再从 0 开始。
 */
// 参数可用环境变量覆盖 (测试里用极小值快速验证分段/续传/看门狗)
const DL_SEGMENTS_MAX = parseInt(process.env.AGNES_DL_SEGMENTS_MAX, 10) || 3;            // 单文件最多分几段 (实测 >4 段会明显劣化)
const DL_SEGMENT_MIN = parseInt(process.env.AGNES_DL_SEGMENT_MIN, 10) || 3 * 1024 * 1024; // 小于此大小不值得分段
const DL_POOL_MAX = parseInt(process.env.AGNES_DL_POOL_MAX, 10) || 12;                    // 全局同时进行的下载连接数上限
const DL_SEGMENT_RETRIES = parseInt(process.env.AGNES_DL_SEGMENT_RETRIES, 10) || 3;       // 单段重试次数 (重试只补没收完的部分)
const DL_STALL_MS = parseInt(process.env.AGNES_DL_STALL_MS, 10) || 60 * 1000;             // 单段多久没新数据算卡住, 只重试该段
const DL_ADAPT_WINDOW_MS = parseInt(process.env.AGNES_DL_ADAPT_WINDOW_MS, 10) || 2000;  // 单连接先跑多久再判断要不要分段
const DL_ADAPT_MIN_RATE = parseFloat(process.env.AGNES_DL_ADAPT_MIN_RATE) || 1.5;        // 低于此速度 (MB/s) 才改分段; 够快就保持单连接

// ---------- 全局连接池 (避免"每个文件都开满段数"把平台打爆) ----------
let dlSlots = 0;
const dlWaiters = [];
function acquireSlot() {
    if (dlSlots < DL_POOL_MAX) { dlSlots++; return Promise.resolve(); }
    return new Promise((resolve) => dlWaiters.push(() => { dlSlots++; resolve(); }));
}
function releaseSlot() {
    if (dlSlots > 0) dlSlots--;
    const next = dlWaiters.shift();
    if (next) next();
}

// ---------- 下载进度 (供前端轮询显示百分比/速度) ----------
const dlProgress = new Map();
function progressBegin(key, total) {
    if (!key) return;
    dlProgress.set(String(key), { bytes: 0, total: total || 0, startedAt: Date.now(), status: 'downloading' });
}
function progressAdd(key, n) {
    const p = key && dlProgress.get(String(key));
    if (p) p.bytes += n;
}
function progressEnd(key, status, error) {
    const p = key && dlProgress.get(String(key));
    if (!p) return;
    p.status = status;
    p.error = error || null;
    p.endedAt = Date.now();
    const k = String(key);
    setTimeout(() => dlProgress.delete(k), 5 * 60 * 1000).unref?.();   // 留一会儿给前端读收尾状态
}

app.get('/api/save-progress', (req, res) => {
    const p = dlProgress.get(String(req.query.key || ''));
    if (!p) return res.json({ ok: true, found: false });
    const elapsed = ((p.endedAt || Date.now()) - p.startedAt) / 1000;
    return res.json({
        ok: true,
        found: true,
        status: p.status,
        error: p.error || null,
        bytes: p.bytes,
        total: p.total,
        percent: p.total ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : null,
        speedMBps: elapsed > 0.5 ? Math.round((p.bytes / 1048576 / elapsed) * 100) / 100 : null
    });
});

/** 探测 Range 支持与文件总大小 (不支持就老实退回单连接) */
async function probeDownload(url, headers) {
    const ac = new AbortController();
    // 探测只读响应头: 读完立刻主动断开。
    // 不能 await body.cancel() —— 有的 CDN 会"发完响应头就不发数据",
    // 这时 cancel 会一直挂着, 整个下载在第一步就卡死。
    const timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* 已结束 */ } }, 10000);
    try {
        const r = await fetch(url, {
            headers: { ...headers, Range: 'bytes=0-0', 'accept-encoding': 'identity' },
            signal: ac.signal
        });
        const cr = r.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+)\s*$/);
        const rawLen = m ? parseInt(m[1], 10) : parseInt(r.headers.get('content-length') || '0', 10);
        return {
            supportsRange: r.status === 206,
            length: Number.isFinite(rawLen) ? rawLen : 0,
            etag: r.headers.get('etag') || '',
            lastModified: r.headers.get('last-modified') || ''
        };
    } catch (e) {
        console.warn(`⚠️ [save-video] Range 探测失败 (${e.message})，改用单连接下载`);
        return { supportsRange: false, length: 0, etag: '', lastModified: '' };
    } finally {
        clearTimeout(timer);
        try { ac.abort(); } catch (_) { /* 断开探测连接 */ }
    }
}

/** 把 [from, total) 切成若干段 (每段不小于 DL_SEGMENT_MIN, 段数不超过 DL_SEGMENTS_MAX) */
function planSegments(from, total) {
    const rest = total - from;
    if (rest <= 0) return [];
    const n = Math.max(1, Math.min(DL_SEGMENTS_MAX, Math.ceil(rest / DL_SEGMENT_MIN)));
    const each = Math.ceil(rest / n);
    const segs = [];
    for (let s = from; s < total; s += each) segs.push([s, Math.min(s + each - 1, total - 1)]);
    return segs;
}

/**
 * 下载一个区间到 .part 文件的指定位置 (定位写入)。
 * 段内自带重试 + 卡住看门狗; 重试时从"已写到的位置"继续, 不重头来。
 */
async function downloadSegment(url, partPath, headers, start, end, onBytes) {
    const fh = await fs.promises.open(partPath, 'r+');
    let pos = start;
    try {
        for (let attempt = 1; attempt <= DL_SEGMENT_RETRIES; attempt++) {
            let stallNote = '';
            try {
                await acquireSlot();
                try {
                    const ac = new AbortController();
                    let lastAt = Date.now();
                    const wd = setInterval(() => {
                        if (Date.now() - lastAt > DL_STALL_MS) {
                            stallNote = `卡住 (${Math.round(DL_STALL_MS / 1000)}s 无新数据)`;
                            try { ac.abort(); } catch (_) { /* 已结束 */ }
                        }
                    }, 5000);
                    try {
                        const resp = await fetch(url, {
                            headers: { ...headers, Range: `bytes=${pos}-${end}`, 'accept-encoding': 'identity' },
                            signal: ac.signal
                        });
                        if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
                        for await (const chunk of resp.body) {
                            lastAt = Date.now();
                            const take = Math.min(chunk.length, end + 1 - pos);
                            if (take <= 0) break;
                            await fh.write(chunk, 0, take, pos);
                            pos += take;
                            onBytes(take);
                            if (pos > end) break;
                        }
                    } finally {
                        clearInterval(wd);
                    }
                } finally {
                    releaseSlot();
                }
                if (pos > end) return;
                throw new Error(`该段未收完 (${pos}/${end + 1})`);
            } catch (e) {
                const why = stallNote || e.message;
                if (attempt >= DL_SEGMENT_RETRIES) throw new Error(`${why} (该段已重试 ${attempt} 次)`);
                console.warn(`⚠️ [save-video] 分片重试 ${attempt}/${DL_SEGMENT_RETRIES}: ${why} — 从 ${(pos / 1048576).toFixed(2)}MB 继续`);
                await new Promise((r) => setTimeout(r, 800 * attempt));
            }
        }
    } finally {
        await fh.close();
    }
}

/**
 * 单连接下载 (平台不支持 Range 时用); 支持 Range 时也能从 from 处续传。
 * @param {Function} [onWatch] 观察窗口回调 (已写字节, 已耗时ms); 返回 'segment' 表示"太慢, 改分段"
 * @returns {Promise<{upgrade:boolean, pos:number}>} upgrade=true 表示提前中止以改走分段
 */
async function downloadSingleStream(url, partPath, headers, from, total, onBytes, onWatch) {
    const fh = await fs.promises.open(partPath, 'r+');
    let pos = from;
    let upgrade = false;
    const tStart = Date.now();
    let lastWatch = tStart;
    try {
        for (let attempt = 1; attempt <= DL_SEGMENT_RETRIES; attempt++) {
            let stallNote = '';
            try {
                await acquireSlot();
                try {
                    const ac = new AbortController();
                    let lastAt = Date.now();
                    const wd = setInterval(() => {
                        if (Date.now() - lastAt > DL_STALL_MS) {
                            stallNote = `卡住 (${Math.round(DL_STALL_MS / 1000)}s 无新数据)`;
                            try { ac.abort(); } catch (_) { /* 已结束 */ }
                        }
                    }, 5000);
                    let response = null;
                    try {
                        const h = { ...headers, 'accept-encoding': 'identity' };
                        if (pos > 0) h.Range = `bytes=${pos}-`;
                        response = await fetch(url, { headers: h, signal: ac.signal });
                        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
                        for await (const chunk of response.body) {
                            lastAt = Date.now();
                            await fh.write(chunk, 0, chunk.length, pos);
                            pos += chunk.length;
                            onBytes(chunk.length);
                            if (onWatch && Date.now() - lastWatch >= 500) {
                                lastWatch = Date.now();
                                if (onWatch(pos - from, Date.now() - tStart) === 'segment') { upgrade = true; break; }
                            }
                        }
                        if (upgrade && response.body) {
                            // 必须在释放池子名额之前把这条连接拆干净:
                            // 否则首个连接还挂着、分片连接已经进来, 并发会短暂翻倍 (实测峰值 4 -> 8)
                            await Promise.race([
                                response.body.cancel().catch(() => {}),
                                new Promise((r) => setTimeout(r, 2000))   // 拆不掉也不死等, 继续走分段
                            ]);
                        }
                    } finally {
                        clearInterval(wd);
                    }
                } finally {
                    releaseSlot();
                }
                if (upgrade) return { upgrade: true, pos };
                if (!total || pos >= total) return { upgrade: false, pos };
                throw new Error(`未收完 (${pos}/${total})`);
            } catch (e) {
                const why = stallNote || e.message;
                if (attempt >= DL_SEGMENT_RETRIES) throw new Error(`${why} (已重试 ${attempt} 次)`);
                console.warn(`⚠️ [save-video] 重试 ${attempt}/${DL_SEGMENT_RETRIES}: ${why}`);
                await new Promise((r) => setTimeout(r, 800 * attempt));
            }
        }
    } finally {
        await fh.close();
    }
}

/**
 * 把平台视频下载到 filePath (先写 .part, 完成后再改名)。
 * @returns {Promise<{size:number, segments:number, resumedFrom:number}>}
 */
async function downloadVideoFile(url, filePath, headers, progressKey) {
    const partPath = filePath + '.part';
    const metaPath = filePath + '.part.json';
    const probe = await probeDownload(url, headers);
    const total = probe.length;
    progressBegin(progressKey, total);

    // 断点续传: 校验已有 .part 是不是同一个文件 (url/etag/长度/时间任一不符就重来)
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { /* 没有断点 */ }
    const sameFile = !!(meta && meta.url === url
        && ((probe.etag && meta.etag === probe.etag) || (!probe.etag && meta.length === total && meta.lastModified === probe.lastModified)));
    let have = 0;
    if (sameFile && fs.existsSync(partPath)) {
        have = fs.statSync(partPath).size;
        if (total && have > total) have = 0;
        if (!probe.supportsRange) have = 0;   // 不能续传的平台只能重来
    }
    if (!sameFile || !fs.existsSync(partPath) || !have) {
        try { fs.rmSync(partPath, { force: true }); } catch (_) { /* 忽略 */ }
        fs.writeFileSync(partPath, '');
        fs.writeFileSync(metaPath, JSON.stringify({ url, length: total, etag: probe.etag, lastModified: probe.lastModified }));
        have = 0;
    }
    if (have > 0) {
        console.log(`♻️ [save-video] 断点续传: 已有 ${(have / 1048576).toFixed(2)}MB / ${(total / 1048576).toFixed(2)}MB`);
    }

    const onBytes = (n) => progressAdd(progressKey, n);
    const canSegment = probe.supportsRange && total >= DL_SEGMENT_MIN && (total - have) > DL_SEGMENT_MIN;
    let segments = 1;

    if (!canSegment) {
        await downloadSingleStream(url, partPath, headers, have, total, onBytes);
    } else {
        // 先单连接开跑, 在观察窗口里量一下速度再决定要不要分段。
        // 为什么要这样: 同一 CDN 同一文件, 实测单连接 0.45~1.93MB/s、3 段并发 0.65~2.50MB/s ——
        // 文件被边缘节点缓存后单连接很快, 这时硬上分段反而更慢 (实测 3 倍劣化)。
        const r = await downloadSingleStream(url, partPath, headers, have, total, onBytes, (bytes, ms) => {
            if (ms < DL_ADAPT_WINDOW_MS || bytes < 256 * 1024) return null;   // 样本太小, 不判定
            const rate = bytes / 1048576 / (ms / 1000);
            if (rate >= DL_ADAPT_MIN_RATE) return null;                       // 够快, 保持单连接
            console.log(`⚡ [save-video] 单连接仅 ${rate.toFixed(2)}MB/s (< ${DL_ADAPT_MIN_RATE}MB/s)，改为分段并发`);
            return 'segment';
        });
        if (r.upgrade && (total - r.pos) > DL_SEGMENT_MIN) {
            const segs = planSegments(r.pos, total);
            segments = segs.length + 1;
            console.log(`⬇️ [save-video] 分段下载: ${segs.length} 段 x ~${((total - r.pos) / segs.length / 1048576).toFixed(2)}MB (已完成 ${(r.pos / 1048576).toFixed(2)}MB)`);
            await Promise.all(segs.map(([s, e]) => downloadSegment(url, partPath, headers, s, e, onBytes)));
        }
    }

    const size = fs.statSync(partPath).size;
    if (total && size !== total) {
        throw new Error(`下载不完整 (${(size / 1048576).toFixed(2)}MB / ${(total / 1048576).toFixed(2)}MB)，已保留断点，重试将从断点续传`);
    }
    try { fs.rmSync(filePath, { force: true }); } catch (_) { /* 覆盖旧文件 */ }
    fs.renameSync(partPath, filePath);
    try { fs.rmSync(metaPath, { force: true }); } catch (_) { /* 清理断点元信息 */ }
    return { size, segments, resumedFrom: have };
}

app.post('/api/save-video', async (req, res) => {
    const { url, title, filename, authHeader, progressKey } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '缺少有效的视频 URL' });
    if (!filename) return res.status(400).json({ error: '缺少 filename' });

    const safeTitle = sanitizeFilename(title);
    const safeName = sanitizeFilename(filename);
    const dir = ensureDir(path.join(CONFIG.basePath, CONFIG.videoFolder, safeTitle));
    const filePath = path.join(dir, safeName);

    const headers = {};
    // Sora 风格平台的内容端点需要平台鉴权头
    if (authHeader && /^Bearer\s+[\w.\-]+$/.test(authHeader)) headers['Authorization'] = authHeader;

    try {
        const { size, segments, resumedFrom } = await downloadVideoFile(url, filePath, headers, progressKey);
        console.log(`💾 视频已保存: ${filePath} (${(size / 1024 / 1024).toFixed(2)} MB${segments > 1 ? `, ${segments} 段并发` : ''}${resumedFrom ? `, 续传 ${(resumedFrom / 1048576).toFixed(2)}MB` : ''})`);
        progressEnd(progressKey, 'done');
        res.json({
            success: true,
            path: `${CONFIG.videoFolder}/${safeTitle}/${safeName}`,
            size,
            sizeText: `${(size / 1024 / 1024).toFixed(2)} MB`,
            segments,
            resumedFrom
        });
    } catch (err) {
        const raw = String(err.message || err);
        const msg = err.name === 'AbortError'
            ? '下载视频超时'
            // "terminated" 是 undici 的说法: 连接被对端掐断 (平台 CDN 断流/网关重启)
            : (/terminated|socket hang up|ECONNRESET|UND_ERR_SOCKET|premature close/i.test(raw)
                ? `下载连接被中断 (平台 CDN 断流: ${raw})`
                : (raw.startsWith('保存视频失败') || raw.startsWith('下载') || raw.includes('断点') ? raw : `保存视频失败: ${raw}`));
        console.error(`❌ [save-video] ${msg} (断点已保留, 重试可续传)`);
        progressEnd(progressKey, 'error', msg);
        res.status(500).json({ error: msg, resumable: true });
    }
});

// ================= 作品库 =================

/**
 * 把作品库内的相对路径解析成磁盘上的真实绝对路径。
 * 兼容两种布局 (历史版本曾把"某一部剧"的目录设为保存位置):
 *   A. 统一布局: <保存位置>/video|images/<标题>/<文件>
 *   B. 旧布局:   <保存位置>/<剧名>/video|images/<标题>/<文件>
 * 只向下多探一层, 不做递归遍历, 也不允许 ".." 越界。
 */
function resolveLibraryPath(relPath) {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return '';
    if (rel.split('/').includes('..') || path.isAbsolute(rel)) return '';
    const direct = path.join(CONFIG.basePath, rel);
    if (fs.existsSync(direct)) return direct;
    try {
        for (const entry of fs.readdirSync(CONFIG.basePath)) {
            if (MANAGED_FOLDERS.includes(entry)) continue;
            const sub = path.join(CONFIG.basePath, entry);
            try { if (!fs.statSync(sub).isDirectory()) continue; } catch (_) { continue; }
            const candidate = path.join(sub, rel);
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch (_) { /* 根目录不可读 */ }
    return '';
}

app.get('/api/gallery', (req, res) => {
    const items = [];
    const collect = (typePath, group) => {
        if (!fs.existsSync(typePath)) return;
        fs.readdirSync(typePath).forEach(title => {
            const titlePath = path.join(typePath, title);
            try { if (!fs.statSync(titlePath).isDirectory()) return; } catch (_) { return; }
            fs.readdirSync(titlePath).forEach(file => {
                if (!file.match(collect.regex)) return;
                let stat;
                try { stat = fs.statSync(path.join(titlePath, file)); } catch (_) { return; }
                items.push({
                    id: [collect.type, group, title, file].filter(Boolean).join('_'),
                    title, type: collect.type, group: group || '', filename: file,
                    // 与 /api/save-video 返回的 path 保持一致: <type>/<标题>/<文件>
                    path: [collect.type, group, title, file].filter(Boolean).join('/'),
                    size: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
                    date: stat.mtime.toLocaleString('zh-CN')
                });
            });
        });
    };
    const scan = (type, regex) => {
        collect.type = type; collect.regex = regex;
        collect(path.join(CONFIG.basePath, type), '');            // 统一布局
        try {                                                     // 旧布局: <root>/<剧名>/<type>/...
            fs.readdirSync(CONFIG.basePath).forEach(entry => {
                if (MANAGED_FOLDERS.includes(entry)) return;
                const sub = path.join(CONFIG.basePath, entry);
                try { if (fs.statSync(sub).isDirectory()) collect(path.join(sub, type), entry); } catch (_) {}
            });
        } catch (_) { /* 根目录不可读 */ }
    };
    scan(CONFIG.imagesFolder, /\.(png|jpg|jpeg|webp)$/i);
    scan(CONFIG.videoFolder, /\.(mp4|mov|avi|webm)$/i);
    res.json(items);
});

app.get('/api/folders', (req, res) => {
    const structure = { images: [], video: [] };
    const listGroups = (type, typePath, group) => {
        if (!fs.existsSync(typePath)) return;
        fs.readdirSync(typePath).forEach(title => {
            const titlePath = path.join(typePath, title);
            try { if (!fs.statSync(titlePath).isDirectory()) return; } catch (_) { return; }
            structure[type].push({
                name: title,
                path: [type, group, title].filter(Boolean).join('/'),
                files: fs.readdirSync(titlePath).length
            });
        });
    };
    [CONFIG.imagesFolder, CONFIG.videoFolder].forEach(type => {
        listGroups(type, path.join(CONFIG.basePath, type), '');
        try {
            fs.readdirSync(CONFIG.basePath).forEach(entry => {
                if (MANAGED_FOLDERS.includes(entry)) return;
                const sub = path.join(CONFIG.basePath, entry);
                try { if (fs.statSync(sub).isDirectory()) listGroups(type, path.join(sub, type), entry); } catch (_) {}
            });
        } catch (_) { /* 根目录不可读 */ }
    });
    res.json(structure);
});

app.get('/api/download/:type/:title/:filename', (req, res) => {
    const rel = [req.params.type, req.params.title, req.params.filename].join('/');
    const filePath = resolveLibraryPath(rel);
    if (filePath) res.download(filePath);
    else res.status(404).json({ error: '文件不存在: ' + rel });
});

// 支持 base64 编码路径，解决含 "/" 的文件名无法通过 URL 参数传递的问题
const base64 = require('base64-url');
app.get('/api/download-file', (req, res) => {
    const encoded = String(req.query.path || '').trim();
    if (!encoded) return res.status(400).json({ error: '缺少 path 参数' });
    try {
        const filePath = base64.decode(encoded);
        const fullPath = resolveLibraryPath(filePath);
        if (fullPath) {
            res.download(fullPath);
        } else {
            res.status(404).json({ error: '文件不存在: ' + filePath });
        }
    } catch (e) {
        res.status(400).json({ error: '路径解码失败: ' + e.message });
    }
});

app.delete('/api/file/:type/:title/:filename', (req, res) => {
    const rel = [req.params.type, req.params.title, req.params.filename].join('/');
    const filePath = resolveLibraryPath(rel);
    if (filePath) { fs.unlinkSync(filePath); res.json({ success: true }); }
    else res.status(404).json({ error: '文件不存在: ' + rel });
});

// ================= 合并剧集目录 (服务器模式自动/手动合并: 调用 merge_videos.py) =================
// ?stream=1 时改用 NDJSON 流式返回, 每行一个阶段事件 (逐行 JSON), 前端据此显示
// "拼接 → 音频识别 → 字幕烧录" 的实时进度; 不带该参数时行为与旧版完全一致。
app.post('/api/merge-episode', (req, res) => {
    const relDir = String((req.body || {}).dir || '').trim().replace(/\\/g, '/');
    if (!relDir || relDir.includes('..') || path.isAbsolute(relDir) || !relDir.startsWith(CONFIG.videoFolder + '/')) {
        return res.status(400).json({ error: '需要作品库内的相对剧集目录 (如 video/标题)' });
    }
    const absDir = resolveLibraryPath(relDir);
    if (!absDir) return res.status(404).json({ error: `剧集目录不存在: ${relDir}` });
    if (!absDir.startsWith(CONFIG.basePath)) return res.status(400).json({ error: '目录越界' });
    if (!fs.statSync(absDir).isDirectory()) return res.status(404).json({ error: `不是目录: ${relDir}` });
    let runner;
    try {
        runner = require('./electron-process-video');
    } catch (e) {
        return res.status(500).json({ error: '合并模块加载失败: ' + e.message });
    }

    const streaming = String(req.query.stream || '') === '1';
    let onStage = null;
    if (streaming) {
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        onStage = (stage) => {
            if (res.writableEnded) return;
            try { res.write(JSON.stringify(stage) + '\n'); } catch (_) { /* 连接已断开 */ }
        };
    }

    console.log(`🎬 [merge-episode] 合并剧集: ${relDir}${streaming ? ' (流式进度)' : ''}`);
    runner.mergeEpisode(absDir, (err, result) => {
        if (err) {
            console.error(`❌ [merge-episode] ${err.message.split('\n')[0]}`);
            if (streaming) {
                if (!res.writableEnded) res.end(JSON.stringify({ stage: 'error', message: err.message }) + '\n');
                return;
            }
            return res.status(500).json({ error: err.message });
        }
        console.log(`✅ [merge-episode] 完成: ${result.finalVideoPath}`);
        if (streaming) {
            if (!res.writableEnded) res.end(JSON.stringify({ stage: 'result', result }) + '\n');
            return;
        }
        res.json(result);
    }, onStage);
});

// ================= 手动合并指定视频文件 (服务器模式: 调用 merge_videos.py) =================
app.post('/api/merge-files', (req, res) => {
    const { files, outName, outDir } = req.body || {};
    const list = Array.isArray(files) ? files.filter(f => typeof f === 'string' && f.trim()) : [];
    if (list.length < 2) return res.status(400).json({ error: '请至少提供 2 个视频文件路径' });
    for (const f of list) {
        if (!path.isAbsolute(f)) return res.status(400).json({ error: `必须是绝对路径: ${f}` });
        if (!fs.existsSync(f)) return res.status(400).json({ error: `文件不存在: ${f}` });
    }
    let runner;
    try {
        runner = require('./electron-process-video');
    } catch (e) {
        return res.status(500).json({ error: '合并模块加载失败: ' + e.message });
    }
    console.log(`🎬 [merge-files] 开始合并 ${list.length} 个视频 -> ${outName || '合并视频'}_完整版.mp4`);
    runner.mergeVideoFiles({ files: list, outName, outDir }, (err, result) => {
        if (err) {
            console.error(`❌ [merge-files] ${err.message.split('\n')[0]}`);
            return res.status(500).json({ error: err.message });
        }
        console.log(`✅ [merge-files] 完成: ${result.finalVideoPath}`);
        res.json(result);
    });
});

// 静态文件服务（放在 API 路由之后）
app.use(express.static(path.join(__dirname)));

// 启动: 端口被占用时先回收"本项目的旧实例", 保持访问地址稳定。
// 非桌面端不会静默改用 3001/3002 —— 否则 open-browser.bat 里写死的
// http://localhost:3000 会连到旧实例上, 而且旧实例会越积越多。
const MAX_PORT = PORT + 10;

// 全局服务器引用，用于优雅退出
let server = null;
let boundPort = PORT;      // 实际监听端口 (桌面端据此打开窗口)

/** 尝试监听指定端口: 成功 true, 端口被占用 false */
function tryListen(port) {
    return new Promise((resolve, reject) => {
        const s = app.listen(port);
        // 拉长 keep-alive: 限流重试等场景浏览器会等待 30s+ 后再发请求，
        // Node 默认 5s 关闭空闲连接会导致浏览器复用失效连接报 "Failed to fetch"
        s.keepAliveTimeout = 120000;
        s.headersTimeout = 125000;
        s.once('listening', () => {
            server = s;
            boundPort = port;
            console.log(`🚀 AGNES 2.5 视频生成器服务器已启动`);
            console.log(`📍 访问地址: http://localhost:${port}`);
            console.log(`📁 存储路径: ${CONFIG.basePath}`);
            console.log(`🔗 通用代理: http://localhost:${port}/api/proxy?target=<编码后的平台URL>`);
            ensureDir(CONFIG.basePath);
            ensureDir(path.join(CONFIG.basePath, CONFIG.imagesFolder));
            ensureDir(path.join(CONFIG.basePath, CONFIG.videoFolder));
            resolve(true);
        });
        s.once('error', (err) => {
            s.removeAllListeners();
            try { s.close(); } catch (_) {}
            if (err.code === 'EADDRINUSE') return resolve(false);
            reject(err);
        });
    });
}

/**
 * 空闲退出看门狗: 页面关闭后自动退出进程, 立即释放端口。
 * 只有"曾经打开过页面"才会生效, 因此脚本直接调 API 的用法不受影响;
 * 有请求正在处理 (合并/字幕烧录/生成) 时也不会退出。
 */
function startIdleWatchdog() {
    if (process.env.AGNES_DESKTOP === '1') return;

    let prevWall = Date.now();
    let prevUptime = process.uptime();
    const timer = setInterval(() => {
        const now = Date.now();
        const wallDelta = now - prevWall;
        const monoDelta = (process.uptime() - prevUptime) * 1000;
        prevWall = now;
        prevUptime = process.uptime();
        // 系统休眠/挂起: 墙钟走了很久而单调时钟几乎没动, 不能算作"页面已关闭"
        // (否则笔记本睡一觉回来, 服务器已经退出了)
        if (wallDelta - monoDelta > 30000) {
            pages.forEach((_, id) => pages.set(id, now));
            if (pages.size === 0) emptySince = now;
            return;
        }

        if (!everHeartbeat || inFlight > 0) return;

        if (pages.size > 0) {
            // 还没到"失联"阈值就不动; 全部失联时以最后一次心跳作为计时起点
            const lastSeen = Math.max(...pages.values());
            if (now - lastSeen <= IDLE_EXIT_MS) return;
            pages.clear();
            emptySince = lastSeen;
            emptyByClose = false;
        } else if (!emptySince) {
            emptySince = now;
        }

        // 页面明确关闭 -> 短宽限后退出 (覆盖刷新); 失联 -> 等满一个完整周期
        const grace = emptyByClose ? CLOSE_GRACE_MS : IDLE_EXIT_MS;
        if (now - emptySince > grace) {
            console.log(emptyByClose
                ? `\n🛑 页面已关闭，自动释放端口 ${boundPort}...`
                : `\n🛑 页面已失联 ${Math.round((now - emptySince) / 60000)} 分钟，自动释放端口 ${boundPort}... (重新打开页面即可继续使用)`);
            gracefulShutdown('page-closed');
        }
    }, Math.max(500, Math.min(5000, Math.floor(IDLE_EXIT_MS / 10))));
    if (timer.unref) timer.unref();
}

/** 启动服务器 @returns {Promise<number>} 实际监听的端口 */
async function startServer(startPort) {
    const desktop = process.env.AGNES_DESKTOP === '1';
    let port = startPort;

    while (port <= MAX_PORT) {
        if (await tryListen(port)) {
            startIdleWatchdog();
            if (!desktop) warnStaleSiblings();
            return port;
        }

        // 端口被占用: 先判断是不是本项目的旧实例, 是就回收 (访问地址保持不变)
        console.log(`⚠️ 端口 ${port} 已被占用，检查是否为旧实例...`);
        const freed = reclaimStaleInstance(port, (m) => console.log('   ' + m));
        if (freed > 0 && await waitPortFree(port, 4000)) {
            if (await tryListen(port)) {
                console.log(`♻️ 已回收旧实例占用的端口 ${port} (共结束 ${freed} 个进程)`);
                startIdleWatchdog();
                if (!desktop) warnStaleSiblings();
                return port;
            }
        }

        if (!desktop) {
            console.error(`❌ 端口 ${port} 被其它程序占用, 已停止启动 (不静默改端口, 否则浏览器会连到旧实例上)。`);
            console.error(`   请先结束占用该端口的程序:`);
            console.error(`     Windows: netstat -ano | findstr :${port}   找到 PID 后  taskkill /F /PID <PID>`);
            console.error(`     或改用其它端口:  set PORT=3001 && node server.js`);
            console.error(`   如果占用者是本项目的旧实例, 可执行: node free-port.js ${port}`);
            process.exit(1);
        }
        console.warn(`⚠️ 桌面端改用端口 ${port + 1}...`);
        port++;
    }

    console.error(`❌ 端口 ${startPort}~${MAX_PORT} 均被占用, 无法启动。`);
    process.exit(1);
}

/**
 * 启动后扫一遍相邻端口, 报告"旧版本静默换端口"遗留下来的残留实例。
 * 只报告不结束: 用户可能故意开着第二个实例 (例如另一套保存位置), 不能替他做决定。
 */
function warnStaleSiblings() {
    setTimeout(() => {
        const found = [];
        for (let p = PORT; p <= PORT + 10; p++) {
            if (p === boundPort) continue;
            for (const pid of listeningPids(p)) {
                if (isOurServer(commandLine(pid))) found.push(`${p} (PID ${pid})`);
            }
        }
        if (found.length) {
            console.warn(`⚠️ 检测到 ${found.length} 个残留的 AGNES 服务器实例: ${found.join(', ')}`);
            console.warn(`   它们是旧版本"端口被占用就自动改用下一个端口"留下的, 建议清理以释放内存:`);
            found.forEach(f => console.warn(`     node free-port.js ${f.split(' ')[0]}`));
        }
    }, 1200).unref?.();
}

const ready = startServer(PORT);   // 实际监听端口 (electron-main.js 据此打开窗口)

module.exports = app;
module.exports.ready = ready;

// ================== 优雅退出处理 ==================
let shuttingDown = false;

function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n🛑 正在关闭服务器 (${signal})...`);
    reportEvent('app.close');

    if (!server || !server.listening) {
        console.log('服务器未运行，直接退出');
        process.exit(0);
    }

    // 设置超时，强制退出
    const timeout = setTimeout(() => {
        console.error('❌ 强制关闭服务器 (超时)');
        process.exit(1);
    }, 5000);

    // 立即断开 keep-alive 空闲连接: server.close() 只停止接收新连接,
    // 若仍有浏览器保持的长连接 (keepAliveTimeout 120s), 端口会继续被占用很久。
    if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch (_) {}
    }

    // 尝试优雅关闭
    server.close(() => {
        clearTimeout(timeout);
        console.log('✅ 服务器已关闭, 端口已释放');
        process.exit(0);
    });

    // 同时发送 SIGTERM 给子进程 (如果有)
    if (global.agnesChildren) {
        global.agnesChildren.forEach(child => {
            try { child.kill('SIGTERM'); } catch (_) {}
        });
    }
}

// 监听退出信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 未捕获异常时退出
process.on('uncaughtException', (err) => {
    console.error('💥 未捕获异常:', err.message);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 未处理的 Promise 拒绝:', reason);
});
