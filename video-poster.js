/**
 * AGNES 2.5 - 作品库封面 (视频第一帧当海报)
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 作品库卡片原来只有 🎬 图标, 现在用视频第一帧做封面:
 *   · 用随包 ffmpeg 抽帧, 结果按"绝对路径 + 大小 + mtime"落盘缓存 —— 同一文件只抽一次,
 *     成片被重新烧录 (大小/mtime 变了) 会自动换新封面;
 *   · 开头是黑场 (AI 片段很常见的淡入) 时, 顺着 0.4s/1s/2s 找到第一张有画面的帧 ——
 *     不然封面就是一整块黑, 比默认图标还难看;
 *   · 图片作品直接返回原图, 不需要抽帧;
 *   · 抽帧是异步的, 且同一张封面的并发请求共享一次 ffmpeg 调用 —— 服务器 (挂机轮询、
 *     页面心跳) 都在同一个进程里, 不能因为生成封面把事件循环卡住。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

// ffmpeg 偶尔会卡在坏文件上, 到点就放弃 (前端回退成默认图标, 不拖住页面)
const EXTRACT_TIMEOUT_MS = 20000;
// 黑场判定的亮度阈值 (YAVG, 0~255)。这里量的是"缩放后、即将编成 JPEG"的那一帧, 已按
// 全范围 (0~255) 换算: 纯黑≈0.3, 暗到快看不见的淡入帧≈9, 正常画面 50~110。
// 取 12 是因为实测某分镜第一帧 YAVG=0.34 (整块黑), 而 0.4s 处只有 9 也还是糊的。
const MIN_COVER_LUMA = 12;
// 候选时间点: 先取第一帧, 是黑场就往后挪一点再试 (AI 片段淡入黑场很常见)
const COVER_CANDIDATE_SECONDS = [0, 0.4, 1, 2];

/**
 * ffmpeg 定位: AGNES_FFMPEG 环境变量 > 随包 resources/ffmpeg (打包版/开发版) > 系统 PATH。
 * 打包版注意: extraResources 把 resources 又嵌了一层, 真实路径在 <安装目录>/resources/resources/ffmpeg。
 */
function resolveFfmpeg() {
    const fromEnv = String(process.env.AGNES_FFMPEG || '').trim().replace(/^"|"$/g, '');
    const candidates = [];
    if (fromEnv) candidates.push(fromEnv, path.join(fromEnv, 'ffmpeg.exe'));
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'resources', 'ffmpeg', 'ffmpeg.exe'));
        candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    }
    candidates.push(path.join(__dirname, 'resources', 'ffmpeg', 'ffmpeg.exe'));
    for (const cand of candidates) {
        try { if (cand && fs.statSync(cand).isFile()) return cand; } catch (_) { /* 换下一个 */ }
    }
    return 'ffmpeg';   // 交给系统 PATH: 找不到时 spawn 会报错, 上层降级为"没有封面"
}

const FFMPEG = resolveFfmpeg();

const isImageFile = (p) => IMAGE_EXT.test(String(p || ''));
const isVideoFile = (p) => VIDEO_EXT.test(String(p || ''));

function ensureCacheDir(dir) {
    if (!dir) return null;
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch (_) { return null; }
}

/** 缓存键: 内容一变 (大小/mtime 变) 就换名, 天然失效, 不会拿旧封面糊弄 */
function posterKey(filePath, stat) {
    return crypto.createHash('sha1')
        .update(`${path.resolve(filePath)}|${stat.size}|${stat.mtimeMs}`)
        .digest('hex');
}

const _inflight = new Map();

/**
 * 抽一帧到 outPath, 顺便用 signalstats 报出这帧的平均亮度 (判断是不是黑场)。
 * 解析不出亮度时 luma 为 null (当作"有画面", 不因为读不到统计就反复重试)。
 * @returns {Promise<{path:string, luma:number|null}|null>} 抽不出帧 (超时/坏文件/超出片长) 返回 null
 */
function extractFrame(filePath, seconds, outPath) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (seconds > 0) args.push('-ss', String(seconds));       // 输入侧定位, 快
    args.push('-i', filePath, '-frames:v', '1',
              // 宽度超过 640 才缩 (高度 -2 取偶数, 编码器要求), 不放大
              '-vf', "scale='if(gt(iw,640),640,iw)':-2,signalstats,metadata=print:file=-",
              '-q:v', '4', outPath);

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let stdout = '';
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        const child = spawn(FFMPEG, args, { windowsHide: true });
        timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); }, EXTRACT_TIMEOUT_MS);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.on('error', () => finish(null));
        child.on('close', (code) => {
            let size = 0;
            try { size = fs.statSync(outPath).size; } catch (_) { /* 没产出 */ }
            if (code !== 0 || size === 0) return finish(null);
            const m = stdout.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
            finish({ path: outPath, luma: m ? parseFloat(m[1]) : null });
        });
    });
}

/**
 * 取封面文件的绝对路径:
 *   图片 -> 原图本身; 视频 -> 开头的画面 (第一帧; 是黑场就往后挪一点) 的 jpg, 缓存命中直接返回。
 * 返回 Promise<string|null>; 抽帧失败/ffmpeg 缺失一律 null (调用方回退默认图标)。
 * @param {string} filePath 媒体文件绝对路径
 * @param {{cacheDir?:string}} opts cacheDir: 封面缓存目录 (作品库下的 .posters)
 */
function getPosterFile(filePath, opts = {}) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return Promise.resolve(null); }
    if (!stat.isFile()) return Promise.resolve(null);
    if (isImageFile(filePath)) return Promise.resolve(filePath);      // 图片本身就是封面
    if (!isVideoFile(filePath)) return Promise.resolve(null);

    const cacheDir = ensureCacheDir(opts.cacheDir);
    if (!cacheDir) return Promise.resolve(null);
    const out = path.join(cacheDir, `${posterKey(filePath, stat)}.jpg`);
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (_inflight.has(out)) return _inflight.get(out);                // 并发请求只抽一次

    const tmpAt = (i) => `${out}.${process.pid}.${i}.tmp.jpg`;
    const cleanTmp = () => { for (let i = 0; i < COVER_CANDIDATE_SECONDS.length; i++) { try { fs.unlinkSync(tmpAt(i)); } catch (_) {} } };

    const task = (async () => {
        let chosen = null;      // 选中的候选帧 (非黑场)
        let fallback = null;    // 兜底: 第一张能抽出来的帧 (整片都黑时也不至于没有封面)
        for (let i = 0; i < COVER_CANDIDATE_SECONDS.length; i++) {
            const frame = await extractFrame(filePath, COVER_CANDIDATE_SECONDS[i], tmpAt(i));
            if (!frame) break;                          // 超出片长/坏文件: 不再往后试
            if (fallback === null) fallback = frame;
            if (frame.luma === null || frame.luma >= MIN_COVER_LUMA) { chosen = frame; break; }
        }
        const pick = chosen || fallback;
        if (!pick) { cleanTmp(); return null; }
        try {
            fs.renameSync(pick.path, out);              // 原子落盘: 并发/重启都不会读到半张图
            return out;
        } catch (_) {
            return null;
        } finally {
            cleanTmp();
        }
    })().finally(() => _inflight.delete(out));

    _inflight.set(out, task);
    return task;
}

module.exports = { getPosterFile, resolveFfmpeg, isImageFile, isVideoFile };
