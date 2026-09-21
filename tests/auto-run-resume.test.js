/* ============================================================
 * 挂机刷新不丢任务 (刷新/断网/关页面都不能把正在跑的任务弄丢)
 *   node tests/auto-run-resume.test.js
 *
 * 用户要求: 刷新后有痕, 不能丢失要执行的任务; 和挂机生成一样 ——
 *           除非用户点"停止"(要先确认), 否则所有任务都不中断;
 *           断网重连后要提醒并继续执行未完成的任务。
 *
 * 锁住的行为:
 *   1. 挂机中刷新 -> 状态落盘 (集号/进度/阶段)
 *   2. 重新打开页面 -> 按记录自动接着跑, 并且弹出提醒 (不是默默消失)
 *   3. 只有点"停止"才中断: 先确认; 取消则继续并保留记录; 确认则清记录不再自动续跑
 *   4. 暂停状态也要记住: 刷新后是"暂停", 不会自己跑; 点"继续"必须真的跑起来
 *      (刷新后只有状态没有循环, 只翻标记是不够的)
 *   5. 断网: 挂起等待不中止、不重复提交, 记录成 waiting-network; 重连后自动续跑 + 提醒
 *   6. 分镜刚补齐 -> 自动检查并出成片 (片段齐了却没有成片是以前的典型故障)
 *   7. 冒烟: 真实构造整个应用 + 断网/重连/关页面事件都不抛异常
 * ============================================================ */
const { createHarness, makeChecker } = require('./dom-harness');

const { check, report } = makeChecker();

/** 造一个最小挂机环境 (只造被测逻辑用得到的部分) */
function makeApp(h, opts = {}) {
    const g = Object.create(h.Cls.prototype);
    g.history = opts.history || [];
    g.settings = { ...g.getDefaultSettings(), apiEndpoint: 'https://x/v1', apiKey: 'k', modelName: 'm' };
    g.series = { ...g.getDefaultSeries(), title: '测试剧', scenesPerEpisode: 3, sceneDuration: 5, totalEpisodes: 2, nextEpisode: 2 };
    g.serverMode = true;
    g.serverOutputDir = 'D:\\out';
    g.outputPaths = { base: 'D:\\out', images: '', video: '' };
    g._activeJobs = new Set();
    g._finalizing = new Set();
    g._mergeChecked = new Set();
    g._online = opts.online !== false;
    g._autoRunning = true;
    g._autoLoopActive = false;
    g._statuses = [];
    g.setSeriesStatus = (m) => g._statuses.push(m);
    g.showStatus = (m) => g._statuses.push(m);
    g.saveHistory = () => {};
    g.renderGallery = () => {};
    g.renderHistory = () => {};
    g.renderSeriesUI = () => {};
    g.switchTab = () => {};
    g.stopModalCountdown = () => {};
    g._clearTabAttention = () => {};
    g._markTabAttention = () => {};
    g._attentionBeep = () => {};
    g._syncAutoMergeUI = () => {};
    g.showAutoRunControls = () => {};
    g.delay = () => Promise.resolve();
    g.notices = [];
    g.notifyAttention = (o) => g.notices.push(o);
    return g;
}

(async function run() {
    console.log('\n【场景 1】挂机中刷新 -> 状态落盘, 不许凭空消失');
    {
        const h = createHarness();
        const g = makeApp(h);
        g._autoRunning = true;
        g.saveRunState({ phase: 'generating', ep: 37, nextEpisode: 37, done: 36 });
        const st = g.loadRunState();
        check('落盘了挂机记录', !!st && st.active === true, true);
        check('记录里有剧名', st.title, '测试剧');
        check('记录里有当前集号与进度', `${st.ep}/${st.done}`, '37/36');
        check('记录里有阶段', st.phase, 'generating');
        check('提醒文案说人话 (剧名/集号/阶段/已完成)', /测试剧/.test(g.runStateText(st)) && /第 37 集/.test(g.runStateText(st)) && /生成中/.test(g.runStateText(st)) && /已完成 36 集/.test(g.runStateText(st)), true);
    }

    console.log('\n【场景 2】重新打开页面 -> 按记录自动接着跑 + 提醒');
    {
        const h = createHarness();
        const g = makeApp(h);
        g.saveRunState({ phase: 'generating', ep: 37, nextEpisode: 37, done: 36 });
        // 新页面: 同一份 localStorage, 全新的实例状态
        const g2 = makeApp(h);
        g2._autoRunning = false;
        for (const k of ['saveRunState', 'loadRunState', 'clearRunState', 'runStateText', 'episodeSceneProgress', 'findIncompleteEpisodes']) {
            if (typeof g[k] === 'function') g2[k] = g[k].bind(g2);
        }
        let started = 0;
        g2.autoGenerateAllSeries = async () => { started++; };
        await g2.resumeAutoRunOnLoad();
        check('自动接着跑 (不是悄悄丢掉)', started, 1);
        check('弹了提醒告诉用户在继续', g2.notices.length >= 1 && /继续/.test(g2.notices[0].title), true);
        check('提醒里带上了上次的进度', /第 37 集/.test(g2.notices[0].message), true);
    }

    console.log('\n【场景 3】只有点"停止"才中断, 而且要先确认');
    {
        const h = createHarness();
        const g = makeApp(h);
        g.saveRunState({ phase: 'generating', ep: 2 });
        let confirmed = null;
        g.showConfirm = async (o) => { confirmed = o; return false; };     // 先点"取消"
        await g.stopAutoRun();
        check('停止前弹了确认框', !!confirmed && /停止/.test(confirmed.title), true);
        check('确认文案写明"这是唯一会中断挂机的操作"', /唯一会中断挂机/.test(confirmed.message), true);
        check('取消后挂机继续', g._autoRunning, true);
        check('取消后记录还在 (下次打开仍会续跑)', !!g.loadRunState(), true);

        g.showConfirm = async () => true;                                  // 真的确认停止
        await g.stopAutoRun();
        check('确认后确实停了', g._autoRunning, false);
        check('停止后记录清掉 (不再自动续跑)', g.loadRunState(), null);
    }

    console.log('\n【场景 4】暂停也要记住; 刷新后点"继续"必须真的跑起来');
    {
        const h = createHarness();
        const g = makeApp(h);
        g._autoPaused = true;
        g.saveRunState({ active: true, paused: true, phase: 'paused', ep: 3 });
        let started = 0;
        g.autoGenerateAllSeries = async () => { started++; };
        await g.resumeAutoRunOnLoad();
        check('刷新后是"暂停"态, 不自己跑', started, 0);
        check('状态提示说明点"继续"才会跑', /暂停/.test(g._statuses.join(' ')), true);

        // 点"继续": 刷新后只有状态没有循环, 必须重新把循环跑起来
        g._autoPaused = false;
        g.kickAutoLoop();
        check('点继续后真的开跑', started, 1);
        g._autoLoopActive = true;
        g.kickAutoLoop();
        check('循环已在跑时不重复启动', started, 1);
    }

    console.log('\n【场景 5】断网: 挂起等待 + 不重复提交; 重连: 自动续跑 + 提醒');
    {
        const h = createHarness();
        const g = makeApp(h, { online: false });
        g.saveRunState({ active: true, phase: 'generating', ep: 37 });
        let started = 0;
        g.autoGenerateAllSeries = async () => { started++; };
        await g.resumeAutoRunOnLoad();
        check('断网时不启动新一轮 (先等网络)', started, 0);
        check('提醒了网络未连接', /网络/.test(g.notices[0].title), true);
        check('记录成"等待网络"而不是丢掉', (g.loadRunState() || {}).phase, 'waiting-network');

        // 网络恢复
        g._autoRunning = false;
        g.onNetworkChange(true);
        check('重连后自动续跑', started, 1);
        check('提醒了"继续执行未完成的任务"', /继续执行未完成的任务/.test(g.notices.map(n => n.title).join(' ')), true);

        // 循环还在等网络时: 不重复启动第二个循环
        const g3 = makeApp(h);
        g3._autoLoopActive = true;
        let started3 = 0;
        g3.autoGenerateAllSeries = async () => { started3++; };
        g3._online = false;
        g3.onNetworkChange(false);
        g3.onNetworkChange(true);
        check('循环还在等 -> 由它自己继续, 不重复启动', started3, 0);
    }

    console.log('\n【场景 6】断网等待: 网络恢复继续; 用户点停止立刻退出');
    {
        const h = createHarness();
        const g = makeApp(h, { online: false });
        g._autoRunning = true;
        const p = g.waitForNetwork('第 37 集');
        g._online = true;
        check('网络恢复后继续 (返回 true)', await p, true);
        check('等待期间给过提示', /等待恢复/.test(g._statuses.join(' ')), true);

        const h2 = createHarness();
        const g2 = makeApp(h2, { online: false });
        g2._autoRunning = true;
        g2.delay = () => { g2._autoRunning = false; return Promise.resolve(); };   // 模拟用户点了停止
        check('用户停止后不再等待 (返回 false)', await g2.waitForNetwork(), false);
    }

    console.log('\n【场景 7】分镜刚补齐 -> 自动检查并出成片');
    {
        const h = createHarness();
        const g = makeApp(h);
        g.episodeByTitle = () => ({ no: 1, scenes: [1, 2, 3].map(i => ({ title: `场景${i}`, prompt: `p${i}`, duration: 5 })) });
        g.episodeSceneProgress = () => ({ epNo: 1, title: '测试剧第1集', total: 3, done: 3, saved: [], unsaved: [], pending: [] });
        const merged = [];
        g.ensureEpisodeMerged = async (t) => { merged.push(t); return 'merged'; };
        g._checkEpisodeReadyAfterSave({ id: 'r3', title: '测试剧第1集', path: 'video/3.mp4', status: 'completed' });
        check('落盘后触发了"本集是否该出成片"的检查', merged.join(','), '测试剧第1集');

        const g2 = makeApp(h);
        g2.episodeByTitle = () => ({ no: 1, scenes: [1, 2, 3].map(i => ({ title: `场景${i}`, prompt: `p${i}`, duration: 5 })) });
        g2.episodeSceneProgress = () => ({ epNo: 1, title: '测试剧第1集', total: 3, done: 2, saved: [], unsaved: [{}, {}], pending: [] });
        const merged2 = [];
        g2.ensureEpisodeMerged = async (t) => { merged2.push(t); return 'merged'; };
        g2._checkEpisodeReadyAfterSave({ id: 'r2', title: '测试剧第1集', path: 'video/2.mp4', status: 'completed' });
        check('没齐时不合并', merged2.length, 0);
    }

    console.log('\n【场景 8】冒烟: 真实构造整个应用 + 事件处理不抛异常');
    {
        const h = createHarness();
        let booted = true; let g = null;
        try { g = new h.Cls(); } catch (e) { booted = false; console.log('  构造失败:', e.message); }
        check('构造 + init() 未抛异常', booted, true);
        await new Promise(r => setTimeout(r, 200));
        const fired = [];
        try {
            h.fire('window', 'offline'); fired.push('offline');
            h.fire('window', 'online'); fired.push('online');
            h.fire('window', 'beforeunload'); fired.push('beforeunload');
        } catch (e) { console.log('  事件处理抛错:', e.message); }
        check('断网/重连/关页面事件都处理成功', fired.length, 3);
        check('没有挂机任务时不会自己开循环', g._autoLoopActive, false);
    }

    const failures = report();
    process.exit(failures ? 1 : 0);
})();
