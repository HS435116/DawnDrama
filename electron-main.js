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
const net = require('net');
const { mergeEpisode, mergeVideoFiles, mergeEpisodesBatch } = require('./electron-process-video');

let win = null;

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
