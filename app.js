/* ============================================================
 * AGNES 2.5 批量视频生成器 — 前端主逻辑
 * Copyright (c) 2026  晨曦微光工作室
 * 本软件基于 MIT 许可证开源发布 (详见 LICENSE)
 * ============================================================ */
/**
 * AGNES 2.5 批量视频生成器 - 前端主逻辑 v2
 *
 * 相对旧版的关键修复:
 *  1. 轮询规范化: 状态统一为 queued/running/succeeded/failed, 不再原样透传平台字符串
 *  2. 轮询有终态: 连续错误/404/总超时(30分钟)都会退出并标记"未知", 不再永久卡"排队中"
 *  3. 批量并行: 所有场景同时提交、并发轮询, 互相独立, 单个失败不影响其它
 *  4. 支持"重试轮询"(未知任务)与"停止"(取消等待)
 *  5. 生成完成自动把视频下载到本地 output/video/<标题>/ 目录 (服务器模式)
 *  6. 服务器模式自动检测, 所有平台请求经 /api/proxy 绕过 CORS
 */

// ================= 版本信息 =================
const APP_VERSION = '2.8.2';
// 版本更新清单地址: 指向仓库根目录的 latest.json ({"version","notes","url","date"})
// 发布新版本时的检查清单:
//   1) bump 本文件的 APP_VERSION、package.json 的 version、server.js 的 APP_VERSION
//   2) 把 latest.json 的 version 改成新版本号, 并在 notes 写更新说明
//      (清单版本必须 > 用户当前版本, 老版本用户才会收到提醒)
//   3) url 留空表示"暂无下载地址", 界面会引导用户去项目主页
// 更新清单候选地址 (按顺序尝试, 第一个成功的即生效):
//   1) 自建下载站 —— 国内可达, 与安装包同一域名
//   2) GitHub raw  —— 备用源 (部分网络下不可达, 所以放后面)
// 只读第一项即可; 任何一项都不可达时静默跳过, 不影响任何功能
const UPDATE_MANIFEST_URLS = [
    'http://78oq264463tb.vicp.fun/latest.json',
    'https://raw.githubusercontent.com/HS435116/DawnDrama/main/latest.json'
];
const DEFAULT_UPDATE_MANIFEST_URL = UPDATE_MANIFEST_URLS[0];   // 兼容旧引用 (界面默认显示第一个源)
// 项目主页: 清单里未提供下载地址时的兜底入口
const PROJECT_HOMEPAGE = 'https://github.com/HS435116/DawnDrama';

const POLL_CFG = {
    initialInterval: 5000,     // 首次轮询间隔
    runningInterval: 5000,     // running 状态轮询间隔
    queuedInterval: 10000,     // queued 状态轮询间隔 (排队时降低频率)
    errorInterval: 8000,       // 出错后轮询间隔
    maxConsecutiveErrors: 10,  // 连续网络/服务错误上限 -> 未知
    maxNotFoundErrors: 8,      // 连续 404 上限 -> 任务ID可能无效
    maxTotalMs: 30 * 60 * 1000 // 单任务总等待上限 30 分钟
};

class AgnesVideoGenerator {
    constructor() {
        this.settings = this.loadSettings();
        this.history = this.loadHistory();
        this.series = this.loadSeries();
        this.batchItems = [];
        this.isGenerating = false;
        this.stopRequested = false;
        this.serverMode = false;
        this.availableModels = [];
        this.galleryFilter = 'all';
        this.modalCountdownTimer = null;
        this._renderTimer = null;
        this._activeJobs = new Set(); // 正在提交/监控中的记录ID, 防止重复操作
        this._finalizing = new Set(); // 正在保存落盘中的记录ID, 防止重复下载
        this._unfinishedSig = null;   // "未完成任务"面板的内容指纹 (避免无谓重绘)
        this._unfinishedHidden = false;
        this._scriptGenerated = false; // 剧本是否已生成待确认
        this._postRunning = false;      // 后期处理(音频识别+字幕烧录)是否进行中
        this._postPercent = null;       // 后期处理进度百分比
        this.llmModels = [];            // 剧本AI模型列表 (按当前凭据来源拉取)
        this._llmModelsKey = null;      // 上面这份列表对应的来源标识
        this._llmModelsFetchedAt = 0;   // 拉取时间 (5 分钟内不重复拉)
        this._llmFetching = false;      // 正在拉取中 (防止并发重复请求)

        // 网络状态与"挂机等网络"的等待者
        this._online = (typeof navigator === 'undefined' || navigator.onLine !== false);

        this._mergeChecked = new Set(); // 本会话已检查过"该集是否该合并"的集名 (避免重复弹窗)
        this._mergePrompts = new Set(); // 已提示过"分镜已齐, 要不要合并"的集名
        this._autoLoopActive = false;   // 挂机 for 循环是否真的在跑 (与 _autoRunning 区分: 暂停态/恢复态可能只有状态没有循环)

        // 保存根目录的唯一来源: 服务器 /api/health 返回的 outputDir (即"模型设置 → 保存位置")。
        // 此处不写死任何盘符/目录, 避免与用户自定义路径产生分歧。
        this.serverOutputDir = null;
        this.outputPaths = { base: '', images: '', video: '' };

        this.apiClient = null;
        this._rebuildClient();

        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.renderBatchList();
        this.renderGallery();
        this.renderHistory();
        this.updateSettingsUI();
        this.updateConnectionStatus();
        const fv = document.getElementById('footer-version');
        if (fv) fv.textContent = APP_VERSION;

        // 检测本地服务器是否可用 (决定是否走 /api/proxy、能否落盘保存)
        await this.detectServerMode();
        // 保存位置来自服务器, 检测完成后重新同步设置页/作品库显示
        this.updateSettingsUI();
        this.renderGallery();
        // 页面心跳: 关掉应用后让服务器自动退出、释放端口
        this._startHeartbeat();

        // 版本更新检查 (静默; 有新版本时入口闪烁并弹窗一次, 不影响使用)
        this.checkForUpdates(true);

        // 恢复未完成任务的轮询
        this.resumePendingTasks();

        // 同步自动合并复选框状态
        this._syncAutoMergeUI();

        // 按上次留下的挂机痕迹接着跑 (刷新/断网/关页面都不该让任务凭空消失;
        // 只有用户点过"⏹️ 停止全剧生成"才会清掉痕迹)
        this.resumeAutoRunOnLoad();
    }

    /* ================= 服务器模式检测 ================= */

    async detectServerMode() {
        try {
            const resp = await fetch('/api/health', { method: 'GET' });
            if (resp.ok) {
                const data = await resp.json();
                this.serverMode = !!data.server;
                if (data.version) this.serverVersion = data.version;
                // 保存位置以服务器(模型设置)为准, 全局统一使用 this.serverOutputDir
                if (this.serverMode && data.outputDir) this.applyOutputDir(data.outputDir);
            }
        } catch (_) {
            this.serverMode = false; // file:// 直接打开 -> 本地模式
        }
        console.log(this.serverMode ? '🖥️ 服务器模式: 请求将经由本地代理转发' : '📄 本地模式: 直接请求平台接口 (可能受 CORS 限制)');
        if (this.serverMode && this.serverOutputDir) console.log(`💾 保存位置: ${this.serverOutputDir}`);
        this._rebuildClient();
        this.updateConnectionStatus();
    }

    /**
     * 页面心跳: 服务器据此判断"应用页面还开着"。
     * 关闭页面时用 sendBeacon 明确告知 -> 服务器立即退出并释放端口,
     * 不会再留下占着 3000/3001 的僵尸进程 (下次启动也就不会撞端口)。
     */
    _startHeartbeat() {
        if (this._heartbeatTimer || !this.serverMode) return;
        this._pageId = Math.random().toString(36).slice(2, 10);
        const ping = () => {
            if (this._stoppedByServer) return;
            fetch(`/api/heartbeat?id=${this._pageId}`, { cache: 'no-store' }).catch(() => {});
        };
        ping();
        // 心跳间隔 15s; 浏览器把后台标签页节流到 1次/分钟也没关系 ——
        // 服务器只在"失联 10 分钟"后才退出, 而真正关闭页面走下面的 beacon 立即通知。
        this._heartbeatTimer = setInterval(ping, 15000);

        // 页面卸载: sendBeacon 只能发 POST (服务器端 GET/POST 都接受)
        const bye = (e) => {
            // persisted=true 表示进 bfcache / 标签页被冻结, 页面还会回来:
            // 这时通知服务器退出, 用户切回来就变成"本地服务器未连接"了, 所以必须跳过。
            if (e && e.persisted) return;
            const url = `/api/heartbeat?id=${this._pageId}&closing=1`;
            try {
                if (navigator.sendBeacon) navigator.sendBeacon(url);
                else fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
            } catch (_) { /* 关闭阶段尽力而为 */ }
        };
        window.addEventListener('pagehide', bye);
        window.addEventListener('beforeunload', bye);

        // 从 bfcache 恢复 / 切回前台: 重新登记, 并顺手确认服务器还在
        const back = () => { ping(); this.checkServerAlive(); };
        window.addEventListener('pageshow', back);
        window.addEventListener('focus', back);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) back(); });
    }

    /**
     * 轻量确认本地服务器是否还在 (页面可能比服务器活得久: 服务器退出/重启过)。
     * 状态栏与"保存位置"据此自动恢复, 不需要用户手动刷新页面。
     */
    async checkServerAlive() {
        try {
            const resp = await fetch('/api/health', { method: 'GET', cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const wasServer = this.serverMode;
            this.serverMode = !!data.server;
            this._serverCheckError = null;
            if (this.serverMode && data.outputDir) this.applyOutputDir(data.outputDir);
            if (this.serverMode && data.version) this.serverVersion = data.version;
            if (!wasServer && this.serverMode) {
                this._rebuildClient();
                this.renderGallery();
                this.showStatus('🖥️ 已重新连接本地服务器，保存位置与代理已恢复', 'success');
            }
            this.updateConnectionStatus();
            return this.serverMode;
        } catch (e) {
            if (this.serverMode) {
                // 之前是服务器模式, 现在连不上了: 说清楚状态并提示怎么恢复
                this.serverMode = false;
                this._rebuildClient();
                this._serverCheckError = e.message;
                this.showStatus(`⚠️ 与本地服务器的连接已断开 (${e.message})：请确认"启动服务器.bat"窗口仍在运行，然后刷新页面`, 'warning');
            }
            this._serverCheckError = this._serverCheckError || e.message;
            this.updateConnectionStatus();
            return false;
        }
    }

    /**
     * 统一设置保存根目录: 前端所有路径显示/拼接/合并都以此为唯一依据。
     * (settings.basePath / outputPaths / 设置页输入框 / 桌面端持久化 同步更新)
     */
    applyOutputDir(dir) {
        const clean = String(dir || '').trim().replace(/[\\/]+$/, '');
        if (!clean) return;
        this.serverOutputDir = clean;
        this.outputPaths.base = clean;
        this.outputPaths.images = clean + '\\images';
        this.outputPaths.video = clean + '\\video';
        this.settings.basePath = clean;
        const input = document.getElementById('base-path');
        if (input) input.value = clean;
        this.saveSettings();
    }

    _rebuildClient() {
        if (this.settings.apiEndpoint && this.settings.apiKey) {
            this.apiClient = new AgnesAPIClient({ ...this.settings, useProxy: this.serverMode });
            // 让客户端能感知"停止": 退避重试/限流冷却会被立即打断, 在途请求可被中止
            this.apiClient.setStopCheck(() => this.stopRequested);
        } else {
            this.apiClient = null;
        }
    }

    /* ================= 事件绑定 ================= */

    setupEventListeners() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        window.onclick = (event) => {
            const modal = document.getElementById('modal');
            if (event.target === modal) this.closeModal();
        };
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeModal(); });

        ['api-endpoint', 'api-key', 'model-name'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.saveSettings());
        });

        // 断网/重连感知: 挂机时不希望一次网络抖动就把整轮任务丢掉,
        // 也不希望用户不知道"网络断了正在等"。两个事件都在这里统一处理。
        window.addEventListener('online', () => this.onNetworkChange(true));
        window.addEventListener('offline', () => this.onNetworkChange(false));
        // 关页面前把挂机状态落盘 (正常关闭也会走这里; 刷新同理) —— 只落盘, 不停止
        window.addEventListener('beforeunload', () => { this.saveRunState({}); });
    }

    switchTab(tabId) {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === tabId));
        if (tabId === 'workshop') this.renderSeriesUI();
        // 进入"模型设置"时拉一次剧本AI模型列表 (有 5 分钟缓存, 不会每次切页都请求)
        if (tabId === 'models') this.fetchLlmModels({ silent: true });
    }

    /* ================= 批量场景列表 ================= */
    static MAX_REF_IMAGES = 9;

    addBatchItem() {
        this.batchItems.push({ id: Date.now() + Math.random(), title: `场景 ${this.batchItems.length + 1}`, prompt: '', refImages: [] });
        this.renderBatchList();
    }

    removeBatchItem(id) {
        this.batchItems = this.batchItems.filter(i => i.id !== id);
        this.batchItems.forEach((item, i) => { if (/^场景 \d+$/.test(item.title)) item.title = `场景 ${i + 1}`; });
        this.renderBatchList();
    }

    updateBatchField(id, field, value) {
        const item = this.batchItems.find(i => i.id === id);
        if (item) item[field] = value;
    }

    /** 添加参考图：支持多张，最多 MAX_REF_IMAGES 张 */
    addRefImage(id) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/jpg,image/webp';
        input.multiple = true;
        input.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return;
            const item = this.batchItems.find(i => i.id === id);
            if (!item) return;
            let remaining = AgnesVideoGenerator.MAX_REF_IMAGES - item.refImages.length;
            files.slice(0, remaining).forEach(file => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    item.refImages.push(ev.target.result);
                    this.renderBatchList();
                };
                reader.readAsDataURL(file);
            });
        };
        input.click();
    }

    /** 移除第 idx 张参考图 */
    removeRefImage(id, idx) {
        const item = this.batchItems.find(i => i.id === id);
        if (item) {
            item.refImages.splice(idx, 1);
            this.renderBatchList();
        }
    }

    renderBatchList() {
        const container = document.getElementById('batch-list');
        if (!container) return;

        if (this.batchItems.length === 0) {
            container.innerHTML = '<p class="empty-hint">暂无场景。主提示词留空时将逐个使用下方场景提示词。</p>';
            return;
        }

        const maxCount = AgnesVideoGenerator.MAX_REF_IMAGES;
        container.innerHTML = this.batchItems.map((item, index) => {
            const thumbs = item.refImages.map((img, i) =>
                `<img src="${this.escapeAttr(img)}" class="ref-thumb" alt="参考图${i+1}" title="参考图 ${i+1}">
                 <button class="btn btn-small btn-danger ref-remove" onclick="generator.removeRefImage(${item.id}, ${i})" title="移除这张参考图">✕</button>`
            ).join('');
            const addBtn = item.refImages.length < maxCount
                ? `<button class="btn btn-small btn-secondary ref-img-btn" onclick="generator.addRefImage(${item.id})" title="添加参考图片 (最多 ${maxCount} 张)">🖼️ +参考图</button>`
                : `<span class="ref-limit-hint" title="已达上限 (${maxCount} 张)">🖼️ ${maxCount}/${maxCount}</span>`;
            return `
            <div class="batch-item" data-id="${item.id}">
                <span class="batch-index">${index + 1}.</span>
                <input type="text" value="${this.escapeAttr(item.title)}" onchange="generator.updateBatchField(${item.id}, 'title', this.value)" placeholder="场景标题" style="width: 120px;">
                <input type="text" value="${this.escapeAttr(item.prompt)}" onchange="generator.updateBatchField(${item.id}, 'prompt', this.value)" placeholder="输入此场景的提示词..." style="flex: 1;">
                <div class="ref-image-area">
                    <div class="ref-thumbs">${thumbs}</div>
                    ${addBtn}
                </div>
                <button class="btn btn-small btn-danger" onclick="generator.removeBatchItem(${item.id})">删除</button>
            </div>`;
        }).join('');
    }

    /* ================= 生成主流程 ================= */

    async startGeneration() {
        if (this.isGenerating) return this.showStatus('已有任务在生成中，请等待完成或点击停止', 'error');

        const title = document.getElementById('title').value.trim();
        const mainPrompt = document.getElementById('prompt').value.trim();

        if (!title) return this.showStatus('请输入项目标题', 'error');

        const batchCount = parseInt(document.getElementById('batch-count').value) || 1;
        const config = {
            title,
            duration: parseInt(document.getElementById('duration').value) || 5,
            resolution: document.getElementById('resolution').value,
            ratio: document.getElementById('ratio').value,
            batchCount: Math.max(1, Math.min(20, batchCount))
        };

        // 步骤 1: 自动检测主提示词 —— 优先按主提示词生成分镜场景, 为空才用批量场景列表
        this.switchTab('generate');
        this.showProgressPanel(true);
        this.setProgressBar(0, '🔍 正在检测主提示词...');
        const plan = await this.resolveScenePlan(mainPrompt, this.getPromptSceneCount());

        if (plan.scenes.length === 0) {
            this.showProgressPanel(false);
            return this.showStatus('请输入主提示词，或在批量场景列表中添加场景提示词', 'error');
        }
        this.showStatus(plan.message, plan.ok ? 'success' : 'warning');
        this.setProgressBar(0, `🧩 已确定 ${plan.scenes.length} 个分镜 (来源: ${plan.sourceLabel})，准备提交...`);

        if (!this.apiClient) {
            return this.simulateGeneration(config, plan.scenes);
        }
        if (!this.settings.modelName || !this.settings.modelName.trim()) {
            this.showProgressPanel(false);
            return this.showStatus('⚠️ 尚未配置模型 ID，请先到"模型设置"页选择或输入模型', 'error');
        }

        // 展开为 batchCount × scenes 个任务
        const jobs = [];
        for (let b = 0; b < config.batchCount; b++) {
            plan.scenes.forEach((p, idx) => jobs.push({
                prompt: p.prompt,
                refImages: p.refImages || [],
                duration: p.duration,
                label: plan.scenes.length > 1 ? `分镜${idx + 1}` : '',
                seq: b * plan.scenes.length + idx + 1
            }));
        }

        // 批量生成: 生成完成后固定执行"音频识别 + 中文字幕烧录 + 合并成片", 并等待其结束
        // 以便把 后期处理 的实时阶段显示在"生成进度"里
        await this.runGeneration(config, jobs, config.title, { forcePostProcess: true, awaitPostProcess: true });
    }

    /** 主提示词自动拆分分镜数 (1~12) */
    getPromptSceneCount() {
        const el = document.getElementById('prompt-scene-count');
        const n = parseInt(el && el.value);
        return Math.max(1, Math.min(12, Number.isFinite(n) ? n : 4));
    }

    /**
     * 决定本次生成使用哪些场景 (主提示词优先):
     *  主提示词非空 -> 用剧本AI把它扩写成 count 个连续分镜 (未配置/失败时退回按行拆分或整段单分镜);
     *  主提示词为空 -> 使用"批量场景列表"里已填写的场景。
     * 返回 { scenes, source, sourceLabel, ok, message }
     */
    async resolveScenePlan(mainPrompt, count) {
        const batchScenes = this.batchItems
            .filter(b => (b.prompt || '').trim())
            .map((b, i) => ({
                title: (b.title || '').trim() || `场景${i + 1}`,
                prompt: b.prompt.trim(),
                refImages: b.refImages || []
            }));

        // 主提示词为空: 退回到批量场景列表
        if (!mainPrompt) {
            return {
                scenes: batchScenes,
                source: 'batch',
                sourceLabel: '批量场景列表',
                ok: batchScenes.length > 0,
                message: batchScenes.length
                    ? `📊 主提示词为空，改用批量场景列表中的 ${batchScenes.length} 个新场景`
                    : '⚠️ 主提示词与批量场景列表均为空，请输入提示词'
            };
        }

        // 主提示词存在: 优先按它自动生成分镜场景
        if (count > 1 && this.llmClient()) {
            this.setProgressBar(0, `🧩 剧本AI正在按主提示词拆分 ${count} 个分镜场景...`);
            try {
                const scenes = await this.expandPromptToScenes(mainPrompt, count);
                if (scenes.length) {
                    return {
                        scenes,
                        source: 'main-ai',
                        sourceLabel: '主提示词 (AI拆分)',
                        ok: true,
                        message: `🧩 已按主提示词自动生成 ${scenes.length} 个分镜场景：${scenes.map(s => s.title).join(' / ')}`
                    };
                }
                console.warn('剧本AI未返回分镜, 退回整段主提示词');
            } catch (e) {
                console.warn('主提示词拆分失败, 退回整段作为单个分镜:', e);
                return {
                    scenes: [{ title: '主提示词', prompt: mainPrompt, refImages: [] }],
                    source: 'main',
                    sourceLabel: '主提示词 (整段)',
                    ok: true,
                    message: `⚠️ 剧本AI拆分分镜失败 (${e.message})，已改用整段主提示词作为单个分镜`
                };
            }
        }

        // 未配置剧本AI文本模型: 多行时按行拆分, 否则整段作为一个分镜
        const lines = mainPrompt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (count > 1 && lines.length > 1) {
            return {
                scenes: lines.map((l, i) => ({ title: `分镜${i + 1}`, prompt: l, refImages: [] })),
                source: 'main-lines',
                sourceLabel: '主提示词 (按行拆分)',
                ok: true,
                message: `🧩 未配置剧本AI文本模型，已按行拆出 ${lines.length} 个分镜场景`
            };
        }
        return {
            scenes: [{ title: '主提示词', prompt: mainPrompt, refImages: [] }],
            source: 'main',
            sourceLabel: '主提示词',
            ok: true,
            message: '🧩 已按主提示词生成 1 个分镜场景'
        };
    }

    /** 调用剧本AI, 把一段主提示词扩写成 count 个可直接文生视频的连续分镜 */
    async expandPromptToScenes(mainPrompt, count) {
        const ratio = document.getElementById('ratio')?.value || '16:9';
        const duration = parseInt(document.getElementById('duration')?.value) || 5;
        const obj = await this.seriesChat(
`请把下面这段主提示词扩展为恰好 ${count} 个连续分镜，用于AI文生视频批量生成。

主提示词：${mainPrompt}

要求：
1. 每个分镜的 prompt 是可直接用于文生视频的独立完整描述（视频模型看不到其它分镜），必须包含：景别与机位、主体动作与表情、本分镜的情节推进、光影氛围；
2. 画面比例统一为 ${ratio}，并写在每个分镜 prompt 的开头；
3. 各分镜按时间顺序连贯衔接，合起来完整呈现主提示词的意图；
4. 画面全程禁止字幕、对话框、水印、UI文字；
5. 每个 scene 的 duration 必须严格等于 ${duration}（秒），禁止输出其它数值。
只输出JSON：{"scenes":[{"title":"分镜名","prompt":"完整分镜提示词","duration":${duration}}]}`);
        if (!obj || !Array.isArray(obj.scenes)) return [];
        return obj.scenes
            .map((sc, i) => ({
                title: String(sc.title || `分镜${i + 1}`).trim(),
                prompt: String(sc.prompt || '').trim(),
                refImages: [],
                duration: Math.max(1, Math.min(60, parseInt(sc.duration) || duration))
            }))
            .filter(sc => sc.prompt);
    }

    /**
     * 通用批量生成入口: 批量生成页与"短剧工坊一键下一集"共用。
     * jobs: [{prompt, label?, seq, duration?}]
     * opts.forcePostProcess: 无论"自动合并"开关如何, 生成完成后都执行音频识别+字幕烧录
     * opts.awaitPostProcess: 等待后期处理结束 (供批量生成页显示实时阶段进度)
     */
    async runGeneration(config, jobs, episodeTitle = null, opts = {}) {
        if (this.isGenerating) return this.showStatus('已有任务在生成中，请等待完成或点击停止', 'error');
        if (!this.apiClient) return this.showStatus('未配置 API，无法生成', 'error');
        if (!jobs || jobs.length === 0) return;

        this.isGenerating = true;
        this.stopRequested = false;
        document.body.classList.add('generating');
        this.showProgressPanel(true);
        this.setProgressBar(0, `准备提交 ${jobs.length} 个任务...`);
        this.switchTab('generate');

        const startTime = Date.now();

        this.setProgressBar(0, `0/${jobs.length} 完成`);
        // 总进度条只统计本批次任务 (作品库里的"重试"不计入, 否则会出现超过100%)
        this._batchTotal = jobs.length;
        this._batchDone = 0;

        // 提交节流: 按设置的间隔串行错峰提交 (平台限流时自适应加倍)
        const sec = parseFloat(this.settings.submitIntervalSec);
        this.submitStaggerMs = Number.isFinite(sec) ? Math.max(0, sec * 1000) : 2000;
        this._lastSubmitAt = 0;
        this.haltSubmissions = false;

        // 并行监控: 每个任务独立"提交->轮询"，提交动作经 submitGate 串行限速
        const results = await Promise.all(jobs.map((job) =>
            this.processOne(config, job, jobs.length).then(r => {
                this._batchDone++;
                const pct = Math.min(100, Math.round((this._batchDone / jobs.length) * 100));
                this.setProgressBar(pct, `${this._batchDone}/${jobs.length} 个任务已结束`);
                return r;
            })
        ));

        const ok = results.filter(r => r === 'succeeded').length;
        const fail = results.filter(r => r === 'failed').length;
        const unknown = results.filter(r => r === 'unknown').length;
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        this.isGenerating = false;
        document.body.classList.remove('generating');
        const allSucceeded = ok > 0 && fail === 0 && unknown === 0 && !this.stopRequested;
        if (this.stopRequested) {
            this.setProgressBar(100, `⏹️ 已手动停止 (用时 ${elapsed}s)`);
        } else if (ok === jobs.length) {
            this.setProgressBar(100, `✅ 全部 ${jobs.length} 个任务生成成功！用时 ${elapsed} 秒`);
        } else {
            const rl = this.haltSubmissions ? ' | 曾触发限流，未提交任务可在作品库"重试"' : '';
            this.setProgressBar(100, `完成: ${ok} 成功 / ${fail} 失败 / ${unknown} 未知 (用时 ${elapsed}s)${rl}`);
        }
        this.renderGallery();
        this.renderHistory();

        // 挂机时用户不在电脑前, 批次结果要主动提醒 (有失败一定提醒; 全部成功只在页面处于后台时提醒)
        if (!this.stopRequested && fail + unknown > 0) {
            this.notifyAttention({
                title: `本批生成结束：${fail + unknown} 个分镜未成功`,
                message: `成功 ${ok} / 失败 ${fail} / 未知 ${unknown} (用时 ${elapsed}s)。\n`
                    + `未成功的任务可先点"🔍 任务扫描并找回"，再在"未完成任务"面板里重试。`,
                level: 'warning',
                tab: 'generate',
                actions: [
                    { text: '🔍 任务扫描并找回', cls: 'btn-primary', run: () => this.scanTasks() },
                    { text: '📋 查看未完成任务', cls: 'btn-secondary', run: () => { this.switchTab('gallery'); this.renderUnfinishedTasks(true); } },
                ],
            });
        } else if (!this.stopRequested && ok > 0 && document.hidden) {
            this.notifyAttention({
                title: '本批生成全部完成',
                message: `${jobs.length} 个分镜全部生成成功 (用时 ${elapsed}s)。`,
                level: 'success', tab: 'gallery',
            });
        }

        // 生成完成后自动执行后期处理: 音频识别 (VAD+ASR) + 烧录中文字幕 + 合并成片
        // 只有整批全部成功才合并, 否则会把残缺的分镜烧成"完整版"成片
        const mergeTitle = episodeTitle || (config?.title);
        const postWanted = !!opts.forcePostProcess || localStorage.getItem('autoMergeEnabled') === 'true';
        const postEnabled = postWanted && allSucceeded;
        if (mergeTitle && postEnabled) {
            this.setProgressBar(100, `✅ 生成完成 (${ok}/${jobs.length}) — 进入音频识别与中文字幕烧录`);
            const postOpts = { force: true, showProgress: true };
            if (opts.awaitPostProcess) {
                // 等后期处理跑完, 让"生成进度"能一路显示到字幕烧录结束
                await this.autoMergeAfterGeneration(mergeTitle, postOpts);
            } else {
                setTimeout(() => this.autoMergeAfterGeneration(mergeTitle, postOpts), 1000);
            }
        } else if (mergeTitle && postWanted && !allSucceeded) {
            this.showStatus(`⚠️ 有 ${fail + unknown} 个分镜未成功，已跳过音频识别与字幕烧录 (避免生成残缺成片)。可在作品库重试补齐后再执行"📦 手动合并视频"`, 'warning');
        } else if (mergeTitle && ok > 0 && fail === 0 && unknown === 0) {
            this.showStatus('💡 本批视频已全部完成。可在"短剧工坊 → 视频合并设置"开启自动合并，或点击"📦 手动合并视频"生成完整版', 'info');
        }

        // 进度面板在后期处理期间保持可见, 结束后自动收起。
        // 注意也要看"单条重试"这类零散任务: 否则刚点完重试, 面板 6 秒后就连同进度一起收起来了。
        setTimeout(() => {
            if (!this.isGenerating && !this._postRunning && this._activeJobs.size === 0) this.showProgressPanel(false);
        }, 6000);
    }

    /**
     * 把"生成进度"面板显示出来 (保留已有进度行, 不清空)。
     * 面板在「批量生成」页, 而"重试"按钮在作品库/未完成任务面板上 ——
     * 不切过去的话进度就写在用户看不见的地方, 表现就是"点了重试没反应"。
     */
    revealProgressPanel() {
        const panel = document.getElementById('progress-panel');
        if (panel) panel.style.display = 'block';
        const gen = document.getElementById('generate');
        if (gen && !gen.classList.contains('active')) this.switchTab('generate');
        if (panel && panel.scrollIntoView) {
            try { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) { /* 忽略不支持的环境 */ }
        }
    }

    /** 重试/继续监控这类零散任务: 把面板顶部的进度文案也同步成当前在做的事 */
    setProgressHeadline(text) {
        const textEl = document.getElementById('progress-text');
        if (textEl && text) textEl.textContent = text;
    }

    /** 提交节流阀: 保证相邻两次提交间隔不小于 submitStaggerMs (限流后自动加倍) */
    async submitGate() {
        const wait = Math.max(0, (this._lastSubmitAt || 0) + (this.submitStaggerMs || 0) - Date.now());
        this._lastSubmitAt = Math.max(Date.now(), (this._lastSubmitAt || 0) + (this.submitStaggerMs || 0));
        if (wait > 0) await this._sleepAbortable(wait);
    }

    /** 可被"停止"立即打断的等待 (分片检查, 避免点了停止还在空等) */
    async _sleepAbortable(ms) {
        const step = 250;
        for (let waited = 0; waited < ms; waited += step) {
            if (this.stopRequested) throw AgnesAPIClient.cancelledError();
            await this.delay(Math.min(step, ms - waited));
        }
        if (this.stopRequested) throw AgnesAPIClient.cancelledError();
    }

    async processOne(config, job, totalJobs) {
        if (this.stopRequested) return 'skipped';

        const timestamp = Date.now();
        const seq = job.seq;
        const sanitizedTitle = this.sanitizeFilename(config.title);
        const record = {
            id: `vid_${sanitizedTitle}_${seq}_${timestamp}`,
            title: config.title,
            type: 'video',
            filename: `video_${seq}_${timestamp}.mp4`,
            path: null,
            url: null,
            apiTaskId: null,
            platform: this.apiClient.platform,
            date: new Date().toLocaleString('zh-CN'),
            size: '生成中...',
            duration: `${job.duration || config.duration}s`,
            resolution: config.resolution.toUpperCase(),
            status: 'queued',
            progress: 0,
            createdAt: timestamp,
            finishedAt: null,
            error: null,
            rawResponse: null,
            // 保存请求参数，失败后可一键重新提交
            request: {
                prompt: job.prompt,
                refImages: job.refImages || [],
                duration: job.duration || config.duration,
                resolution: config.resolution,
                ratio: config.ratio
            }
        };
        this.history.push(record);
        this.renderGallery();
        this.saveHistory();

        const progressLabel = `#${seq}/${totalJobs}${job.label ? ' ' + job.label : ''}`;
        return this.submitAndMonitor(record, progressLabel);
    }

    /** 内容指纹: 用于识别"相同内容"的任务, 防止重复提交浪费配额 */
    promptHash(s) {
        let h = 5381;
        const str = String(s || '');
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    /** 参考图指纹串 (参与内容比对, 避免同提示词不同首帧被误判相同) */
    _refImgKey(req) {
        return ((req && req.refImages) || []).map(x => (x && (x.url || x)) || '').sort().join(',');
    }

    /** 统一内容指纹: 优先按 request 现算 (含时长/参考图), 兼容无 request 的历史记录 */
    _hashOf(rec) {
        if (rec && rec.request) {
            return this.promptHash((rec.request.prompt || '') + '|' + (rec.request.duration || '') + '|' + this._refImgKey(rec.request));
        }
        return (rec && rec.hash) || '';
    }

    _sameContent(a, b) {
        const ha = this._hashOf(a), hb = this._hashOf(b);
        return !!ha && ha === hb;
    }

    /** 任务进行中守卫: 同一条记录不允许同时存在两个提交/监控流程 */
    async submitAndMonitor(record, progressLabel) {
        this._activeJobs.add(record.id);
        try {
            return await this._submitAndMonitorInner(record, progressLabel);
        } finally {
            this._activeJobs.delete(record.id);
        }
    }

    /** 对一条记录执行 提交 -> 轮询 -> 取回视频 全流程 (新生成与"重试"共用) */
    async _submitAndMonitorInner(record, progressLabel) {
        // 已点"停止": 不要再提交 (批次里排在后面的任务会走到这里)
        if (this.stopRequested) {
            this.showStatus('⏹️ 已停止：新任务不再提交，请等当前批次结束后再重试', 'warning');
            return 'skipped';
        }
        // 前序任务触发限流时，不再提交新任务 (已提交的任务监控不受影响)
        if (this.haltSubmissions) {
            record.status = 'failed';
            record.error = '前序任务触发平台限流，本任务未提交。请稍后在作品库点击"重试"';
            record.finishedAt = Date.now();
            this.saveHistory(); this.renderGallery();
            this.updateProgressItem(record.id, progressLabel, '⏸️ 因限流保护未提交', 'failed');
            
            return 'failed';
        }

        const req = record.request || { prompt: record.title, duration: 5, resolution: '720p', ratio: '16:9' };
        record.hash = this._hashOf(record);

        try {
            await this.submitGate();

            // ===== 相同内容已有完成作品 -> 直接复用其视频, 不再重复提交 (整集重跑不浪费配额) =====
            // 仅限同标题 (同一集/同一项目) 内复用, 跨剧同词不串用; 放在提交闸之后: 等闸期间孪生任务可能刚好完成。
            // 如确需强制重新生成, 先删除对应已完成记录
            const doneTwin = this.history.find(h => h.id !== record.id
                && h.title === record.title
                && this._sameContent(h, record)
                && this.normalizeLegacyStatus(h.status) === 'completed'
                && !h.duplicateOf
                && (h.path || h.url));
            if (doneTwin) {
                let reusable = true;
                if (doneTwin.path && this.serverMode) {
                    // 校验本地文件仍存在 (若已手动删除则照常重新生成)
                    try {
                        const head = await fetch('/api/download/' + doneTwin.path.split('/').map(encodeURIComponent).join('/'), { method: 'HEAD' });
                        reusable = head.ok;
                    } catch (_) { reusable = false; }
                }
                if (reusable) {
                    record.status = 'completed';
                    record.progress = 100;
                    record.duplicateOf = doneTwin.id;
                    record.apiTaskId = record.apiTaskId || doneTwin.apiTaskId || null;
                    record.path = doneTwin.path;
                    record.size = doneTwin.size;
                    record.url = doneTwin.url;
                    record.actualDurationSec = doneTwin.actualDurationSec;
                    record.durationMismatch = doneTwin.durationMismatch;
                    record.finishedAt = Date.now();
                    this.saveHistory();
                    this.renderGallery();
                    this.updateProgressItem(record.id, progressLabel, '♻️ 相同内容已有完成视频，直接复用 (不消耗配额)', 'completed');
                    console.log(`♻️ 任务 ${record.id} 与已完成作品 ${doneTwin.id} 内容相同, 复用已保存视频`);
                    return 'succeeded';
                }
            }

            // ===== 任务检测扫描 (在提交节流之后: 先排队的兄弟任务此时已标记 submitStarted) =====
            // 相同内容已有任务在提交/生成中 -> 共享其平台任务, 不重复提交配额
            const twin = this.history.find(h => h.id !== record.id
                && this._sameContent(h, record)
                && this.isPendingStatus(this.normalizeLegacyStatus(h.status))
                && (h.apiTaskId || h.submitStarted)
                && !h.duplicateOf);
            if (twin) {
                // 等待孪生任务拿到平台任务ID (它可能还在提交队列中)
                for (let i = 0; i < 90 && !twin.apiTaskId && this.isPendingStatus(this.normalizeLegacyStatus(twin.status)); i++) {
                    this.updateProgressItem(record.id, progressLabel, `♻️ 检测到相同内容任务，等待共享其进度 (${i + 1}s)...`, 'waiting');
                    await this.delay(1000);
                }
                if (twin.apiTaskId) {
                    record.apiTaskId = twin.apiTaskId;
                    record.duplicateOf = twin.id;
                    record.status = 'running';
                    this.saveHistory(); this.renderGallery();
                    this.updateProgressItem(record.id, progressLabel, `♻️ 与 ${twin.apiTaskId} 内容相同，共享进度 (省一次提交配额)`, 'running');
                    const r = await this.monitorTask(record, progressLabel);
                    
                    return r;
                }
            }

            // 提交请求走客户端全局串行队列 (限流时自动排队与退避)
            record.submitStarted = true;
            this.updateProgressItem(record.id, progressLabel, '🔗 排队提交...', 'waiting');

            const subOpts = {
                duration: req.duration,
                resolution: req.resolution,
                ratio: req.ratio,
                onRateLimitWait: (ms, n, total) =>
                    this.updateProgressItem(record.id, progressLabel, `⏳ 平台限流，${Math.round(ms / 1000)}s 后自动重试提交 (${n}/${total})`, 'waiting')
            };
            if (req.refImages && req.refImages.length > 0) {
                subOpts.image_urls = req.refImages.map(url => ({ url, role: 'first_frame' }));
            }
            const sub = await this.apiClient.submitTask(req.prompt, subOpts);

            // OpenAI 兼容平台做了时长档位吸附 (如 10s -> 12s): 展示与实际时长校验均以实际下发值为准
            const snapped = sub.durationSent && req.duration && sub.durationSent !== req.duration;
            if (snapped) {
                record.durationRequested = req.duration;
                record.duration = `${sub.durationSent}s`;
            }
            // 固定时长模型 (如 AGNES v2.0): 提交时立即明确告知, 避免用户以为设置生效
            const fixedModel = this.apiClient.isFixedDurationModel && this.apiClient.isFixedDurationModel();
            if (fixedModel) record.fixedDurationNote = true;

            record.apiTaskId = sub.taskId;
            record.status = sub.status === 'succeeded' ? 'running' : sub.status;
            // 平台已接收: 清掉之前留下的旧原因 (限流等待期间的僵尸判定/上一次失败的原因)
            record.error = null;
            record.errorTech = null;
            this.renderGallery();
            this.saveHistory();
            this.updateProgressItem(record.id, progressLabel,
                fixedModel
                    ? `⚠️ 已提交，但当前模型 (v2.0) 固定输出 5 秒/4:3，设定 ${req.duration}s 不生效；如需 8/12 秒竖屏请切换 agnes-video-2.5-flash`
                    : `✅ 已提交 (任务ID: ${sub.taskId}${snapped ? `, 时长档位 ${req.duration}s→${sub.durationSent}s` : ''})`,
                'running');

            if (sub.videoUrl) {
                await this.finalizeRecord(record, sub.videoUrl);
                
                return 'succeeded';
            }

            const finalStatus = await this.monitorTask(record, progressLabel);
            
            return finalStatus;
        } catch (error) {
            // 用户点了"停止": 不算失败, 标记为已停止 (有平台任务 ID 的可用"任务扫描"找回)
            if (error && error.cancelled) return this._markRecordStopped(record, progressLabel);
            console.error(`❌ 任务 ${progressLabel} 提交失败:`, error);
            record.status = 'failed';
            record.error = AgnesAPIClient.isPlatformBusyError(error)
                ? '平台繁忙：已自动退避重试多次仍被拒绝。建议把「模型设置 → 高级参数 → 提交间隔」调大 (如 10~30 秒) 或分小批生成，然后点"重试"'
                : AgnesAPIClient.friendlyError(error);
            record.errorTech = error.message;
            record.finishedAt = Date.now();
            this.saveHistory();
            this.renderGallery();
            this.updateProgressItem(record.id, progressLabel, `❌ 失败: ${record.error}`, 'failed');
            if (AgnesAPIClient.isPlatformBusyError(error)) {
                // 只阻止后续新提交，绝不打断已提交任务的监控
                this.haltSubmissions = true;
                this.submitStaggerMs = Math.min((this.submitStaggerMs || 2000) * 2, 60000);
                this.showStatus('⏳ 平台限流/排队已满：已暂停后续提交并自动加倍提交间隔，已提交任务继续监控中', 'warning');
            }
            
            return 'failed';
        }
    }

    /* ================= 轮询监控 (核心修复) ================= */

    async monitorTask(record, progressLabel = '') {
        this._activeJobs.add(record.id);
        try {
            return await this._monitorTaskInner(record, progressLabel);
        } finally {
            this._activeJobs.delete(record.id);
        }
    }

    async _monitorTaskInner(record, progressLabel = '') {
        const startMs = Date.now();
        let consecutiveErrors = 0;
        let notFoundErrors = 0;
        let lastStatusShown = record.status;

        while (true) {
            if (this.stopRequested) return this._markRecordStopped(record, progressLabel);

            const totalElapsed = Date.now() - startMs;
            if (totalElapsed > POLL_CFG.maxTotalMs) {
                record.status = 'unknown';
                record.error = `等待超过 30 分钟未完成。任务仍在平台上 (ID: ${record.apiTaskId})，页面刷新后可自动重新提交`;
                this.saveHistory(); this.renderGallery();
                this.updateProgressItem(record.id, progressLabel, '⏱️ 等待超时，已转为未知状态', 'failed');
                return 'unknown';
            }

            try {
                const st = await this.apiClient.queryTask(record.apiTaskId);
                consecutiveErrors = 0;
                notFoundErrors = 0;

                record.rawResponse = st.raw;
                if (st.progress !== null && st.progress !== undefined) record.progress = Math.min(100, st.progress);
                if (st.status !== record.status) {
                    record.status = st.status;
                    this.renderGallery();
                }
                this.updateProgressItem(record.id, progressLabel,
                    `${st.status === 'queued' ? '⏳ 排队中' : '⏳ 生成中'} ${this.formatElapsed(totalElapsed)}${st.rawStatus && st.rawStatus !== st.status ? ` (${st.rawStatus})` : ''}`,
                    st.status === 'queued' ? 'waiting' : 'running');

                if (st.status === 'succeeded') {
                    if (st.videoUrl) {
                        record.urlNeedsAuth = !!st.videoUrlNeedsAuth;
                        await this.finalizeRecord(record, st.videoUrl);
                        this.updateProgressItem(record.id, progressLabel, '✅ 生成成功', 'completed');
                        return 'succeeded';
                    }
                    // 平台说成功但没解析到地址 -> 未知，保留原始响应供排查
                    record.status = 'unknown';
                    record.error = '平台报告任务成功，但未能从响应中解析出视频地址 (可在详情中查看原始响应)';
                    this.saveHistory(); this.renderGallery();
                    this.updateProgressItem(record.id, progressLabel, '⚠️ 成功但未取到视频地址', 'failed');
                    return 'unknown';
                }

                if (st.status === 'failed') {
                    record.status = 'failed';
                    record.error = st.error
                        ? AgnesAPIClient.friendlyError({ message: String(st.error), status: 500 })
                        : '平台返回任务失败';
                    record.errorTech = st.error || '';
                    record.finishedAt = Date.now();
                    this.saveHistory(); this.renderGallery();
                    this.updateProgressItem(record.id, progressLabel, `❌ 平台返回失败: ${record.error}`, 'failed');
                    return 'failed';
                }

                await this.delay(st.status === 'queued' ? POLL_CFG.queuedInterval : POLL_CFG.runningInterval);

            } catch (error) {
                // 用户点了"停止"导致请求被中断: 按停止处理, 不计入轮询错误
                if (error && error.cancelled) return this._markRecordStopped(record, progressLabel);
                // 轮询与提交共享平台配额: 查询触发 429/503(排队已满) 时全局退避, 不计入连续错误
                if (AgnesAPIClient.isPlatformBusyError(error)) {
                    this.apiClient._rlUntil = Math.max(this.apiClient._rlUntil || 0, Date.now() + 30000);
                    this.updateProgressItem(record.id, progressLabel, '⏳ 平台繁忙/限流，30s 后重试查询', 'waiting');
                    await this.delay(30000);
                    continue;
                }
                if (error.status === 404) {
                    notFoundErrors++;
                    console.warn(`轮询 404 (${notFoundErrors}/${POLL_CFG.maxNotFoundErrors}): ${record.apiTaskId}`);
                    if (notFoundErrors >= POLL_CFG.maxNotFoundErrors) {
                        record.status = 'unknown';
                        record.error = '查询接口持续 404，任务 ID 可能无效或平台接口已变更';
                        this.saveHistory(); this.renderGallery();
                        this.updateProgressItem(record.id, progressLabel, '❓ 任务查询不到 (404)', 'failed');
                        return 'unknown';
                    }
                } else {
                    consecutiveErrors++;
                    console.warn(`轮询出错 (${consecutiveErrors}/${POLL_CFG.maxConsecutiveErrors}):`, error.message);
                    if (consecutiveErrors >= POLL_CFG.maxConsecutiveErrors) {
                        record.status = 'unknown';
                        record.error = AgnesAPIClient.friendlyError(error);
                        record.errorTech = error.message;
                        this.saveHistory(); this.renderGallery();
                        this.updateProgressItem(record.id, progressLabel, '❓ 接口持续不可用', 'failed');
                        return 'unknown';
                    }
                }
                await this.delay(POLL_CFG.errorInterval);
            }
        }
    }

    /** 生成成功: 保存到本地 output/video (服务器模式), 更新记录 (防重入: 监控/扫描同时判定成功时只保存一次) */
    async finalizeRecord(record, videoUrl) {
        if (this._finalizing.has(record.id)) {
            console.log(`⏭️ 跳过重复保存: ${record.id} 正在保存流程中`);
            return;
        }
        this._finalizing.add(record.id);
        try {
            await this._finalizeRecordInner(record, videoUrl);
        } finally {
            this._finalizing.delete(record.id);
        }
    }

    async _finalizeRecordInner(record, videoUrl) {
        record.url = videoUrl;
        record.status = 'completed';
        record.progress = 100;
        record.finishedAt = Date.now();

        // 共享平台任务的重复记录: 直接复用孪生记录已保存的本地文件, 不重复下载
        if (record.duplicateOf) {
            const twin = this.history.find(h => h.id === record.duplicateOf);
            if (twin && twin.path) {
                record.path = twin.path;
                record.size = twin.size;
                record.actualDurationSec = twin.actualDurationSec;
                record.durationMismatch = twin.durationMismatch;
                this.saveHistory();
                this.renderGallery();
                return;
            }
        }

        if (this.serverMode) {
            this.updateProgressItem(record.id, '', '💾 正在保存到本地...', 'running');
            const failReason = await this._saveVideoLocally(record, videoUrl);
            if (failReason) {
                // 生成成功但没落盘 ("已生成未保存"): 必须把原因说出来。
                // 以前这里只有一句 console.warn, 界面上看不出是链接过期还是网络问题。
                record.saveError = failReason;
                this.updateProgressItem(record.id, '',
                    `⚠️ 已生成但未保存到本地: ${failReason} (可在"未完成任务"点重新下载)`, 'failed');
                this.showStatus(`⚠️ 视频已生成，但保存到本地失败: ${failReason}。可在"未完成任务"面板点"重新下载"`, 'warning');
            } else {
                record.saveError = null;
            }
        } else {
            record.size = '在线视频';
        }

        this.saveHistory();
        this.renderGallery();
        // 这一格落盘后, 这一集很可能刚齐: 顺手检查并出成片。
        // 覆盖"扫描找回 / 未保存重新下载 / 单条重试 / 刷新后自动轮询"这几条没有合并钩子的路径 ——
        // 以前它们只把片段写回作品库, 用户看到"片段齐了却永远没有成片"。
        this._checkEpisodeReadyAfterSave(record);
    }

    /**
     * 记录落盘后检查"这一集是不是齐了" → 齐了就补出成片。
     * 只做检查与提示/合并, 不阻塞调用方 (生成进度不应被 1 分钟的合并卡住)。
     */
    _checkEpisodeReadyAfterSave(record) {
        try {
            if (!record || !record.path || !record.title) return;
            if (!this.serverMode && !window.electronAPI) return;
            if (!this._mergeChecked) this._mergeChecked = new Set();
            const ep = this.episodeByTitle(record.title);
            if (!ep || !ep.scenes.length) return;
            if (this._mergeChecked.has(record.title)) return;   // 本会话已处理过这一集
            if (this._postRunning || this._mergeRunning) return; // 正在合并, 别插队
            const prog = this.episodeSceneProgress(ep);
            if (prog.pending.length || prog.unsaved.length || prog.total === 0) return;
            this.ensureEpisodeMerged(record.title).catch(e => {
                console.warn(`片段齐了但自动合并失败 (${record.title}):`, e.message);
                this.showStatus(`⚠️ ${record.title} 分镜已齐，但合并失败: ${e.message}，可点"📦 手动合并视频"重试`, 'warning');
            });
        } catch (e) {
            console.warn('检查本集是否可合并时出错:', e.message);
        }
    }

    /**
     * 经本地服务器把平台视频下载到本地。
     * 失败自动重试 (共 3 次): 批量生成时多个下载并发/平台 CDN 抖动很常见,
     * 偶发失败不该直接丢给用户手动"重新下载"。
     * @returns {Promise<string|null>} 失败原因 (成功返回 null)
     */
    async _saveVideoLocally(record, videoUrl) {
        const attempts = 3;
        for (let i = 1; i <= attempts; i++) {
            // 下载进度: 服务端按字节上报, 前端轮询显示百分比/速度/续传情况
            const progressKey = `dl_${record.id}_${Date.now()}`;
            const stopPolling = this._pollDownloadProgress(record, progressKey);
            try {
                const resp = await fetch('/api/save-video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Sora 风格 content 端点需要带平台鉴权头, 由服务器代为下载
                    body: JSON.stringify({
                        url: videoUrl, title: record.title, filename: record.filename,
                        progressKey,
                        authHeader: record.urlNeedsAuth ? `Bearer ${this.apiClient.apiKey}` : undefined
                    })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    record.path = data.path;
                    record.size = data.sizeText;
                    console.log(`💾 已保存到本地: ${data.path}${data.segments > 1 ? ` (${data.segments} 段并发)` : ''}`);
                    // 探测实际时长, 与设定不符时在作品库标出 (平台可能忽略时长参数)
                    this._probeActualDuration(record);
                    return null;
                }
                const err = await resp.json().catch(() => ({}));
                const reason = this._saveErrorText(resp.status, err.error);
                // 断网这类错误重试几次结果完全一样, 只会让界面反复显示"正在保存到本地"
                // (看起来像在反复下载)。服务器标了 retryable=false 就直接把原因交给用户。
                if (err.retryable === false) {
                    console.warn(`保存到本地失败 (服务器判定重试无意义, 不再自动重试): ${reason}`);
                    record.size = '在线视频';
                    return reason;
                }
                if (i < attempts) {
                    console.warn(`保存到本地失败 (第 ${i}/${attempts} 次): ${reason} — 2s 后重试`);
                    await this.delay(2000);
                    continue;
                }
                record.size = '在线视频';
                return reason;
            } catch (e) {
                // fetch 抛错说明请求根本没到本地服务器 (服务器退出了/刚重启/端口变了)
                const reason = `本地服务器连接失败 (${e.message})`;
                if (i < attempts) {
                    console.warn(`保存到本地失败 (第 ${i}/${attempts} 次): ${reason} — 2s 后重试`);
                    await this.delay(2000);
                    continue;
                }
                record.size = '在线视频';
                this._serverCheckError = this._serverCheckError || e.message;
                return `${reason}：请确认"启动服务器.bat"窗口仍在运行 (服务器退出后视频无法落盘)，恢复后点"重新下载"`;
            } finally {
                stopPolling();
            }
        }
        return null;
    }

    /**
     * 轮询下载进度并显示在进度行上。
     * 分段下载和断点续传在后台跑, 用户看不到任何动静就以为卡死了 —— 这里给出百分比、速度与"续传"提示。
     * @returns {Function} 停止轮询
     */
    _pollDownloadProgress(record, progressKey) {
        const startedAt = Date.now();
        const timer = setInterval(async () => {
            try {
                const r = await fetch(`/api/save-progress?key=${encodeURIComponent(progressKey)}`, { cache: 'no-store' });
                if (!r.ok) return;
                const p = await r.json();
                if (!p.found) {
                    // 还没开始 (排队等服务端) 或条目已过期
                    if (Date.now() - startedAt > 3000) this.updateProgressItem(record.id, '', `⏳ 等待服务器开始下载 ${this.formatElapsed(Date.now() - startedAt)}`, 'waiting');
                    return;
                }
                const mb = (n) => (n / 1048576).toFixed(1);
                const pct = p.percent === null ? '' : `${p.percent}% `;
                const speed = p.speedMBps ? ` · ${p.speedMBps}MB/s` : '';
                if (p.status === 'downloading') {
                    this.updateProgressItem(record.id, '',
                        `💾 正在保存到本地 ${pct}(${mb(p.bytes)}/${p.total ? mb(p.total) + 'MB' : '?'}${speed})`, 'running');
                } else if (p.status === 'done') {
                    this.updateProgressItem(record.id, '', `💾 已保存到本地 (${mb(p.bytes)}MB${p.total ? `/${mb(p.total)}MB` : ''}, ${this._fmtSecs((Date.now() - startedAt) / 1000)}${speed})`, 'completed');
                } else if (p.status === 'error') {
                    this.updateProgressItem(record.id, '', `⚠️ 下载失败: ${p.error || '未知原因'}${p.bytes ? ` (已下载 ${mb(p.bytes)}MB, 已保留断点)` : ''}`, 'failed');
                }
            } catch (_) { /* 服务器重启等瞬时失败: 忽略, 下一次轮询再说 */ }
        }, 1200);
        return () => clearInterval(timer);
    }

    _fmtSecs(s) {
        s = Math.round(s);
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}分${s % 60}秒`;
    }

    /** 把保存失败的原因翻译成"还能不能救、怎么救" */
    _saveErrorText(status, rawError) {
        const raw = String(rawError || '');
        // 成品文件被占用: 服务器那句已经写清楚了"数据已完整, 只需收尾", 别再套一层
        if (/无法写入成品文件|被占用/.test(raw)) return raw;
        // 断网: 服务器已经确认连不上平台。这类错误重试没用, 说清楚"进度还在, 恢复后能续传"
        if (/网络不通|无法解析|ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENETUNREACH|ENETDOWN|ECONNREFUSED/i.test(raw)) {
            return '本机网络已断开 (连不上平台)。已下载的部分会保留，网络恢复后点"重新下载"会从断点续传';
        }
        // 416: 本地断点与平台文件长度不一致 (服务器会自动丢弃断点重下, 这里给个说明)
        if (/416/.test(raw)) return '本地断点与平台文件不一致 (HTTP 416)，已自动丢弃断点重下，可再点一次"重新下载"';
        if (/下载连接被中断|terminated|socket hang up|premature close/i.test(raw)) {
            return '平台视频下载被中断 (平台 CDN 断流)，可点重新下载再试';
        }
        if (/下载卡住/.test(raw)) return `${raw}，可点重新下载再试`;
        if (/HTTP\s*40[13]|expired|过期/i.test(raw)) return `平台视频链接已失效或需要鉴权 (${raw})，只能重新生成`;
        if (/HTTP\s*404/.test(raw)) return `平台视频链接已失效 (404)，只能重新生成`;
        if (/超时|timeout|abort/i.test(raw)) return '下载超时 (视频较大或平台较慢)，可点重新下载再试';
        if (/ENOSPC|no space/i.test(raw)) return '磁盘空间不足，请清理保存位置所在磁盘';
        if (/EPERM|EACCES|权限/i.test(raw)) return '写入保存目录失败 (权限不足)，请换个保存位置';
        if (status === 502) return `平台视频下载失败 (${raw})，通常是网络抖动，可点重新下载再试`;
        return raw || `本地保存失败 (HTTP ${status})`;
    }

    /**
     * 探测已保存视频的实际时长 (借 <video> 元数据, 桌面/服务器模式通用, 无需 ffmpeg)。
     * 部分免费平台会忽略时长/比例参数按默认档位渲染, 这里把"设定 vs 实际"的差异显性化。
     */
    _probeActualDuration(record) {
        try {
            if (!record.path || !this.serverMode || !record.duration) return;
            const src = '/api/download-file?path=' + this._encodeLibraryPath(record.path);
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            let settled = false;
            const finish = (sec) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                video.removeAttribute('src');
                if (!Number.isFinite(sec) || sec <= 0) return;
                record.actualDurationSec = Math.round(sec * 10) / 10;
                const requested = parseFloat(String(record.duration)) || 0;
                record.durationMismatch = requested > 0 && Math.abs(sec - requested) > Math.max(1.5, requested * 0.25);
                this.saveHistory();
                this.renderGallery();
                if (record.durationMismatch) {
                    console.warn(`⏱️ 视频 ${record.filename} 实际 ${record.actualDurationSec}s, 与设定的 ${record.duration} 不符 (平台可能未按设定时长渲染)`);
                }
            };
            const timer = setTimeout(() => finish(NaN), 15000);
            video.onloadedmetadata = () => finish(video.duration);
            video.onerror = () => finish(NaN);
            video.src = src;
        } catch (_) { /* 探测失败不影响主流程 */ }
    }

    /* ================= 恢复 / 重试 / 停止 ================= */

    resumePendingTasks() {
        const now = Date.now();
        this.history.forEach(item => {
            if (this.isPendingStatus(item.status)) {
                if (item.createdAt && (now - item.createdAt) >= POLL_CFG.maxTotalMs) {
                    item.status = 'unknown';
                    item.error = item.error || '页面关闭期间等待超时，可在"未完成任务"中重试';
                }
            }
        });
        this.saveHistory();

        // 页面刚加载: 不可能有任务正处于"提交中", 因此所有没有平台任务ID的
        // 排队/生成中记录都已是死链, 立即标记为可重试 (否则会永远显示"进行中"且无法恢复)
        this._clearZombieQueuedTasks(0);

        // 恢复有 apiTaskId 的 pending 任务轮询 (任务已在平台上, 只是继续查询, 不额外消耗提交配额)
        const pending = this.history.filter(item => this.isPendingStatus(item.status) && item.apiTaskId);
        if (pending.length > 0) {
            console.log(`🔄 发现 ${pending.length} 个未完成任务，恢复轮询...`);
            pending.forEach((item, index) => {
                setTimeout(() => {
                    if (this.isPendingStatus(item.status)) {
                        this.monitorTask(item, '恢复').catch(e => console.warn('恢复轮询失败:', e));
                    }
                }, index * 1500);
            });
        }

        // 其余未完成任务 (主要是断网时提交丢失、没有平台任务ID的) 不自动重新提交:
        // 重新提交会消耗平台配额, 统一交给"未完成任务"面板, 由用户点"重试"或"全部重试"决定。
        this.renderUnfinishedTasks(true);
    }

    /** 清除"僵尸"任务（仍在排队/生成中, 但没有平台任务ID 的残留记录）
     *  这类记录没有任何可查询的任务ID, 无法恢复轮询, 只能标记为可重试。
     *  @param {number} thresholdMs - 超时阈值; 默认 5 分钟(会话内检测),
     *         页面刚加载时传 0, 因为此时不可能有任务真正在提交中。
     */
    _clearZombieQueuedTasks(thresholdMs = 5 * 60 * 1000) {
        const now = Date.now();
        let cleared = 0;
        this.history.forEach(item => {
            const s = this.normalizeLegacyStatus(item.status);
            // 正在提交/监控中的任务不算僵尸: 平台限流退避最长约 5.5 分钟,
            // 期间它就是"没有任务ID的排队中", 误判会把还在重试的任务标成"已中断"
            if (this._activeJobs && this._activeJobs.has(item.id)) return;
            if (this.isPendingStatus(s) && !item.apiTaskId && item.createdAt) {
                const elapsed = now - item.createdAt;
                if (elapsed >= thresholdMs) {
                    item.status = 'unknown';
                    // 分两种真实情况给不同的下一步建议:
                    //  · 从未提交 (限流等待/批次被停止) -> 平台上没有这个任务, 放心重试
                    //  · 提交过程中中断 -> 平台可能已收到, 先去平台后台确认再重试, 免得白烧配额
                    item.error = item.error || (item.submitStarted
                        ? '提交过程中被中断，平台可能已收到该任务但未取到任务ID；建议先到平台后台确认，再决定是否重试 (重试可能重复消耗配额)'
                        : '尚未提交到平台（排队/限流等待中被中断），平台上没有这个任务，直接点重试即可');
                    cleared++;
                }
            }
        });
        if (cleared > 0) {
            this.saveHistory();
            this.renderGallery();
            console.log(`🧹 清理了 ${cleared} 个无平台任务ID的僵尸任务 (已标记为可重试)`);
        }
    }

    /**
     * 一键重试: 有提交参数的失败任务重新提交生成; 仅有任务 ID 的未知任务恢复轮询
     */
    /**
     * 找出记录对应的分镜 (同一集里所有记录标题都一样, 不带分镜名根本分不清是哪一段)。
     * @returns {{seq:number, total:number, title:string}|null}
     */
    recordSceneInfo(record) {
        try {
            const s = this.series;
            const hash = this._hashOf(record);
            if (!hash) return null;
            const groups = [];
            if (Array.isArray(s.currentScenes) && s.currentScenes.length) groups.push(s.currentScenes);
            (Array.isArray(s.episodes) ? s.episodes : []).forEach(ep => {
                if (Array.isArray(ep.scenes) && ep.scenes.length) groups.push(ep.scenes);
            });
            for (const scenes of groups) {
                for (let i = 0; i < scenes.length; i++) {
                    const sc = scenes[i];
                    const h = this.promptHash(sc.prompt + '|' + (sc.duration || s.sceneDuration) + '|');
                    if (h === hash) return { seq: i + 1, total: scenes.length, title: sc.title || '' };
                }
            }
        } catch (_) { /* 匹配不到就走下面的兜底 */ }
        return null;
    }

    /** 进度行的标签: 批次行与重试行统一成 "#序号/总数 分镜名", 否则同集多条看起来像重复 */
    recordProgressLabel(record, prefix = '') {
        const info = this.recordSceneInfo(record);
        if (info) return `${prefix}#${info.seq}/${info.total}${info.title ? ' ' + info.title : ''}`;
        const prompt = (record && record.request && record.request.prompt) || '';
        const brief = prompt ? prompt.slice(0, 10) + (prompt.length > 10 ? '…' : '') : (record ? record.title : '');
        return `${prefix}${brief}`;
    }

    async retryItem(id) {
        const item = this.history.find(h => h.id === id);
        if (!item) return;
        if (this.isPendingStatus(this.normalizeLegacyStatus(item.status))) return this.showStatus('该任务仍在进行中', 'error');
        if (this._activeJobs.has(id)) return this.showStatus('⏳ 该任务正在监控/重试中，请勿重复点击', 'error');

        // 已完成但本地未保存 (下载失败/换过保存位置): 只重新下载, 不重新生成, 不浪费配额。
        // 放在"未配置 API"判断之前 —— 重新下载走本地服务器, 不需要平台 API。
        if (this.normalizeLegacyStatus(item.status) === 'completed' && item.url && !item.path && this.serverMode) {
            this.showStatus('📥 正在重新下载已生成的视频...', 'info');
            await this.finalizeRecord(item, item.url);
            if (item.path) this.showStatus('✅ 已重新下载并保存到本地', 'success');
            else this.showStatus(`❌ 重新下载失败: ${item.saveError || '网络异常或平台链接已过期'}`, 'error');
            this.renderGallery();
            return;
        }

        if (!this.apiClient) return this.showStatus('未配置 API，无法重试', 'error');
        // 单独重试是一次新的用户动作: 解除上一批次的限流保护与停止标记,
        // 否则点完"停止"后再点重试会被上一次的 stopRequested 立刻取消掉。
        if (!this.isGenerating) { this.haltSubmissions = false; this.stopRequested = false; }

        // 任务检测: 相同内容的任务已在生成中 -> 阻止重复提交 (省配额)
        // 注意: 必须与 record.hash 使用同一套指纹算法 (_hashOf 含时长与参考图),
        // 否则 h.hash === hash 永远不成立, 这道防重复提交的闸门会失效。
        // 也要拦"刚建好、还没走到提交"的批次任务 (submitStarted 还没置位),
        // 否则批次与手动重试会在同一瞬间都通过检查, 同一分镜被提交两次。
        if (item.request) {
            const hash = this._hashOf(item);
            const twin = this.history.find(h => h.id !== id && this.isPendingStatus(this.normalizeLegacyStatus(h.status))
                && h.hash === hash
                && (h.apiTaskId || h.submitStarted || (h.createdAt && Date.now() - h.createdAt < 10 * 60 * 1000)));
            if (twin) {
                return this.showStatus(`♻️ 检测到相同内容的任务正在进行 (${twin.apiTaskId || '排队中'})，已阻止重复提交以免白耗配额`
                    + `；如需强制重来，请先删除作品库里那条记录`, 'warning');
            }
        }

        if (item.request) {
            const label = `🔄 重试 ${this.recordProgressLabel(item)}`;
            // 立刻把面板亮出来并写上这一条: 用户点了重试就该马上看到它, 而不是写进一个藏起来的面板
            this.revealProgressPanel();
            this.updateProgressItem(item.id, label, '🔄 已加入提交队列 (等待提交节流...)', 'waiting');
            this.setProgressHeadline(`🔄 正在重试：${this.recordProgressLabel(item)}`);

            Object.assign(item, {
                status: 'queued', progress: 0, error: null, url: null,
                apiTaskId: null, finishedAt: null, rawResponse: null,
                duplicateOf: null, submitStarted: false,
                date: new Date().toLocaleString('zh-CN')
            });
            this.renderGallery();
            this.saveHistory();
            this.showStatus('🔄 已加入提交队列 (全局串行，限流时自动退避)...', 'success');
            const result = await this.submitAndMonitor(item, label);
            if (result === 'succeeded') this.showStatus('✅ 重试成功，视频已生成', 'success');
            else if (result === 'failed') this.showStatus('❌ 重试失败，详情见作品库', 'error');
        } else if (item.apiTaskId) {
            await this.retryTask(id);
        } else {
            this.showStatus('该记录缺少提交参数和任务 ID，无法重试', 'error');
        }
    }

    /** 扫描进度条: 按钮行下方的实时反馈 (0~100 + 状态文字) */
    setScanProgress(pct, text) {
        const wrap = document.getElementById('scan-progress');
        if (!wrap) return;
        wrap.style.display = 'block';
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        const fill = document.getElementById('scan-progress-fill');
        if (fill) fill.style.width = p + '%';
        const pctEl = document.getElementById('scan-progress-percent');
        if (pctEl) pctEl.textContent = p + '%';
        const txt = document.getElementById('scan-status-text');
        if (txt) txt.textContent = text || '';
    }

    /**
     * 任务检测扫描:
     *  1. 合并进行中任务里的重复内容 (相同提示词+时长只保留一个提交)
     *  2. 逐个查询进行中/未知任务的平台真实状态 —— 已完成的补全取回视频 (含被合并的重复任务), 失败的标记原因
     *  3. 完成作品查重: 内容完全相同的重复渲染标记 ♻️, 供批量清理
     *  全程在按钮下方显示扫描进度条; 没有进行中任务时也可单独执行查重
     */
    async scanTasks() {
        if (this._scanning) return this.showStatus('⚠️ 扫描正在进行中，请稍候', 'warning');

        // 扫描进度条与"未完成任务"面板都在"批量生成"页: 先切过去,
        // 否则用户在短剧工坊页点"任务扫描并找回"会看不到任何反馈。
        this.switchTab('generate');

        // 先找回"未完成任务"列表并展示 (刷新页面/断网重连后依然能从本地记录恢复)
        const unfinished = this.getUnfinishedTasks();
        this.renderUnfinishedTasks(true);

        // 扫描范围: 排队/生成中 + "未知" (页面关闭期间完成、查询中断的任务)
        const pending = [...unfinished.pending, ...unfinished.unknown];
        const completedCount = this.history.filter(h =>
            this.normalizeLegacyStatus(h.status) === 'completed' && !h.duplicateOf).length;
        const canScan = this.apiClient && pending.some(h => h.apiTaskId);
        if (pending.length === 0 && unfinished.failed.length === 0 && unfinished.unsaved.length === 0 && completedCount < 2) {
            return this.showStatus('🔍 扫描完成: 没有需要扫描的任务', 'success');
        }
        if (!canScan && completedCount < 2) {
            // 无平台任务ID可查, 也没有查重需求 -> 直接给出找回列表
            this.showStatus(`🔍 已找回 ${unfinished.all.length} 个未完成任务，可在下方列表中继续重试`
                + (this.apiClient ? '' : ' (未配置 API，无法查询平台状态)'), 'warning');
            return;
        }

        this._scanning = true;
        const scanBtn = document.getElementById('scan-btn');
        if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = '🔍 扫描中...'; }
        this.setScanProgress(2, `正在分析 ${pending.length} 个任务...`);

        try {
            // ---------- 阶段 1: 合并重复内容 ----------
            const keeps = []; // 每组相同内容保留的第一条
            let merged = 0;
            for (const rec of pending) {
                rec.hash = this._hashOf(rec);
                const keep = keeps.find(k => this._sameContent(k, rec));
                if (keep) {
                    if (keep.apiTaskId && !rec.duplicateOf) {
                        rec.duplicateOf = keep.id;
                        if (keep.apiTaskId) rec.apiTaskId = keep.apiTaskId;
                        rec.error = null;
                        merged++;
                        console.log(`🔍 任务扫描: 合并重复任务 ${rec.id} -> ${keep.id}`);
                    }
                } else {
                    keeps.push(rec);
                }
            }
            // const lost 将在阶段 2.5 后计算，考虑自动重提交的情况
            this.saveHistory();

            // ---------- 阶段 2: 逐个查询补全 (按平台任务 ID 去重, 共享任务的记录只查一次) ----------
            // 注意: keeps ⊆ pending (被合并的重复记录也在其中), 只遍历 pending 即可覆盖全部
            const byTask = new Map();
            for (const rec of pending) {
                if (!rec.apiTaskId) continue;
                if (!(this.isPendingStatus(this.normalizeLegacyStatus(rec.status)) || rec.status === 'unknown')) continue;
                if (!byTask.has(rec.apiTaskId)) byTask.set(rec.apiTaskId, []);
                byTask.get(rec.apiTaskId).push(rec);
            }
            const toCheck = [...byTask.keys()];
            this.setScanProgress(10, `已合并重复 ${merged} 个，开始查询 ${toCheck.length} 个任务状态...`);
            if (toCheck.length > 0) await this.delay(400); // 让用户看清阶段结果

            let completed = 0, failed = 0, stillRunning = 0, checked = 0;
            const recoveredTitles = new Set();   // 本次补全取回视频的集, 稍后判断是否需要合并
            if (this.apiClient) {
                for (const taskId of toCheck) {
                    checked++;
                    try {
                        const st = await this.apiClient.queryTask(taskId);
                        const group = byTask.get(taskId);
                        if (st.status === 'succeeded' && st.videoUrl) {
                            for (const rec of group) {
                                rec.urlNeedsAuth = !!st.videoUrlNeedsAuth;
                                await this.finalizeRecord(rec, st.videoUrl);
                                completed++;
                                if (rec.path) recoveredTitles.add(rec.title);
                            }
                        } else if (st.status === 'failed') {
                            for (const rec of group) {
                                rec.status = 'failed';
                                rec.error = st.error
                                    ? AgnesAPIClient.friendlyError({ message: String(st.error), status: 500 })
                                    : '平台返回任务失败';
                                rec.finishedAt = Date.now();
                            }
                            failed++;
                        } else {
                            stillRunning++;
                        }
                    } catch (e) {
                        console.warn(`扫描查询 ${taskId} 失败: ${e.message}`);
                        stillRunning++;
                    }
                    this.setScanProgress(10 + Math.round((checked / Math.max(1, toCheck.length)) * 78),
                        `查询中 ${checked}/${toCheck.length}: 完成 ${completed} · 失败 ${failed} · 进行中 ${stillRunning}`);
                }
            }

            // ---------- 阶段 2.5: 找回无平台任务ID的未完成任务 (断网导致提交响应丢失) ----------
            // 仅统计并展示, 不自动重新提交 —— 重新提交会消耗平台配额, 交由用户决定
            const lost = pending.filter(h =>
                h.status === 'unknown' && !h.apiTaskId && !h.duplicateOf
            ).length;

            // ---------- 阶段 3: 完成作品查重 (同标题下内容完全相同的重复渲染标记 ♻️ 供清理) ----------
            this.history.forEach(h => { delete h.duplicateContentOf; });
            const doneKeeps = [];
            let dupMarked = 0;
            for (const rec of this.history) {
                if (this.normalizeLegacyStatus(rec.status) !== 'completed') continue;
                if (rec.duplicateOf) continue; // 已是共享任务的副本
                if (!rec.path && !rec.url) continue;
                const keep = doneKeeps.find(k => k.title === rec.title && this._sameContent(k, rec));
                if (keep) {
                    rec.duplicateContentOf = keep.id;
                    dupMarked++;
                    console.log(`🔍 完成作品查重: ${rec.id} 与 ${keep.id} 内容相同, 标记为重复`);
                } else {
                    doneKeeps.push(rec);
                }
            }

            // ---------- 阶段 3.5: 重新计算未完成任务 (阶段2 已把部分任务补全/标记失败) ----------
            const remain = this.getUnfinishedTasks();
            this.renderUnfinishedTasks(true);

            this.setScanProgress(100,
                `扫描完成: 合并重复 ${merged} · 补全完成 ${completed} · 平台失败 ${failed} · 仍在进行 ${stillRunning}`
                + (dupMarked ? ` · 标记重复作品 ${dupMarked}` : '')
                + (lost ? ` · 无平台任务ID ${lost}` : '')
                + (remain.all.length ? ` · 待处理 ${remain.all.length}` : ''));
            const summaryEl = document.getElementById('scan-summary');
            if (summaryEl) summaryEl.textContent = (completed > 0 ? `✅ 已补全取回 ${completed} 个视频并保存到本地　` : '')
                + (dupMarked > 0 ? `♻️ 发现 ${dupMarked} 个内容重复的作品，已在卡片上标记，可勾选后"批量删除"清理　` : '')
                + (remain.all.length > 0 ? `♻️ 已在下方"未完成任务"中找回 ${remain.all.length} 个任务，可继续重试生成` : '');

            // ---------- 阶段 4: 汇总结果, 让用户选择后续操作 ----------
            // 可重试 = 失败/未知的任务 (有提交参数可重生成, 或有平台任务ID可查状态)
            const recoverable = remain.all.filter(h => {
                const s = this.normalizeLegacyStatus(h.status);
                return s === 'failed' || s === 'unknown' || s === 'completed';
            });
            const stillPending = remain.pending;

            if (completed > 0 || failed > 0 || stillRunning > 0 || lost > 0 || dupMarked > 0 || remain.all.length > 0) {
                let dialogMsg = `📊 扫描完成\n\n`;
                if (completed > 0) dialogMsg += `✅ 成功补全: ${completed} 个\n`;
                if (failed > 0) dialogMsg += `❌ 平台返回失败: ${failed} 个\n`;
                if (stillRunning > 0) dialogMsg += `⏳ 仍在生成中: ${stillRunning} 个\n`;
                if (lost > 0) dialogMsg += `⚠️ 无平台任务ID (需重新提交): ${lost} 个\n`;
                if (dupMarked > 0) dialogMsg += `♻️ 标记重复作品: ${dupMarked} 个\n`;

                if (recoverable.length > 0) {
                    dialogMsg += `\n未完成任务清单 (${recoverable.length} 个, 已在页面下方列出):\n`;
                    recoverable.slice(0, 12).forEach(h => {
                        const s = this.normalizeLegacyStatus(h.status);
                        const tag = s === 'completed' ? '💾未保存' : (s === 'failed' ? '❌失败' : '❓未知');
                        dialogMsg += `  · [${tag}] ${h.title}${h.apiTaskId ? ` (ID: ${String(h.apiTaskId).slice(-8)})` : ''}\n`;
                    });
                    if (recoverable.length > 12) dialogMsg += `  · ... 还有 ${recoverable.length - 12} 个\n`;
                }

                if (stillPending.length > 0) {
                    dialogMsg += `\n仍在进行 (${stillPending.length} 个):\n`;
                    stillPending.slice(0, 5).forEach(h => {
                        dialogMsg += `  · ${h.title}\n`;
                    });
                    if (stillPending.length > 5) dialogMsg += `  · ... 还有 ${stillPending.length - 5} 个\n`;
                }

                const ok = await this.showConfirm({
                    title: '🔍 任务扫描结果',
                    message: dialogMsg + '\n是否立即重试这些未完成的任务？\n(已在平台生成完成的会直接取回视频，不会重复消耗配额)',
                    okText: '🔄 全部重试',
                    cancelText: '稍后手动处理'
                });

                if (ok && recoverable.length > 0) {
                    // 统一走 retryItem: 未保存的重新下载 / 有任务ID的恢复轮询 / 其余重新提交
                    for (const rec of recoverable) {
                        this.showStatus(`🔄 正在恢复: ${rec.title}`, 'info');
                        this.retryItem(rec.id).catch(e => console.warn('恢复失败:', rec.title, e));
                        await this.delay(200); // 轻微错峰, 提交由 submitGate 串行限速
                    }
                    this.saveHistory();
                    this.renderGallery();
                    this.renderUnfinishedTasks(true);
                    this.showStatus(`✅ 已启动 ${recoverable.length} 个未完成任务的重试`, 'success');
                }
            } else {
                this.showStatus(`✅ 任务扫描完成: 全部 ${completed + merged} 个任务状态正确${completed > 0 ? `，已补全 ${completed} 个` : ''}`, 'success');
            }
        } finally {
            this._scanning = false;
            if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = '🔍 任务扫描 (查状态/去重)'; }
            this.saveHistory();
            this.renderGallery();
            this.renderHistory();
            this.renderUnfinishedTasks(true);
        }

        // 扫描把片段找回来了: 若某集因此补齐, 就接着合并成片 (以前这一步缺失,
        // 表现为"视频都下回来了却没有成片", 必须手动点"手动合并视频")
        if (recoveredTitles && recoveredTitles.size) {
            await this.mergeRecoveredEpisodes([...recoveredTitles]);
        }
    }

    /**
     * 补全取回后按集合并 (只处理"分镜已齐"的集; 未开启自动合并时改成一键提示)。
     * @param {string[]} titles 本次有片段被找回的集名
     */
    async mergeRecoveredEpisodes(titles) {
        let merged = 0, incomplete = 0, prompted = 0, notFound = 0;
        for (const title of titles) {
            try {
                const r = await this.ensureEpisodeMerged(title);
                if (r === 'merged') { merged++; this.renderGallery(); }
                else if (r === 'incomplete') incomplete++;
                else if (r === 'prompted') prompted++;
                else notFound++;
            } catch (e) {
                console.warn(`补全后自动合并失败 (${title}):`, e.message);
                this.showStatus(`⚠️ ${title}：分镜已补齐，但合并失败: ${e.message}，可在"短剧工坊 → 手动合并视频"重试`, 'warning');
            }
        }
        // 还没齐: 明确告诉用户下一步, 避免"找不到成片"
        if (incomplete) {
            this.showStatus(`💡 有 ${incomplete} 集尚未补齐全部分镜，补齐后会自动合并（也可随时点"📦 手动合并视频"）`, 'info');
        } else if (prompted && !merged) {
            this.showStatus('💡 分镜已齐，但「启用自动合并」没勾选，所以没有自动合成。已弹出提示，可一键合并', 'info');
        }
    }

    /**
     * 保证这一集真的有成片 (分镜齐了就必须产出 <集名>_完整版.mp4)。
     * 所有"片段刚补齐"的路径都应该走这里: 扫描找回、挂机续跑、断线重连后的自动重试。
     *
     * 三种结果:
     *   merged    —— 已合成, 且服务端确认生成了成片文件
     *   prompted  —— 未勾选「启用自动合并」: 弹一键提示, 不擅自烧 CPU, 更不谎报成功
     *   skipped   —— 服务端模式不可用/该集不在剧本里
     * 失败会抛错 (调用方决定怎么提示), 绝不 `return` 一个假成功。
     * @returns {Promise<'merged'|'prompted'|'incomplete'|'skipped'|'missing'>}
     */
    async ensureEpisodeMerged(title) {
        if (!title) return 'skipped';
        if (!this.serverMode && !window.electronAPI) return 'skipped';
        if (!this._mergeChecked) this._mergeChecked = new Set();   // 兼容测试里只造了部分实例的情况
        const ep = this.episodeByTitle(title);
        if (!ep || !ep.scenes.length) return 'missing';
        const prog = this.episodeSceneProgress(ep);
        if (prog.pending.length || prog.unsaved.length || prog.total === 0) return 'incomplete';
        // 已经合成过就不重复烧一遍 (同一会话内按集名 + 成片是否已落盘判断)
        if (this._mergeChecked.has(title)) return 'skipped';
        if (localStorage.getItem('autoMergeEnabled') !== 'true') {
            // 不擅自合并, 但也绝不默默什么都不做 —— 给个一键提示
            this._mergeChecked.add(title);
            this.notifyAttention({
                key: `merge-prompt:${title}`,
                title: `${title} 分镜已齐，要现在合成整集吗？`,
                message: `这一集 ${prog.done}/${prog.total} 个片段都已保存到本地，但「启用自动合并」没有勾选，所以没有自动合成。\n\n`
                    + '点下面按钮可立即合成（含音频识别 + 中文字幕烧录，约 1 分钟，不消耗平台配额）。\n'
                    + '也可以到"短剧工坊 → 视频合并设置"勾上「启用自动合并」，以后就自动完成。',
                level: 'warning',
                tab: 'workshop',
                actions: [
                    { text: '🎬 立即合并成片', cls: 'btn-primary', run: () => this.mergeEpisodeNow(title) },
                    { text: '📦 稍后手动合并', cls: 'btn-secondary', run: () => this.switchTab('workshop') },
                ],
            });
            return 'prompted';
        }
        this._mergeChecked.add(title);
        const relPath = await this.autoMergeAfterGeneration(title, { force: true, showProgress: true });
        if (!relPath) throw new Error('合并没有产出成片 (未返回成片路径)');
        this.renderGallery();
        return 'merged';
    }

    /** 提醒里那一键合并: 走同一套合并流程, 结果照样如实反馈 */
    async mergeEpisodeNow(title) {
        this.closeModal();
        this._mergeChecked.add(title);
        try {
            const relPath = await this.autoMergeAfterGeneration(title, { force: true, showProgress: true });
            if (!relPath) throw new Error('合并没有产出成片 (未返回成片路径)');
            this.renderGallery();
        } catch (e) {
            this.showStatus(`❌ ${title} 合并失败: ${e.message}`, 'error');
        }
    }

    /**
     * 按作品标题找回对应的剧集 (含尚未归档的"当前分镜")。
     * 合并需要用它判断"这一集的分镜是否已经齐了"。
     */
    episodeByTitle(title) {
        if (!title) return null;
        const s = this.series;
        for (const ep of (Array.isArray(s.episodes) ? s.episodes : [])) {
            if (this.seriesEpisodeTitle(ep.no) === title) return { no: ep.no, scenes: ep.scenes || [] };
        }
        if (Array.isArray(s.currentScenes) && s.currentScenes.length
            && this.seriesEpisodeTitle(s.nextEpisode) === title) {
            return { no: s.nextEpisode, scenes: s.currentScenes };
        }
        return null;
    }

    /**
     * 某集的分镜补齐后自动合并成片 (兼容旧调用: 内部统一走 ensureEpisodeMerged)。
     * 以前它在"未勾选自动合并"时返回 'disabled', 在合并完却拿不到成片路径时**照样返回 'merged'** ——
     * 后者就是"假成功"的来源之一, 现在只有真的产出成片才算 merged。
     * @returns {Promise<'merged'|'incomplete'|'prompted'|'skipped'|'missing'>}
     */
    async maybeAutoMergeEpisode(title) {
        return this.ensureEpisodeMerged(title);
    }

    /* ================= 未完成任务找回 (刷新页面 / 断网重连后) ================= */

    /**
     * 分类收集"未完成"任务 —— 全部来自本地持久化记录, 因此刷新页面/断网重连后依然存在:
     *  ⏳ 进行中 (排队/生成中) · ❓ 状态未知 (查询中断) · ❌ 失败可重试 · 💾 已生成但未保存到本地
     */
    getUnfinishedTasks() {
        const pending = [], unknown = [], failed = [], unsaved = [];
        this.history.forEach(h => {
            if (!this._isUnfinishedRecord(h)) return;
            const s = this.normalizeLegacyStatus(h.status);
            if (this.isPendingStatus(s)) pending.push(h);
            else if (s === 'unknown') unknown.push(h);
            else if (s === 'failed') failed.push(h);
            else unsaved.push(h); // 已完成但未落盘
        });
        const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
        [pending, unknown, failed, unsaved].forEach(arr => arr.sort(byNewest));
        return { pending, unknown, failed, unsaved, all: [...pending, ...unknown, ...failed, ...unsaved] };
    }

    /** 渲染"未完成任务"面板 (内容未变化时跳过重绘, 避免轮询期间频繁刷新 DOM) */
    renderUnfinishedTasks(force = false) {
        const panel = document.getElementById('unfinished-panel');
        if (!panel) return;
        if (force) this._unfinishedHidden = false;      // 显式调用 (扫描/重试) 时重新展开
        if (this._unfinishedHidden) { panel.style.display = 'none'; return; }
        const g = this.getUnfinishedTasks();
        const sig = g.all.map(h => `${h.id}:${h.status}:${h.path ? 1 : 0}`).join('|');
        if (!force && sig === this._unfinishedSig) return;
        this._unfinishedSig = sig;

        if (g.all.length === 0) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';

        const countEl = document.getElementById('unfinished-count');
        if (countEl) countEl.textContent = `(${g.all.length} 个)`;

        const hint = document.getElementById('unfinished-hint');
        if (hint) {
            const parts = [];
            if (g.pending.length) parts.push(`⏳ 进行中 ${g.pending.length}`);
            if (g.unknown.length) parts.push(`❓ 状态未知 ${g.unknown.length}`);
            if (g.failed.length) parts.push(`❌ 失败可重试 ${g.failed.length}`);
            if (g.unsaved.length) parts.push(`💾 已生成未保存 ${g.unsaved.length}`);
            hint.innerHTML = parts.join(' · ')
                + '<br>这些任务已从本地记录中找回。点击"🔄 全部重试"继续生成，也可逐条重试。'
                + '<br><span style="color: var(--text-muted);">提示: 若视频其实已在平台生成完成，会先查询平台状态并直接取回视频，不会重复消耗配额。</span>';
        }

        const list = document.getElementById('unfinished-list');
        if (!list) return;
        const rows = [];
        const addRows = (arr, badge, color, actionText) => arr.forEach(h => {
            // 未保存的记录没有 error, 用 saveError 把"为什么没存下来"显示出来
            const reasonText = h.error || h.saveError || '';
            const reason = reasonText ? this.escapeHtml(String(reasonText).slice(0, 120)) : '';
            const pending = this.isPendingStatus(this.normalizeLegacyStatus(h.status));
            rows.push(`
                <div style="display: flex; align-items: center; gap: 10px; background: var(--surface-hover); border-radius: 8px; padding: 8px 10px;">
                    <span style="color: ${color}; font-size: 0.8rem; white-space: nowrap;">${badge}</span>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.escapeAttr(h.title)}">${this.escapeHtml(h.title)}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${h.apiTaskId ? 'ID: ' + this.escapeHtml(String(h.apiTaskId).slice(-12)) : '无平台任务ID'} · ${this.escapeHtml(h.date || '')}${reason ? ' · ' + reason : ''}
                        </div>
                    </div>
                    <button class="btn btn-small btn-secondary" onclick="generator.previewItem('${h.id}')" title="查看状态详情 (任务ID/进度/原因/平台原始响应)">🔍 状态详情</button>
                    ${pending
                        ? ''
                        : `<button class="btn btn-small btn-secondary" onclick="generator.retryItem('${h.id}')">${actionText}</button>`}
                </div>`);
        });
        addRows(g.pending, '⏳ 进行中', '#fbbf24', '🔄 重试');
        addRows(g.unknown, '❓ 未知', '#9ca3af', '🔄 重试');
        addRows(g.failed, '❌ 失败', '#ef4444', '🔄 重试');
        addRows(g.unsaved, '💾 未保存', '#3b82f6', '📥 重新下载');
        list.innerHTML = rows.join('');
    }

    hideUnfinishedPanel() {
        this._unfinishedHidden = true;
        const panel = document.getElementById('unfinished-panel');
        if (panel) panel.style.display = 'none';
    }

    /**
     * 一键重试全部未完成任务。
     * 进行中的任务跳过 (避免重复提交); 与批量生成一致, 提交动作由 submitGate 串行限速,
     * 因此这里并发启动而不是逐条等待 (逐条等待会被单个任务最多 30 分钟的轮询阻塞)。
     */
    async retryAllUnfinished() {
        const g = this.getUnfinishedTasks();
        const todo = [...g.unknown, ...g.failed, ...g.unsaved];
        if (todo.length === 0) {
            return this.showStatus(g.pending.length
                ? `⏳ 还有 ${g.pending.length} 个任务正在进行中，无需重试`
                : '✅ 没有需要重试的任务', 'warning');
        }
        if (!this.apiClient) return this.showStatus('未配置 API，无法重试', 'error');

        // 先把"生成进度"面板亮出来: 这些重试的进度都写在那里面
        this.revealProgressPanel();
        this.setProgressHeadline(`🔄 正在重试 ${todo.length} 个未完成任务 (提交自动排队限速)`);
        this.showStatus(`🔄 开始重试 ${todo.length} 个未完成任务 (提交将自动排队限速)...`, 'info');
        for (const item of todo) {
            // 不 await: 让它与批量生成一样并发跑, 由 submitGate 串行控制提交节奏
            this.retryItem(item.id).catch(e => console.warn('重试失败:', item.title, e));
            await this.delay(200);
        }
        this.renderUnfinishedTasks(true);
    }

    /** 面板内"查状态并找回": 复用任务扫描 (查询平台真实状态 + 补全取回已完成视频) */
    async scanUnfinishedTasks() { return this.scanTasks(); }

    /**
     * 一键清理全部"未完成任务"记录。
     * 只删除作品库记录, 不删除任何本地视频文件 —— 目的是让"任务扫描"不再留存它们、
     * 不再被重试, 从而避免继续消耗平台配额和生成已废弃的片段。
     */
    async clearUnfinishedTasks() {
        const g = this.getUnfinishedTasks();
        if (g.all.length === 0) return this.showStatus('当前没有未完成任务', 'success');
        if (this._autoRunning) return this.showStatus('⚠️ 全剧自动生成正在运行，请先停止后再清理', 'error');
        if (this.isGenerating) return this.showStatus('⚠️ 还有生成任务正在进行，请先停止后再清理', 'error');

        const parts = [];
        if (g.pending.length) parts.push(`⏳ 进行中 ${g.pending.length}`);
        if (g.unknown.length) parts.push(`❓ 未知 ${g.unknown.length}`);
        if (g.failed.length) parts.push(`❌ 失败 ${g.failed.length}`);
        if (g.unsaved.length) parts.push(`💾 已生成未保存 ${g.unsaved.length}`);

        const ok = await this.showConfirm({
            title: '🧹 清理未完成任务',
            message: `将删除以下 ${g.all.length} 个未完成任务记录：\n${parts.join(' · ')}\n`
                + `\n清理后"任务扫描"不会再留存它们，也不会再被自动重试，避免继续消耗平台配额。\n`
                + `\n已完成的作品记录保留，本地视频文件不会被删除。\n`
                + `此操作不可恢复，确认清理？`,
            okText: '🧹 确定清理',
            danger: true
        });
        if (!ok) return;

        const ids = new Set(g.all.map(h => h.id));
        this.history = this.history.filter(h => !ids.has(h.id));
        if (this._selectedCardIds) ids.forEach(id => this._selectedCardIds.delete(id));
        this.saveHistory();
        this._unfinishedSig = null;
        this.renderGallery();
        this.renderHistory();
        this.renderUnfinishedTasks(true);
        this.showStatus(`🧹 已清理 ${ids.size} 个未完成任务记录 (本地视频文件未删除)`, 'success');
    }

    async retryTask(id) {
        const item = this.history.find(h => h.id === id);
        if (!item || !item.apiTaskId) return this.showStatus('该记录没有平台任务 ID，无法重试', 'error');
        if (this.isPendingStatus(item.status)) return this.showStatus('该任务仍在监控中', 'error');

        item.status = 'running';
        item.error = null;
        this.renderGallery();
        this.saveHistory();
        // 重新轮询也把进度面板亮出来, 让用户能看着状态变化
        this.revealProgressPanel();
        const label = `🔄 重试轮询 ${this.recordProgressLabel(item)}`;
        this.updateProgressItem(item.id, label, '⏳ 重新开始查询平台状态...', 'running');
        this.setProgressHeadline(`🔄 正在重试轮询：${this.recordProgressLabel(item)}`);
        this.showStatus('🔄 已重新开始轮询该任务...', 'success');
        const final = await this.monitorTask(item, label);
        if (final === 'succeeded') this.showStatus('✅ 任务已完成并取回视频', 'success');
    }

    /**
     * 停止: 立即中断在途请求 + 退避等待, 并把面板里还在跑的行就地标记为已停止。
     * 不这样做的话, "停止"只是设了个标记, 各任务还要把 20~120s 的退避/冷却等完才退出,
     * 用户看到的就是"点了停止还在继续发请求"。
     */
    stopGeneration() {
        const active = this._activeJobs ? this._activeJobs.size : 0;
        if (!this.isGenerating && active === 0) return;
        this.stopRequested = true;
        const aborted = this.apiClient && this.apiClient.abortInFlight ? this.apiClient.abortInFlight() : 0;
        this._markRunningItemsStopped();
        this.showStatus(aborted > 0
            ? `⏹️ 已停止：中断了 ${aborted} 个在途请求，未提交的任务可稍后在作品库"重试"`
            : '⏹️ 已停止：正在结束未完成任务 (自动重试已取消)', 'warning');
    }

    /** 把"生成进度"面板里还在跑的任务就地标记为已停止 (不等各任务自己退出) */
    _markRunningItemsStopped() {
        if (!this._activeJobs || this._activeJobs.size === 0) return;
        this._activeJobs.forEach(id => {
            const rec = this.history.find(h => h.id === id);
            if (rec) this.updateProgressItem(id, rec.title, '⏹️ 已停止 (在途请求已中断)', 'pending');
        });
    }

    /** 清空"生成进度"面板 (只清显示, 不动作品库记录与已保存的视频文件) */
    _clearProgressPanel() {
        const container = document.getElementById('batch-status');
        if (container) container.innerHTML = '';
        this.setProgressBar(0, '准备中...');
        this.showProgressPanel(false);
    }

    /** 停止后把记录标记为"已停止"而不是"失败" (可重试, 不当作平台错误) */
    _markRecordStopped(record, progressLabel) {
        const hadTask = !!record.apiTaskId;
        record.status = hadTask ? 'unknown' : 'failed';
        record.error = hadTask
            ? '⏹️ 已手动停止监控 (任务仍在平台上, 可点"任务扫描"找回)'
            : '⏹️ 已手动停止 (本任务未提交, 可点击"重试")';
        record.finishedAt = Date.now();
        this.saveHistory();
        this.renderGallery();
        this.updateProgressItem(record.id, progressLabel || record.title, '⏹️ 已停止', 'pending');
        return hadTask ? 'unknown' : 'skipped';
    }

    isPendingStatus(status) {
        return ['queued', 'running', 'in_progress', 'processing'].includes(status);
    }

    /* ================= 模拟模式 (未配置 API 时演示) ================= */

    async simulateGeneration(config, prompts) {
        this.isGenerating = true;
        this.stopRequested = false;
        document.body.classList.add('generating');
        this.showProgressPanel(true);
        this.showStatus('📄 本地演示模式: 未配置 API，仅模拟进度 (请在"模型设置"中配置平台)', 'warning');

        const jobs = [];
        for (let b = 0; b < config.batchCount; b++) prompts.forEach((p, i) => jobs.push({ prompt: p.prompt || p, refImages: p.refImages || [], seq: b * prompts.length + i + 1 }));

        await Promise.all(jobs.map(async (job) => {
            const timestamp = Date.now();
            const record = {
                id: `sim_${job.seq}_${timestamp}`,
                title: config.title,
                type: 'video',
                filename: `video_${job.seq}_${timestamp}.mp4`,
                path: null, url: null, apiTaskId: null,
                platform: '模拟',
                date: new Date().toLocaleString('zh-CN'),
                size: '-', duration: `${config.duration}s`,
                resolution: config.resolution.toUpperCase(),
                status: 'running', progress: 0,
                createdAt: timestamp, finishedAt: null, error: null, rawResponse: null
            };
            this.history.push(record);
            this.renderGallery();
            for (let p = 0; p <= 100 && !this.stopRequested; p += 10) {
                record.progress = p;
                this.updateProgressItem(record.id, `#${job.seq}/${jobs.length}`, `⏳ 模拟生成中 ${p}%`, p >= 100 ? 'completed' : 'processing');
                await this.delay(400);
            }
            record.status = 'completed';
            record.finishedAt = Date.now();
            record.error = '演示数据 (未连接真实平台)';
            this.renderGallery();
        }));

        this.saveHistory();
        this.isGenerating = false;
        this.setProgressBar(100, '✅ 演示完成 (未连接真实平台)');
        setTimeout(() => this.showProgressPanel(false), 3000);
    }

    /**
     * 应用内确认对话框 (替代浏览器原生 confirm): 返回 Promise<boolean>
     * 无 DOM 环境 (自动化测试) 时自动回退到 window.confirm
     */
    showConfirm({ title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
        return new Promise(resolve => {
            const modal = document.getElementById('confirm-modal');
            if (!modal) { resolve(window.confirm(message)); return; }
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').innerHTML = String(message).split('\n')
                .map(l => l.trim() ? `<div class="confirm-line">${this.escapeHtml(l)}</div>` : '<div class="confirm-gap"></div>')
                .join('');
            const ok = document.getElementById('confirm-ok-btn');
            const cancel = document.getElementById('confirm-cancel-btn');
            ok.textContent = okText;
            cancel.textContent = cancelText;
            ok.className = danger ? 'btn btn-danger' : 'btn btn-primary';
            document.getElementById('confirm-input-wrap').style.display = 'none'; // 确认模式不带输入框
            modal.style.display = 'block';

            const done = (val) => {
                modal.style.display = 'none';
                ok.onclick = null;
                cancel.onclick = null;
                modal.onclick = null;
                resolve(val);
            };
            ok.onclick = () => done(true);
            cancel.onclick = () => done(false);
            modal.onclick = (e) => { if (e.target === modal) done(false); };
        });
    }

    /* ================= 进度面板 ================= */

    showProgressPanel(show) {
        const panel = document.getElementById('progress-panel');
        if (panel) {
            panel.style.display = show ? 'block' : 'none';
            if (show) {
                document.getElementById('batch-status').innerHTML = '';
                this._batchDone = 0;
                this._hidePostPanel();      // 新一轮生成: 清掉上一轮的后期处理进度
                this._postPercent = null;
                this.setProgressBar(0, '准备中...');
            }
        }
    }

    updateProgressItem(recordId, label, text, state = 'processing') {
        const row = document.getElementById(`prog-${recordId}`);
        if (!row) {
            const container = document.getElementById('batch-status');
            if (!container) return;
            const div = document.createElement('div');
            div.className = 'status-item';
            div.id = `prog-${recordId}`;
            div.innerHTML = `
                <div class="status">
                    <span class="status-dot ${state}" id="prog-dot-${recordId}"></span>
                    <span>${this.escapeHtml(label || '任务')}</span>
                </div>
                <div class="progress-mini">
                    <div class="progress-bar-mini"><div class="progress-fill-mini" id="prog-bar-${recordId}" style="width: 0%"></div></div>
                    <span class="progress-percent" id="prog-text-${recordId}">${this.escapeHtml(text)}</span>
                </div>
            `;
            container.appendChild(div);
        } else {
            const dot = document.getElementById(`prog-dot-${recordId}`);
            // 状态灯: pending 灰 / waiting 黄慢闪(等待提交·限流) / running 绿闪(平台已接收) /
            //         completed 绿常亮 / failed 红
            if (dot) dot.className = `status-dot ${state}`;
            const textEl = document.getElementById(`prog-text-${recordId}`);
            if (textEl) textEl.textContent = text;
        }
        const bar = document.getElementById(`prog-bar-${recordId}`);
        const item = this.history.find(h => h.id === recordId);
        if (bar && item) bar.style.width = (item.progress || 0) + '%';
    }

    /** 打开输出目录 (桌面应用模式: 资源管理器定位; 浏览器模式: 直接打开) */
    openOutputFolder() {
        const dir = (this.serverOutputDir || this.outputPaths.base || '').replace(/[\\/]+$/, '');
        if (window.electronAPI) {
            // reveal 期望正斜杠相对路径, 主进程拼接输出目录后在资源管理器中定位
            return window.electronAPI.reveal('');
        }
        window.open('file:///' + dir.replace(/\\/g, '/'));
    }

    /** 在资源管理器中显示作品文件 (桌面应用模式) */
    revealItem(id) {
        const item = this.history.find(h => h.id === id);
        if (item && item.path && window.electronAPI) window.electronAPI.reveal(item.path);
    }

    /** 更改保存位置 (设置页): 服务器立即生效, 桌面版重启保留 */
    async changeOutputDir() {
        if (!this.serverMode) return this.showStatus('📄 浏览器直连模式不支持更改保存位置，请使用服务器模式或桌面版', 'warning');
        const suggested = this.serverOutputDir || this.outputPaths.base || '';
        const dir = await this.showPrompt({
            title: '📂 更改保存位置',
            message: '生成完成的作品将保存到该目录 (立即生效, 重启保留)。\n建议选择固定盘符下的文件夹；旧文件仍保留在原目录。',
            label: '目录路径 (绝对路径)',
            value: suggested,
            okText: '📂 确认更改'
        });
        if (!dir || dir === suggested) return;
        try {
            const resp = await fetch('/api/set-output-dir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '设置失败');
            this.applyOutputDir(data.outputDir);
            if (window.electronAPI && window.electronAPI.saveOutputDir) window.electronAPI.saveOutputDir(data.outputDir);
            this.renderGallery();
            this.showStatus(`✅ 保存位置已更改: ${data.outputDir}`, 'success');
        } catch (e) {
            this.showStatus('❌ 更改失败: ' + e.message, 'error');
        }
    }

    /** 当前版本功能介绍 (点击底部版本号弹出) */
    showVersionInfo() {
        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        body.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0;">🎬 晨曦短剧梦工坊 v${APP_VERSION}</h3>
                <span class="type-badge">版本功能介绍</span>
            </div>
            <div class="item-info" style="line-height: 1.9;">
                <p><strong>🤖 短剧工坊</strong>：文本AI根据主提示词延伸每集剧情；人物面孔/声音/服装全剧锁定（程序化校验补全）；一键生成下一集；全剧挂机到完结（可暂停/停止）。</p>
                <p><strong>📚 剧本存档</strong>：一键保存整部剧本（含人物锁定卡），导入即可延续人物一致性生成续季；支持导出/导入 JSON 跨设备迁移。</p>
                <p><strong>🔌 多平台接入</strong>：火山方舟 (Seedance) / OpenAI 兼容 / 完全自定义 JSON 三种预设 + 自动识别；模型列表拉取或任意自定义模型 ID；通用本地代理绕过 CORS。</p>
                <p><strong>🛡️ 限流自适应</strong>：提交全局串行排队 + 共享冷却时钟，429 自动退避重试（窗口约 5.5 分钟）；轮询与提交共享配额协调。</p>
                <p><strong>🔍 任务扫描</strong>：合并重复任务、逐个查询平台真实状态、补全取回已完成视频；实时扫描进度条。</p>
                <p><strong>💬 友好提示</strong>：失败原因全部中文化并给出下一步建议；技术细节折叠保留供排查。</p>
                <p><strong>🖥️ 桌面版</strong>：无边框窗口 + 自定义标题栏 + 应用图标；作品保存位置可自定义、一键打开所在文件夹。</p>
                <p><strong>💾 其他</strong>：剧本/设置导出（密钥自动脱敏）、作品库管理、生成历史、离线可用。</p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary" onclick="generator.closeModal()">知道了</button>
            </div>
        `;
        modal.style.display = 'block';
    }

    setProgressBar(percent, text) {
        const pct = Math.max(0, Math.min(100, Number(percent) || 0)); // 进度值钳制在 0~100
        const fill = document.getElementById('progress-fill');
        const textEl = document.getElementById('progress-text');
        if (fill) { fill.style.width = pct + '%'; fill.textContent = pct > 8 ? Math.round(pct) + '%' : ''; }
        if (textEl) textEl.textContent = text || '';
    }


    /* ================= 版本更新 (可选功能: 离线/旧版本不受影响) ================= */

    compareVersions(a, b) {
        const pa = String(a).split('.').map(n => parseInt(n) || 0);
        const pb = String(b).split('.').map(n => parseInt(n) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
        }
        return 0;
    }

    /**
     * 抓取一个更新清单地址 (带 6 秒超时)。
     * 没有超时的话, 一个"连不上但不立刻报错"的源会把检查卡住很久。
     * @returns {Promise<object|null>} 清单对象 (必须含 version), 失败返回 null
     */
    async _fetchManifest(url) {
        const ac = new AbortController();
        const timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* 已结束 */ } }, 6000);
        try {
            const resp = await fetch(url, { cache: 'no-store', signal: ac.signal });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const manifest = await resp.json();
            if (!String(manifest && manifest.version || '').trim()) throw new Error('清单缺少 version 字段');
            return manifest;
        } finally {
            clearTimeout(timer);
        }
    }

    async checkForUpdates(silent = false) {
        // 更新源地址: 可在更新页临时填入; 未配置/不可达时静默跳过, 不影响任何功能
        // 注意: 更新页已渲染时以输入框为准, 且允许"清空输入框"来撤销自定义地址、回退到内置默认清单
        const urlInput = document.getElementById('update-url-input');
        if (urlInput) {
            const typed = urlInput.value.trim();
            if (typed) localStorage.setItem('agnes_update_url', typed);
            else localStorage.removeItem('agnes_update_url');
        }
        // 用户手填的地址优先; 否则按内置候选列表依次尝试 (自建下载站 -> GitHub)
        const custom = (localStorage.getItem('agnes_update_url') || '').trim();
        const candidates = custom ? [custom] : UPDATE_MANIFEST_URLS.slice();
        const result = document.getElementById('update-result');
        if (candidates.length === 0) {
            if (!silent) this.showStatus('⚠️ 未配置更新源地址。可在下方填入更新清单 URL 后检查 (离线时所有功能不受影响)', 'warning');
            return null;
        }
        if (!silent && result) { result.textContent = '🔍 正在检查更新...'; result.className = 'status-message warning'; result.style.display = 'block'; }
        try {
            // 逐个候选尝试: 单个源不可达/超时/清单不合法就换下一个, 全部失败才放弃
            let manifest = null, url = '';
            for (const cand of candidates) {
                try {
                    const r = await this._fetchManifest(cand);
                    if (r) { manifest = r; url = cand; break; }
                } catch (e) { console.warn(`更新源不可用 (${cand}): ${e.message}`); }
            }
            if (!manifest) throw new Error('所有更新源均不可用');
            this._manifestUrlUsed = url;
            const latest = String(manifest.version || '').trim();
            if (!latest) throw new Error('清单缺少 version 字段');
            const info = { version: latest, notes: String(manifest.notes || ''), url: String(manifest.url || ''), date: String(manifest.date || '') };
            this._updateInfo = info;
            const isNew = this.compareVersions(latest, APP_VERSION) > 0;
            const tab = document.getElementById('update-tab');
            if (isNew) {
                if (tab) { tab.style.display = ''; tab.classList.add('update-blink'); }
                localStorage.setItem('agnes_update_info', JSON.stringify(info));
                if (localStorage.getItem('agnes_update_seen') !== latest) {
                    localStorage.setItem('agnes_update_seen', latest);
                    const go = await this.showConfirm({
                        title: '🎉 发现新版本 v' + latest,
                        message: '当前版本: v' + APP_VERSION + '\n最新版本: v' + latest + (info.date ? ' (' + info.date + ')' : '') + '\n\n' + (info.notes || '点击查看更新内容。') + '\n\n点击"查看更新"前往版本更新页。旧版本可继续正常使用。',
                        okText: '查看更新'
                    });
                    if (go) this.showUpdatePage();
                }
            } else if (tab) {
                // 入口常驻显示 (便于随时手动查看版本)，只有检测到新版本时才闪烁提醒
                tab.style.display = '';
                tab.classList.remove('update-blink');
            }
            if (!silent) this.showStatus(isNew
                ? '🎉 发现新版本 v' + latest + ' (当前 v' + APP_VERSION + ')，请到"版本更新"页获取'
                : '✅ 已是最新版本 v' + APP_VERSION, 'success');
            return info;
        } catch (e) {
            if (!silent) this.showStatus('❌ 无法连接更新源 (' + e.message + ')。不影响当前版本使用，可稍后再试或离线使用', 'warning');
            return null;
        }
    }

    showUpdatePage() {
        let info = this._updateInfo;
        if (!info) { try { info = JSON.parse(localStorage.getItem('agnes_update_info') || 'null'); } catch (_) {} }
        this.switchTab('update');
        const body = document.getElementById('update-body');
        if (!body) return;
        const url = localStorage.getItem('agnes_update_url') || this._manifestUrlUsed || UPDATE_MANIFEST_URLS[0];
        let infoHtml = '';
        if (info) {
            infoHtml = '<div class="info-row"><span class="info-label">最新版本:</span><span class="info-value">v' + this.escapeHtml(info.version) + (info.date ? ' (' + this.escapeHtml(info.date) + ')' : '') + '</span></div>'
                + (info.notes ? '<div class="confirm-message" style="margin-top:10px;">' + this.escapeHtml(info.notes) + '</div>' : '')
                // 清单里提供了下载地址就给链接; 没提供就引导去项目主页, 而不是留空让人不知道去哪升级
                + (info.url
                    ? '<div class="info-row"><span class="info-label">下载地址:</span><span class="info-value"><a href="' + this.escapeAttr(info.url) + '" target="_blank" rel="noopener" style="color: var(--primary-color);">前往下载 ↗</a></span></div>'
                    : '<div class="info-row"><span class="info-label">下载地址:</span><span class="info-value" style="color: var(--text-muted);">暂未提供，请前往 <a href="' + PROJECT_HOMEPAGE + '" target="_blank" rel="noopener" style="color: var(--primary-color);">项目主页</a> 获取最新版本</span></div>');
        }
        body.innerHTML =
            '<div class="settings-section">' +
                '<h3>📌 版本信息</h3>' +
                '<div class="info-row"><span class="info-label">当前版本:</span><span class="info-value">v' + APP_VERSION + '</span></div>' +
                infoHtml +
            '</div>' +
            '<div class="settings-section">' +
                '<h3>🔍 检查更新</h3>' +
                '<div class="form-group">' +
                    '<label for="update-url-input">更新清单地址 (latest.json 格式: version/notes/url)</label>' +
                    '<input type="text" id="update-url-input" value="' + this.escapeAttr(url) + '" placeholder="https://你的域名/latest.json">' +
                    '<small>默认优先使用自建下载站的 latest.json (另一个内置备用源为项目仓库)；填入自定义地址后只用你填的这一个。留空或不可达时不影响任何功能使用</small>' +
                '</div>' +
                '<div class="form-actions" style="border: none; padding-top: 10px;">' +
                    '<button class="btn btn-primary" onclick="checkForUpdates()">🔍 检查更新</button>' +
                '</div>' +
                '<div id="update-result" class="status-message"></div>' +
            '</div>' +
            '<div class="settings-section">' +
                '<h3>ℹ️ 关于升级</h3>' +
                '<p style="color: var(--text-muted); font-size: 0.9rem; line-height: 1.8;">' +
                '· 检查更新为可选功能，检查失败或离线时<b>不影响旧版本任何功能</b>。<br>' +
                '· 新版本发布后，顶部"🔄 版本更新"入口会闪烁提醒并弹窗一次；下载新执行文件替换旧文件即完成升级，<b>作品、剧本存档与设置全部保留</b>。<br>' +
                '· 最新版本可在 <a href="' + PROJECT_HOMEPAGE + '" target="_blank" rel="noopener" style="color: var(--primary-color);">项目主页</a> 获取。<br>' +
                '· 版权所有 © 2026  晨曦微光工作室</p>' +
            '</div>';
    }

    formatElapsed(ms) {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
    }

    delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    /**
     * 把作品库相对路径编码成 URL 安全的 base64 (服务器端用 base64-url 解码)。
     * 不能直接把 btoa 的结果拼进查询串: 标准 base64 里的 "+" 会被服务端当成空格、
     * "/" 会被当成路径分隔符, 导致本地视频预览/下载 404 (表现为"视频无法播放")。
     */
    _encodeLibraryPath(p) {
        return encodeURIComponent(
            btoa(unescape(encodeURIComponent(String(p || ''))))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '')
        );
    }

    /* ================= 作品库 ================= */

    renderGallery() {
        // 节流: 轮询期间频繁调用
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            this._doRenderGallery();
        }, 200);
    }

    _doRenderGallery() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        // 勾选状态只对"仍在作品库里的记录"有意义。清空历史/单条删除/清除剧本都会移除记录,
        // 残留的 id 会让"批量删除 (N)"显示的数字与卡片对不上 (卡片已消失、计数还在)。
        this._pruneSelection();
        const search = (document.getElementById('search-input')?.value || '').toLowerCase();
        const items = this.history
            .slice().reverse()
            .filter(item => this.galleryFilter === 'all' || this.matchFilter(item.status, this.galleryFilter))
            .filter(item => !search || (item.title || '').toLowerCase().includes(search));

        // 保存位置提示: 无论作品库是否为空都要显示 (与模型设置中的自定义路径保持一致)
        const loc = document.getElementById('save-location');
        if (loc) {
            const dir = this.serverOutputDir || this.outputPaths.base || '';
            if (dir) {
                loc.innerHTML = '💾 保存位置: <span style="color: var(--text-color);" title="' + this.escapeAttr(dir) + '">' + this.escapeHtml(dir) + '</span>'
                    + ' <span style="color: var(--text-muted);">(作品在 ' + this.escapeHtml(this.outputPaths.video || 'video') + ' 子目录下)</span>'
                    + (this.serverMode && window.electronAPI ? ' <button class="btn btn-small btn-secondary" onclick="generator.openOutputFolder()">📂 打开文件夹</button>' : '');
            } else {
                loc.innerHTML = '💾 保存位置: <span style="color: var(--warning-color);">未获取到 (请以服务器/桌面模式启动, 或在"模型设置"中设置保存位置)</span>';
            }
        }

        if (items.length === 0) {
            grid.innerHTML = `<p class="empty-hint" style="grid-column: 1/-1; padding: 40px;">${this.history.length === 0 ? '暂无作品，开始生成你的第一个视频吧！' : '没有符合筛选条件的作品'}</p>`;
            // 空列表没有卡片可恢复, 但计数/全选框仍要同步 (否则像上一步的旧数字会留在按钮上)
            this._restoreSelectionState();
            return;
        }

        grid.innerHTML = items.map(item => this.renderCard(item)).join('');
        // 重新渲染后恢复选中状态
        this._restoreSelectionState();
        // 同步"未完成任务"面板 (刷新/断网找回的列表)
        this.renderUnfinishedTasks();
    }

    /** 丢弃已不在 this.history 中的勾选 id (按"记录是否还存在"判定, 与筛选/搜索无关) */
    _pruneSelection() {
        if (!this._selectedCardIds || this._selectedCardIds.size === 0) return;
        const alive = new Set(this.history.map(h => h.id));
        this._selectedCardIds.forEach(id => { if (!alive.has(id)) this._selectedCardIds.delete(id); });
    }

    _restoreSelectionState() {
        if (this._selectedCardIds && this._selectedCardIds.size > 0) {
            document.querySelectorAll('.media-card').forEach(card => {
                const id = card.dataset.id;
                const isSelected = this._selectedCardIds.has(id);
                card.classList.toggle('selected', isSelected);
                const cb = card.querySelector('.card-checkbox input[type="checkbox"]');
                if (cb) cb.checked = isSelected;
            });
        }
        // 无条件同步: 选中数归零时同样要把按钮计数/全选框刷回未选中
        this.updateSelectionUI();
    }

    matchFilter(status, filter) {
        const s = this.normalizeLegacyStatus(status);
        if (filter === 'pending') return this.isPendingStatus(s);
        return s === filter;
    }

    normalizeLegacyStatus(status) {
        return { in_progress: 'running', processing: 'running' }[status] || status || 'completed';
    }

    renderCard(item) {
        const status = this.normalizeLegacyStatus(item.status);
        const isPending = this.isPendingStatus(status);
        const isFailed = status === 'failed';
        const isUnknown = status === 'unknown';
        const isDone = status === 'completed';
        const hasLocal = !!item.path && this.serverMode;
        // 完成但本地未保存成功: 仅服务器模式下才有"重新下载"的意义 (需平台在线地址)
        const completedNoLocal = isDone && this.serverMode && !hasLocal && !!item.url;

        let badge, badgeColor;
        if (isPending) { badge = status === 'queued' ? '⏳ 排队中' : '⏳ 生成中'; badgeColor = '#fbbf24'; }
        else if (isFailed) { badge = '❌ 失败'; badgeColor = '#ef4444'; }
        else if (isUnknown) { badge = '❓ 未知'; badgeColor = '#9ca3af'; }
        else { badge = '✅ 完成'; badgeColor = '#10b981'; }

        const progressHtml = isPending ? `
            <div style="margin-top: 8px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">
                    <span>已等待 <span class="card-countdown" data-created="${item.createdAt || Date.now()}">00:00</span></span>
                    <span>${Math.round(item.progress || 0)}%</span>
                </div>
                <div class="progress-bar-mini" style="height: 6px; background: var(--surface-hover); border-radius: 3px; overflow: hidden;">
                    <div class="progress-fill-mini card-progress" style="width: ${item.progress || 0}%; height: 100%; transition: width 1s;"></div>
                </div>
            </div>` : '';

        const errorHtml = (isFailed || isUnknown) && item.error
            ? `<div class="card-error" title="${this.escapeAttr(item.error)}">⚠️ ${this.escapeHtml(item.error).slice(0, 80)}</div>` : '';

        return `
        <div class="media-card" data-type="${item.type}" data-title="${this.escapeAttr(item.title)}" data-id="${item.id}" data-status="${status}">
            <div class="card-checkbox">
                <input type="checkbox" onchange="generator.toggleCardSelection('${item.id}')" />
            </div>
            <div class="thumbnail card-thumb-${item.type === 'video' ? 'video' : 'image'}">
                ${item.type === 'video' ? '🎬' : '🖼️'}
                <div class="status-badge" style="color: ${badgeColor};">${badge}</div>
            </div>
            <div class="info">
                <div class="title">${this.escapeHtml(item.title)}</div>
                <div class="meta">
                    <span>${item.type === 'video' ? '🎬 视频' : '🖼️ 图片'}</span>
                    <span>${isPending ? (status === 'queued' ? '排队中' : '生成中') : item.date}</span>
                </div>
                <div class="meta" style="margin-top: 4px;">
                    <span>📐 ${item.resolution || '720P'}</span>
                    <span>${item.durationMismatch
                        ? `<span style="color: #f59e0b;" title="平台未按设定时长渲染">⏱️ 设定 ${this.escapeHtml(item.duration || '-')} · 实际 ${item.actualDurationSec}s ⚠️</span>`
                        : `⏱️ ${this.escapeHtml(item.duration || '-')}`}</span>
                    <span>💾 ${isPending ? '...' : (item.size || '-')}</span>
                </div>
                ${item.duplicateContentOf ? `<div style="margin-top: 4px; font-size: 0.75rem; color: #f59e0b;" title="与另一条已完成作品内容完全相同 (任务扫描标记)，可勾选后批量删除多余记录">♻️ 内容重复 (可清理)</div>` : ''}
                ${item.fixedDurationNote ? `<div style="margin-top: 4px; font-size: 0.75rem; color: #f59e0b;" title="当前模型固定输出时长，忽略设定值">ℹ️ 当前模型固定输出时长，可在模型设置中切换为支持自定义时长的模型</div>` : ''}
                ${progressHtml}
                ${errorHtml}
                <div class="actions">
                    <button class="btn btn-small btn-secondary" onclick="generator.previewItem('${item.id}')">预览</button>
                    ${(isFailed || isUnknown) && (item.request || item.apiTaskId) ? `<button class="btn btn-small btn-secondary" onclick="generator.retryItem('${item.id}')">🔄 ${item.request ? '重试生成' : '重试轮询'}</button>` : ''}
                    ${completedNoLocal ? `<button class="btn btn-small btn-secondary" onclick="generator.retryItem('${item.id}')" title="平台已返回视频但本地下载失败，点击重新下载">📥 重新下载</button>` : ''}
                    <button class="btn btn-small btn-secondary" onclick="generator.downloadItem('${item.id}')" ${isDone ? '' : 'disabled'}>下载</button>
                    <button class="btn btn-small btn-danger" onclick="generator.deleteItem('${item.id}')">删除</button>
                </div>
            </div>
        </div>`;
    }

    filterGallery() { this.renderGallery(); }

    setGalleryFilter(filter) {
        this.galleryFilter = filter;
        document.querySelectorAll('.filter-chips .chip').forEach(ch => ch.classList.toggle('active', ch.dataset.filter === filter));
        this.renderGallery();
    }

    setView(view) {
        const grid = document.getElementById('gallery-grid');
        if (grid) grid.classList.toggle('list-view', view === 'list');
        document.querySelectorAll('.view-toggle .btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    }

    /* 作品库实时倒计时 + 进度刷新 */
    startGalleryTicker() {
        let _zombieCheckCount = 0;
        setInterval(() => {
            document.querySelectorAll('.media-card[data-status="queued"], .media-card[data-status="running"]').forEach(card => {
                const item = this.history.find(h => h.id === card.dataset.id);
                if (!item) return;
                const cd = card.querySelector('.card-countdown');
                if (cd) cd.textContent = this.formatElapsed(Date.now() - (item.createdAt || Date.now())).replace('分', ':').replace(/秒$/, '');
                const bar = card.querySelector('.card-progress');
                if (bar) bar.style.width = (item.progress || 0) + '%';
            });
            // 每 30 秒检查一次僵尸排队任务 (有 request 但超过 5 分钟仍无 apiTaskId)
            _zombieCheckCount++;
            if (_zombieCheckCount % 30 === 0) {
                this._clearZombieQueuedTasks(5 * 60 * 1000);
                // 顺带确认本地服务器还在 (服务器重启/退出后自动恢复, 不用手动刷新页面)
                this.checkServerAlive();
            }
        }, 1000);
    }

    /* ================= 预览 / 下载 / 删除 ================= */

    previewItem(id) {
        const item = this.history.find(h => h.id === id);
        if (!item) return;

        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        const status = this.normalizeLegacyStatus(item.status);
        const isPending = this.isPendingStatus(status);
        const isDone = status === 'completed';
        // 播放源优先级: 本地已下载文件 (无需鉴权) > 平台在线地址
        const localSrc = (item.path && this.serverMode)
            ? '/api/download-file?path=' + this._encodeLibraryPath(item.path)
            : '';
        const playableSrc = localSrc || item.url || '';
        // 已完成但本地未保存成功 (仅服务器模式可重新下载)
        const completedNoLocal = isDone && this.serverMode && !item.path && !!item.url;

        let mediaContent;
        if (isPending) {
            mediaContent = `
                <div class="video-container"><div class="video-placeholder">
                    <div style="font-size: 4rem; margin-bottom: 10px;">⏳</div>
                    <p style="color: var(--warning-color); font-weight: bold;">视频正在${status === 'queued' ? '排队' : '生成'}中...</p>
                    <p id="modal-countdown" style="color: var(--primary-color); font-size: 1.5rem; margin: 10px 0;">00:00</p>
                    <p style="color: var(--text-muted); font-size: 0.85rem;">平台: ${item.platform || '未知'} | 任务ID: ${item.apiTaskId || '-'}</p>
                </div></div>`;
        } else if (playableSrc) {
            mediaContent = `
                <div class="video-container">
                    <video id="preview-video" controls preload="metadata" playsinline style="width:100%; border-radius:8px; background:#000;" src="${this.escapeAttr(playableSrc)}"></video>
                    <p id="preview-video-error" style="display:none; color: var(--warning-color); font-size: 0.85rem; margin-top: 6px;">
                        ⚠️ 视频无法播放: 本地文件可能已被移动或删除，可点击下方"重新下载"重新取回。
                    </p>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 6px;">
                    ${localSrc ? '✅ 正在播放本地已保存文件' : '🌐 正在播放在线地址 (本地未保存，建议点击"重新下载"保存)'}
                </div>`;
        } else {
            mediaContent = `
                <div class="video-container"><div class="video-placeholder">
                    <div style="font-size: 4rem;">🎬</div>
                    <p style="color: var(--warning-color);">${this.escapeHtml(item.error || '无视频地址，暂无法预览')}</p>
                    ${!this.serverMode && item.path ? '<p style="color: var(--text-muted); font-size: 0.85rem;">检测到本地文件记录，但当前是浏览器直连模式；请以服务器/桌面模式打开以预览本地视频。</p>' : ''}
                </div></div>`;
        }

        const rawJson = item.rawResponse ? `<details class="raw-json"><summary>🔍 平台原始响应</summary><pre>${this.escapeHtml(JSON.stringify(item.rawResponse, null, 2))}</pre></details>` : '';

        body.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0;">${this.escapeHtml(item.title)}</h3>
                <span class="type-badge">${item.platform || '视频'}</span>
            </div>
            ${mediaContent}
            ${item.error ? `<div class="card-error" style="margin: 10px 0;">${isPending ? 'ℹ️ ' : '⚠️ '}${this.escapeHtml(item.error)}</div>` : ''}
            ${item.saveError ? `<div class="card-error" style="margin: 10px 0;">💾 本地保存失败：${this.escapeHtml(item.saveError)}</div>` : ''}
            ${item.errorTech ? `<details class="raw-json"><summary>🔧 技术详情 (供排查)</summary><pre>${this.escapeHtml(item.errorTech)}</pre></details>` : ''}
            <div class="item-info">
                <div class="info-row"><span class="info-label">📅 提交时间:</span><span class="info-value">${item.date}</span></div>
                <div class="info-row"><span class="info-label">🆔 任务 ID:</span><span class="info-value">${item.apiTaskId || '-'}</span></div>
                <div class="info-row"><span class="info-label">📐 分辨率:</span><span class="info-value">${item.resolution || '-'}</span></div>
                <div class="info-row"><span class="info-label">⏱️ 时长:</span><span class="info-value">${this.escapeHtml(item.duration || '-')}${item.durationRequested && item.duration !== `${item.durationRequested}s` ? ` <span style="color: var(--text-muted);">(设定 ${item.durationRequested}s，平台档位映射)</span>` : ''}${item.durationMismatch ? ` <span style="color:#f59e0b;">⚠️ 实际 ${item.actualDurationSec}s, 平台未按设定时长渲染</span>` : ''}</span></div>
                <div class="info-row"><span class="info-label">💾 大小:</span><span class="info-value">${isPending ? '生成中' : (item.size || '-')}</span></div>
                ${isPending ? `<div class="info-row"><span class="info-label">📈 进度:</span><span class="info-value">${item.progress || 0}%${item.submitStarted ? ' · 已开始提交' : ' · 尚未提交到平台'}</span></div>` : ''}
                ${item.path ? `<div class="info-row"><span class="info-label">📁 本地路径:</span><span class="info-value" title="${this.escapeAttr((this.serverOutputDir || '') + '/' + item.path)}">${this.escapeHtml((this.serverOutputDir ? this.serverOutputDir.replace(/[\\/]+$/, '') + '\\' : '') + item.path.replace(/\//g, '\\'))}</span></div>
                ${window.electronAPI ? `<button class="btn btn-small btn-secondary" style="margin-top: 8px;" onclick="generator.revealItem('${item.id}')">📂 在文件夹中显示</button>` : ''}` : ''}
            </div>
            ${rawJson}
            <div class="modal-actions">
                ${isPending
                    ? (item.apiTaskId
                        ? `<button class="btn btn-primary" onclick="generator.resumeMonitor('${item.id}')" title="任务已在平台上，重新开始查询它的进度">🔄 继续监控</button>`
                        : '<button class="btn btn-secondary" disabled>⏳ 等待中</button>')
                    : ''}
                ${!isPending && (item.request || item.apiTaskId) && status !== 'completed' ? `<button class="btn btn-primary" onclick="generator.retryItem('${item.id}')">🔄 ${item.request ? '重试生成' : '重试轮询'}</button>` : ''}
                ${completedNoLocal ? `<button class="btn btn-primary" onclick="generator.retryItem('${item.id}')" title="平台已返回视频但本地下载失败，点击重新下载">📥 重新下载</button>` : ''}
                <button class="btn btn-primary" onclick="generator.downloadItem('${item.id}')" ${status === 'completed' ? '' : 'disabled'}>⬇️ 下载</button>
                <button class="btn btn-danger" onclick="generator.deleteItem('${item.id}', true)">🗑️ 删除</button>
                <button class="btn btn-secondary" onclick="generator.closeModal()">关闭</button>
            </div>
        `;
        modal.style.display = 'block';

        // 本地文件可能已被移动/删除 -> 播放失败时给出可操作的提示
        const videoEl = document.getElementById('preview-video');
        if (videoEl) {
            videoEl.addEventListener('error', () => {
                const tip = document.getElementById('preview-video-error');
                if (tip) tip.style.display = 'block';
            });
        }

        if (isPending) {
            this.stopModalCountdown();
            const el = document.getElementById('modal-countdown');
            const startTime = item.createdAt || Date.now();
            this.modalCountdownTimer = setInterval(() => {
                if (el) el.textContent = this.formatElapsed(Date.now() - startTime);
            }, 1000);
        } else {
            this.stopModalCountdown();
        }
    }

    /**
     * 重新开始监控一个"排队/生成中"的记录 (轮询意外中断、页面重开后想接着看进度时用)。
     * 只查询, 不重新提交, 不额外消耗配额。
     */
    async resumeMonitor(id) {
        const item = this.history.find(h => h.id === id);
        if (!item) return;
        if (this._activeJobs && this._activeJobs.has(id)) return this.showStatus('⏳ 该任务正在监控中，无需重复开启', 'warning');
        if (!item.apiTaskId) return this.showStatus('该任务没有平台任务ID，无法查询状态；请用"重试"重新提交', 'error');
        if (!this.apiClient) return this.showStatus('未配置 API，无法查询平台状态', 'error');
        this.closeModal();
        const label = `🔄 继续监控 ${this.recordProgressLabel(item)}`;
        this.revealProgressPanel();
        this.updateProgressItem(item.id, label, '⏳ 正在查询平台状态...', 'running');
        this.setProgressHeadline(`🔄 正在继续监控：${this.recordProgressLabel(item)}`);
        this.showStatus(`🔄 已重新开始监控: ${item.title}`, 'info');
        this.monitorTask(item, label).catch(e => console.warn('继续监控失败:', e));
    }

    stopModalCountdown() {
        if (this.modalCountdownTimer) { clearInterval(this.modalCountdownTimer); this.modalCountdownTimer = null; }
    }

    closeModal() {
        this.stopModalCountdown();
        const modal = document.getElementById('modal');
        if (modal) modal.style.display = 'none';
        // 用 × 关掉提醒弹窗时, 同样要收掉标题前缀与小圆点
        if (this._attention) this._dismissAttention();
    }

    async downloadItem(id) {
        const item = this.history.find(h => h.id === id);
        if (!item) return;
        if (this.isPendingStatus(this.normalizeLegacyStatus(item.status))) return;

        try {
            // 优先从本地 output 目录下载 (服务器模式)
            if (item.path && this.serverMode) {
                const [type, title, filename] = this.splitLocalPath(item.path);
                window.open(`/api/download/${type}/${encodeURIComponent(title)}/${encodeURIComponent(filename)}`, '_blank');
                return;
            }
            if (item.url) {
                this.showStatus('📥 正在下载视频...', 'success');
                await this.apiClient.downloadVideo(item.url, item.filename, !!item.urlNeedsAuth);
                this.showStatus('✅ 下载成功！', 'success');
                return;
            }
            alert('该记录没有可下载的视频');
        } catch (error) {
            this.showStatus('❌ 下载失败: ' + error.message, 'error');
        }
    }

    splitLocalPath(p) {
        const parts = p.split('/');
        return [parts[0], parts[1], parts.slice(2).join('/')];
    }

    async deleteItem(id, fromModal = false) {
        if (!await this.showConfirm({
            title: '🗑️ 删除作品记录',
            message: '确定要删除这个作品记录吗？(不会删除已保存的本地文件)',
            okText: '删除',
            danger: true
        })) return;
        this.history = this.history.filter(h => h.id !== id);
        this.saveHistory();
        this.renderGallery();
        this.renderHistory();
        if (fromModal) this.closeModal();
    }

    // 批量删除功能
    toggleCardSelection(id) {
        // 持久化选中状态到 Set
        if (!this._selectedCardIds) this._selectedCardIds = new Set();
        if (this._selectedCardIds.has(id)) {
            this._selectedCardIds.delete(id);
        } else {
            this._selectedCardIds.add(id);
        }
        // 同步 DOM 视觉状态（不重新渲染，避免丢失其他选中）
        const card = document.querySelector(`.media-card[data-id="${id}"]`);
        if (!card) return;
        const isSelected = this._selectedCardIds.has(id);
        card.classList.toggle('selected', isSelected);
        const cb = card.querySelector('.card-checkbox input[type="checkbox"]');
        if (cb) cb.checked = isSelected;
        this.updateSelectionUI();
    }

    selectAllCards() {
        if (!this._selectedCardIds) this._selectedCardIds = new Set();
        const visibleCards = document.querySelectorAll('.media-card');
        if (visibleCards.length === 0) return;

        // 根据当前卡片实际选中状态决定操作，不依赖 checkbox 状态（避免时序问题）
        const allSelected = Array.from(visibleCards).every(
            card => this._selectedCardIds.has(card.dataset.id)
        );

        if (allSelected) {
            // 全部已选中 → 取消全选
            visibleCards.forEach(card => {
                this._selectedCardIds.delete(card.dataset.id);
                card.classList.remove('selected');
                const cb = card.querySelector('.card-checkbox input[type="checkbox"]');
                if (cb) cb.checked = false;
            });
        } else {
            // 存在未选中 → 全选
            visibleCards.forEach(card => {
                this._selectedCardIds.add(card.dataset.id);
                card.classList.add('selected');
                const cb = card.querySelector('.card-checkbox input[type="checkbox"]');
                if (cb) cb.checked = true;
            });
        }
        this.updateSelectionUI();
    }

    deselectAllCards() {
        if (!this._selectedCardIds) this._selectedCardIds = new Set();
        this._selectedCardIds.clear();
        document.querySelectorAll('.media-card').forEach(card => {
            card.classList.remove('selected');
            const cb = card.querySelector('.card-checkbox input[type="checkbox"]');
            if (cb) cb.checked = false;
        });
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        const selectedCount = this._selectedCardIds ? this._selectedCardIds.size : 0;
        const selectAllCheckbox = document.getElementById('select-all-checkbox');
        const batchDeleteBtn = document.getElementById('batch-delete-btn');

        if (batchDeleteBtn) {
            batchDeleteBtn.disabled = selectedCount === 0;
            batchDeleteBtn.textContent = `批量删除 (${selectedCount})`;
        }

        // 更新全选复选框状态（基于持久化的 Set）
        const visibleCards = document.querySelectorAll('.media-card');
        if (selectAllCheckbox) {
            if (visibleCards.length === 0 || selectedCount === 0) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = false;
            } else if (selectedCount === visibleCards.length) {
                selectAllCheckbox.checked = true;
                selectAllCheckbox.indeterminate = false;
            } else {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = true;
            }
        }
    }

    async batchDeleteItems() {
        if (!this._selectedCardIds || this._selectedCardIds.size === 0) return;
        const selectedIds = Array.from(this._selectedCardIds);
        const titles = selectedIds.map(id => {
            const item = this.history.find(h => h.id === id);
            return item?.title || '未知';
        }).join('、');

        if (!await this.showConfirm({
            title: '🗑️ 批量删除作品',
            message: `确定要删除以下 ${selectedIds.length} 个作品记录吗？\n\n${titles}`,
            okText: '批量删除',
            danger: true
        })) return;

        this.history = this.history.filter(h => !selectedIds.includes(h.id));
        this._selectedCardIds.clear();
        this.saveHistory();
        this.renderGallery();
        this.renderHistory();
    }

    // 自动合并功能 (生成完成后: 拼接分镜 -> 音频识别 -> 烧录中文字幕 -> 成片)
    // opts.force: 无视"自动合并"开关强制执行 (批量生成/短剧工坊固定启用)
    // opts.showProgress: 把后期处理的实时阶段显示在"生成进度"面板里
    async autoMergeAfterGeneration(episodeName, opts = {}) {
        // 检查是否启用自动合并
        const autoMergeEnabled = opts.force || localStorage.getItem('autoMergeEnabled') === 'true';
        if (!autoMergeEnabled) return;

        const showProgress = !!opts.showProgress;
        if (showProgress) {
            this._postRunning = true;
            this._showPostPanel(`🎙️ 音频识别与中文字幕 — ${episodeName}`);
            this.setProgressBar(100, `🎙️ 正在对《${episodeName}》执行音频识别并烧录中文字幕...`);
        }
        this.showStatus(`🎬 正在自动合并分镜视频: ${episodeName}...`, 'info');
        const onStage = showProgress ? (ev) => this._onPostStage(ev) : null;

        try {
            // 获取作品目录路径
            const episodeDir = this.getEpisodeDir(episodeName);
            if (!episodeDir) {
                throw new Error('未找到作品目录');
            }

            // 调用 Electron 的合并功能 (传入绝对路径确保 Python 脚本正确定位)
            let absEpisodeDir = episodeDir;
            if (this.serverMode && (this.serverOutputDir || this.outputPaths.base)) {
                const base = (this.serverOutputDir || this.outputPaths.base).replace(/[\\/]+$/, '');
                const rel = episodeDir.replace(/^\.\//, '');
                absEpisodeDir = base + (rel.startsWith('/') || rel.startsWith('\\') ? '' : '/') + rel;
            }
            let relPath = null;
            let subInfo = null;      // 字幕到底烧成功没有: 脚本会如实回报, 别再无脑说"已烧录"
            let subReason = '';      // 没烧上的原因 (由合并脚本给出)
            if (window.electronAPI) {
                if (showProgress) this._setPostProgress(3, `🎬 准备处理分镜片段`, `保存位置: ${absEpisodeDir}`);
                const result = await window.electronAPI.mergeEpisode(absEpisodeDir, onStage);
                if (!result.success) throw new Error(result.error || '合并失败');
                relPath = this._toRelOutputPath(result.result.finalVideoPath);
                subInfo = result.result.subtitles;
                subReason = result.result.subtitleReason || '';
            } else {
                // 服务器模式: 调用后端合并接口 (需服务器本机有 python + ffmpeg)
                // stream=1 时后端以 NDJSON 逐行推送阶段事件, 用于实时显示 ASR/字幕烧录进度
                const relDir = `${this.getEpisodeFolder()}/${this.sanitizeFilename(episodeName)}`;
                if (showProgress) this._setPostProgress(3, `🎬 准备处理分镜片段`, `保存位置: ${absEpisodeDir}`);
                const data = await this._mergeEpisodeViaServer(relDir, onStage);
                relPath = this._toRelOutputPath(data.finalVideoPath);
                subInfo = data.subtitles;
                subReason = data.subtitleReason || '';
            }
            if (!relPath) throw new Error('合并没有产出成片 (服务器未返回成片路径)');

            // 字幕到底烧上没有: true/false 来自合并脚本, undefined 表示旧版脚本没回报 (按"不知道"处理, 不吹牛)
            this._lastMergeHadSubtitles = (subInfo === true) ? true : (subInfo === false ? false : null);
            this._lastSubtitleReason = (subInfo === false) ? subReason : null;
            const noSubs = this._lastMergeHadSubtitles === false;
            const subWhy = this._lastSubtitleReason ? `：${this._lastSubtitleReason}` : '';
            const subUnknown = this._lastMergeHadSubtitles === null;
            this.showStatus(noSubs
                ? `⚠️ 合并完成，但这一集没有烧上中文字幕${subWhy}（成片已保存，可重跑合并）`
                : (subUnknown ? `✅ 合并成功: ${episodeName}（未回报字幕状态）` : `✅ 合并成功: ${episodeName}`),
                noSubs ? 'warning' : 'success');
            if (showProgress) {
                this._setPostProgress(100,
                    noSubs ? `⚠️ 合并完成 (未烧中文字幕${subWhy})` : '✅ 音频识别与字幕烧录完成',
                    `成片: ${relPath}`);
            }
            if (noSubs) {
                this.notifyAttention({
                    key: `nosub:${episodeName}`,
                    title: `${episodeName} 合并完成，但没有中文字幕`,
                    message: `成片已经生成，但字幕这一步被跳过了${subWhy}。\n\n`
                        + '常见原因：这一集的音频识别不到语音，或本机缺少 ASR 模块/模型。\n'
                        + '成片本身可以正常使用；需要字幕的话，修好原因后再点一次"📦 手动合并视频"即可重烧。',
                    level: 'warning',
                    tab: 'gallery',
                });
            }

            // 把成片路径写回作品库记录 (绝对路径转相对路径存储, 与服务器模式保持一致)
            const record = this.history.find(h => h.title === episodeName && h.type === 'video');
            if (record && relPath) {
                record.path = relPath;
                this.saveHistory();
                this.renderGallery();
            }
            return relPath;
        } catch (error) {
            if (showProgress) this._setPostProgress(this._postPercent || 0, '❌ 后期处理失败', error.message);
            this.showStatus(`❌ 自动合并失败: ${error.message}`, 'error');
            console.error('自动合并错误:', error);
            throw error;
        } finally {
            if (showProgress) {
                this._postRunning = false;
                this._postPercent = null;
            }
        }
    }

    /** 调用后端合并接口: 优先用 NDJSON 流读取实时阶段, 不支持时退回普通 JSON 响应 */
    async _mergeEpisodeViaServer(relDir, onStage) {
        const resp = await fetch('/api/merge-episode?stream=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: relDir })
        });
        const ctype = resp.headers.get('content-type') || '';
        const streamed = resp.ok && resp.body && resp.body.getReader && ctype.includes('ndjson');
        if (!streamed) {
            // 旧版服务器 / 代理不支持流式: 退回一次性 JSON
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.success) throw new Error(data.error || '合并失败');
            return data;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let result = null;
        let failure = null;

        const consume = (line) => {
            const text = line.trim();
            if (!text) return;
            let ev;
            try { ev = JSON.parse(text); } catch (_) { return; }
            if (ev.stage === 'result') { result = ev.result; return; }
            if (ev.stage === 'error') { failure = ev.message || '合并失败'; return; }
            if (onStage) onStage(ev);
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(consume);
        }
        consume(buffer);

        if (failure) throw new Error(failure);
        if (!result) throw new Error('合并未返回结果');
        return result;
    }

    /** 绝对路径 -> 相对保存根目录的路径 (作品库统一按相对路径存储) */
    _toRelOutputPath(absPath) {
        if (!absPath) return null;
        try {
            const base = (this.serverOutputDir || this.outputPaths.base || '').replace(/[\\/]+$/, '');
            if (base && absPath.startsWith(base)) return absPath.slice(base.length).replace(/^[\\/]/, '');
        } catch (_) { /* 非法路径按原样返回 */ }
        return absPath;
    }

    /* ================= 后期处理进度 (音频识别 + 字幕烧录) ================= */

    _showPostPanel(title) {
        const panel = document.getElementById('post-progress-panel');
        if (panel) panel.style.display = 'block';
        this._setPostProgress(0, title || '🎙️ 音频识别与中文字幕', '');
    }

    _hidePostPanel() {
        const panel = document.getElementById('post-progress-panel');
        if (panel) panel.style.display = 'none';
    }

    _setPostProgress(percent, text, detail) {
        const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        this._postPercent = pct;
        const fill = document.getElementById('post-progress-fill');
        const pctEl = document.getElementById('post-progress-percent');
        const statusText = document.getElementById('post-status-text');
        const detailEl = document.getElementById('post-detail');
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (statusText) statusText.textContent = text || '';
        if (detailEl) detailEl.textContent = detail || '';
    }

    /** merge_videos.py 阶段 -> 进度百分比 (ASR 阶段按已识别片段数线性推进) */
    _postStagePercent(ev) {
        const stage = ev && ev.stage;
        if (stage === 'asr') {
            const total = Number(ev.total) || 0;
            const cur = Number(ev.current) || 0;
            return total > 0 ? 25 + Math.round(45 * Math.min(1, cur / total)) : 30;
        }
        const table = {
            start: 6, concat: 15, srt: 72, burn: 85,
            'burn-failed': 95, 'no-speech': 95, 'asr-unavailable': 95, done: 100
        };
        return Object.prototype.hasOwnProperty.call(table, stage) ? table[stage] : (this._postPercent || 50);
    }

    _onPostStage(ev) {
        if (!ev || !ev.stage) return;
        const pct = this._postStagePercent(ev);
        const icons = {
            start: '🎬', concat: '🔗', asr: '🎙️', srt: '📄', burn: '🔥',
            done: '✅', 'burn-failed': '⚠️', 'no-speech': '⚠️', 'asr-unavailable': '⚠️'
        };
        const icon = icons[ev.stage] || '⏳';
        const detail = (ev.current && ev.total) ? `已处理 ${ev.current}/${ev.total}` : '';
        this._setPostProgress(pct, `${icon} ${ev.message || ''}`, detail);
        if (ev.stage === 'done') {
            this.setProgressBar(100, `✅ 后期处理完成 (音频识别 + 中文字幕已烧录)`);
            this.showStatus(`${icon} ${ev.message || '后期处理完成'}`, 'success');
        } else if (ev.stage === 'burn-failed' || ev.stage === 'no-speech' || ev.stage === 'asr-unavailable') {
            this.setProgressBar(100, `⚠️ ${ev.message || '后期处理未生成字幕'}`);
            this.showStatus(`${icon} ${ev.message || '后期处理完成'}`, 'warning');
        }
    }

    getEpisodeDir(episodeName) {
        // 获取作品目录: <保存位置>/video/<标题>/ —— 保存位置统一取自模型设置 (serverOutputDir)
        const basePath = this.serverOutputDir || this.outputPaths.base;
        if (!basePath) return null;
        const title = this.sanitizeFilename(episodeName);
        return `${basePath.replace(/[\\/]+$/, '')}/video/${title}`;
    }

    /** 作品库视频文件夹的相对名 (服务器接口用): 默认 "video" */
    getEpisodeFolder() {
        return 'video';
    }

    toggleAutoMerge(checked) {
        localStorage.setItem('autoMergeEnabled', checked ? 'true' : 'false');
        this.showStatus(checked ? '✅ 已启用自动合并' : '⚠️ 已禁用自动合并', checked ? 'success' : 'warning');
    }

    /** 根据 localStorage 同步自动合并复选框的视觉状态 */
    _syncAutoMergeUI() {
        const cb = document.getElementById('auto-merge-enabled');
        if (cb) cb.checked = localStorage.getItem('autoMergeEnabled') === 'true';
    }

    _setMergeProgress(percent, text, detail) {
        const panel = document.getElementById('merge-progress-panel');
        if (!panel) return;
        panel.style.display = 'block';
        const fill = document.getElementById('merge-progress-fill');
        const pctEl = document.getElementById('merge-progress-percent');
        const statusText = document.getElementById('merge-status-text');
        const detailEl = document.getElementById('merge-detail');
        if (fill) fill.style.width = percent + '%';
        if (pctEl) pctEl.textContent = percent + '%';
        if (statusText) statusText.textContent = text;
        if (detailEl) detailEl.textContent = detail || '';
    }

    _hideMergeProgress() {
        const panel = document.getElementById('merge-progress-panel');
        if (panel) panel.style.display = 'none';
    }

    async manualMergeSelected() {
        if (!this._selectedCardIds || this._selectedCardIds.size === 0) {
            this.showStatus('⚠️ 请先在作品库勾选要合并的视频', 'warning');
            return;
        }

        const episodes = [];
        this._selectedCardIds.forEach(id => {
            const item = this.history.find(h => h.id === id);
            if (item?.title) episodes.push(item);
        });

        if (episodes.length === 0) {
            this.showStatus('⚠️ 未找到有效的作品记录', 'warning');
            return;
        }

        this._setMergeProgress(0, '准备合并...', `共 ${episodes.length} 个作品待处理`);
        let successCount = 0;
        let failCount = 0;
        let noSubCount = 0;

        for (let i = 0; i < episodes.length; i++) {
            const item = episodes[i];
            const percent = Math.round(((i) / episodes.length) * 100);
            this._setMergeProgress(percent, `正在合并: ${item.title}`, `第 ${i + 1}/${episodes.length} 集`);
            try {
                // force: 这是用户明确点的"合并", 不该因为"启用自动合并"没勾选就静默什么都不做 ——
                // 以前这里没传 force, 结果是"提示合并成功、目录里却没有文件"。
                const relPath = await this.autoMergeAfterGeneration(item.title, { force: true, showProgress: true });
                if (!relPath) throw new Error('合并没有产出成片 (未返回成片路径)');
                if (this._lastMergeHadSubtitles === false) noSubCount++;
                successCount++;
                this._setMergeProgress(Math.round(((i + 1) / episodes.length) * 100),
                    `✅ ${item.title} 合并成功`, `第 ${i + 1}/${episodes.length} 集`);
            } catch (e) {
                failCount++;
                this._setMergeProgress(Math.round(((i + 1) / episodes.length) * 100),
                    `❌ ${item.title} 合并失败`, e.message);
                console.error(`合并 ${item.title} 失败:`, e);
            }
            // 短暂延迟让 UI 刷新显示当前状态
            await this.delay(150);
        }

        this._setMergeProgress(100,
            failCount > 0
                ? `完成: ${successCount} 成功 / ${failCount} 失败${noSubCount ? ` (其中 ${noSubCount} 集未烧字幕)` : ''}`
                : `✅ 全部合并完成!${noSubCount ? ` (${noSubCount} 集未烧中文字幕, 见提示)` : ''}`,
            failCount > 0
                ? `${successCount} 个成功，${failCount} 个失败`
                : '所有作品均已成功合并');

        // 2 秒后自动收起进度条，并弹出 toast 提醒
        setTimeout(() => {
            this._hideMergeProgress();
            if (failCount === 0) {
                this.showStatus(`🎉 全部 ${successCount} 个作品合并成功！`, 'success');
            } else {
                this.showStatus(`⚠️ 合并完成: ${successCount} 成功 / ${failCount} 失败`, failCount === successCount ? 'error' : 'warning');
            }
        }, 2500);
    }

    /* ================= 手动合并: 弹窗选择本地视频文件 ================= */

    /** 入口: 弹出系统文件选择框 -> 确认对话框 -> 自动合并生成新的完整版视频 */
    async manualMergeVideos() {
        if (this._mergeRunning) return this.showStatus('⚠️ 已有合并任务在进行中，请稍候', 'warning');

        let files = null;
        if (window.electronAPI && window.electronAPI.selectVideoFiles) {
            // 桌面版: 直接弹出系统文件选择框 (多选)
            files = await window.electronAPI.selectVideoFiles();
            if (!files || files.length === 0) return; // 用户取消选择, 静默返回
        } else {
            // 服务器模式: 浏览器无本地路径权限, 由用户输入服务器本机的绝对路径
            files = await this._promptMergePathsByInput();
            if (files === null) return; // 用户取消
            if (files.length === 0) return this.showStatus('⚠️ 未输入有效的视频文件路径', 'warning');
        }

        if (files.length < 2) return this.showStatus('⚠️ 至少需要选择 2 个视频文件才能合并', 'warning');

        // 默认输出: 与第一个视频同目录, 名称取其文件名主干
        const first = files[0];
        const lastSlash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
        const defaultDir = lastSlash > 0 ? first.slice(0, lastSlash) : '';
        const stem = first.slice(lastSlash + 1).replace(/\.[^.]+$/, '') || '合并视频';
        const ts = new Date();
        const stamp = `${ts.getMonth() + 1}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`;
        this._mergeCtx = { files: files.slice(), outName: `${stem}_${stamp}`, outDir: defaultDir };
        this._showMergeDialog();
    }

    /** 服务器模式: 弹窗让用户逐行输入服务器本机的视频文件绝对路径 */
    _promptMergePathsByInput() {
        return new Promise(resolve => {
            const modal = document.getElementById('modal');
            const body = document.getElementById('modal-body');
            if (!modal || !body) { resolve(null); return; }
            body.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <h3 style="margin: 0;">📦 手动合并视频</h3>
                    <span class="type-badge">服务器模式</span>
                </div>
                <p style="color: var(--text-muted); font-size: 0.85rem; margin: 0 0 10px;">
                    浏览器模式无本地文件选择权限。请输入服务器本机上的视频文件<b>绝对路径</b>，每行一个，按合并顺序排列 (至少 2 个)：<br>
                    例如 <code>D:\\Videos\\片段1.mp4</code>
                </p>
                <textarea id="merge-paths-input" rows="7" style="width: 100%; box-sizing: border-box;" placeholder="D:\\Videos\\片段1.mp4&#10;D:\\Videos\\片段2.mp4"></textarea>
                <div class="modal-actions">
                    <button class="btn btn-primary" onclick="generator._resolveMergePaths(true)">下一步</button>
                    <button class="btn btn-secondary" onclick="generator._resolveMergePaths(false)">取消</button>
                </div>
            `;
            modal.style.display = 'block';
            this._mergePathsResolver = resolve;
            setTimeout(() => { const el = document.getElementById('merge-paths-input'); if (el) el.focus(); }, 50);
        });
    }

    _resolveMergePaths(ok) {
        const resolver = this._mergePathsResolver;
        this._mergePathsResolver = null;
        this.closeModal();
        if (!resolver) return;
        if (!ok) { resolver(null); return; }
        const el = document.getElementById('merge-paths-input');
        const raw = el ? el.value : '';
        resolver(String(raw).split('\n').map(l => l.trim()).filter(Boolean));
    }

    /** 渲染合并确认对话框 (文件列表可排序/删除 + 成片名称/输出目录) */
    _showMergeDialog() {
        const ctx = this._mergeCtx;
        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        if (!modal || !body) return;
        const isDesktop = !!(window.electronAPI && window.electronAPI.mergeVideoFiles);
        body.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <h3 style="margin: 0;">📦 手动合并视频</h3>
                <span class="type-badge">共 ${ctx.files.length} 个片段</span>
            </div>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin: 0 0 10px;">
                将按下方顺序合并为一个新的完整版视频 (含 ASR 字幕烧录)。可用 ↑↓ 调整顺序、✕ 移除。
            </p>
            <div id="merge-file-list" style="max-height: 240px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px; padding: 6px; margin-bottom: 12px;"></div>
            <div class="form-group">
                <label>📝 成片名称 (自动生成 <名称>_完整版.mp4)</label>
                <input type="text" id="merge-out-name" value="${this.escapeAttr(ctx.outName)}" oninput="generator._mergeCtx.outName = this.value">
            </div>
            <div class="form-group">
                <label>📁 输出目录</label>
                <input type="text" id="merge-out-dir" value="${this.escapeAttr(ctx.outDir)}" oninput="generator._mergeCtx.outDir = this.value">
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary" onclick="generator._confirmMergeFiles()">✅ 确认合并</button>
                <button class="btn btn-secondary" onclick="generator.closeModal()">取消</button>
            </div>
        `;
        this._renderMergeList();
        modal.style.display = 'block';
    }

    _renderMergeList() {
        const wrap = document.getElementById('merge-file-list');
        const ctx = this._mergeCtx;
        if (!wrap || !ctx) return;
        wrap.innerHTML = ctx.files.map((f, i) => `
            <div style="display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px dashed var(--border-color); font-size: 0.82rem;">
                <span style="color: var(--primary-color); font-weight: bold; min-width: 22px;">${i + 1}.</span>
                <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.escapeAttr(f)}">${this.escapeHtml(f)}</span>
                <button class="btn btn-small btn-secondary" style="padding: 1px 7px;" title="上移" onclick="generator._mergeMove(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-small btn-secondary" style="padding: 1px 7px;" title="下移" onclick="generator._mergeMove(${i}, 1)" ${i === ctx.files.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-small btn-danger" style="padding: 1px 7px;" title="移除" onclick="generator._mergeRemove(${i})">✕</button>
            </div>`).join('');
    }

    _mergeMove(i, dir) {
        const ctx = this._mergeCtx;
        if (!ctx) return;
        const j = i + dir;
        if (j < 0 || j >= ctx.files.length) return;
        [ctx.files[i], ctx.files[j]] = [ctx.files[j], ctx.files[i]];
        this._renderMergeList();
    }

    _mergeRemove(i) {
        const ctx = this._mergeCtx;
        if (!ctx) return;
        ctx.files.splice(i, 1);
        if (ctx.files.length < 2) {
            this.closeModal();
            return this.showStatus('⚠️ 至少需要 2 个视频文件，已退出合并', 'warning');
        }
        this._renderMergeList();
    }

    /** 确认合并: 关闭对话框 -> 调用合并 -> 进度面板 -> 成功后定位文件 */
    async _confirmMergeFiles() {
        const ctx = this._mergeCtx || {};
        const files = (ctx.files || []).map(f => String(f).trim()).filter(Boolean);
        if (files.length < 2) return this.showStatus('⚠️ 至少需要 2 个视频文件', 'warning');
        const outName = String(ctx.outName || '').trim() || `合并视频_${Date.now()}`;
        const outDir = String(ctx.outDir || '').trim();
        if (!outDir) return this.showStatus('⚠️ 请填写输出目录', 'warning');

        this.closeModal();
        this._mergeRunning = true;
        this._setMergeProgress(5, '正在合并所选视频...', `${files.length} 个片段 -> ${outName}_完整版.mp4`);
        // 实时显示 拼接 -> 音频识别 -> 烧录中文字幕 的阶段进度
        const onStage = (ev) => {
            if (!ev || !ev.stage) return;
            const detail = (ev.current && ev.total) ? `已处理 ${ev.current}/${ev.total}` : '';
            this._setMergeProgress(this._postStagePercent(ev), `🎙️ ${ev.message || '处理中'}`, detail);
        };
        try {
            let finalPath = null;
            if (window.electronAPI && window.electronAPI.mergeVideoFiles) {
                const result = await window.electronAPI.mergeVideoFiles({ files, outName, outDir }, onStage);
                if (!result.success) throw new Error(result.error || '合并失败');
                finalPath = result.result?.finalVideoPath;
            } else {
                const resp = await fetch('/api/merge-files', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files, outName, outDir })
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || '合并失败');
                finalPath = data.finalVideoPath;
            }
            this._setMergeProgress(100, '✅ 合并成功', finalPath || '');
            this.showStatus(`🎉 合并完成: ${outName}_完整版.mp4`, 'success');
            if (finalPath && window.electronAPI && window.electronAPI.revealPath) {
                window.electronAPI.revealPath(finalPath); // 在资源管理器中定位新生成的完整版
            }
        } catch (e) {
            console.error('手动合并失败:', e);
            this._setMergeProgress(100, '❌ 合并失败', e.message);
            this.showStatus('❌ 合并失败: ' + e.message, 'error');
        } finally {
            this._mergeRunning = false;
            setTimeout(() => this._hideMergeProgress(), 6000);
        }
    }

    /* ================= 历史记录 ================= */

    renderHistory() {
        const list = document.getElementById('history-list');
        if (!list) return;
        const typeFilter = document.getElementById('filter-type')?.value;
        const dateFilter = document.getElementById('filter-date')?.value;

        let filtered = this.history;
        if (typeFilter && typeFilter !== 'all') filtered = filtered.filter(h => h.type === typeFilter);
        if (dateFilter) filtered = filtered.filter(h => h.date && h.date.includes(dateFilter));

        list.innerHTML = filtered.slice().reverse().map(item => {
            const status = this.normalizeLegacyStatus(item.status);
            const statusText = { queued: '⏳ 排队中', running: '⏳ 生成中', completed: '✅ 完成', failed: '❌ 失败', unknown: '❓ 未知' }[status] || '';
            return `
            <div class="history-item">
                <div class="info">
                    <h4>${item.type === 'video' ? '🎬' : '🖼️'} ${this.escapeHtml(item.title)} <small style="color: var(--text-muted);">${statusText}</small></h4>
                    <p>${item.date} | ${item.platform || '视频'} | ${item.resolution || '-'}</p>
                </div>
                <div class="actions">
                    <button class="btn btn-small btn-secondary" onclick="generator.previewItem('${item.id}')">查看</button>
                    <button class="btn btn-small btn-danger" onclick="generator.deleteItem('${item.id}')">删除</button>
                </div>
            </div>`;
        }).join('');
        if (filtered.length === 0) list.innerHTML = '<p class="empty-hint" style="padding: 40px;">暂无历史记录</p>';
    }

    filterHistory() { this.renderHistory(); }

    async clearHistory() {
        if (!await this.showConfirm({
            title: '🗑️ 清空历史记录',
            message: '确定要清空所有历史记录吗？此操作不可恢复。',
            okText: '清空',
            danger: true
        })) return;
        this.history = [];
        this.saveHistory();
        this.renderGallery();
        this.renderHistory();
    }

    /* ================= 模型设置 ================= */

    updateSettingsUI() {
        const s = this.settings;
        const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null && v !== '') el.value = v; };
        set('api-endpoint', s.apiEndpoint);
        set('api-key', s.apiKey);
        set('model-name', s.modelName);
        set('platform-preset', s.apiFormat || 'auto');
        set('custom-json', s.customJson);
        set('custom-poll-path', s.customPollPath);
        set('custom-result-path', s.customResultPath);
        set('seed', s.seed);
        set('submit-interval', s.submitIntervalSec ?? 2);
        set('llm-endpoint', s.llmEndpoint);
        set('llm-key', s.llmApiKey);
        const llmSame = document.getElementById('llm-same-creds');
        if (llmSame) llmSame.checked = s.llmSameAsVideo !== false;
        // 保存位置显示优先级: 服务器生效值 > 本地保存值 (两者应一致, 以服务器为准)
        set('base-path', this.serverOutputDir || s.basePath);
        this.toggleCustomSection();
        this.toggleLLMInputs();
    }

    toggleLLMInputs() {
        const same = document.getElementById('llm-same-creds')?.checked !== false;
        ['llm-endpoint', 'llm-key'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = same;
                el.placeholder = same ? '自动使用视频平台的端点/密钥' : '填入文本模型专用地址';
            }
        });
        // 只按缓存渲染, 不在这里发请求 (本方法也会被 updateSettingsUI 调用)
        this.renderLlmModelSelect(
            this._llmModelsKey === this.llmCredsKey() ? this.llmModels : [],
            this.settings.llmModel
        );
    }

    /** 勾选/取消"与视频平台使用相同端点和密钥": 切换模型来源并拉取对应列表 */
    onLlmSameCredsChange() {
        this.toggleLLMInputs();
        return this.fetchLlmModels({ silent: true });
    }

    /** 当前生效的剧本AI凭据来源: 勾选=继承视频平台接入, 未勾选=自定义文本端点 */
    llmCreds() {
        const g = (id) => (document.getElementById(id)?.value || '').trim();
        const s = this.settings;
        const same = document.getElementById('llm-same-creds')?.checked !== false;
        if (same) {
            return {
                same: true,
                endpoint: g('api-endpoint') || s.apiEndpoint || '',
                apiKey: g('api-key') || s.apiKey || '',
                apiFormat: g('platform-preset') || s.apiFormat || 'auto'
            };
        }
        return {
            same: false,
            endpoint: g('llm-endpoint') || s.llmEndpoint || '',
            apiKey: g('llm-key') || s.llmApiKey || '',
            apiFormat: 'auto'
        };
    }

    llmCredsKey() {
        const c = this.llmCreds();
        return `${c.same ? 'inherit' : 'custom'}|${c.endpoint}|${c.apiKey}|${c.apiFormat}`;
    }

    /** 写入剧本AI模型下拉框下方的动态提示 */
    setLlmModelHint(text, color) {
        const el = document.getElementById('llm-model-hint');
        if (!el) return;
        el.textContent = text;
        el.style.color = color || 'var(--text-muted)';
    }

    /** 当前选中的剧本AI模型 (下拉框, 或"手动输入"时的文本框) */
    readLlmModelSelection() {
        const sel = document.getElementById('llm-model');
        const manual = document.getElementById('llm-model-manual');
        let v = sel ? sel.value : '';
        if (v === '__manual__') v = (manual && manual.value) || '';
        return String(v || '').trim();
    }

    /**
     * 渲染剧本AI模型下拉框。
     * 已保存但不在列表里的模型会以"（当前配置）"保留下来 ——
     * 否则换个端点拉列表就会把用户原来的选择悄悄丢掉。
     */
    renderLlmModelSelect(models, current) {
        const sel = document.getElementById('llm-model');
        if (!sel) return;
        const list = Array.isArray(models) ? models.slice() : [];
        const cur = String(current !== undefined ? current : this.settings.llmModel || '').trim();
        const keepCur = cur && !list.includes(cur);
        const opts = ['<option value="">— 请选择文本模型 —</option>'];
        if (keepCur) opts.push(`<option value="${this.escapeAttr(cur)}">${this.escapeHtml(cur)}（当前配置）</option>`);
        list.forEach(m => opts.push(`<option value="${this.escapeAttr(m)}">${this.escapeHtml(m)}</option>`));
        opts.push('<option value="__manual__">✏️ 手动输入模型 ID…</option>');
        sel.innerHTML = opts.join('');
        sel.value = cur || '';

        const manual = document.getElementById('llm-model-manual');
        if (manual) {
            if (cur && !list.length) manual.value = cur;    // 拉不到列表时把手填值也带出来
            manual.style.display = sel.value === '__manual__' ? 'block' : 'none';
        }
    }

    /** 拉取剧本AI模型列表 (按当前凭据来源), silent=true 时不提示"正在拉取" */
    async fetchLlmModels(opts = {}) {
        const silent = !!opts.silent;
        const creds = this.llmCreds();
        const sourceName = creds.same ? '平台接入' : '自定义文本端点';

        if (!creds.endpoint || !creds.apiKey) {
            this.renderLlmModelSelect([], this.settings.llmModel);
            this.setLlmModelHint(creds.same
                ? '⚠️ 请先在上方填写「平台接入」的 API 端点与密钥（或取消勾选，改用文本模型专用的端点/密钥）'
                : '⚠️ 请先填写文本模型端点与密钥，填好后会自动拉取可用模型', 'var(--warning-color)');
            return null;
        }

        const key = this.llmCredsKey();
        const fresh = this._llmModelsKey === key && Date.now() - (this._llmModelsFetchedAt || 0) < 5 * 60 * 1000;
        if (fresh && !opts.force) {
            this.renderLlmModelSelect(this.llmModels, this.settings.llmModel);
            return this.llmModels;
        }
        if (this._llmFetching) return null;   // 避免连点/切来切去时重复请求

        this._llmFetching = true;
        if (!silent) this.setLlmModelHint(`🔍 正在从${sourceName}拉取模型列表...`);
        try {
            const client = new AgnesAPIClient({
                apiEndpoint: creds.endpoint, apiKey: creds.apiKey,
                modelName: this.settings.llmModel || '', apiFormat: creds.apiFormat,
                useProxy: this.serverMode
            });
            const models = await client.fetchModels();
            // 拉取期间用户可能又改了来源, 结果对不上就丢弃
            if (this.llmCredsKey() !== key) return null;

            this.llmModels = Array.isArray(models) ? models : [];
            this._llmModelsKey = key;
            this._llmModelsFetchedAt = Date.now();
            this.renderLlmModelSelect(this.llmModels, this.settings.llmModel);

            if (this.llmModels.length) {
                this.setLlmModelHint(`✅ 已从${sourceName}拉取到 ${this.llmModels.length} 个模型，请选择写剧本用的模型`, 'var(--success-color)');
            } else {
                this.setLlmModelHint(`⚠️ ${sourceName}未提供 /models 接口，请在下方手动输入模型 ID`, 'var(--warning-color)');
            }
            return this.llmModels;
        } finally {
            this._llmFetching = false;
        }
    }

    /** "🔄 拉取模型"按钮: 强制重新拉取 */
    refreshLlmModels() {
        return this.fetchLlmModels({ force: true });
    }

    /** 文本模型端点/密钥改动后, 重新拉取该端点的模型列表 */
    onLlmCredsChange() {
        if (this.llmCreds().same) return;   // 继承模式下这两个框是只读的
        return this.fetchLlmModels({ force: true });
    }

    /** 下拉框选择变化: 立即生效并保存 (不必再点"保存设置") */
    onLlmModelChange() {
        const sel = document.getElementById('llm-model');
        const manual = document.getElementById('llm-model-manual');
        const manualMode = !!sel && sel.value === '__manual__';
        if (manual) {
            // 切到手动输入时带上原选择, 避免"点一下手动输入"就把已配置的模型清空
            if (manualMode && !manual.value.trim()) manual.value = this.settings.llmModel || '';
            manual.style.display = manualMode ? 'block' : 'none';
        }

        const model = this.readLlmModelSelection();
        this.settings.llmModel = model;
        this.saveSettings();
        if (model) this.showStatus(`✅ 剧本AI模型已设为: ${model}`, 'success');
    }

    toggleCustomSection() {
        const preset = document.getElementById('platform-preset')?.value || 'auto';
        const group = document.getElementById('custom-json-group');
        if (group) group.style.display = preset === 'custom' ? 'block' : 'none';

        // 平台提示文案
        const hint = document.getElementById('platform-hint');
        if (hint) {
            const hints = {
                auto: '根据端点地址与模型名自动识别平台 (推荐)',
                ark: '火山方舟 (豆包 Seedance): 自动使用 contents/generations/tasks 接口，参数拼接在提示词中。需通过本地服务器代理访问。',
                openai: 'OpenAI 兼容格式 (POST /videos)，适用于大多数聚合平台。',
                custom: '完全自定义: 使用下方 JSON 模板作为请求体，支持 {{prompt}} {{model}} {{duration}} {{resolution}} {{ratio}} {{seed}} 占位符。'
            };
            hint.textContent = hints[preset] || '';
        }

        // 方舟预设时补充模型建议
        const datalist = document.getElementById('model-options');
        if (datalist && preset === 'ark') {
            const current = Array.from(datalist.options).map(o => o.value);
            AgnesAPIClient.ARK_MODELS.forEach(m => {
                if (!current.includes(m)) {
                    const opt = document.createElement('option');
                    opt.value = m;
                    datalist.appendChild(opt);
                }
            });
        }
    }

    onPlatformPresetChange() {
        const preset = document.getElementById('platform-preset').value;
        const endpointInput = document.getElementById('api-endpoint');
        // 切换预设时若端点为空或为另一预设默认值，自动填入对应默认端点
        const defaults = {
            ark: 'https://ark.cn-beijing.volces.com/api/v3',
            openai: 'https://apihub.agnes-ai.com/v1'
        };
        if (defaults[preset] && (!endpointInput.value.trim() || Object.values(defaults).includes(endpointInput.value.trim()))) {
            endpointInput.value = defaults[preset];
        }
        this.toggleCustomSection();
    }

    async fetchModels() {
        // 先暂存输入框中的端点/密钥再拉取
        this.settings.apiEndpoint = document.getElementById('api-endpoint').value.trim();
        this.settings.apiKey = document.getElementById('api-key').value.trim();
        this.settings.apiFormat = document.getElementById('platform-preset').value;
        if (!this.settings.apiEndpoint) return this.showStatus('⚠️ 请先输入 API 端点', 'error');
        if (!this.settings.apiKey) return this.showStatus('⚠️ 请先输入 API 密钥', 'error');
        this._rebuildClient();

        this.showStatus('🔍 正在拉取模型列表...', 'success');
        const models = await this.apiClient.fetchModels();
        if (!models || models.length === 0) {
            this.showStatus('⚠️ 无法拉取模型列表 (部分平台不提供 /models 接口，可手动输入模型 ID)', 'error');
            return;
        }
        this.availableModels = models;

        // 剧本AI 若用"平台接入"的凭据, 下拉框共用这份列表 (同一份端点/密钥, 不重复请求)
        if (this.llmCreds().same) {
            this.llmModels = models;
            this._llmModelsKey = this.llmCredsKey();
            this._llmModelsFetchedAt = Date.now();
            this.renderLlmModelSelect(models, this.settings.llmModel);
            this.setLlmModelHint(`✅ 已从平台接入拉取到 ${models.length} 个模型，请选择写剧本用的模型`, 'var(--success-color)');
        }

        const datalist = document.getElementById('model-options');
        datalist.innerHTML = models.map(m => `<option value="${this.escapeAttr(m)}">`).join('');

        const container = document.getElementById('models-list');
        const videoKeywords = ['video', 'seedance', 'seedream', 'wan', 'kling', 'hailuo', 'vidu', 'agnes', 'cog'];
        const videoModels = models.filter(m => videoKeywords.some(kw => m.toLowerCase().includes(kw)));
        const others = models.filter(m => !videoModels.includes(m));

        let html = '';
        if (videoModels.length > 0) {
            html += '<div style="margin-bottom: 12px;"><strong style="color: var(--primary-color);">🎬 疑似视频模型 (点击选用):</strong><div class="model-chip-list">';
            html += videoModels.map(m => `<span class="model-chip" onclick="generator.selectModel('${this.escapeAttr(m)}')">${this.escapeHtml(m)}</span>`).join('');
            html += '</div></div>';
        }
        if (others.length > 0) {
            html += `<div><strong style="color: var(--text-muted);">📦 其他模型 (${others.length}):</strong><div class="model-chip-list">`;
            html += others.slice(0, 60).map(m => `<span class="model-chip dim" onclick="generator.selectModel('${this.escapeAttr(m)}')">${this.escapeHtml(m)}</span>`).join('');
            if (others.length > 60) html += `<span class="model-chip dim">... 另 ${others.length - 60} 个</span>`;
            html += '</div></div>';
        }
        container.innerHTML = html;
        this.showStatus(`✅ 拉取到 ${models.length} 个模型，点击即可选用`, 'success');
    }

    selectModel(modelId) {
        document.getElementById('model-name').value = modelId;
        this.settings.modelName = modelId;
        // ★ 自动适配默认分镜时长: 取模型支持的最大值
        const maxDur = AgnesAPIClient.getModelMaxDuration(modelId);
        if (maxDur && maxDur !== this.series.sceneDuration) {
            this.series.sceneDuration = maxDur;
            this.saveSeries();
            const durEl = document.getElementById('series-scene-duration');
            if (durEl) durEl.value = maxDur;
            this.showStatus(`✅ 已选择模型: ${modelId}，自动适配默认分镜时长为 ${maxDur}s (点击"保存设置")`, 'success');
        } else {
            this.saveSettings();
            this.showStatus(`✅ 已选择模型: ${modelId} (记得点击"保存设置")`, 'success');
        }
        this._rebuildClient();
    }

    async testConnection() {
        this.settings.apiEndpoint = document.getElementById('api-endpoint').value.trim();
        this.settings.apiKey = document.getElementById('api-key').value.trim();
        this.settings.apiFormat = document.getElementById('platform-preset').value;
        this.settings.modelName = document.getElementById('model-name').value.trim();
        if (!this.settings.apiEndpoint || !this.settings.apiKey) return this.showStatus('⚠️ 请先配置端点和密钥', 'error');
        this._rebuildClient();

        this.showStatus('🔗 正在测试连接...', 'success');
        const result = await this.apiClient.testConnection();
        if (result.success) {
            this.showStatus(`✅ 连接成功！平台: ${result.platform} | 模型数: ${result.models?.length || '未知(不支持/models)'}`, 'success');
        } else {
            this.showStatus(`❌ 连接失败: ${result.error || '请检查端点和密钥'}`, 'error');
        }
    }

    async saveModelSettings() {
        const modelNameInput = document.getElementById('model-name').value.trim();
        const typedBasePath = (document.getElementById('base-path')?.value || '').trim();
        this.settings = {
            ...this.settings,
            apiEndpoint: document.getElementById('api-endpoint').value.trim(),
            apiKey: document.getElementById('api-key').value.trim(),
            modelName: modelNameInput,
            apiFormat: document.getElementById('platform-preset').value,
            customJson: document.getElementById('custom-json').value,
            customPollPath: document.getElementById('custom-poll-path').value.trim(),
            customResultPath: document.getElementById('custom-result-path').value.trim(),
            seed: document.getElementById('seed').value ? parseInt(document.getElementById('seed').value) : null,
            submitIntervalSec: Math.max(0, parseFloat(document.getElementById('submit-interval').value) || 0),
            llmSameAsVideo: document.getElementById('llm-same-creds')?.checked !== false,
            llmEndpoint: document.getElementById('llm-endpoint')?.value.trim() || '',
            llmApiKey: document.getElementById('llm-key')?.value.trim() || '',
            llmModel: this.readLlmModelSelection(),
            basePath: typedBasePath || this.serverOutputDir || this.settings.basePath || ''
        };
        this.saveSettings();
        this._rebuildClient();
        this.updateConnectionStatus();

        // 保存位置: 直接手填的路径同样立即生效 (与"更改保存位置"按钮等效), 全局统一
        if (typedBasePath && this.serverMode && typedBasePath.replace(/[\\/]+$/, '') !== (this.serverOutputDir || '')) {
            try {
                const resp = await fetch('/api/set-output-dir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dir: typedBasePath })
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || '保存位置设置失败');
                this.applyOutputDir(data.outputDir);
                if (window.electronAPI && window.electronAPI.saveOutputDir) window.electronAPI.saveOutputDir(data.outputDir);
                this.renderGallery();
                return this.showStatus(`✅ 设置已保存，保存位置已更新为: ${data.outputDir}`, 'success');
            } catch (e) {
                return this.showStatus(`⚠️ 设置已保存，但保存位置未更改: ${e.message}`, 'warning');
            }
        }
        if (typedBasePath && !this.serverMode) {
            this.settings.basePath = typedBasePath;
            this.outputPaths.base = typedBasePath;
            this.saveSettings();
        }

        // 剧本AI模型校验: 用"当前来源"的模型列表比对 (勾选=平台接入的列表, 未勾选=自定义端点的列表),
        // 名字对不上就提前提醒 —— 否则要等到生成时才从平台收到 "503 No available channel"
        const llmModel = this.settings.llmModel;
        const llmList = this.llmCreds().same ? this.availableModels : this.llmModels;
        if (llmModel && Array.isArray(llmList) && llmList.length && !llmList.includes(llmModel)) {
            return this.showStatus(`⚠️ 设置已保存，但剧本AI模型「${llmModel}」不在该端点拉取到的模型列表中，`
                + `平台可能没有这个模型的渠道。可用模型示例: ${llmList.slice(0, 6).join('、')}`
                + `（点「🔄 拉取模型」可查看全部）`, 'warning');
        }
        this.showStatus('✅ 设置已保存', 'success');
    }

    async resetSettings() {
        if (!await this.showConfirm({
            title: '🔄 恢复默认设置',
            message: '确定要恢复默认设置吗？当前平台配置与密钥将被清除。',
            okText: '恢复默认',
            danger: true
        })) return;
        this.settings = this.getDefaultSettings();
        this.updateSettingsUI();
        this.saveSettings();
        this._rebuildClient();
        this.updateConnectionStatus();
        this.showStatus('✅ 已恢复默认设置', 'success');
    }

    getDefaultSettings() {
        return {
            apiEndpoint: 'https://apihub.agnes-ai.com/v1',
            apiKey: '',
            modelName: 'agnes-video-2.5-flash',
            apiFormat: 'auto',
            customJson: '',
            customPollPath: '',
            customResultPath: '',
            seed: null,
            submitIntervalSec: 2,
            llmSameAsVideo: true,
            llmEndpoint: '',
            llmApiKey: '',
            llmModel: '',
            basePath: '', // 留空: 实际保存位置由服务器 outputDir 决定 (模型设置中可自定义)
            autoCreateFolder: true,
            keepOriginal: true
        };
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('agnes_settings');
            const s = saved ? { ...this.getDefaultSettings(), ...JSON.parse(saved) } : this.getDefaultSettings();
            // 旧版设置迁移
            if (s.apiFormat === 'agnes') s.apiFormat = 'auto';
            if (s.modelName === 'custom' && s.customModel) { s.modelName = s.customModel; }
            return s;
        } catch { return this.getDefaultSettings(); }
    }

    saveSettings() {
        // 从界面同步关键字段 (若存在)
        const g = (id) => document.getElementById(id)?.value;
        if (g('api-endpoint') !== undefined && g('api-endpoint') !== null) this.settings.apiEndpoint = g('api-endpoint').trim();
        if (g('api-key')) this.settings.apiKey = g('api-key').trim();
        if (g('model-name')) this.settings.modelName = g('model-name').trim();
        if (g('base-path')) this.settings.basePath = g('base-path').trim();
        localStorage.setItem('agnes_settings', JSON.stringify(this.settings));
        this._rebuildClient();
        this.updateConnectionStatus();
    }

    updateConnectionStatus() {
        const el = document.getElementById('connection-status');
        if (!el) return;
        const mode = this.serverMode
            ? '🖥️ 服务器已连接 (已就绪)'
            : `📄 本地模式 (服务器未连接${this._serverCheckError ? ': ' + this._serverCheckError : ''} — 请运行"启动服务器"后刷新页面)`;
        if (this.settings.apiEndpoint && this.settings.apiKey) {
            const platform = this.apiClient ? this.apiClient.platform : 'auto';
            const platformName = { ark: '火山方舟', openai: 'OpenAI兼容', custom: '自定义' }[platform] || platform;
            el.textContent = `状态: 已连接 ${platformName} | ${mode}`;
            el.style.color = this.serverMode ? 'var(--success-color)' : 'var(--warning-color)';
        } else {
            el.textContent = `状态: 未配置 API (演示模式) | ${mode}`;
            el.style.color = 'var(--warning-color)';
        }
    }

    /* ================= 工具 ================= */

    /* ================= 短剧工坊 (剧本AI: 延伸剧情 + 人物一致性) ================= */

    getDefaultSeries() {
        return {
            title: '', genre: '古风奇幻', premise: '',
            characters: [],      // [{name, look, voice, outfit, tagline}]
            nextEpisode: 1,
            season: 1,           // 季数: 导入存档续季时 +1, 用于人物一致性延续
            scenesPerEpisode: 4,
            totalEpisodes: 10,
            sceneDuration: 5,
            resolution: '720p',
            ratio: '9:16',       // 竖屏短剧默认
            lockCharacters: true,
            charCountAuto: true,  // 人物数默认按主提示词自动识别
            currentScenes: [],   // [{title, prompt, duration}]
            episodes: []         // [{no, synopsis, cliffhanger, scenes, createdAt}]
        };
    }

    loadSeries() {
        try {
            const s = localStorage.getItem('agnes_series');
            return s ? { ...this.getDefaultSeries(), ...JSON.parse(s) } : this.getDefaultSeries();
        } catch { return this.getDefaultSeries(); }
    }

    saveSeries() { localStorage.setItem('agnes_series', JSON.stringify(this.series)); }

    /** 文本模型客户端 (剧本AI): 默认复用视频平台端点与密钥 */
    llmClient() {
        const s = this.settings;
        const endpoint = (s.llmSameAsVideo === false ? s.llmEndpoint : '') || s.apiEndpoint;
        const apiKey = (s.llmSameAsVideo === false ? s.llmApiKey : '') || s.apiKey;
        if (!endpoint || !apiKey || !s.llmModel) return null;
        return new AgnesAPIClient({
            apiEndpoint: endpoint, apiKey,
            modelName: s.llmModel, apiFormat: 'auto',
            useProxy: this.serverMode
        });
    }

    async seriesChat(userPrompt) {
        const client = this.llmClient();
        if (!client) throw new Error('尚未配置剧本AI文本模型 (模型设置 → 剧本AI)');
        const content = await client.chat([
            { role: 'system', content: '你是一名专业短剧编剧兼分镜师，为AI文生视频工具编写分镜提示词。无论被要求什么，你都只输出一个JSON对象，禁止输出JSON以外的解释文字。JSON 字符串值内部禁止出现未转义的英文双引号 " —— 对白引用一律使用中文引号「」，以保证 JSON 合法。' },
            { role: 'user', content: userPrompt }
        ], { temperature: 0.8, maxTokens: 16384 });
        const obj = AgnesAPIClient.extractJson(content);
        if (!obj) {
            const c = String(content);
            throw new Error(`剧本AI未返回有效JSON (共${c.length}字，可能因输出长度被截断)。末尾内容: …${c.slice(-100)}`);
        }
        return obj;
    }

    /**
     * 剧本AI报错的补充提示。
     * 最常见的是"模型名不存在/该分组无渠道"(平台返回 503 no available channel) ——
     * 这不是重试能解决的问题, 直接把改法 + 平台可用模型列出来。
     */
    llmErrorHint(e) {
        if (!e) return '';
        let out = e.hint ? '\n💡 ' + e.hint : '';
        if (e.modelUnavailable && Array.isArray(this.availableModels) && this.availableModels.length) {
            out += '\n可用模型示例: ' + this.availableModels.slice(0, 8).join('、')
                + (this.availableModels.length > 8 ? ` …(共 ${this.availableModels.length} 个)` : '');
        }
        return out;
    }

    setSeriesStatus(msg, type = 'success') {
        const el = document.getElementById('series-status');
        if (el) {
            el.textContent = msg;
            el.className = 'status-message ' + type;
            el.style.display = 'block';
        } else this.showStatus(msg, type);
    }

    readSeriesForm() {
        const s = this.series;
        const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
        if (g('series-title') !== undefined) {
            s.title = (g('series-title') || '').trim();
            s.genre = g('series-genre') || s.genre;
            s.premise = (g('series-premise') || '').trim();
            s.scenesPerEpisode = Math.max(1, Math.min(12, parseInt(g('series-ep-count')) || 4));
            s.totalEpisodes = Math.max(1, Math.min(100, parseInt(g('series-total-episodes')) || 10));
            s.sceneDuration = Math.max(1, Math.min(60, parseInt(g('series-scene-duration')) || s.sceneDuration));
            if (g('series-resolution')) s.resolution = g('series-resolution');
            if (g('series-ratio')) s.ratio = g('series-ratio');
            const lock = document.getElementById('series-lock-chars');
            s.lockCharacters = lock ? lock.checked : true;
        }
        this.saveSeries();
    }

    characterLockText(c) {
        return `${c.name}（外貌：${c.look || '默认'}${c.outfit ? '；服装：' + c.outfit : ''}${c.voice ? '；声音：' + c.voice : ''}）`;
    }

    /**
     * 程序化人物一致性保障:
     * 分镜提到某人物但没有包含其锁定面孔描述时，自动把设定卡逐字补进提示词。
     */
    ensureCharacterConsistency(prompt, characters) {
        let out = String(prompt || '');
        for (const c of (characters || [])) {
            if (!c.name || !c.look) continue;
            if (out.includes(c.name) && !out.includes(c.look)) {
                out += `\n【人物一致性锁定】${this.characterLockText(c)}`;
            }
        }
        return out;
    }

    /* ---------- 人物设定卡 ---------- */

    /**
     * 从主提示词里识别"人物角色"名单。
     * 支持两种常见写法:
     *   1. 行内列举:  ...桥体危机四伏。人物：沈桥（少女）、司天官、阿婆
     *   2. 标签换行:  人物：\n 1. 沈桥 \n 2. 司天官
     * 只认带明确标签(人物/角色/主要人物…)的行, 不做模糊猜测 —— 猜错会凭空多出人物卡。
     * @returns {string[]} 人物姓名 (最多 12 个)
     */
    parseCastFromPremise(premise) {
        const text = String(premise || '');
        if (!text.trim()) return [];

        const LABEL = '(?:主要人物|主要角色|重要人物|关键人物|核心人物|登场人物|出场人物|人物设定|人物角色|人物|角色|卡司|cast)';
        // 主提示词通常是一整段文字, 标签可能跟在句号/逗号/空格之后, 所以不能只认行首
        const labelScanRe = new RegExp(`(?:^|[。！？!?；;，,\\n]\\s*|\\s)(${LABEL})\\s*[:：]\\s*([^。\\n]*)`, 'i');
        const labelHeadRe = new RegExp(`^\\s*${LABEL}\\s*[:：]`);
        const names = [];

        const push = (raw) => {
            const isCjk = /[\u4e00-\u9fa5]/.test(String(raw));
            let n = String(raw)
                .replace(/^(?:姓名|名字)\s*[:：]\s*/, '')
                .replace(/[\s"'“”「」]+/g, isCjk ? '' : ' ')   // 中文名去空格, 西文名保留词间空格
                .trim()
                .replace(/[。；;、,，.]+$/, '')
                .replace(/^(?:等|和|与|及)+/, '')
                .replace(/(?:等|等等)$/, '');
            if (!n) return;
            if (n.length > (isCjk ? 12 : 24)) return;
            if (/^(?:无|略|见上|同上|多名|若干|多人|待定)$/.test(n)) return;
            if (!names.includes(n)) names.push(n);
        };

        const splitInline = (inline) => {
            // 先去掉括号里的补充说明, 再切分 (括号里也会有逗号, 先切会把说明切碎)
            const cleaned = inline.replace(/[（(][^）)]*[）)]/g, '、');
            const hasLatin = /[A-Za-z]/.test(cleaned);
            return hasLatin
                ? cleaned.split(/[、,，/／|｜;；]+|\s+(?:and|&)\s+/i)
                : cleaned.split(/[、,，/／|｜;；]+|\s*(?:和|与|及)\s*|\s+/);
        };

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(labelScanRe);
            if (!m) continue;
            const inline = (m[2] || '').trim();
            if (inline) {
                splitInline(inline).forEach(push);
                continue;
            }
            // 标签后没写内容: 仅当标签独占一行时, 才往下读列表项/每行一个姓名
            if (!labelHeadRe.test(lines[i])) continue;
            for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
                const line = lines[j].trim();
                if (!line) break;
                if (labelScanRe.test(line)) break;
                const item = line.match(/^(?:\d+\s*[.、)）]|[-*•·])\s*(.+)$/);
                if (item) { push(item[1]); continue; }
                if (/[:：]/.test(line) || line.length > (/(?:[\u4e00-\u9fa5])/.test(line) ? 12 : 24)) break;
                push(line);
            }
        }
        return names.slice(0, 12);
    }

    /** 人物数是否按主提示词自动识别 */
    charCountAutoEnabled() {
        const el = document.getElementById('series-char-auto');
        return el ? el.checked : this.series.charCountAuto !== false;
    }

    /** 勾选状态变化: 记住选择, 并把自动识别结果回填到"人物数" */
    toggleCharCountAuto() {
        this.series.charCountAuto = this.charCountAutoEnabled();
        this.saveSeries();
        this.syncCharCountFromPremise();
    }

    /** 主提示词变化时把识别到的人物数回填到输入框 (自动模式才回填) */
    syncCharCountFromPremise() {
        const el = document.getElementById('series-char-count');
        if (!el) return;
        const auto = this.charCountAutoEnabled();
        el.disabled = auto;
        el.title = auto ? '由主提示词中的人物角色自动识别；取消勾选左侧选项可手动指定' : '手动指定人物卡数量';
        if (!auto) return;
        const premiseEl = document.getElementById('series-premise');
        const premise = premiseEl ? premiseEl.value : this.series.premise;
        // 主提示词没写人物名单时 (交给剧本AI识别), 回填已生成的人物卡数量 ——
        // 这样生成完就能直接看到"实际识别出几位", 而不是留空让人猜。
        const n = this.parseCastFromPremise(premise).length || (this.series.characters || []).length;
        el.value = n ? String(n) : '';
        el.placeholder = 'AI识别';
    }

    async generateCharacters() {
        this.readSeriesForm();
        const s = this.series;
        if (!s.premise.trim()) { this.setSeriesStatus('⚠️ 请先填写"世界观与主线提示词"', 'error'); return false; }
        this._lastSeriesError = null;

        // 人物数: 自动模式下由主提示词的人物角色决定 (识别不出时交给剧本AI判断),
        // 生成后再把实际人数回填到输入框, 用户随时可取消自动识别改为手填。
        const auto = this.charCountAutoEnabled();
        const cast = auto ? this.parseCastFromPremise(s.premise) : [];
        const manualCount = Math.max(1, Math.min(8, parseInt(document.getElementById('series-char-count')?.value) || 3));

        const castRule = !auto
            ? `请设计 ${manualCount} 个核心人物的设定卡。`
            : (cast.length
                ? `主提示词中已明确出现以下 ${cast.length} 位人物：${cast.join('、')}。`
                    + `请恰好为这 ${cast.length} 位人物各生成一张设定卡，姓名必须与主提示词完全一致，不要增加或减少人物。`
                : `请先从上面的世界观与主线中识别出全部主要人物（主角、对手、关键配角），`
                    + `为识别出的每一位各生成一张设定卡（最多 8 位，超过时只保留最重要的 8 位）。`
                    + `不要虚构主提示词里没有出现的人物，也不要漏掉已经出现的角色。`);

        this.setSeriesStatus(auto
            ? (cast.length ? `🧬 已按主提示词识别出 ${cast.length} 位人物，正在生成设定卡...` : '🧬 剧本AI正在从主提示词中识别人物并生成设定卡...')
            : '🧬 剧本AI正在设计人物设定卡...');
        try {
            const obj = await this.seriesChat(
`剧集：《${s.title || '未命名'}》（类型：${s.genre}）
世界观与主线：${s.premise}

${castRule}这些设定将在全剧每个分镜中逐字复用，用于保证人物面孔与声音的一致性，要求：
1. look：写死面孔与外形（年龄、脸型、五官、发型发色、肤色、体型、辨识标记），必须具体到可直接用于文生视频，禁止"美丽""帅气"等模糊词；
2. voice：写死声音（音色高低、语速、语气习惯、口音），对白分镜将据此保持音色一致；
3. outfit：写死服装（颜色、材质、款式、配饰），全剧不变；
4. tagline：一句话人物简介。
只输出JSON：{"characters":[{"name":"姓名","look":"...","voice":"...","outfit":"...","tagline":"..."}]}`);
            if (!Array.isArray(obj.characters) || obj.characters.length === 0) throw new Error('剧本AI未返回人物列表');
            s.characters = obj.characters.map(c => ({
                name: c.name || '角色',
                look: c.look || '',
                voice: c.voice || '',
                outfit: c.outfit || '',
                tagline: c.tagline || ''
            }));
            this.saveSeries();
            this.renderSeriesUI();
            const fromLabel = auto ? (cast.length ? `（按主提示词识别出的 ${cast.length} 位人物）` : '（由剧本AI从主提示词识别）') : '';
            this.setSeriesStatus(`✅ 已生成 ${s.characters.length} 个人物设定卡${fromLabel} (面孔/声音/服装全剧锁定)，可微调后使用`, 'success');
            return true;
        } catch (e) {
            console.error('人物设定生成失败:', e);
            this._lastSeriesError = e;
            this.setSeriesStatus('❌ 人物设定生成失败: ' + e.message + this.llmErrorHint(e), 'error');
            return false;
        }
    }

    addCharacter() {
        this.series.characters.push({ name: `人物${this.series.characters.length + 1}`, look: '', voice: '', outfit: '', tagline: '' });
        this.saveSeries();
        this.renderSeriesUI();
    }

    updateCharacter(i, field, value) {
        const c = this.series.characters[i];
        if (c) c[field] = value;
        this.saveSeries();
    }

    removeCharacter(i) {
        this.series.characters.splice(i, 1);
        this.saveSeries();
        this.renderSeriesUI();
    }

    /* ---------- 分镜剧本 ---------- */

    async generateEpisodeScript() {
        this.readSeriesForm();
        const s = this.series;
        if (s.nextEpisode > s.totalEpisodes) {
            this.setSeriesStatus(`✅ 本剧 ${s.totalEpisodes} 集已全部完结。如需续写，请在"剧集设定"中调大总集数`, 'warning');
            return false;
        }
        if (!s.premise.trim()) { this.setSeriesStatus('⚠️ 请先填写"世界观与主线提示词"', 'error'); return false; }
        if (!s.characters.length) { this.setSeriesStatus('⚠️ 请先生成或手动填写人物设定卡 (人物一致性依赖设定卡)', 'error'); return false; }
        const ep = s.nextEpisode;
        this.setSeriesStatus(`📝 剧本AI正在编写第 ${ep} 集完整剧本（含世界观更新 + 分镜详情）...`);
        try {
            const previous = s.episodes.slice(-3).map(e => `第${e.no}集「${e.title || ''}」：${e.synopsis}`).join('\n') || '（本剧第一集）';
            const lastCliff = s.episodes.length ? `\n上一集结尾悬念：${s.episodes[s.episodes.length - 1].cliffhanger}` : '';
            const totalEp = s.totalEpisodes || s.scenesPerEpisode;
            // 请求AI同时生成：精简版世界观更新 + 本集分镜
            const obj = await this.seriesChat(
`剧集：《${s.title || '未命名'}》（类型：${s.genre}）
世界观与主线（当前版本）：${s.premise}

人物设定卡（涉及人物的分镜必须逐字复用其外貌/服装/声音描述，不得改写或省略）：
${s.characters.map(c => '- ' + this.characterLockText(c)).join('\n')}

前情提要：
${previous}${lastCliff}

请完成以下两件事：

【任务一：更新世界观】
基于本集剧情发展，用 200~400 字精炼更新「世界观与主线」，覆盖本季核心矛盾、角色状态变化。直接输出纯文本，不要 JSON。

【任务二：编写本集分镜】
请编写第 ${ep} 集，拆分为恰好 ${s.scenesPerEpisode} 个连续分镜。要求：
1. 每个分镜 prompt 是可直接用于文生视频的独立完整描述（模型看不到其它分镜），必须包含：景别与机位、人物动作与表情、本分镜情节点、光影氛围、声音（对白用中文引号「」+ 音效描述）；prompt 中禁止出现英文双引号 "；
2. 全剧画面规格统一：比例 ${s.ratio}、分辨率 ${s.resolution}，请把画面比例写在每个分镜 prompt 开头；
3. 涉及人物时逐字复用设定卡的 look/voice/outfit 描述，确保人物面孔与声音在所有分镜中一致；
4. 画面全程禁止字幕、对话框、水印、UI文字；
5. 每个 scene 的 duration 必须严格等于 ${s.sceneDuration}（秒），全部分镜统一使用该时长，禁止输出其它数值；
6. 剧情承上启下，结尾留悬念。
只输出JSON：{"updatedPremise":"精炼后的世界观与主线(200-400字)","synopsis":"本集大纲(80字内)","cliffhanger":"下集悬念(30字内)","scenes":[{"title":"场景名","prompt":"完整分镜提示词","duration":${s.sceneDuration}}]}`);
            if (!obj.scenes || !Array.isArray(obj.scenes) || obj.scenes.length === 0) {
                throw new Error('剧本AI未返回分镜列表 (可能输出被截断，请重试一次，或在剧集设定中减少每集分镜数)');
            }
            // 更新世界观
            if (obj.updatedPremise) {
                s.premise = obj.updatedPremise.trim();
            }
            const truncated = obj.scenes.length < s.scenesPerEpisode;
            s.currentScenes = obj.scenes
                .map((sc, i) => ({
                    title: sc.title || `场景${i + 1}`,
                    prompt: this.ensureCharacterConsistency(sc.prompt || '', s.characters),
                    duration: Math.max(1, Math.min(60, parseInt(sc.duration) || s.sceneDuration))
                }))
                .filter(sc => sc.prompt.trim());
            s.episodes.push({
                no: ep,
                title: obj.synopsis || `第${ep}集`,
                synopsis: obj.synopsis || '',
                cliffhanger: obj.cliffhanger || '',
                scenes: s.currentScenes.map(x => ({ ...x })),
                createdAt: Date.now()
            });
            s.nextEpisode = ep + 1;
            this.saveSeries();
            // 回填主提示词框（更新后的世界观）
            const premiseEl = document.getElementById('series-premise');
            if (premiseEl && premiseEl.value !== s.premise) {
                premiseEl.value = s.premise;
            }
            this.renderSeriesUI();
            this._scriptGenerated = true;
            this._updateConfirmBtn();
            const truncNote = truncated ? ' ⚠️ 检测到剧本输出被截断，已自动修复并保留完整分镜；如缺场景可重新生成本集' : '';
            this.setSeriesStatus(`✅ 第 ${ep} 集剧本完成！世界观已更新，共 ${s.currentScenes.length} 个分镜，请确认后启动生成${truncNote}`, truncated ? 'warning' : 'success');
            return true;
        } catch (e) {
            console.error('剧本生成失败:', e);
            this._lastSeriesError = e;
            this.setSeriesStatus('❌ 剧本生成失败: ' + e.message + this.llmErrorHint(e), 'error');
            return false;
        }
    }

    addScene() {
        this.series.currentScenes.push({ title: `场景${this.series.currentScenes.length + 1}`, prompt: '', duration: this.series.sceneDuration });
        this.saveSeries();
        this.renderSeriesUI();
    }

    updateScene(i, field, value) {
        const sc = this.series.currentScenes[i];
        if (!sc) return;
        if (field === 'duration') {
            const dur = parseInt(value);
            sc[field] = (isNaN(dur) || dur < 1) ? this.series.sceneDuration : Math.min(60, dur);
        } else {
            sc[field] = value;
        }
        this.saveSeries();
    }

    removeScene(i) {
        this.series.currentScenes.splice(i, 1);
        this.saveSeries();
        this.renderSeriesUI();
    }

    /** 批量添加情景: 每行一个情景描述，自动并入人物锁定描述 */
    batchAddScenes() {
        const ta = document.getElementById('series-batch-scenes');
        if (!ta) return;
        const lines = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return this.setSeriesStatus('⚠️ 请输入情景，每行一个', 'error');
        lines.forEach(line => this.series.currentScenes.push({
            title: line.slice(0, 12),
            prompt: this.ensureCharacterConsistency(line, this.series.characters),
            duration: this.series.sceneDuration
        }));
        ta.value = '';
        this.saveSeries();
        this.renderSeriesUI();
        this.setSeriesStatus(`✅ 已批量添加 ${lines.length} 个情景分镜`, 'success');
    }

    /* ---------- AI写剧本 ---------- */
    /** 仅调用剧本AI生成下一集分镜，不自动触发视频生成 */
    async aiWriteScript() {
        if (this.isGenerating) return this.setSeriesStatus('⚠️ 已有任务在生成中，请等待完成', 'error');
        if (!this.llmClient()) {
            this.switchTab('models');
            return this.showStatus('⚠️ 请先在"模型设置 → 剧本AI"配置文本模型 ID', 'error');
        }
        this.readSeriesForm();
        if (!this.series.premise.trim()) return this.setSeriesStatus('⚠️ 请先填写"世界观与主线提示词"', 'error');

        // 若上一集刚生成分镜，先询问是否重新生成
        if (this.series.currentScenes.length > 0) {
            const okRetry = await this.showConfirm({
                title: '📝 重新生成剧本',
                message: `当前第 ${this.series.nextEpisode} 集已有待确认分镜，重新生成将覆盖当前内容。\n确认继续？`,
                okText: '🔄 重新生成',
                cancelText: '使用当前分镜'
            });
            if (okRetry === false) {
                // 用户选择使用当前分镜 → 直接跳转确认生成
                this.confirmAutoGenerate();
                return;
            }
        }

        if (this.series.characters.length === 0) {
            const okC = await this.generateCharacters();
            if (!okC) return;
        }

        const ok = await this.generateEpisodeScript();
        if (!ok) return;
        // 剧本生成成功后，提示用户确认
        this.showStatus('📖 剧本已生成，请在下方查看分镜内容，确认无误后点击"确认自动生成"启动视频生成', 'info');
    }

    /* ---------- 确认自动生成 ---------- */
    /** 用户确认剧本后，启动批量视频生成 */
    async confirmAutoGenerate() {
        this.readSeriesForm();
        const s = this.series;
        if (!this.apiClient) return this.setSeriesStatus('⚠️ 未配置视频生成 API，无法启动', 'error');
        if (s.currentScenes.length === 0) return this.setSeriesStatus('⚠️ 当前没有分镜，请先点击"AI写剧本"生成', 'warning');

        // 如果尚未生成剧本，提示用户
        if (!this._scriptGenerated) {
            const ok = await this.showConfirm({
                title: '▶️ 确认自动生成分镜视频',
                message: `剧集：《${s.title || '未命名'}》第 ${s.nextEpisode} 集\n`
                    + `将使用当前分镜列表（${s.currentScenes.length} 个场景）生成视频\n`
                    + `规格：${s.resolution} ${s.ratio}，合计约 ${s.currentScenes.reduce((a, sc) => a + (sc.duration || s.sceneDuration), 0)} 秒成片\n`
                    + `\n确认启动生成？`,
                okText: '🚀 确认生成'
            });
            if (!ok) return this.setSeriesStatus('已取消', 'warning');
        }
        await this.launchScenes();
        // 生成完成后重置剧本标记
        this._scriptGenerated = false;
        this._updateConfirmBtn();
    }

    _updateConfirmBtn() {
        const btn = document.getElementById('confirm-generate-btn');
        if (!btn) return;
        btn.disabled = !this._scriptGenerated || this.isGenerating;
        btn.textContent = this.isGenerating ? '⏳ 生成中...' : (this._scriptGenerated ? '✅ 确认自动生成' : '✅ 确认自动生成');
    }

    /* ---------- 一键生成下一集（兼容旧调用，仍为两步合一） ---------- */

    async generateNextEpisode() {
        if (this.isGenerating) return this.setSeriesStatus('⚠️ 已有任务在生成中，请等待完成', 'error');
        if (!this.llmClient()) {
            this.switchTab('models');
            return this.showStatus('⚠️ 请先在"模型设置 → 剧本AI"配置文本模型 ID', 'error');
        }
        this.readSeriesForm();
        if (!this.series.premise.trim()) return this.setSeriesStatus('⚠️ 请先填写"世界观与主线提示词"', 'error');

        // 防误点确认: 将消耗平台配额 (剧本AI + 一整集视频生成)
        const okStart = await this.showConfirm({
            title: '🚀 一键生成下一集',
            message: `剧集：《${this.series.title || '未命名'}》 将生成第 ${this.series.nextEpisode} 集：\n`
                + `· 编剧AI编写 ${this.series.scenesPerEpisode} 个分镜剧本\n`
                + `· 自动批量生成全部分镜视频并保存到本地\n`
                + `\n将消耗平台配额 (剧本AI + 视频生成)，确认开始？`,
            okText: '🚀 开始生成'
        });
        if (!okStart) return this.setSeriesStatus('已取消', 'warning');

        try {
            if (this.series.characters.length === 0) {
                const okC = await this.generateCharacters();
                if (!okC) return;
            }
            const ok = await this.generateEpisodeScript();
            if (!ok) return;
            await this.launchScenes();
        } catch (e) {
            console.error(e);
            this.setSeriesStatus('❌ 一键生成失败: ' + e.message, 'error');
        }
    }

    /* ---------- 中断续跑: 分镜完成度追踪 ---------- */

    /** 剧集标题的唯一生成处 (作品库记录、续跑匹配、合并目录名都以此为准)
     *  @param {object} [ser] 显式传入剧集对象, 避免依赖 this.series 的时序 (如清除前先取标题)
     */
    seriesEpisodeTitle(epNo, ser = null) {
        const s = ser || this.series;
        const seasonPrefix = (s.season || 1) > 1 ? `第${s.season}季` : '';
        return `${s.title || '短剧'}${seasonPrefix}第${epNo}集`;
    }

    /** 归属于某一部剧的作品库记录标题集合 (按剧集标题精确匹配, 不会误伤其它剧或手动提交的任务) */
    seriesRecordTitles(ser = null) {
        const s = ser || this.series;
        const titles = new Set();
        (s.episodes || []).forEach(ep => titles.add(this.seriesEpisodeTitle(ep.no, s)));
        // 还没写进 episodes 的"当前分镜"对应的那一集也要覆盖
        if ((s.currentScenes || []).length) titles.add(this.seriesEpisodeTitle(s.nextEpisode, s));
        return titles;
    }

    /**
     * "未完成"记录的统一判定 —— 未完成任务面板、任务扫描、清除剧本任务三处共用同一口径,
     * 避免出现"面板里看得到、清除时却漏掉"的不一致。
     */
    _isUnfinishedRecord(h) {
        if (!h || h.duplicateOf) return false; // 共享平台任务的副本只保留主记录
        const st = this.normalizeLegacyStatus(h.status);
        if (this.isPendingStatus(st) || st === 'unknown') return true;
        if (st === 'failed') return !!(h.request || h.apiTaskId); // 可重试的失败
        // 平台已生成但本地没落盘 (仅服务器模式可判定; 本地模式无 path 属正常情况)
        if (st === 'completed') return this.serverMode && !h.path && !!h.url;
        return false;
    }

    /** 某条作品库记录是否算"这个分镜已生成且片段在本地可用" */
    _isSceneSaved(h) {
        if (this.normalizeLegacyStatus(h.status) !== 'completed') return false;
        // 服务器模式必须真正落盘, 否则合并成片时会缺片段; 本地模式退回用平台地址判断
        return this.serverMode ? !!h.path : !!(h.path || h.url);
    }

    /**
     * 统计某一集的分镜完成情况。
     * 分镜 ↔ 作品库记录用内容指纹(提示词+时长+参考图)匹配, 与去重逻辑同源, 因此
     * 只要提示词没变, 重新运行也能认出"这个分镜早就生成过了"。
     *  @returns {{epNo,title,total,scenes,saved,unsaved,pending,done}}
     *    saved   已生成且片段在本地
     *    unsaved 平台已生成但片段没落盘 (只需重新下载, 不消耗生成配额)
     *    pending 还没生成成功 (需要提交平台)
     */
    episodeSceneProgress(ep) {
        const s = this.series;
        const epNo = ep.no;
        const title = this.seriesEpisodeTitle(epNo);
        const scenes = ep.scenes || [];
        const durOf = (sc) => sc.duration || s.sceneDuration;

        const byHash = new Map();
        this.history.forEach(h => {
            if (h.title !== title || h.duplicateOf) return;
            const hash = this._hashOf(h);
            if (!hash) return;
            const cur = byHash.get(hash);
            // 同一分镜可能有多条记录, 优先保留"已落盘"的那条
            if (!cur || (!this._isSceneSaved(cur) && this._isSceneSaved(h))) byHash.set(hash, h);
        });

        const saved = [], unsaved = [], pending = [];
        scenes.forEach(sc => {
            const rec = byHash.get(this.promptHash(sc.prompt + '|' + durOf(sc) + '|'));
            if (!rec) pending.push(sc);
            else if (this._isSceneSaved(rec)) saved.push({ scene: sc, record: rec });
            else unsaved.push({ scene: sc, record: rec });
        });
        return { epNo, title, total: scenes.length, scenes, saved, unsaved, pending, done: saved.length };
    }

    /**
     * 找出"剧本已写好、但分镜还没全部落盘"的剧集 (按集号升序)。
     * 断网、刷新页面、关闭应用造成的中断都能靠它找回 —— 这是"继续执行刚才中断的任务"的依据。
     */
    findIncompleteEpisodes() {
        return (this.series.episodes || [])
            .filter(ep => (ep.scenes || []).length > 0)
            .map(ep => this.episodeSceneProgress(ep))
            .filter(p => p.pending.length > 0 || p.unsaved.length > 0)
            .sort((a, b) => a.epNo - b.epNo);
    }

    /** 全剧挂机: 等待"未暂停"且当前没有其它生成批次在跑 */
    async _waitAutoSlot(label = '') {
        while (this._autoPaused && this._autoRunning) {
            this.setSeriesStatus(`⏸️ 已暂停${label ? ` (${label}尚未开始)` : ''}。点击"继续"恢复全剧生成...`, 'warning');
            await this.delay(1500);
        }
        while (this.isGenerating && this._autoRunning) {
            this.setSeriesStatus('⏳ 等待当前批次任务结束后开始下一集...', 'warning');
            await this.delay(2000);
        }
        // 刷新后恢复的挂机: 上一轮的任务还在轮询中, 等它们有结果再开始下一集,
        // 否则同一批分镜会被重复提交 (白耗配额)。
        while (this._autoRunning && !this.isGenerating
            && this._activeJobs && this._activeJobs.size > 0) {
            this.setSeriesStatus(`⏳ 等待上一轮 ${this._activeJobs.size} 个任务结束后继续...`, 'warning');
            await this.delay(2000);
        }
    }

    /* ================= 挂机运行痕迹: 刷新/断网/关页面都不丢任务 ================= */

    /**
     * 把"正在挂机"写进本地存储。
     *
     * 以前这是纯内存状态 (一个 for 循环 + _autoRunning 标记), 页面一刷新就什么都没了:
     * 用户看到的是"任务凭空消失", 既没有提醒, 也不知道该不该重来。
     * 现在的规矩: 只有用户点"⏹️ 停止全剧生成"才会清除痕迹, 其余情况 (刷新/断网/关页面)
     * 一律留下状态, 下次打开时接着跑。
     * @param {object} [patch] 要覆盖的字段; 传 {} 表示只刷新时间戳
     */
    saveRunState(patch = {}) {
        try {
            const prev = this.loadRunState() || {};
            const s = this.series || {};
            const st = Object.assign({
                active: !!this._autoRunning,
                paused: !!this._autoPaused,
                title: s.title || '',
                season: s.season || 1,
                ep: s.nextEpisode || 1,
                nextEpisode: s.nextEpisode || 1,
                totalEpisodes: s.totalEpisodes || 0,
                done: this._autoDone || 0,
                phase: 'generating',      // generating | waiting-network | stalled | done
                note: '',
                startedAt: prev.startedAt || Date.now(),
                updatedAt: Date.now(),
            }, prev, patch);
            st.updatedAt = Date.now();
            localStorage.setItem('agnes_auto_run', JSON.stringify(st));
            return st;
        } catch (_) { return null; }   // 存储写不进去不影响生成
    }

    loadRunState() {
        try {
            const raw = localStorage.getItem('agnes_auto_run');
            if (!raw) return null;
            const st = JSON.parse(raw);
            return (st && typeof st === 'object') ? st : null;
        } catch (_) { return null; }
    }

    clearRunState() {
        try { localStorage.removeItem('agnes_auto_run'); } catch (_) { /* 忽略 */ }
    }

    /** 把落盘状态说成人话 (用于提醒) */
    runStateText(st) {
        if (!st) return '';
        const ep = st.nextEpisode || st.ep || 1;
        const total = st.totalEpisodes ? ` / 共 ${st.totalEpisodes} 集` : '';
        const when = st.updatedAt ? new Date(st.updatedAt).toLocaleString('zh-CN') : '';
        const phase = { generating: '生成中', 'waiting-network': '等待网络', stalled: '卡住待处理', done: '已完成' }[st.phase] || '生成中';
        return `《${st.title || '未命名'}》第 ${ep} 集${total} · ${phase}`
            + (st.done ? ` · 已完成 ${st.done} 集` : '')
            + (when ? `\n（记录于 ${when}）` : '');
    }

    /**
     * 页面加载后, 按落盘痕迹决定怎么接着干。
     *   · 上次是"正在生成" → 直接继续 (刷新不该让挂机断掉, 只有用户点停止才算停)
     *   · 上次是"卡住"     → 弹提醒让用户选继续/停止 (卡住往往需要人看一眼, 不擅自烧配额)
     *   · 上次是"暂停"     → 恢复成暂停态, 等用户点继续
     */
    async resumeAutoRunOnLoad() {
        const st = this.loadRunState();
        if (!st || !st.active) return;
        this.setSeriesStatus(`♻️ 检测到上次未结束的挂机任务：${(this.runStateText(st) || '').split('\n')[0]}\n正在按记录继续...`, 'warning');

        if (!this._online) {
            // 联网后 onNetworkChange 会再次调用这里
            this.saveRunState({ phase: 'waiting-network', note: '等待网络恢复' });
            this.notifyAttention({
                key: 'resume-offline',
                title: '网络未连接，挂机任务已挂起',
                message: `上次的挂机任务还在：\n${this.runStateText(st)}\n\n`
                    + '已提交到平台的任务会在平台侧继续生成；本机网络恢复后会自动接着跑，'
                    + '不需要你重新点一次"一键生成本剧全部视频"。',
                level: 'warning',
                tab: 'workshop',
                actions: [
                    { text: '🔍 先扫描找回', cls: 'btn-secondary', run: () => this.scanTasks() },
                    { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
                ],
            });
            return;
        }

        if (st.phase === 'stalled') {
            this.notifyAttention({
                key: 'resume-stalled',
                title: '上次的挂机任务卡住了，要继续吗？',
                message: `上次停在这里：\n${this.runStateText(st)}\n\n`
                    + '已完成的分镜片段都保留着，不会重做也不会重复消耗配额（平台已生成完成的会直接取回）。',
                level: 'warning',
                tab: 'workshop',
                actions: [
                    { text: '🚀 继续生成', cls: 'btn-primary', run: () => this.autoGenerateAllSeries({ autoResume: true }) },
                    { text: '🔍 任务扫描并找回', cls: 'btn-secondary', run: () => this.scanTasks() },
                    { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
                ],
            });
            return;
        }

        // 暂停态: 恢复挂机状态但不往下跑
        if (st.paused) {
            this._autoRunning = true;
            this._autoPaused = true;
            this._autoDone = st.done || 0;
            this.showAutoRunControls(true);
            this.setSeriesStatus(`⏸️ 挂机任务已恢复为"暂停"状态 (${this.runStateText(st)})。点"▶️ 继续"开始跑下一集`, 'warning');
            return;
        }

        this.notifyAttention({
            key: 'resume-running',
            title: '正在继续上次未完成的挂机任务',
            message: `${this.runStateText(st)}\n\n`
                + '刷新或断网不会丢任务：已完成的片段会直接复用，缺的片段只补缺的那部分。\n'
                + '需要停下来时，请点"⏹️ 停止全剧生成"（会先跟你确认）。',
            level: 'success',
            tab: 'workshop',
            actions: [
                { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
            ],
        });
        await this.delay(600);      // 让提醒先显示出来, 再开始跑
        this.kickAutoLoop();
    }

    /**
     * 按需把挂机循环真正跑起来。
     * 为什么需要它: "正在挂机"有两种存在形式 —— 状态 (落盘/_autoRunning) 和真正在跑的 for 循环。
     * 刷新后恢复、暂停转继续、断网重连都属于"有状态但没有循环", 必须显式再启动一次,
     * 否则用户点了"▶️ 继续"或网络恢复了却什么都没发生。
     */
    kickAutoLoop() {
        if (this._autoPaused) return;          // 用户按了暂停: 不擅自开跑
        if (this._autoLoopActive) return;      // 循环已经在跑, 别开第二个
        this._autoRunning = false;             // 交回给 autoGenerateAllSeries 重新接管 (它自己会置 true)
        Promise.resolve(this.autoGenerateAllSeries({ autoResume: true }))
            .catch(e => console.warn('自动续跑失败:', e && e.message));
    }

    /** 挂机按钮组: 恢复页面时按落盘状态显示 */
    showAutoRunControls(running) {
        const startBtn = document.getElementById('auto-all-btn');
        if (startBtn) startBtn.disabled = !!running;
        const pauseBtn = document.getElementById('auto-pause-btn');
        if (pauseBtn) {
            pauseBtn.style.display = running ? '' : 'none';
            pauseBtn.textContent = this._autoPaused ? '▶️ 继续' : '⏸️ 暂停';
        }
        const stopBtn = document.getElementById('auto-stop-btn');
        if (stopBtn) stopBtn.style.display = running ? '' : 'none';
    }

    /* ================= 断网 / 重连 ================= */

    /** 网络状态变化: 挂机期间断网不中止任务, 恢复后自动接着跑 */
    onNetworkChange(isOnline) {
        const was = this._online;
        this._online = isOnline;
        if (isOnline) {
            if (!was) {
                const st = this.loadRunState();
                const hasRun = !!(st && st.active) || this._autoRunning;
                this.showStatus('🌐 网络已恢复', 'success');
                if (hasRun) {
                    this.notifyAttention({
                        key: 'net-back',
                        title: '网络已恢复，继续执行未完成的任务',
                        message: (this.runStateText(st) || '挂机任务进行中')
                            + '\n\n断网期间已提交到平台的任务不会白跑，恢复后会直接取回；'
                            + '缺的片段只补缺的那部分，不会整集重做。',
                        level: 'success',
                        tab: 'workshop',
                        actions: [
                            { text: '🔍 任务扫描并找回', cls: 'btn-secondary', run: () => this.scanTasks() },
                            { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
                        ],
                    });
                    // 循环还在跑的话它自己会从"等网络"里出来; 循环已经结束的 (刷新/卡住后)
                    // 这里重新把它跑起来
                    if (!this._autoLoopActive) this.kickAutoLoop();
                } else {
                    const un = this.getUnfinishedTasks();
                    if (un.all.length) {
                        this.notifyAttention({
                            key: 'net-back-unfinished',
                            title: '网络已恢复，还有未完成的任务',
                            message: `还有 ${un.all.length} 个任务没跑完，可以现在把它们接着做完。`,
                            level: 'warning',
                            tab: 'generate',
                            actions: [
                                { text: '🔄 全部重试', cls: 'btn-primary', run: () => this.retryAllUnfinished() },
                                { text: '🔍 任务扫描并找回', cls: 'btn-secondary', run: () => this.scanTasks() },
                            ],
                        });
                    }
                }
            }
            return;
        }
        // 断网
        if (was !== false) {
            this.showStatus('🌐 网络已断开：已提交到平台的任务会在平台侧继续，恢复后自动接着跑', 'warning');
            if (this._autoRunning) {
                this.saveRunState({ phase: 'waiting-network', note: '断网等待中' });
                this.setSeriesStatus('🌐 网络已断开，挂机不会中止：正在等待网络恢复 (期间不会重复提交任务)', 'warning');
            }
        }
    }

    /** 断网时挂机在这里等 (用户点停止/暂停则退出等待) */
    async waitForNetwork(label = '') {
        if (this._online) return this._autoRunning;
        const startedAt = Date.now();
        while (!this._online && this._autoRunning) {
            const mins = Math.floor((Date.now() - startedAt) / 60000);
            this.setSeriesStatus(`🌐 网络已断开，正在等待恢复${label ? `（${label}尚未开始）` : ''}`
                + `${mins > 0 ? ` · 已等 ${mins} 分钟` : ''}\n已提交到平台的任务不受影响；不想等了请点"⏹️ 停止全剧生成"`, 'warning');
            await this.delay(3000);
        }
        return this._autoRunning;
    }


    /**
     * 续跑一个中断的剧集 (不重新写剧本, 沿用已存的分镜提示词, 保证与已生成片段连贯):
     *  1. 平台已生成但没落盘的片段 -> 重新下载 (不消耗生成配额)
     *  2. 还没生成的分镜 -> 只提交这些缺失的分镜
     *  @returns {{remaining: null|object}} remaining 为 null 表示本集已补齐
     */
    async finishEpisodeProgress(prog) {
        // 1) 先补齐"平台上已生成、只是没下载下来"的片段
        const deadRecords = [];
        if (prog.unsaved.length) {
            this.setSeriesStatus(`📥 第 ${prog.epNo} 集：正在重新下载 ${prog.unsaved.length} 个已生成的片段...`);
            for (const item of prog.unsaved) {
                const rec = item.record;
                if (!rec || !rec.url) { if (rec) deadRecords.push(rec); continue; }
                await this.finalizeRecord(rec, rec.url);
                if (!rec.path) deadRecords.push(rec);   // 链接已过期/下载失败 -> 重新下载这条路走不通
            }
        }

        // 2) 下载不回来的片段 (没有地址 / 链接失效): 只能重新生成。
        //    否则这一集永远停在"待重新下载", 每点一次挂机都在原地打转 —— 用户看到的"死循环"就是这么来的。
        //    做法: 移除这些失效记录, 让对应分镜重新回到"待生成", 由下面的补生成流程重做。
        let remain = this.episodeSceneProgress({ no: prog.epNo, scenes: prog.scenes });
        const dead = remain.unsaved.filter(it => !it.record || !it.record.url).map(it => it.record)
            .concat(deadRecords.filter(Boolean))
            // 正在提交/监控中的记录不能当"失效"删掉: 那会把一次正在进行的重试打断,
            // 既浪费已消耗的配额, 记录也会凭空消失。
            .filter(r => r && !(this._activeJobs && this._activeJobs.has(r.id)));
        const deadIds = new Set(dead.map(r => r.id).filter(Boolean));
        if (deadIds.size && this._autoRunning) {
            this.history = this.history.filter(h => !deadIds.has(h.id));
            this.saveHistory();
            this.renderGallery();
            this.setSeriesStatus(`♻️ 第 ${prog.epNo} 集：${deadIds.size} 个片段的平台链接已失效，改为重新生成 (会消耗配额)...`);
            remain = this.episodeSceneProgress({ no: prog.epNo, scenes: prog.scenes });
        }

        // 3) 补生成缺失的分镜 (只提交缺失部分, 已有的分镜不会被重复生成)
        if (remain.pending.length && this._autoRunning) {
            this.setSeriesStatus(`🎬 第 ${prog.epNo} 集：补生成 ${remain.pending.length} 个缺失分镜 (已完成 ${remain.done}/${remain.total})...`);
            await this.launchScenes(true, { epNo: prog.epNo, title: prog.title, scenes: remain.pending });
            remain = this.episodeSceneProgress({ no: prog.epNo, scenes: prog.scenes });
        }

        if (remain.pending.length + remain.unsaved.length === 0) return { remaining: null };
        return {
            remaining: {
                epNo: prog.epNo, title: prog.title, total: prog.total, done: remain.done,
                pendingCount: remain.pending.length, unsavedCount: remain.unsaved.length
            }
        };
    }

    /** 用当前分镜启动批量视频生成 (复用统一生成管线); skipConfirm=true 供全剧挂机内部调用
     *  @param {object} [spec] 续跑中断剧集时指定 {epNo, title, scenes}, 不再依赖 currentScenes
     */
    async launchScenes(skipConfirm = false, spec = null) {
        const s = this.series;
        const scenes = (spec && spec.scenes) ? spec.scenes : s.currentScenes;
        if (scenes.length === 0) return this.setSeriesStatus('⚠️ 当前没有分镜，请先生成剧本或批量添加情景', 'error');
        if (!this.apiClient) return this.setSeriesStatus('⚠️ 未配置视频生成 API，无法启动', 'error');

        const epNo = (spec && spec.epNo) || (s.episodes.length ? s.episodes[s.episodes.length - 1].no : s.nextEpisode);
        const config = {
            title: (spec && spec.title) || this.seriesEpisodeTitle(epNo),
            duration: s.sceneDuration,
            resolution: s.resolution || (document.getElementById('resolution')?.value) || '720p',
            ratio: s.ratio || (document.getElementById('ratio')?.value) || '16:9',
            batchCount: 1
        };

        // 防误点确认 (全剧挂机内部调用时跳过)
        if (!skipConfirm) {
            const totalSec = scenes.reduce((a, sc) => a + (sc.duration || s.sceneDuration), 0);
            const ok = await this.showConfirm({
                title: '▶️ 用当前分镜启动生成',
                message: `剧集：《${config.title}》\n`
                    + `将提交 ${scenes.length} 个分镜到视频生成管线\n`
                    + `规格：${config.resolution} ${config.ratio}，合计约 ${totalSec} 秒成片\n`
                    + `\n将消耗平台配额，免费档会自动排队限速。确认启动？`,
                okText: '🚀 启动生成'
            });
            if (!ok) return this.setSeriesStatus('已取消启动', 'warning');
        }
        // 同步到批量生成表单，界面状态一致
        const t = document.getElementById('title'); if (t && !t.value) t.value = config.title;
        const d = document.getElementById('duration'); if (d) d.value = config.duration;

        const jobs = scenes.map((sc, i) => ({
            prompt: sc.prompt,
            label: sc.title ? ` ${sc.title}` : '',
            seq: i + 1,
            duration: sc.duration || s.sceneDuration
        }));
        this.setSeriesStatus(`🚀 正在生成《${config.title}》: ${jobs.length} 个分镜已提交视频生成管线...`);
        // 启动生成时自动开启 ASR + 中文字幕烧录 + 合并成片（不删除分镜片段）
        // 用 forcePostProcess 直接传入, 不再临时改写"自动合并"开关 (避免与异步后期处理互相干扰)
        return this.runGeneration(config, jobs, config.title, { forcePostProcess: true });
    }

    /* ================= 一键生成全剧 (懒人挂机模式) ================= */

    /**
     * 全自动生成全剧: 从下一集循环"编剧AI写剧本 -> 批量生成该集全部分镜视频"直到总集数完结。
     * 期间可暂停/继续 (当前集完成后生效) 或停止; 启动前弹确认对话框。
     */
    async autoGenerateAllSeries(opts = {}) {
        const autoResume = !!opts.autoResume;   // 由"刷新/断网后按落盘痕迹恢复"调用: 不再弹确认框
        if (this._autoRunning) return this.setSeriesStatus('⚠️ 全剧自动生成已在运行中', 'error');
        if (this.isGenerating) return this.setSeriesStatus('⚠️ 已有任务在生成中，请等待完成后再启动全剧生成', 'error');
        if (!this.llmClient()) {
            this.switchTab('models');
            return this.showStatus('⚠️ 请先在"模型设置 → 剧本AI"配置文本模型 ID', 'error');
        }
        if (!this.apiClient) return this.setSeriesStatus('⚠️ 未配置视频生成 API，无法启动', 'error');

        this.readSeriesForm();
        const s = this.series;
        if (!s.premise.trim()) return this.setSeriesStatus('⚠️ 请先填写"世界观与主线提示词"', 'error');

        // 先找回"已写剧本但分镜没跑完"的剧集 (断网/刷新/关闭应用导致的中断)
        const resumeList = this.findIncompleteEpisodes();
        const from = s.nextEpisode;
        const to = Math.max(from, s.totalEpisodes);
        const hasNewEpisodes = s.nextEpisode <= s.totalEpisodes;

        if (!hasNewEpisodes && resumeList.length === 0) {
            this.clearRunState();   // 确实没有要干的了, 痕迹可以清掉
            return this.setSeriesStatus(`✅ 本剧 ${s.totalEpisodes} 集已全部生成。如需续写请在"剧集设定"中调大总集数`, 'success');
        }

        const newCount = hasNewEpisodes ? (to - from + 1) : 0;
        const totalUnits = resumeList.length + newCount;
        const sumPending = resumeList.reduce((a, p) => a + p.pending.length, 0);
        const sumUnsaved = resumeList.reduce((a, p) => a + p.unsaved.length, 0);

        let msg = `剧集：《${s.title || '未命名'}》\n`;
        if (resumeList.length) {
            msg += `\n♻️ 检测到 ${resumeList.length} 个中断的剧集，将先续跑 (沿用已保存的分镜，不重新写剧本)：\n`;
            resumeList.slice(0, 8).forEach(p => {
                msg += `   · 第 ${p.epNo} 集：已完成 ${p.done}/${p.total}`
                    + (p.unsaved.length ? `，待重新下载 ${p.unsaved.length}` : '')
                    + (p.pending.length ? `，待生成 ${p.pending.length}` : '') + `\n`;
            });
            if (resumeList.length > 8) msg += `   · ... 还有 ${resumeList.length - 8} 个剧集\n`;
            msg += `   合计：补生成 ${sumPending} 个分镜、先尝试重新下载 ${sumUnsaved} 个片段\n`
                + `   （能下回来的直接保存；平台链接已失效的会改为重新生成，这部分会消耗配额）\n`;
        }
        if (hasNewEpisodes) {
            msg += `\n新剧集范围：第 ${from} 集 ~ 第 ${to} 集 (共 ${newCount} 集)\n`;
        }
        msg += `每集：${s.scenesPerEpisode} 个分镜 × ${s.sceneDuration}秒, ${s.resolution} ${s.ratio}\n`
            + `\n全自动流程：先续跑中断的剧集，再循环"编剧AI写剧本 → 批量生成全部分镜视频"直到完结。\n`
            + `期间断网不会丢任务：会自动等待网络恢复后接着跑，已提交到平台的任务照常取回。\n`
            + `刷新/关闭页面也不会丢：下次打开会按记录自动继续（只有你点"⏹️ 停止全剧生成"才算停止）。\n`
            + `期间可随时【暂停/继续】(当前集完成后生效) 或【停止】。\n`
            + `注意：将连续消耗平台配额，免费档每集约需数分钟甚至更久，挂机等待即可。`;
        if (!autoResume) {
            const ok = await this.showConfirm({
                title: '🚀💤 启用一键生成本剧全部视频',
                message: msg,
                okText: '🚀 确定启用',
                cancelText: '取消'
            });
            if (!ok) return this.setSeriesStatus('已取消全剧生成', 'warning');
        }

        // 一键挂机模式默认开启自动合并 (不写入 localStorage，手动模式仍保持用户原有选择)
        const _originalAutoMerge = localStorage.getItem('autoMergeEnabled') === 'true';
        localStorage.setItem('autoMergeEnabled', 'true');
        this._syncAutoMergeUI();  // 立即同步 UI 复选框

        this._autoRunning = true;
        this._autoPaused = false;
        this._autoDone = 0;
        this._autoLoopActive = true;
        this.showAutoRunControls(true);
        this.switchTab('workshop');
        // 落盘"正在挂机": 只有用户点停止才会清掉 (刷新/断网/关页面都留痕)
        this.saveRunState({ active: true, paused: false, phase: 'generating', done: 0, note: '', startedAt: (this.loadRunState() || {}).startedAt || Date.now() });

        let done = 0;
        let stalled = null; // 因分镜没跑完而中止的剧集 (绝不能再往后跳, 否则这些分镜会永久丢失)
        try {
            // ---------- 阶段 1: 先续跑中断的剧集 (复用已存分镜, 不重新写剧本、不重复消耗配额) ----------
            for (const prog of resumeList) {
                if (!this._autoRunning) break;
                await this._waitAutoSlot(`第 ${prog.epNo} 集`);
                if (!this._autoRunning) break;
                // 断网不中止挂机: 等网络恢复再续跑这一集
                if (!await this.waitForNetwork(`第 ${prog.epNo} 集`)) break;
                this.saveRunState({ phase: 'generating', ep: prog.epNo, nextEpisode: prog.epNo, done });

                this.setSeriesStatus(`♻️ 续跑中断的第 ${prog.epNo} 集：已完成 ${prog.done}/${prog.total}`
                    + (prog.unsaved.length ? `，先重新下载 ${prog.unsaved.length} 个片段` : '')
                    + (prog.pending.length ? `，再补生成 ${prog.pending.length} 个分镜` : '') + '...');
                const r = await this.finishEpisodeProgress(prog);
                if (!r.remaining) {
                    done++;
                    this._autoDone = done;
                    this.saveRunState({ phase: 'generating', ep: prog.epNo, nextEpisode: prog.epNo, done });
                    this.setSeriesStatus(`✅ 第 ${prog.epNo} 集已补齐 (${done}/${totalUnits})，继续下一集...`, 'success');
                    // 这一集是靠"重新下载"补齐的 (没有重新生成, 因此不会走生成结束后的合并流程),
                    // 这里补合并, 否则用户会发现片段齐了却没有成片
                    await this.ensureEpisodeMerged(prog.title);
                    continue;
                }
                stalled = r.remaining;
                break;
            }

            // ---------- 阶段 2: 生成新剧集 ----------
            if (this._autoRunning && !stalled && hasNewEpisodes) {
                for (let ep = from; ep <= to; ep++) {
                    if (!this._autoRunning) break;
                    await this._waitAutoSlot(`第 ${ep} 集`);
                    if (!this._autoRunning) break;
                    // 断网不中止挂机: 在这里等网络恢复 (用户不点停止就一直等)
                    if (!await this.waitForNetwork(`第 ${ep} 集`)) break;

                    this._autoDone = done;
                    this.saveRunState({ phase: 'generating', ep, nextEpisode: ep, done });
                    this.setSeriesStatus(`🤖 全剧生成中 [${done + 1}/${totalUnits}]：编剧AI正在编写第 ${ep} 集...`);
                    if (s.characters.length === 0) {
                        const okC = await this.generateCharacters();
                        if (!okC) throw new Error('人物设定卡生成失败'
                            + (this._lastSeriesError ? `: ${this._lastSeriesError.message}` : '') + this.llmErrorHint(this._lastSeriesError));
                    }
                    const okScript = await this.generateEpisodeScript();
                    if (!okScript) throw new Error(`第 ${ep} 集剧本生成失败 (已完成 ${done} 集，其余可稍后手动继续)`
                        + this.llmErrorHint(this._lastSeriesError));
                    await this.launchScenes(true); // 挂机模式: 跳过单集确认对话框
                    done++;
                    this._autoDone = done;
                    this.saveRunState({ phase: 'generating', ep, nextEpisode: ep, done });

                    // 关键校验: 本集若仍有分镜没落盘, 立即中止而不是跳到下一集,
                    // 否则中断的那一集会被 nextEpisode 跳过, 分镜片段永久丢失。
                    let prog = this.episodeSceneProgress({ no: ep, scenes: s.currentScenes });
                    // 分镜没齐 + 当前断网 -> 这不是"失败", 是网络问题。等网络回来后把这一集补完再往下走,
                    // 而不是把用户丢在"第 N 集未跑完"的提醒里 (挂机就该扛住这种抖动)。
                    if ((prog.pending.length || prog.unsaved.length) && !this._online) {
                        this.saveRunState({ phase: 'waiting-network', ep, nextEpisode: ep, done, note: `第 ${ep} 集等网络` });
                        if (!await this.waitForNetwork(`第 ${ep} 集补缺`)) break;
                        await this.finishEpisodeProgress(prog);
                        prog = this.episodeSceneProgress({ no: ep, scenes: s.currentScenes });
                    }
                    if (prog.pending.length || prog.unsaved.length) {
                        stalled = {
                            epNo: ep, title: prog.title, total: prog.total, done: prog.done,
                            pendingCount: prog.pending.length, unsavedCount: prog.unsaved.length
                        };
                        break;
                    }
                    // 本集分镜已齐: 确保成片真的出来了 (以前只有生成入口会合并,
                    // 走"重新下载补齐"的集会出现"片段齐了却没有成片")
                    await this.ensureEpisodeMerged(prog.title);
                    this.setSeriesStatus(`✅ 第 ${ep} 集完成 (${done}/${totalUnits})${ep < to ? '，即将开始下一集...' : ''}`);
                }
            }

            // ---------- 收尾 ----------
            if (stalled) {
                const detail = `已完成 ${stalled.done}/${stalled.total} 个分镜`
                    + `${stalled.pendingCount ? `，待生成 ${stalled.pendingCount}` : ''}`
                    + `${stalled.unsavedCount ? `，待重新下载 ${stalled.unsavedCount}` : ''}`;

                // 同一处卡住反复出现时, 不再给"继续生成"按钮 ——
                // 否则用户点一次、立刻又卡在同一处, 两个对话框来回弹, 看着就是死循环。
                const stallKey = `${stalled.epNo}|${stalled.done}/${stalled.total}|${stalled.pendingCount}|${stalled.unsavedCount}`;
                this._stallRepeats = (this._lastStallKey === stallKey) ? (this._stallRepeats || 1) + 1 : 1;
                this._lastStallKey = stallKey;
                const worthRetrying = this._stallRepeats < 2;

                const hint = worthRetrying
                    ? `已完成的分镜片段全部保留，不会丢失。可以先"🔍 任务扫描"找回未完成任务并重试，`
                        + `再点"🚀💤 一键生成本剧全部视频"从第 ${stalled.epNo} 集继续。`
                    : `第 ${this._stallRepeats} 次卡在同一处：直接再点"继续生成"不会有变化，`
                        + `请先在"未完成任务"面板里把这 ${stalled.pendingCount + stalled.unsavedCount} 个分镜处理掉`
                        + `（点单条"🔄 重试"重新生成，或删除不需要的分镜），再继续。`;
                // 卡住了: 留下痕迹 (active 仍为 true, phase=stalled), 下次打开会提示"要不要接着跑"
                this.saveRunState({
                    active: true, phase: 'stalled', done,
                    ep: stalled.epNo, nextEpisode: stalled.epNo,
                    note: `第 ${stalled.epNo} 集未跑完`,
                });
                this.setSeriesStatus(`⚠️ 第 ${stalled.epNo} 集未跑完 (${detail})，全剧生成已暂停。\n${hint}`, 'warning');

                this.notifyAttention({
                    key: `stall:${stallKey}`,
                    title: `第 ${stalled.epNo} 集未跑完，全剧生成已暂停`,
                    message: `${detail}。\n\n${hint}\n\n`
                        + '这条进度已记下来：关掉页面或刷新后，下次打开会问你要不要接着跑。',
                    level: 'warning',
                    tab: 'generate',   // 未完成任务面板与扫描进度都在"批量生成"页
                    actions: [
                        { text: '📋 查看未完成任务', cls: 'btn-primary', run: () => this._showUnfinishedPanel() },
                        { text: '🔍 任务扫描并找回', cls: 'btn-secondary', run: () => this.scanTasks() },
                        ...(worthRetrying ? [{ text: '🚀 继续全剧生成', cls: 'btn-secondary', run: () => this.autoGenerateAllSeries() }] : []),
                        { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
                    ],
                });
            } else if (this._autoRunning) {
                const doneMsg = `🎉 全剧自动生成完成！共完成 ${done} 集, 视频已保存到 ${this.serverOutputDir || '设置的保存位置'}\\video\\`;
                this.setSeriesStatus(doneMsg, 'success');
                this.clearRunState();   // 跑完了, 痕迹清掉, 下次打开不该再自动续跑
                this._autoRunning = false;   // 走到这里说明是正常跑完, 不是被用户停止
                if (document.hidden) {
                    this.notifyAttention({
                        title: '全剧自动生成完成',
                        message: `共完成 ${done} 集，视频已保存到 ${this.serverOutputDir || '设置的保存位置'}\\video\\`,
                        level: 'success', tab: 'workshop',
                    });
                }
            } else {
                this.setSeriesStatus(`⏹️ 全剧生成已停止 (完成 ${done} 集)。已完成内容保留，可随时继续`, 'warning');
            }
        } catch (e) {
            console.error('全剧自动生成失败:', e);
            // 中断了但没完成: 留下痕迹, 下次打开还能接着跑 (用户没点停止就不算结束)
            this.saveRunState({ active: true, phase: 'stalled', done, note: `中断: ${e.message}` });
            this.setSeriesStatus(`❌ 全剧生成中止: ${e.message} (已完成 ${done} 集保留，可再次点击本按钮继续)`, 'error');
            this.notifyAttention({
                title: '全剧生成已中止',
                message: `${e.message}\n\n已完成 ${done} 集的内容全部保留，可修复原因后继续。\n`
                    + '（这条记录已保存：下次打开页面会提示你接着跑，不会凭空丢掉）',
                level: 'error',
                tab: 'workshop',
                actions: [
                    { text: '🔍 任务扫描并找回', cls: 'btn-primary', run: () => this.scanTasks() },
                    { text: '🚀 继续全剧生成', cls: 'btn-secondary', run: () => this.autoGenerateAllSeries() },
                    { text: '⏹️ 停止挂机', cls: 'btn-secondary', run: () => this.stopAutoRun() },
                ],
            });
        } finally {
            // 恢复一键挂机前的自动合并设置
            if (!_originalAutoMerge) localStorage.removeItem('autoMergeEnabled');
            this._syncAutoMergeUI();  // 同步还原 UI 复选框
            const stopped = !this._autoRunning;
            this._autoLoopActive = false;
            this._autoRunning = false;
            this._autoPaused = false;
            this.showAutoRunControls(false);
            if (stopped) this.clearRunState();          // 只有"用户点了停止"或"真的跑完"才清痕迹
            else this.saveRunState({ active: true });   // 其余情况保留, 下次接着跑
            this.renderSeriesUI();
        }
    }

    async toggleAutoPause() {
        if (!this._autoRunning) return;
        // 防误点: 暂停需确认 (继续操作可逆, 不加确认)
        if (!this._autoPaused) {
            const ok = await this.showConfirm({
                title: '⏸️ 暂停全剧生成',
                message: '将在当前集完成后暂停，不再开始新的一集。\n已提交的任务会正常跑完，可随时点击"继续"恢复。',
                okText: '⏸️ 确定暂停'
            });
            if (!ok) return;
        }
        this._autoPaused = !this._autoPaused;
        this.saveRunState({ active: true, paused: this._autoPaused, phase: this._autoPaused ? 'paused' : 'generating' });
        const btn = document.getElementById('auto-pause-btn');
        if (btn) btn.textContent = this._autoPaused ? '▶️ 继续' : '⏸️ 暂停';
        if (!this._autoPaused) {
            this.setSeriesStatus('▶️ 已继续全剧生成', 'success');
            this.kickAutoLoop();   // 刷新后恢复的"暂停"没有循环, 点继续要真的开跑
        }
    }

    async stopAutoRun() {
        if (!this._autoRunning) return;
        const ok = await this.showConfirm({
            title: '⏹️ 停止全剧自动生成',
            message: '这是唯一会中断挂机的操作（刷新、断网、关页面都不会）。\n\n'
                + '当前正在生成的任务也会停止，已完成的集数与片段全部保留；\n'
                + '停止后不会再自动续跑，下次需要你重新点"🚀💤 一键生成本剧全部视频"。',
            okText: '⏹️ 确定停止',
            danger: true
        });
        if (!ok) return;
        this._autoRunning = false;
        this._autoPaused = false;
        this.stopRequested = true; // 中断当前集的任务监控
        this.clearRunState();       // 用户明确停止: 痕迹清掉, 下次打开不再自动续跑
        this.setSeriesStatus('⏹️ 正在停止全剧生成...(已完成的集数与片段保留)', 'warning');
    }

    /** 应用内输入对话框 (存档命名等): 返回 Promise<string|null> */
    showPrompt({ title = '输入', message = '', label = '名称', value = '', okText = '确定' } = {}) {
        return new Promise(resolve => {
            const modal = document.getElementById('confirm-modal');
            if (!modal) { resolve(window.prompt(message + '\n' + label, value)); return; }
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').innerHTML = String(message).split('\n')
                .map(l => l.trim() ? `<div class="confirm-line">${this.escapeHtml(l)}</div>` : '<div class="confirm-gap"></div>')
                .join('');
            const wrap = document.getElementById('confirm-input-wrap');
            const labelEl = document.getElementById('confirm-input-label');
            const input = document.getElementById('confirm-input');
            wrap.style.display = 'block';
            labelEl.textContent = label;
            input.value = value || '';
            const ok = document.getElementById('confirm-ok-btn');
            const cancel = document.getElementById('confirm-cancel-btn');
            ok.textContent = okText;
            cancel.textContent = '取消';
            ok.className = 'btn btn-primary';
            modal.style.display = 'block';
            setTimeout(() => { input.focus(); input.select(); }, 50);

            const done = (val) => {
                modal.style.display = 'none';
                wrap.style.display = 'none';
                ok.onclick = null; cancel.onclick = null; modal.onclick = null;
                resolve(val);
            };
            ok.onclick = () => done(input.value.trim() || null);
            cancel.onclick = () => done(null);
            modal.onclick = (e) => { if (e.target === modal) done(null); };
        });
    }

    /* ================= 剧本存档 (跨季延续人物一致性) ================= */

    getArchives() {
        try { return JSON.parse(localStorage.getItem('agnes_series_archives') || '[]') || []; }
        catch { return []; }
    }

    saveArchives(list) { localStorage.setItem('agnes_series_archives', JSON.stringify(list)); }

    async saveSeriesArchive() {
        const s = this.series;
        if (!s.title && !s.premise && !s.characters.length) return this.showStatus('当前剧本为空，无需存档', 'warning');
        const defaultName = `${s.title || '未命名剧本'} 第${s.season || 1}季·至第${Math.max(0, Math.min(s.nextEpisode - 1, s.totalEpisodes))}集`;
        const name = await this.showPrompt({
            title: '💾 保存剧本存档',
            message: `将保存：剧集设定与主提示词、${s.characters.length} 个人物设定卡 (面孔/声音锁定)、${s.episodes.length} 集剧本历史。\n存档可在以后导入，延续人物一致性生成续季。`,
            label: '存档名称',
            value: defaultName,
            okText: '💾 保存存档'
        });
        if (!name) return;

        const list = this.getArchives();
        list.unshift({
            id: 'arch_' + Date.now(),
            name,
            savedAt: Date.now(),
            summary: { characters: s.characters.length, episodes: s.episodes.length, nextEpisode: s.nextEpisode, totalEpisodes: s.totalEpisodes, season: s.season || 1 },
            data: JSON.parse(JSON.stringify(s))
        });
        this.saveArchives(list);
        this.renderSeriesArchives();
        this.showStatus(`✅ 剧本存档已保存: ${name}`, 'success');
    }

    async loadSeriesArchive(id) {
        const arch = this.getArchives().find(a => a.id === id);
        if (!arch || !arch.data) return this.showStatus('存档不存在或已损坏', 'error');
        if (this.isGenerating) return this.showStatus('⚠️ 生成进行中，无法导入存档', 'error');
        const d = arch.data;
        const newSeason = (d.season || 1) + 1;
        const hasCur = this.series.title || this.series.premise || this.series.characters.length || this.series.episodes.length;
        const ok = await this.showConfirm({
            title: `📤 启用存档: ${arch.name}`,
            message: `将载入《${d.title || '未命名'}》的剧集设定与 ${d.characters.length} 个人物设定卡。\n`
                + `人物面孔/声音锁定描述原样保留 —— 保证续季人物一致性。\n`
                + `导入后：进入第 ${newSeason} 季，从第 1 集开始生成 (共 ${d.totalEpisodes} 集)，原集数历史仍保留在本存档中。\n`
                + (hasCur ? '\n⚠️ 当前工坊未保存的修改将被覆盖 (建议先点"保存当前剧本存档")。' : ''),
            okText: `📤 导入并开始第 ${newSeason} 季`
        });
        if (!ok) return;

        this.series = {
            ...this.getDefaultSeries(),
            ...JSON.parse(JSON.stringify(d)),
            season: newSeason,
            nextEpisode: 1,
            episodes: [],
            currentScenes: []
        };
        this.saveSeries();
        this.renderSeriesUI();
        this.setSeriesStatus(`✅ 已启用《${d.title || '未命名'}》第 ${newSeason} 季: ${this.series.characters.length} 个人物锁定已继承，从第 1 集开始。可直接"一键生成下一集"或挂机`, 'success');
    }

    async deleteSeriesArchive(id) {
        const arch = this.getArchives().find(a => a.id === id);
        if (!arch) return;
        const ok = await this.showConfirm({
            title: '🗑️ 删除剧本存档',
            message: `确定删除存档「${arch.name}」吗？删除后无法用该存档延续人物一致性，此操作不可恢复。`,
            okText: '删除',
            danger: true
        });
        if (!ok) return;
        this.saveArchives(this.getArchives().filter(a => a.id !== id));
        this.renderSeriesArchives();
        this.showStatus('🗑️ 存档已删除', 'success');
    }

    exportSeriesArchive(id) {
        const arch = this.getArchives().find(a => a.id === id);
        if (!arch) return;
        const blob = new Blob([JSON.stringify(arch, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `剧本存档_${arch.name}.json`.replace(/[<>:"/\\|?*]/g, '_');
        a.click();
        URL.revokeObjectURL(url);
    }

    async importSeriesArchiveFile(inputEl) {
        const file = inputEl && inputEl.files && inputEl.files[0];
        if (!file) return;
        try {
            const obj = JSON.parse(await file.text());
            const data = obj.data || obj;
            if (!Array.isArray(data.characters) || !data.characters.length) {
                throw new Error('不是有效的剧本存档 (缺少人物设定卡)');
            }
            const list = this.getArchives();
            const name = `${obj.name || `${data.title || '导入剧本'} 第${data.season || 1}季`} (导入)`;
            list.unshift({
                id: 'arch_' + Date.now(),
                name,
                savedAt: Date.now(),
                summary: { characters: data.characters.length, episodes: (data.episodes || []).length, nextEpisode: data.nextEpisode, totalEpisodes: data.totalEpisodes, season: data.season || 1 },
                data
            });
            this.saveArchives(list);
            this.renderSeriesArchives();
            this.showStatus(`✅ 存档文件已导入: ${name}，点击"启用存档"即可延续生成续季`, 'success');
        } catch (e) {
            this.showStatus('❌ 导入失败: ' + e.message, 'error');
        } finally {
            inputEl.value = '';
        }
    }

    renderSeriesArchives() {
        const list = this.getArchives();
        const wrap = document.getElementById('archives-list');
        if (!wrap) return;
        if (list.length === 0) {
            wrap.innerHTML = '<p class="empty-hint">暂无存档。当前剧本完成后，点"保存当前剧本存档"为续季留档。</p>';
            return;
        }
        wrap.innerHTML = list.map(a => {
            const sum = a.summary || {};
            const date = new Date(a.savedAt).toLocaleString('zh-CN');
            return `
            <div class="archive-item">
                <div class="archive-info">
                    <div class="archive-name">📚 ${this.escapeHtml(a.name)}</div>
                    <div class="archive-meta">${sum.characters || 0} 个人物锁定 · ${sum.episodes || 0} 集历史 · 进度第 ${sum.nextEpisode || 1} 集 · 保存于 ${date}</div>
                </div>
                <div class="archive-actions">
                    <button class="btn btn-small btn-primary" onclick="generator.loadSeriesArchive('${a.id}')">📤 启用续季</button>
                    <button class="btn btn-small btn-secondary" onclick="generator.exportSeriesArchive('${a.id}')">导出</button>
                    <button class="btn btn-small btn-danger" onclick="generator.deleteSeriesArchive('${a.id}')">删除</button>
                </div>
            </div>`;
        }).join('');
    }

    /* ---------- 工坊界面渲染 ---------- */

    /**
     * 清除短剧工坊数据 (右上角按钮):
     * 清空剧集设定/人物卡/分镜/集数历史, 用于开始一部新剧; 不影响已生成的视频作品。
     */
    async clearSeries() {
        const s = this.series;
        const hasData = s.title || s.premise || s.characters.length || s.currentScenes.length || s.episodes.length;
        if (!hasData) return this.showStatus('短剧工坊已是空状态，无需清除', 'success');

        // 任务还在跑的时候不允许清除: 否则任务会继续执行、而记录已被清掉,
        // 既找不到任务又会往磁盘写已废弃剧集的片段 (污染文件)。
        if (this._autoRunning) return this.setSeriesStatus('⚠️ 全剧自动生成正在运行，请先点"⏹️ 停止全剧生成"再清除剧本任务', 'error');
        if (this.isGenerating) return this.setSeriesStatus('⚠️ 还有生成任务正在进行，请先点"⏹️ 停止"再清除剧本任务', 'error');

        // 该剧占用的作品库记录 —— 必须在重置 this.series 之前算好
        const titles = this.seriesRecordTitles(s);
        const owned = this.history.filter(h => titles.has(h.title));
        const leftover = owned.filter(h => this._isUnfinishedRecord(h));
        const keepCount = owned.length - leftover.length;

        const ok = await this.showConfirm({
            title: '🗑️ 清除短剧工坊数据',
            message: `将删除剧集《${s.title || '未命名'}》：\n`
                + `· 剧集设定与主提示词\n`
                + `· ${s.characters.length} 个人物设定卡\n`
                + `· ${s.currentScenes.length} 个待生成分镜\n`
                + `· ${s.episodes.length} 集剧本历史 (当前进度: 第${s.nextEpisode}集)\n`
                + `\n并同步清理该剧在作品库中未完成的 ${leftover.length} 个任务记录——\n`
                + `否则"任务扫描"会一直留存它们，一旦重试就会继续消耗平台配额并生成已废弃的片段。\n`
                + `\n已生成完成的 ${keepCount} 个作品记录会保留；本地视频文件不会被删除。\n`
                + `\n💡 如需保留人物设定用于续季 (第二季人物一致性)，请先点"💾 保存当前剧本存档"再清除。`,
            okText: '🗑️ 确定清除',
            danger: true
        });
        if (!ok) return;

        this.series = this.getDefaultSeries();
        this.saveSeries();

        let removedTasks = 0;
        if (leftover.length) {
            const ids = new Set(leftover.map(h => h.id));
            this.history = this.history.filter(h => !ids.has(h.id));
            // 批量删除的勾选状态里可能还留着已清理的 id
            if (this._selectedCardIds) ids.forEach(id => this._selectedCardIds.delete(id));
            this.saveHistory();
            removedTasks = ids.size;
            this.renderGallery();
            this.renderHistory();
        }

        this.renderSeriesUI();
        this._unfinishedSig = null;
        this.renderUnfinishedTasks(true); // 立即从"未完成任务"面板移除, 不留残余
        this.setSeriesStatus(removedTasks
            ? `🗑️ 剧本数据已清空，并同步清理了 ${removedTasks} 个未完成任务记录。可以开始一部新剧了`
            : '🗑️ 剧本数据已清空，可以开始一部新剧了', 'success');
    }

    renderSeriesUI() {
        const s = this.series;
        const setV = (id, v) => {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el && v !== undefined) el.value = v;
        };
        setV('series-title', s.title);
        setV('series-genre', s.genre);
        setV('series-premise', s.premise);
        setV('series-ep-count', s.scenesPerEpisode);
        setV('series-total-episodes', s.totalEpisodes);
        setV('series-scene-duration', s.sceneDuration);
        setV('series-resolution', s.resolution);
        setV('series-ratio', s.ratio);
        const lock = document.getElementById('series-lock-chars');
        if (lock) lock.checked = s.lockCharacters !== false;
        // 人物数: 自动识别时把识别结果回填到输入框并置为只读
        const charAuto = document.getElementById('series-char-auto');
        if (charAuto) charAuto.checked = s.charCountAuto !== false;
        this.syncCharCountFromPremise();

        // 工坊进度标签: 完结时显示完结状态, 否则显示 下一集/总集数 (含季数)
        const progressLabel = document.getElementById('series-progress-label');
        if (progressLabel) {
            const seasonTxt = (s.season || 1) > 1 ? `第${s.season}季 · ` : '';
            if (s.nextEpisode > s.totalEpisodes) {
                progressLabel.textContent = `✅ 《${s.title || '未命名'}》${seasonTxt}全 ${s.totalEpisodes} 集已完结`;
                progressLabel.style.color = 'var(--success-color)';
            } else {
                progressLabel.textContent = `${seasonTxt}下一集: 第 ${s.nextEpisode} 集 / 共 ${s.totalEpisodes} 集`;
                progressLabel.style.color = '';
            }
        }

        this.renderSeriesArchives();

        const cList = document.getElementById('characters-list');
        if (cList) {
            cList.innerHTML = s.characters.length ? s.characters.map((c, i) => `
                <div class="char-card">
                    <div class="char-head">
                        <input type="text" value="${this.escapeAttr(c.name)}" onchange="generator.updateCharacter(${i}, 'name', this.value)" placeholder="姓名">
                        <button class="btn btn-small btn-danger" onclick="generator.removeCharacter(${i})">删除</button>
                    </div>
                    ${c.tagline ? `<small class="char-tagline">🧬 ${this.escapeHtml(c.tagline)}</small>` : ''}
                    <label>面孔/外形 (全剧锁定)</label>
                    <textarea rows="2" onchange="generator.updateCharacter(${i}, 'look', this.value)" placeholder="年龄、脸型、五官、发型发色、辨识标记...">${this.escapeHtml(c.look)}</textarea>
                    <label>声音 (全剧锁定)</label>
                    <input type="text" value="${this.escapeAttr(c.voice)}" onchange="generator.updateCharacter(${i}, 'voice', this.value)" placeholder="音色、语速、语气、口音...">
                    <label>服装 (全剧锁定)</label>
                    <input type="text" value="${this.escapeAttr(c.outfit)}" onchange="generator.updateCharacter(${i}, 'outfit', this.value)" placeholder="颜色、款式、配饰...">
                </div>`).join('') : '<p class="empty-hint">暂无人物。填写主线后点击"AI生成人物设定卡"，或手动添加。</p>';
        }

        const scList = document.getElementById('scenes-list');
        if (scList) {
            // 根据当前模型动态生成时长选项
            const durOptions = AgnesAPIClient.getModelDurationOptions(this.settings.modelName || '');
            scList.innerHTML = s.currentScenes.length ? s.currentScenes.map((sc, i) => `
                <div class="scene-row">
                    <span class="scene-no">${i + 1}</span>
                    <div class="scene-main">
                        <div style="display:flex; gap:8px;">
                            <input type="text" value="${this.escapeAttr(sc.title)}" onchange="generator.updateScene(${i}, 'title', this.value)" placeholder="场景名">
                            <select onchange="generator.updateScene(${i}, 'duration', this.value)">
                                ${durOptions.map(d => `<option value="${d}" ${parseInt(sc.duration) === d ? 'selected' : ''}>${d}秒</option>`).join('')}
                            </select>
                            <button class="btn btn-small btn-danger" onclick="generator.removeScene(${i})">删</button>
                        </div>
                        <textarea rows="3" onchange="generator.updateScene(${i}, 'prompt', this.value)" placeholder="分镜提示词">${this.escapeHtml(sc.prompt)}</textarea>
                    </div>
                </div>`).join('') : '<p class="empty-hint">暂无分镜。点击"AI写剧本"，或在下方批量添加情景。</p>';
        }
        // 页面加载/切换时同步确认按钮状态
        this._updateConfirmBtn();
    }

    /**
     * "🗑️ 清空": 清空输入框 + 清空"生成进度"面板。
     * 有任务在跑时必须先停 —— 否则清掉的进度行会被仍在进行的轮询/重试重新写回来,
     * 表现就是"点了清空却清不掉"。作品库记录与已保存的视频文件不受影响。
     */
    async clearForm() {
        const active = this._activeJobs ? this._activeJobs.size : 0;
        if (this.isGenerating || active > 0) {
            const ok = await this.showConfirm({
                title: '🗑️ 清空',
                message: `还有任务正在进行 (${active || '若干'} 个)：\n`
                    + `清空会先停止这些任务的监控，再清空进度列表。\n\n`
                    + `· 作品库里的记录和已保存的视频文件不会被删除\n`
                    + `· 已提交到平台的任务仍会在平台侧继续，可稍后用"任务扫描"找回\n\n`
                    + `确定继续吗？`,
                okText: '停止并清空',
                danger: true
            });
            if (!ok) return;
            this.stopGeneration();
        }
        document.getElementById('title').value = '';
        document.getElementById('prompt').value = '';
        document.getElementById('batch-count').value = '1';
        this.batchItems = [];
        this.renderBatchList();
        this._clearProgressPanel();
    }

    showHelp() {
        const modal = document.getElementById('modal');
        document.getElementById('modal-body').innerHTML = `
            <h3 style="margin-bottom: 15px;">📖 使用帮助</h3>
            <div class="item-info">
                <p><strong>1. 配置平台</strong> (模型设置页): 选择平台预设 (火山方舟 / OpenAI 兼容 / 自定义)，填写端点与密钥，保存后可"拉取模型列表"或手动输入模型 ID。</p>
                <p style="margin-top: 10px;"><strong>2. 生成视频</strong>: 填写标题与提示词 (可添加多个场景批量生成)，设置时长/分辨率/比例，点击"开始批量生成"。</p>
                <p style="margin-top: 10px;"><strong>3. 查看进度</strong>: 任务提交后自动轮询；排队/生成中状态实时更新，完成后视频自动保存到「模型设置 → 保存位置」下的 video/标题/ 目录。刷新页面或断网重连后，点击"🔍 任务扫描"可找回未完成任务清单继续重试；作品库中已完成的作品点"预览"可直接播放。</p>
                <p style="margin-top: 10px;"><strong>4. 状态说明</strong>: ❓未知 = 平台长时间未返回，可点"重试轮询"；❌失败 = 平台报错，查看详情中的错误信息。</p>
                <p style="margin-top: 10px;"><strong>提示</strong>: 火山方舟等平台有 CORS 限制，请通过"启动服务器.bat"以服务器模式使用；火山方舟模型需先在方舟控制台开通。</p>
            </div>
            <div class="modal-actions"><button class="btn btn-primary" onclick="generator.closeModal()">知道了</button></div>
        `;
        modal.style.display = 'block';
    }

    exportSettings() {
        const blob = new Blob([JSON.stringify(this.settings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'agnes-settings.json'; a.click();
        URL.revokeObjectURL(url);
    }

    /* ================= 需要用户处理的提醒 (挂机跑完 / 中断) ================= */

    /**
     * 强化提醒。
     * 挂机生成结束时用户往往不在这个页面上, 只在面板里写一行状态是看不到的, 所以同时做四件事:
     *   1. 窗口标题加前缀 —— 任务栏/标签页上直接可见, 挂机时最有效
     *   2. 对应标签页加小圆点 —— 切到别的页面也能看到
     *   3. 弹一个带"下一步"按钮的对话框, 不会被后续状态消息刷掉
     *   4. 页面在后台时补一声提示音 —— 浏览器标签不闪烁, 声音最直接
     * @param {{title:string, message:string, actions?:Array<{text:string,cls?:string,run:Function}>,
     *          level?:'warning'|'error'|'success', tab?:string}} opts
     */
    notifyAttention(opts = {}) {
        const level = opts.level || 'warning';
        const icon = { warning: '⏸️', error: '❌', success: '✅' }[level] || '⏸️';
        const actions = Array.isArray(opts.actions) ? opts.actions : [];
        this._baseTitle = this._baseTitle || document.title;

        document.title = `${icon} ${this._baseTitle}`;
        this._attention = { level, tab: opts.tab || '', key: opts.key || '' };
        this._attentionActions = actions;
        this._markTabAttention(opts.tab);

        const hidden = !!document.hidden;
        if (hidden) this._attentionBeep(level);   // 只在后台响, 不打扰正在看的人

        // 同一条提醒已经摆在屏幕上了: 只更新按钮, 不重复弹 (避免反复弹窗)
        const sameOnScreen = this._attentionShownKey && this._attentionShownKey === opts.key
            && document.getElementById('modal') && document.getElementById('modal').style.display === 'block';

        const body = document.getElementById('modal-body');
        const modal = document.getElementById('modal');
        if (!body || !modal) return;
        if (!sameOnScreen) {
            body.innerHTML = `
            <div style="display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px;">
                <div style="font-size: 1.8rem; line-height: 1;">${icon}</div>
                <div style="min-width: 0;">
                    <h3 style="margin: 0 0 8px;">${this.escapeHtml(opts.title || '生成任务提醒')}</h3>
                    <div style="white-space: pre-wrap; line-height: 1.7;">${this.escapeHtml(opts.message || '')}</div>
                </div>
            </div>
            ${hidden ? '<p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 10px;">页面在后台，已同时用窗口标题和小圆点提醒</p>' : ''}
            <div class="modal-actions">
                ${actions.map((a, i) => `<button class="btn ${a.cls || (i === 0 ? 'btn-primary' : 'btn-secondary')}" onclick="generator._runAttentionAction(${i})">${this.escapeHtml(a.text)}</button>`).join('')}
                <button class="btn btn-secondary" onclick="generator._dismissAttention()">知道了</button>
            </div>`;
        } else {
            // 内容可能变了 (比如"继续生成"按钮去掉了), 只刷新按钮区
            const actionsEl = body.querySelector('.modal-actions');
            if (actionsEl) {
                actionsEl.innerHTML = actions.map((a, i) => `<button class="btn ${a.cls || (i === 0 ? 'btn-primary' : 'btn-secondary')}" onclick="generator._runAttentionAction(${i})">${this.escapeHtml(a.text)}</button>`).join('')
                    + '<button class="btn btn-secondary" onclick="generator._dismissAttention()">知道了</button>';
            }
        }
        this._attentionShownKey = opts.key || '';
        modal.style.display = 'block';
    }

    /** 打开"未完成任务"面板 (它在批量生成页, 先切过去, 否则用户看不到) */
    _showUnfinishedPanel() {
        this.switchTab('generate');
        this._unfinishedHidden = false;
        const panel = document.getElementById('unfinished-panel');
        if (panel) panel.style.display = 'block';
        this.renderUnfinishedTasks(true);
        const el = document.getElementById('unfinished-panel');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /** 点击提醒里的"下一步"按钮: 先收起提醒, 再执行对应动作 */
    _runAttentionAction(index) {
        const action = (this._attentionActions || [])[index];
        this._dismissAttention();
        if (action && typeof action.run === 'function') {
            try { action.run(); } catch (e) { console.warn('提醒动作执行失败:', e); }
        }
    }

    /** 收起提醒: 恢复窗口标题、清掉标签页小圆点 */
    _dismissAttention() {
        if (this._baseTitle) document.title = this._baseTitle;
        this._clearTabAttention();
        this._attention = null;
        this._attentionActions = [];
        this._attentionShownKey = '';
        const modal = document.getElementById('modal');
        if (modal) modal.style.display = 'none';
        this.stopModalCountdown();
    }

    _markTabAttention(tab) {
        if (!tab) return;
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('attention', btn.dataset.tab === tab));
    }

    _clearTabAttention() {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('attention'));
    }

    /** 后台提醒音: WebAudio 现场合成, 不依赖音频文件 (失败也绝不影响主流程) */
    _attentionBeep(level) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const tone = (freq, at, dur) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.value = 0.08;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + at);
                osc.stop(ctx.currentTime + at + dur);
            };
            if (level === 'success') { tone(880, 0, 0.15); tone(1320, 0.18, 0.22); }
            else { tone(880, 0, 0.15); tone(620, 0.18, 0.22); }
            setTimeout(() => { try { ctx.close(); } catch (_) {} }, 900);
        } catch (_) { /* 没有音频权限/不支持时不提醒 */ }
    }

    showStatus(message, type = 'success') {
        const status = document.getElementById('settings-status');
        if (status) {
            status.textContent = message;
            status.className = 'status-message ' + type;
            status.style.display = 'block';
            clearTimeout(this._statusTimer);
            this._statusTimer = setTimeout(() => { status.style.display = 'none'; }, 5000);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }

    escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    escapeAttr(s) { return this.escapeHtml(s); }
    sanitizeFilename(name) { return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 50); }

    loadHistory() {
        try {
            const saved = localStorage.getItem('agnes_history');
            const h = saved ? JSON.parse(saved) : [];
            return Array.isArray(h) ? h : [];
        } catch { return []; }
    }
    saveHistory() { localStorage.setItem('agnes_history', JSON.stringify(this.history)); }
}

/* ================= 全局入口 (兼容 HTML onclick) ================= */

let generator;
document.addEventListener('DOMContentLoaded', () => {
    generator = new AgnesVideoGenerator();
    generator.startGalleryTicker();
});

function ensureGenerator() { if (!generator) generator = new AgnesVideoGenerator(); return generator; }
['showHelp', 'exportSettings', 'addBatchItem', 'startGeneration', 'clearForm', 'saveModelSettings',
 'testConnection', 'resetSettings', 'fetchModels', 'filterGallery', 'filterHistory', 'clearHistory',
 'stopGeneration', 'onPlatformPresetChange', 'toggleCustomSection', 'toggleLLMInputs',
 'generateCharacters', 'generateEpisodeScript', 'generateNextEpisode', 'launchScenes',
 'batchAddScenes', 'addCharacter', 'addScene', 'scanTasks', 'clearSeries',
 'autoGenerateAllSeries', 'toggleAutoPause', 'stopAutoRun',
 'changeOutputDir', 'showVersionInfo', 'saveSeriesArchive', 'loadSeriesArchive', 'deleteSeriesArchive', 'exportSeriesArchive', 'importSeriesArchiveFile',
 'showUpdatePage', 'checkForUpdates', 'toggleAutoMerge', 'manualMergeSelected', 'manualMergeVideos',
 'aiWriteScript', 'confirmAutoGenerate'
].forEach(fn => { window[fn] = (...args) => ensureGenerator()[fn](...args); });
window.setView = (v) => ensureGenerator().setView(v);
window.setGalleryFilter = (f) => ensureGenerator().setGalleryFilter(f);
// HTML 内联 onclick 里的 generator.xxx(...) 统一转发到单例实例。
// 用 Proxy 而不是手写方法白名单: 白名单漏一个方法, 对应的按钮点击就会直接报
// "generator.previewItem is not a function"(预览/下载/删除/重试等都曾因此失效)。
// 读写都转发到实例, 避免 window.generator.x = ... 这类赋值被静默丢弃。
window.generator = new Proxy({}, {
    get(_target, prop) {
        if (prop === 'then') return undefined; // 避免被误判为 thenable
        const g = ensureGenerator();
        const value = g[prop];
        return typeof value === 'function' ? value.bind(g) : value;
    },
    set(_target, prop, value) {
        ensureGenerator()[prop] = value;
        return true;
    },
    has() { return true; }
});
