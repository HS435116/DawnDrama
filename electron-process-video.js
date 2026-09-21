/**
 * AGNES 2.5 - 视频处理 IPC 处理器
 * 用于调用 merge_videos.py 进行视频合并、ASR识别、字幕烧录
 * 支持便携模式（内置 Python + ffmpeg + ASR 模型）和开发模式
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 脚本路径
const MERGE_SCRIPT = path.join(__dirname, 'merge_videos.py');

// merge_videos.py 的阶段进度标记前缀 (形如: @@AGNES_STAGE@@ {"stage":"asr",...})
const STAGE_PREFIX = '@@AGNES_STAGE@@';

/**
 * 从脚本输出里取出最后一个合法的 JSON 对象 (结果 JSON 独占一行)。
 * 逐行倒序尝试, 避免日志中出现的花括号把正则匹配拼接成非法 JSON。
 */
function parseLastJson(text) {
    const lines = String(text || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        try {
            return JSON.parse(line);
        } catch (_) { /* 不是合法 JSON, 继续往前找 */ }
    }
    // 兜底: 整体正则匹配 (兼容结果 JSON 与日志同处一行的情况)
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch (_) { /* ignore */ }
    }
    return null;
}

// ============================================================
// 便携模式资源路径解析
// ============================================================

/** 内置运行环境标志物: 命中任一即认为该目录是"随包携带的 resources" */
function hasBundledRuntime(dir) {
    if (!dir) return false;
    return ['ffmpeg', 'asr_model', 'python', 'python_temp']
        .some(name => fs.existsSync(path.join(dir, name)));
}

/**
 * 获取便携模式下的资源目录。
 *
 * Electron 打包后提供的是 process.resourcesPath (= <安装目录>/resources),
 * 而 extraResources "from: resources → to: resources" 会把内容再嵌一层,
 * 即实际运行环境位于 <resourcesPath>/resources/。
 *
 * 这里按"优先命中内置运行环境"的顺序探测多个候选目录:
 * 打包版能命中嵌套目录, 开发版会跳过 node_modules/electron/dist/resources
 * (那里没有内置环境) 落到项目自带的 resources/。
 */
function getPortableResourcesDir() {
    const candidates = [];
    // 打包版: <安装目录>/resources/resources (extraResources) 与 <安装目录>/resources
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'resources'));
        candidates.push(process.resourcesPath);
    }
    // 兼容旧写法/自定义环境
    if (process.resourcesDir) {
        candidates.push(path.join(process.resourcesDir, 'resources'));
        candidates.push(process.resourcesDir);
    }
    // 开发模式
    candidates.push(path.join(__dirname, 'resources'));

    const existing = candidates.filter(d => d && fs.existsSync(d));
    // 优先返回真正带着内置运行环境的那个, 避免误选 electron 自带的空 resources 目录
    return existing.find(hasBundledRuntime) || existing[0] || null;
}

const RESOURCES_DIR = getPortableResourcesDir();

/**
 * 获取内嵌 Python 路径 (兼容 python/ 与 python_temp/ 两种目录名)
 */
function getEmbeddedPython() {
    if (!RESOURCES_DIR) return null;
    for (const dirName of ['python', 'python_temp']) {
        const exePath = path.join(RESOURCES_DIR, dirName, 'python.exe');
        if (fs.existsSync(exePath)) return exePath;
    }
    return null;
}

/**
 * 获取 ffmpeg 路径 (从内置或系统 PATH)
 */
function getFFmpegPath() {
    if (RESOURCES_DIR) {
        const exePath = path.join(RESOURCES_DIR, 'ffmpeg', 'ffmpeg.exe');
        if (fs.existsSync(exePath)) return exePath;
    }
    // 回退到系统 PATH
    return null;
}

/**
 * 获取 ASR 模型路径 (从内置或系统)
 * 便携模式下使用内置模型；如果模型缺失则回退到系统路径
 */
function getASRModelDir() {
    if (RESOURCES_DIR) {
        const modelDir = path.join(RESOURCES_DIR, 'asr_model');
        if (fs.existsSync(path.join(modelDir, 'model.int8.onnx'))) {
            return modelDir;
        }
    }
    // 回退到开发机上的模型路径
    return null;
}

// ============================================================
// 执行视频合并处理
// ============================================================

/**
 * 合并单个剧集目录下的全部分镜视频
 * @param {string} episodePath 剧集目录绝对路径
 * @param {Function} callback (err, result)
 * @param {Function} [onStage] 阶段进度回调: ({stage, message, current?, total?}) => void
 */
function mergeEpisode(episodePath, callback, onStage) {
    console.log(`[VideoProcess] 开始处理: ${episodePath}`);

    if (!fs.existsSync(episodePath)) {
        return callback(new Error(`剧集文件夹不存在: ${episodePath}`));
    }

    const videoFiles = fs.readdirSync(episodePath).filter(f =>
        f.endsWith('.mp4') && !f.includes('_完整版.mp4')
    );

    if (videoFiles.length === 0) {
        return callback(new Error(`剧集文件夹中没有视频文件: ${episodePath}`));
    }

    runMergeScript(['--files', videoFiles.map(f => path.join(episodePath, f)).join('|'),
                    '--out-name', path.basename(episodePath),
                    '--out-dir', episodePath], callback, onStage);
}

function mergeVideoFiles(payload, callback, onStage) {
    const files = Array.isArray(payload?.files) ? payload.files.filter(f => typeof f === 'string' && f.trim()) : [];
    if (files.length < 2) {
        return callback(new Error('请至少选择 2 个视频文件进行合并'));
    }
    const outName = String(payload.outName || '').trim() || `合并视频_${Date.now()}`;
    const outDir = String(payload.outDir || '').trim();

    console.log(`[VideoProcess] 按文件列表合并 ${files.length} 个视频 -> ${outName}_完整版.mp4`);
    runMergeScript(['--files', files.join('|'), '--out-name', outName, '--out-dir', outDir], callback, onStage);
}

function mergeEpisodesBatch(episodePaths, progressCallback, completeCallback) {
    console.log(`[VideoProcess] 批量处理 ${episodePaths.length} 个剧集`);

    let completed = 0;
    const results = [];

    episodePaths.forEach((episodePath, index) => {
        mergeEpisode(episodePath, (err, result) => {
            results.push({ path: episodePath, err, result });

            completed++;
            if (progressCallback) {
                progressCallback(completed, episodePaths.length, results);
            }

            if (completed === episodePaths.length) {
                if (completeCallback) {
                    const successCount = results.filter(r => !r.err).length;
                    completeCallback(err, results, successCount);
                }
            }
        });
    });
}

function runMergeScript(scriptArgs, callback, onStage) {
    // 确定 Python 解释器
    const embeddedPython = getEmbeddedPython();
    let pythonExe;
    // ffmpeg / ASR 模型与 Python 各自独立解析: 即使用户自备 Python, 也应优先用随包的 ffmpeg 与 ASR 模型
    const ffmpegPath = getFFmpegPath();
    const asrModelDir = getASRModelDir();

    if (embeddedPython) {
        pythonExe = embeddedPython;
        console.log(`[VideoProcess] 使用内嵌 Python: ${pythonExe}`);
    } else {
        pythonExe = 'python';
        console.log('[VideoProcess] 未找到内置 Python，回退到系统 PATH 的 python');
    }
    console.log(`[VideoProcess] 资源目录: ${RESOURCES_DIR || '(未找到)'}`);
    if (ffmpegPath) console.log(`[VideoProcess] 使用内置 ffmpeg: ${ffmpegPath}`);
    else console.log('[VideoProcess] ⚠️ 未找到内置 ffmpeg，将使用系统 PATH (可能导致合并失败)');
    if (asrModelDir) console.log(`[VideoProcess] 使用内置 ASR 模型: ${asrModelDir}`);
    else console.log('[VideoProcess] ⚠️ 未找到内置 ASR 模型，将使用脚本内的默认路径 (可能无法烧录字幕)');

    // 构建进程环境：传递内置资源路径作为环境变量
    // AGNES_FFMPEG 传"目录"(脚本约定目录内同时含 ffmpeg.exe 与 ffprobe.exe)
    const env = Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        // 传递给 merge_videos.py 的资源路径
        ...(ffmpegPath ? { AGNES_FFMPEG: path.dirname(ffmpegPath) } : {}),
        ...(asrModelDir ? { AGNES_ASR_MODEL: asrModelDir } : {}),
    });

    const python = spawn(pythonExe, [MERGE_SCRIPT, ...scriptArgs], {
        cwd: path.dirname(MERGE_SCRIPT),
        windowsHide: true,
        env: env
    });

    let stdout = '';
    let stderr = '';
    let stdoutTail = ''; // 跨 chunk 的行缓冲: 阶段标记行可能被拆成多次 data 事件

    /** 逐行扫描子进程输出, 把 @@AGNES_STAGE@@ 标记转成 onStage 回调 */
    const scanStages = (chunk) => {
        if (!onStage) return;
        const lines = (stdoutTail + chunk).split(/\r?\n/);
        stdoutTail = lines.pop() || '';
        for (const line of lines) {
            const idx = line.indexOf(STAGE_PREFIX);
            if (idx === -1) continue;
            const jsonText = line.slice(idx + STAGE_PREFIX.length).trim();
            try {
                onStage(JSON.parse(jsonText));
            } catch (_) { /* 半行/非法标记一律忽略 */ }
        }
    };

    python.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        scanStages(text);
        process.stdout.write(data);
    });

    python.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
    });

    python.on('close', (code) => {
        console.log(`[VideoProcess] 处理完成，退出码: ${code}`);

        if (code !== 0) {
            return callback(new Error(`视频合并失败，退出码: ${code}\n${stderr}`));
        }

        // 阶段标记行本身也是 JSON, 必须先剔除, 否则下面的正则会把标记和结果拼成非法 JSON
        const cleanStdout = stdout
            .split(/\r?\n/)
            .filter(l => !l.includes(STAGE_PREFIX))
            .join('\n');

        // 优先按行解析最后一行合法 JSON (结果 JSON 独占一行), 避免日志里的花括号干扰
        const parsed = parseLastJson(cleanStdout);
        if (parsed) {
            if (parsed.success && parsed.result && parsed.result.finalVideoPath) {
                callback(null, {
                    success: true,
                    finalVideoPath: parsed.result.finalVideoPath,
                    episodeName: parsed.result.episodeName,
                    // 字幕是否真的烧上去了 (缺 ASR / 没识别到语音 / 烧录失败都会是 false)。
                    // 必须透传上去: 前端以前一律显示"已烧录中文字幕", 这就是"假成功"。
                    subtitles: parsed.result.subtitles,
                    subtitleReason: parsed.result.subtitleReason || '',
                    // 单分镜不合并 (只出字幕文件): 前端据此区分"成片"和"原片 + 字幕"
                    merged: parsed.result.merged,
                    subtitlePath: parsed.result.subtitlePath || ''
                });
                return;
            }
            if (parsed.error) {
                return callback(new Error(parsed.error));
            }
        }

        callback(new Error('Python 脚本未返回有效结果'));
    });

    python.on('error', (err) => {
        const hint = err.code === 'ENOENT'
            ? `\n未找到可用的 Python 解释器 (尝试启动: ${pythonExe})。便携版应内置 Python，若提示缺失请重新获取完整安装包。`
            : '';
        callback(new Error(`无法启动 Python 进程: ${err.message}${hint}`));
    });
}

module.exports = {
    mergeEpisode,
    mergeVideoFiles,
    mergeEpisodesBatch
};