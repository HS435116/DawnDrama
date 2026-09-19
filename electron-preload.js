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
    }
});
