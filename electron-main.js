/* ============================================================
 * AGNES 2.5 批量视频生成器 — 桌面应用主进程 (无边框窗口)
 * Copyright (c) 2026 @ 晨曦微光工作室
 * 本软件基于 MIT 许可证开源发布 (详见 LICENSE)
 * ============================================================
 * 职责:
 *  1. 启动内嵌 Express 服务器 (自动挑选空闲端口)
 *  2. 创建无边框窗口 (自定义标题栏, 见 index.html #desktop-titlebar)
 *  3. 窗口控制 IPC (最小化/最大化/关闭)
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { mergeEpisode, mergeVideoFiles, mergeEpisodesBatch } = require('./electron-process-video');
const { downloadToFile, fetchJson, fileNameFromUrl, looksLikeInstaller } = require('./update-downloader');

let win = null;

/** 便携版: 单文件 exe, 就地升级要替换正在运行的文件 (Windows 不允许), 所以只下载不自动安装 */
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
/** 本次是不是"安装完刚起来" (NSIS 装完启动会带 --updated), 前端据此提示一句 */
const IS_UPDATED_RUN = process.argv.includes('--updated');

// 单实例锁: 二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

// 便携版: 数据目录跟随 exe 所在位置 (数据不散落 AppData)
if (process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Data'));
}

/** 从 startPort 起探测一个空闲端口 */
function getFreePort(startPort) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(getFreePort(startPort + 1)));
        probe.listen(startPort, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * 桌面版默认保存位置: 应用所在目录下的 output/
 *   · 便携版 / 免安装运行: 与 exe 同级, 即 <exe目录>/output/
 *   · 开发模式: 项目根目录下的 output/
 *   · 安装到 Program Files 等不可写位置时, 退回用户数据目录, 避免无权限写入
 * 返回值同时交给 server.js 作为"兜底默认值"(AGNES_DEFAULT_OUTPUT_DIR)。
 */
function resolveDefaultOutputDir() {
    const appDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    const candidate = path.join(appDir, 'output');
    try {
        fs.mkdirSync(candidate, { recursive: true });
        fs.accessSync(candidate, fs.constants.W_OK);
        return candidate;
    } catch (_) {
        return path.join(app.getPath('userData'), 'output');
    }
}

// 窗口控制 IPC (注册一次)
ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
ipcMain.on('win-maximize', () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.on('win-close', () => { if (win) win.close(); });
// 持久化设置页的自定义保存位置 (重启后仍生效)
ipcMain.on('save-output-dir', (_, dir) => {
    if (typeof dir === 'string' && dir.trim()) {
        try {
            fs.writeFileSync(path.join(app.getPath('userData'), 'output-dir.json'), JSON.stringify({ outputDir: dir.trim() }, null, 2));
        } catch (_) {}
    }
});
// 在资源管理器中定位作品文件 (路径由渲染进程传相对路径, 主进程基于输出目录拼接, 防任意路径打开)
ipcMain.on('win-reveal', (_, relativePath) => {
    const base = process.env.AGNES_OUTPUT_DIR || '';
    if (!base) return;
    if (!relativePath) { shell.openPath(base); return; }
    if (typeof relativePath !== 'string') return;
    const full = path.join(base, ...String(relativePath).split('/'));
    if (!full.startsWith(base)) return; // 越径防护
    shell.showItemInFolder(full);
});
// 定位任意绝对路径文件 (仅限本机已存在的文件, 供手动合并结果定位)
ipcMain.on('win-reveal-absolute', (_, absPath) => {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return;
    try { if (!fs.existsSync(absPath)) return; } catch (_) { return; }
    shell.showItemInFolder(absPath);
});

// ==================== 应用内更新 (下载 → 安装 → 重启) ====================

/** 允许下载到/执行安装包的位置: 只认我们自己建的临时目录 (安装版) 或当前 exe 所在目录 (便携版) */
const trustedUpdateDirs = new Set();
/** 当前下载任务 (同一时刻只允许一个): { cancelled, destPath } */
let updateTask = null;

const sendToWin = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/** 前端问"我现在是什么运行环境" —— 决定能不能自动安装 */
ipcMain.handle('runtime-info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    portable: IS_PORTABLE,
    updatedRun: IS_UPDATED_RUN,
    exePath: app.getPath('exe'),
    // 安装版: 安装目录就是 exe 所在目录 (NSIS 一键安装固定装在这里); 便携版/开发模式为空
    installDir: app.isPackaged && !IS_PORTABLE ? path.dirname(app.getPath('exe')) : '',
}));

/**
 * 拉取更新清单 (latest.json)。
 * 必须在主进程做: 清单常放在第三方站点, 很多站点没配 CORS 头, 渲染进程的 fetch
 * 会被浏览器同源策略拦掉 —— 表现就是"自建源永远不可用", 只能退到 GitHub。
 */
ipcMain.handle('update-fetch-manifest', async (_, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '地址不合法' };
    try {
        const manifest = await fetchJson(target, { timeoutMs: 8000 });
        if (!manifest || !String(manifest.version || '').trim()) return { ok: false, error: '清单缺少 version 字段' };
        return { ok: true, manifest };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

/**
 * 下载更新包。安装版落到临时目录; 便携版落到当前 exe 旁边
 * (便携版没法覆盖正在运行的自己, 只能下好让用户关掉程序后双击新文件)。
 * 进度通过 update-download-progress 事件推给界面。
 */
ipcMain.handle('update-download', async (_, payload) => {
    const url = String((payload && payload.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '下载地址不合法' };

    // myTask 必须声明在 try 之外: finally 里要用它比对, 声明在 try 内会变成
    // "myTask is not defined", IPC 直接 reject, 界面就永远停在"正在下载"
    let myTask = null;
    let destDir;
    try {
        if (IS_PORTABLE) {
            destDir = path.dirname(app.getPath('exe'));
        } else {
            destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-update-'));
        }
        trustedUpdateDirs.add(path.resolve(destDir));
        const destPath = path.join(destDir, fileNameFromUrl(url));
        // 同一时刻只允许一个下载: 用户关掉弹窗再打开会发起第二次, 这里把上一次取消掉,
        // 免得两个下载各自推进度、还互相把对方的任务状态清掉
        if (updateTask) updateTask.cancelled = true;
        myTask = { cancelled: false, destPath };
        updateTask = myTask;
        console.log(`[Update] 开始下载更新包: ${url}`);
        sendToWin('update-download-progress', { phase: 'start', percent: 0, received: 0, total: null, speed: 0 });

        const res = await downloadToFile(url, destPath, {
            onProgress: (p) => { if (!myTask.cancelled) sendToWin('update-download-progress', { phase: 'progress', ...p }); },
            isCancelled: () => myTask.cancelled,
        });

        if (!looksLikeInstaller(res.path)) {
            try { fs.unlinkSync(res.path); } catch (_) { /* 忽略 */ }
            console.error(`[Update] 下载到的文件不像安装包, 已删除: ${res.path}`);
            sendToWin('update-download-progress', { phase: 'error', error: '下载到的文件不像安装包' });
            return { ok: false, error: '下载到的文件不像安装包，请改从项目主页手动下载' };
        }
        console.log(`[Update] 下载完成: ${res.path} (${res.bytes} 字节)`);
        sendToWin('update-download-progress', { phase: 'done', percent: 100, received: res.bytes, total: res.bytes, speed: 0 });
        return { ok: true, path: res.path, bytes: res.bytes, portable: IS_PORTABLE, installDir: path.dirname(app.getPath('exe')) };
    } catch (e) {
        console.error(`[Update] 下载失败: ${e.message}`);
        sendToWin('update-download-progress', { phase: 'error', error: e.message });
        return { ok: false, error: e.message };
    } finally {
        if (updateTask === myTask) updateTask = null;
    }
});

ipcMain.handle('update-cancel', () => {
    if (updateTask) updateTask.cancelled = true;
    return true;
});

/**
 * 运行安装包并退出本程序。
 * 参数按 electron-builder 生成的一键安装包约定:
 *   --updated    已经知道本程序在跑, 不必弹"请先关闭"的对话框 (它会结束旧进程)
 *   --force-run  装完自动把应用重新拉起来 (这样用户看到的就是"更新完自动重启")
 * 安装目录不额外指定 —— 一键安装包固定装在用户目录下 (perMachine=false),
 * 也就是上一次的安装路径, 与"按之前的安装路径"一致。
 */
ipcMain.handle('update-install', async (_, payload) => {
    const filePath = String((payload && payload.path) || '');
    const dir = path.resolve(path.dirname(filePath));
    if (!trustedUpdateDirs.has(dir) || !looksLikeInstaller(filePath)) {
        return { ok: false, error: '安装包路径不合法' };
    }
    // 参数按 electron-builder 生成向导式安装包的约定:
    //   /S           静默安装 —— 不弹向导页 (程序内的更新是"点一下就装好", 不该让用户再点一圈)
    //   --updated    已经知道本程序在跑, 不必弹"请先关闭"的对话框 (它会结束旧进程)
    //   --force-run  装完自动把应用重新拉起来 (用户看到的就是"更新完自动重启")
    // 安装目录不额外指定: 安装包会从注册表里读上次的安装位置 (含用户自选的目录),
    // 因此静默升级始终装回原处, 与"按之前的安装路径"一致。
    const args = ['/S', '--updated', '--force-run'];
    const child = spawn(filePath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: dir,
    });
    child.unref();
    console.log(`[Update] 启动安装包: ${filePath} (${args.join(' ')}), 本程序即将退出`);
    // 立刻退出: 安装包随后会结束本进程 (更稳) 或等它自己退出后再覆盖文件
    setTimeout(() => { try { app.quit(); } catch (_) { /* 已退出 */ } }, 800);
    return { ok: true };
});

// 在资源管理器中定位本机文件 (便携版下载完用"打开所在文件夹"引导用户)
ipcMain.handle('update-reveal', async (_, filePath) => {
    const target = String(filePath || '');
    const dir = path.resolve(path.dirname(target));
    if (!trustedUpdateDirs.has(dir)) return { ok: false, error: '路径不合法' };
    try { shell.showItemInFolder(target); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

// 用系统浏览器打开更新下载页 (服务器模式/不便自动安装时的兜底)
ipcMain.handle('update-open-url', async (_, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '地址不合法' };
    try { await shell.openExternal(target); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== 文件选择对话框 ====================

/** 弹出系统文件选择框, 让用户挑选多个本地视频文件 (手动合并入口) */
ipcMain.handle('select-video-files', async () => {
    const opts = {
        title: '选择要合并的视频文件 (按住 Ctrl 可多选)',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: '视频文件', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] },
            { name: '所有文件', extensions: ['*'] }
        ]
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths) return [];
    return res.filePaths;
});

// ==================== 视频处理 IPC ====================

/**
 * 合并单个剧集
 */
ipcMain.on('video-merge', (_, episodePath) => {
    if (!win) return;
    win.webContents.send('video-merge-progress', { status: 'processing' });
    // 阶段事件: 前端"生成进度"据此显示 拼接/音频识别/字幕烧录 的实时状态
    const onStage = (stage) => {
        if (win && !win.isDestroyed()) win.webContents.send('video-merge-stage', stage);
    };
    mergeEpisode(episodePath, (err, result) => {
        if (!win) return;
        if (err) {
            win.webContents.send('video-merge-progress', {
                status: 'error',
                error: err.message,
                episodePath
            });
        } else {
            win.webContents.send('video-merge-progress', {
                status: 'completed',
                result
            });
        }
    }, onStage);
});

/**
 * 按文件列表合并视频 (手动合并弹窗模式)
 */
ipcMain.on('video-merge-files', (_, payload) => {
    if (!win) return;
    win.webContents.send('video-merge-files-progress', { status: 'processing' });
    const onStage = (stage) => {
        if (win && !win.isDestroyed()) win.webContents.send('video-merge-stage', stage);
    };
    mergeVideoFiles(payload, (err, result) => {
        if (!win) return;
        if (err) {
            win.webContents.send('video-merge-files-progress', { status: 'error', error: err.message });
        } else {
            win.webContents.send('video-merge-files-progress', { status: 'completed', result });
        }
    }, onStage);
});

/**
 * 批量合并剧集
 */
ipcMain.on('video-merge-batch', (_, episodePaths) => {
    if (!Array.isArray(episodePaths) || episodePaths.length === 0) return;

    // 发送开始事件
    if (win) {
        win.webContents.send('video-merge-batch-start', { total: episodePaths.length });
    }

    let completed = 0;
    const results = [];

    episodePaths.forEach((path, index) => {
        mergeEpisode(path, (err, result) => {
            results.push({ path, err, result });

            completed++;

            // 发送进度事件
            if (win) {
                win.webContents.send('video-merge-batch-progress', {
                    current: completed,
                    total: episodePaths.length,
                    results
                });
            }

            if (completed === episodePaths.length) {
                // 发送完成事件
                if (win) {
                    const successCount = results.filter(r => !r.err).length;
                    win.webContents.send('video-merge-batch-complete', {
                        successCount,
                        total: episodePaths.length,
                        results
                    });
                }
            }
        });
    });
});

function createWindow(port) {
    win = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1024,
        minHeight: 640,
        frame: false,                 // 无边框: 标题栏由页面内 #desktop-titlebar 提供
        backgroundColor: '#0f172a',
        icon: path.join(__dirname, 'assets', 'logo.ico'),
        title: '晨曦短剧梦工坊',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'electron-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.setMenuBarVisibility(false);
    win.removeMenu();
    win.loadURL('http://127.0.0.1:' + port);

    win.on('maximize', () => win.webContents.send('win-state', true));
    win.on('unmaximize', () => win.webContents.send('win-state', false));
    win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
    // 默认保存位置: 应用所在目录下的 output/ (便携版即 <exe目录>/output/)
    const defaultOutputDir = resolveDefaultOutputDir();
    // 交给 server.js 作为兜底默认值: 自定义保存位置无效/被误设时回退到这里
    process.env.AGNES_DEFAULT_OUTPUT_DIR = defaultOutputDir;

    // 保存位置优先级: 环境变量 > 设置页上次自定义的位置 (output-dir.json) > 默认位置
    if (!process.env.AGNES_OUTPUT_DIR) {
        // 恢复设置页上次自定义的保存位置 (output-dir.json 由 IPC 写入)
        // 合法性(是否为作品库内部目录等)由 server.js 统一校验, 非法时会自动回退到默认位置
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'output-dir.json'), 'utf8'));
            if (saved && typeof saved.outputDir === 'string' && saved.outputDir.trim()) {
                process.env.AGNES_OUTPUT_DIR = saved.outputDir.trim();
            }
        } catch (_) { /* 无持久化设置 */ }
        if (!process.env.AGNES_OUTPUT_DIR) {
            process.env.AGNES_OUTPUT_DIR = defaultOutputDir;
        }
    }
    const port = await getFreePort(34567);
    process.env.PORT = String(port);
    process.env.AGNES_DESKTOP = '1';

    // 加载即启动内嵌 Express; ready 解析出"实际监听端口"
    // (端口被抢占时 server.js 会顺延, 窗口地址必须用实际端口, 否则会打开空白页)
    const serverApp = require('./server.js');
    const actualPort = await serverApp.ready;

    createWindow(actualPort);

    app.on('second-instance', () => {
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
});

app.on('window-all-closed', () => app.quit());

// 冒烟测试模式 (AGNES_SMOKE_TEST=1): 启动后自动退出, 用于无人值守验证
if (process.env.AGNES_SMOKE_TEST === '1') {
    setTimeout(() => app.quit(), 9000);
}
