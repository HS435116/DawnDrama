/* ============================================================
 * AGNES 2.5 批量视频生成器 — 预加载桥 (无边框标题栏窗口控制)
 * Copyright (c) 2026 @ 晨曦微光工作室
 * ============================================================ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    desktop: true,
    minimize: () => ipcRenderer.send('win-minimize'),
    maximize: () => ipcRenderer.send('win-maximize'),
    close: () => ipcRenderer.send('win-close'),
    reveal: (relativePath) => ipcRenderer.send('win-reveal', relativePath),
    revealPath: (absPath) => ipcRenderer.send('win-reveal-absolute', absPath),
    saveOutputDir: (dir) => ipcRenderer.send('save-output-dir', dir),
    onWindowState: (cb) => ipcRenderer.on('win-state', (_, max) => cb(max)),

    // ==================== 文件选择 ====================
    /** 弹出系统文件选择框, 返回选中的本地视频文件绝对路径数组 (取消返回 []) */
    selectVideoFiles: () => ipcRenderer.invoke('select-video-files'),

    // ==================== 视频处理 ====================
    /**
     * 合并单个剧集
     * @param {string} episodePath - 剧集文件夹路径
     * @param {(stage: {stage: string, message: string, current?: number, total?: number}) => void} [onStage]
     *        可选: 阶段进度回调 (拼接 / 音频识别 / 字幕烧录), 仅在本次合并期间监听
     * @returns {Promise<{success: boolean, result?: object, error?: string}>}
     */
    mergeEpisode: (episodePath, onStage) => {
        return new Promise((resolve) => {
            const stageHandler = onStage ? (_, stage) => onStage(stage) : null;
            if (stageHandler) ipcRenderer.on('video-merge-stage', stageHandler);

            const handler = (_, result) => {
                ipcRenderer.removeListener('video-merge-progress', handler);
                if (stageHandler) ipcRenderer.removeListener('video-merge-stage', stageHandler);
                if (result.status === 'completed') {
                    resolve({ success: true, result: result.result });
                } else {
                    resolve({ success: false, error: result.error });
                }
            };
            ipcRenderer.on('video-merge-progress', handler);
            ipcRenderer.send('video-merge', episodePath);
        });
    },

    /**
     * 按文件列表合并本地视频 (手动合并弹窗模式)
     * @param {{files: string[], outName: string, outDir: string}} payload
     * @param {(stage: object) => void} [onStage] 可选阶段进度回调
     * @returns {Promise<{success: boolean, result?: {finalVideoPath, episodeName}, error?: string}>}
     */
    mergeVideoFiles: (payload, onStage) => {
        return new Promise((resolve) => {
            const stageHandler = onStage ? (_, stage) => onStage(stage) : null;
            if (stageHandler) ipcRenderer.on('video-merge-stage', stageHandler);

            const handler = (_, result) => {
                ipcRenderer.removeListener('video-merge-files-progress', handler);
                if (stageHandler) ipcRenderer.removeListener('video-merge-stage', stageHandler);
                if (result.status === 'completed') {
                    resolve({ success: true, result: result.result });
                } else {
                    resolve({ success: false, error: result.error });
                }
            };
            ipcRenderer.on('video-merge-files-progress', handler);
            ipcRenderer.send('video-merge-files', payload);
        });
    },

    /**
     * 批量合并剧集
     * @param {string[]} episodePaths - 剧集文件夹路径数组
     * @returns {Promise<void>}
     */
    mergeEpisodesBatch: (episodePaths) => {
        return new Promise((resolve, reject) => {
            const handlers = {
                start: () => { /* 可以在这里处理开始事件 */ },
                progress: () => { /* 可以在这里处理进度事件 */ },
                complete: (_, data) => {
                    ipcRenderer.removeAllListeners('video-merge-batch-start');
                    ipcRenderer.removeAllListeners('video-merge-batch-progress');
                    ipcRenderer.removeAllListeners('video-merge-batch-complete');
                    if (data.successCount > 0) {
                        resolve(data);
                    } else {
                        reject(new Error('批量合并失败'));
                    }
                }
            };

            ipcRenderer.on('video-merge-batch-start', handlers.start);
            ipcRenderer.on('video-merge-batch-progress', handlers.progress);
            ipcRenderer.on('video-merge-batch-complete', handlers.complete);

            ipcRenderer.send('video-merge-batch', episodePaths);

            // 超时保护
            setTimeout(() => {
                ipcRenderer.removeAllListeners('video-merge-batch-start');
                ipcRenderer.removeAllListeners('video-merge-batch-progress');
                ipcRenderer.removeAllListeners('video-merge-batch-complete');
                reject(new Error('批量合并超时'));
            }, 30 * 60 * 1000); // 30分钟超时
        });
    },

    // ==================== 应用内更新 (下载 → 安装 → 重启) ====================

    /** 运行环境: 版本号 / 是否安装版 / 安装目录 / 是否刚更新完启动 */
    runtimeInfo: () => ipcRenderer.invoke('runtime-info'),

    /**
     * 拉取更新清单 (latest.json)。走主进程, 不受浏览器同源策略限制 ——
     * 更新清单常放在没配 CORS 头的第三方站点, 渲染进程直接 fetch 会被拦住。
     * @param {string} url
     * @returns {Promise<{ok: boolean, manifest?: object, error?: string}>}
     */
    updateFetchManifest: (url) => ipcRenderer.invoke('update-fetch-manifest', url),

    /**
     * 下载更新包, 进度通过 onProgress 回调陆续给出 (主进程已节流)
     * @param {{url: string}} payload
     * @param {(p: {phase: string, percent: number|null, received: number, total: number|null, speed: number, error?: string}) => void} [onProgress]
     * @returns {Promise<{ok: boolean, path?: string, bytes?: number, portable?: boolean, installDir?: string, error?: string}>}
     */
    updateDownload: (payload, onProgress) => {
        const handler = onProgress ? (_, p) => onProgress(p) : null;
        if (handler) ipcRenderer.on('update-download-progress', handler);
        return ipcRenderer.invoke('update-download', payload)
            .finally(() => { if (handler) ipcRenderer.removeListener('update-download-progress', handler); });
    },

    /** 取消正在进行的下载 */
    updateCancel: () => ipcRenderer.invoke('update-cancel'),

    /** 运行安装包并按之前的安装路径升级, 装完自动重启 (本程序会先退出) */
    updateInstall: (filePath) => ipcRenderer.invoke('update-install', { path: filePath }),

    /** 在资源管理器中定位已下载的更新包 (便携版引导用户手动运行) */
    updateReveal: (filePath) => ipcRenderer.invoke('update-reveal', filePath),

    /** 用系统浏览器打开下载页 (无法自动安装时的兜底) */
    updateOpenUrl: (url) => ipcRenderer.invoke('update-open-url', url)
});
