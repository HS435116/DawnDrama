/* ============================================================
 * AGNES 2.5 批量视频生成器 — 多平台 API 适配层
 * Copyright (c) 2026 @ 晨曦微光工作室
 * 本软件基于 MIT 许可证开源发布 (详见 LICENSE)
 * ============================================================ */
/**
 * AGNES API 客户端 v2 —— 多平台适配器架构
 *
 * 修复要点 (解决"提交后一直显示队列中"):
 *  1. 火山方舟使用正确的端点:
 *     提交  POST {base}/contents/generations/tasks
 *     查询  GET  {base}/contents/generations/tasks/{id}
 *     结果  content.video_url
 *  2. OpenAI 兼容平台 (/videos) 深度解析多种返回结构
 *  3. 所有平台状态规范化为: queued | running | succeeded | failed
 *  4. 服务器模式下所有远程请求经由本地代理 /api/proxy 转发，彻底绕过 CORS
 *  5. 自定义平台: 自定义 JSON 请求体 + 自定义查询路径 + 自定义结果取值路径
 */

// ================= 图生视频字段协商 =================
// 各聚合站的"参考图/首帧"字段名五花八门 (image_urls / images / image / first_frame / input_reference ...),
// 没法在代码里穷举每个平台, 于是做"试一次就记住":
//   ① 按候选顺序先发第一个; ② 平台若回 400 "xxx is not an allowed request field",
//   就把该字段拉黑、换下一个候选立刻重试; ③ 结论按 "平台|端点|模型" 落 localStorage,
//   之后的任务直接发对的字段 —— 用户不需要改任何设置, 也适用于将来新增的平台。
const IMAGE_FIELD_STORE_KEY = 'agnes_image_field_map';
const IMAGE_FIELD_NAMES = ['images', 'image_urls', 'image', 'image_url', 'first_frame', 'last_frame', 'input_reference'];

class AgnesAPIClient {
    constructor(settings) {
        this.settings = settings || {};
        this.apiKey = settings.apiKey || '';
        this.model = settings.modelName || '';
        this.platform = this.detectPlatform(settings);
        this.seed = settings.seed || null;
        this.customJson = settings.customJson || '';
        this.customPollPath = settings.customPollPath || '';
        this.customResultPath = settings.customResultPath || '';

        // 服务器模式 (页面由本地 Node 服务器提供) 时启用代理，绕过各平台 CORS 限制
        this.useProxy = settings.useProxy !== undefined
            ? !!settings.useProxy
            : (typeof window !== 'undefined' && !!window.location && window.location.protocol.startsWith('http'));

        this.base = this.normalizeBase(settings.apiEndpoint, this.platform);

        // 全局限流协调: 平台配额是共享的, 多任务各自重试会互相抢配额形成 429 风暴。
        // _rlUntil: 全局冷却截止时间 (期间所有请求统一等待)
        // _submitChain / _nextSlotAt: 提交请求全局串行排队, 同一时刻只有一个提交在途
        this._rlUntil = 0;
        this._submitChain = Promise.resolve();
        this._nextSlotAt = 0;
        // 提交节奏: 相邻两次提交 (含退避后的重试) 的最小间隔。
        // 基准取用户的"提交间隔"设置; 平台繁忙时逐次加倍 (上限 60s) —— 否则多个任务会
        // 以 1 秒的间隔"排队冲锋"式地撞平台限流, 把有限的重试次数白白烧光。
        const gapSec = parseFloat(settings.submitIntervalSec);
        this._submitGapBase = Math.max(1000, Number.isFinite(gapSec) ? gapSec * 1000 : 2000);
        this._submitGap = this._submitGapBase;
        this._aborters = new Set();   // 在途请求的 AbortController (供"停止"立即中断)
        this._stopCheck = null;       // 由界面注入: () => 用户是否点了"停止"
    }

    /** 当前生效的提交最小间隔 (平台繁忙时自动加倍, 上限 60s) */
    submitGapMs() { return this._submitGap || this._submitGapBase || 2000; }

    /** 平台繁忙: 拉大提交间隔, 给平台喘息时间 (队列模式的关键) */
    _widenSubmitGap() {
        this._submitGap = Math.min(Math.round((this._submitGap || this._submitGapBase) * 2), 60000);
        return this._submitGap;
    }

    /** 提交成功: 恢复用户设置的间隔 */
    _resetSubmitGap() { this._submitGap = this._submitGapBase; }

    /* ================= 取消 (停止) 支持 ================= */

    /** 注入停止判定 (界面侧的 stopRequested) */
    setStopCheck(fn) { this._stopCheck = typeof fn === 'function' ? fn : null; }

    isStopRequested() { return !!(this._stopCheck && this._stopCheck()); }

    /** 用户点"停止"后抛出的错误: 调用方据此区分"被取消"与"真失败" */
    static cancelledError(msg = '已手动停止') {
        const e = new Error(msg);
        e.cancelled = true;
        return e;
    }

    /**
     * 可被"停止"打断的等待。
     * 退避重试/限流冷却动辄几十秒到几分钟, 若是傻等, 用户点了停止还会继续发请求
     * (表现: "点了停止, 任务还在生成/请求")。这里分片等待并轮询停止标记。
     */
    async _sleepAbortable(ms) {
        const step = 250;
        for (let waited = 0; waited < ms; waited += step) {
            if (this.isStopRequested()) throw AgnesAPIClient.cancelledError();
            await new Promise(r => setTimeout(r, Math.min(step, ms - waited)));
        }
        if (this.isStopRequested()) throw AgnesAPIClient.cancelledError();
    }

    /** 立即中断所有在途 HTTP 请求 (点"停止"时调用) */
    abortInFlight() {
        const n = this._aborters.size;
        this._aborters.forEach(a => { try { a.abort(); } catch (_) {} });
        this._aborters.clear();
        return n;
    }

    /* ================= 平台识别 ================= */

    detectPlatform(settings) {
        const fmt = (settings.apiFormat || 'auto').toLowerCase();
        if (['ark', 'openai', 'custom'].includes(fmt)) return fmt;
        // auto: 根据端点/模型名自动识别
        const ep = (settings.apiEndpoint || '').toLowerCase();
        const model = (settings.modelName || '').toLowerCase();
        if (ep.includes('ark.') || ep.includes('volces.com')) return 'ark';
        if (model.includes('seedance') || model.includes('doubao')) return 'ark';
        return 'openai';
    }

    normalizeBase(endpoint, platform) {
        let base = (endpoint || '').trim().replace(/\/+$/, '');
        if (!base) {
            base = platform === 'ark'
                ? 'https://ark.cn-beijing.volces.com/api/v3'
                : 'https://apihub.agnes-ai.com/v1';
        }
        // 方舟: 用户常只填主机名，自动补 /api/v3
        if (platform === 'ark' && /ark.*\.volces\.com/i.test(base) && !/\/api\/v\d+$/.test(base)) {
            base += '/api/v3';
        }
        // 旧版本地代理地址 '/api/ark' 保留原样 (服务器会将其重写为方舟 /api/v3)
        return base;
    }

    isArk() { return this.platform === 'ark'; }

    /* ================= 底层请求 (自动走本地代理) ================= */

    buildUrl(url) {
        if (!this.useProxy || !/^https?:\/\//i.test(url)) return url;
        const origin = this.settings.proxyOrigin || '';
        return origin + '/api/proxy?target=' + encodeURIComponent(url);
    }

    async request(fullUrl, { method = 'GET', body = null } = {}) {
        const headers = { 'Authorization': `Bearer ${this.apiKey}` };
        if (body) headers['Content-Type'] = 'application/json';

        // 全局限流冷却: 任一请求触发 429 后, 所有请求统一等待冷却结束再发出
        // (可被"停止"打断: 否则点了停止还要空等一分钟才停下来)
        const cooldown = (this._rlUntil || 0) - Date.now();
        if (cooldown > 0) await this._sleepAbortable(cooldown);

        let resp = null;
        for (let tryNo = 0; ; tryNo++) {
            const startAt = Date.now();
            const controller = new AbortController();
            this._aborters.add(controller);
            try {
                resp = await fetch(this.buildUrl(fullUrl), {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal
                });
                break;
            } catch (e) {
                // 用户点了"停止": 中止在途请求, 并且不再重发
                if (controller.signal.aborted) throw AgnesAPIClient.cancelledError();
                // 瞬时网络错误 (如本地代理连接被回收): 1.2s 内快速失败说明请求尚未到达上游,
                // 重发是安全的, 自动重试一次; 迟到的失败 (可能已到上游) 不重试, 避免重复创建任务
                if (tryNo < 1 && Date.now() - startAt < 1200) {
                    console.warn(`⚠️ 网络瞬时错误 (${e.message})，1.5s 后自动重试一次`);
                    await this._sleepAbortable(1500);
                    continue;
                }
                const err = new Error(`网络请求失败 (${method} ${fullUrl}): ${e.message}`);
                err.networkError = true;
                throw err;
            } finally {
                this._aborters.delete(controller);
            }
        }

        const text = await resp.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON 响应 */ }

        if (!resp.ok) {
            const apiMsg = data && (data.error?.message || data.message || data.msg)
                ? (data.error?.message || data.message || data.msg)
                : (text || '').slice(0, 300);
            const err = new Error(`API 错误 ${resp.status}: ${apiMsg}`);
            err.status = resp.status;
            err.body = data;
            // 本地代理报"连不上平台" (DNS/连接被拒/连接超时): 请求根本没发出去,
            // 重试是安全的 —— 标记出来让提交环节走退避重试, 而不是直接判任务失败。
            // 注意: 连接中途断开 (平台可能已收到) 不在其中, 那种情况由服务端标记为不可自动重试。
            if (data && data.safeToRetry) {
                err.proxyUnreachable = true;
                err.transient = true;
            }
            // 平台"没有该模型的可用渠道": 多半是模型名写错 / 该分组未开通。
            // 这类错误重试多少次都一样, 直接把"怎么改"写进提示, 免得用户对着 503 去猜。
            const modelName = (body && body.model) || this.model || '';
            if (/no available channel|无可用渠道|无可用模型|model[_ ]?not[_ ]?found|invalid model|does not exist|不存在的模型/i.test(String(apiMsg))) {
                err.modelUnavailable = true;
                err.hint = `平台当前分组下没有模型「${modelName}」的可用渠道：请到「模型设置」改用该平台已上线的模型`
                    + `（可点「拉取模型列表」查看并选用），或联系平台开通该模型。`;
            }
            throw err;
        }
        if (data === null && text) {
            const err = new Error('平台返回了非 JSON 响应: ' + text.slice(0, 200));
            err.status = resp.status;
            throw err;
        }
        return data;
    }

    /* ================= 提交生成任务 ================= */

    async submitTask(prompt, opts = {}) {
        const duration = this.clampInt(opts.duration || 5, 1, 60);
        const resolution = opts.resolution || '720p';   // 480p/720p/1080p
        const ratio = opts.ratio || '16:9';

        let url, body, sentDuration = duration;
        let refUsed = 0;        // 本次实际带上的参考图张数 (0 = 文生视频)
        let sizeClamped = false; // size 是否被模型限制收敛过 (Flash 只接受 720P)
        let imageIntent = 'reference';   // 参考图意图 (reference 参考图 / keyframe 首帧), 决定字段候选顺序
        let appliedImageField = '';      // 本次实际发出去的图字段名 (用于协商)
        const refAll = AgnesAPIClient.refImageUrls(opts.image_urls);

        /**
         * 按字段名把参考图写进请求体: 数组型字段 (images/image_urls) 发多张, 单值型发第一张。
         * 换字段前先清掉其它图字段 —— 同时出现两个图字段时平台多半直接 400。
         */
        const applyImageField = (field) => {
            for (const f of IMAGE_FIELD_NAMES) delete body[f];
            if (!refAll.length || !field) { appliedImageField = ''; return; }
            const max = Math.min(this.maxRefImages(), 5);
            const use = refAll.slice(0, max);
            if (refAll.length > max) console.warn(`⚠️ 参考图 ${refAll.length} 张超过该平台常用上限 ${max} 张, 只提交前 ${max} 张`);
            if (field === 'images' || field === 'image_urls') body[field] = use;
            else body[field] = use[0];   // first_frame / image / image_url / input_reference: 单张
            appliedImageField = field;
            refUsed = use.length;
        };

        if (this.platform === 'custom' && this.customJson.trim()) {
            // 自定义平台: 模板占位符替换，请求体完全由用户定义
            url = this.base + '/videos';
            body = this.renderCustomTemplate(this.customJson, {
                prompt, duration, resolution, ratio,
                // 自定义平台也能用参考图: 模板里写 {{image_url}} / {{image_urls_json}} / {{mode}}
                mode: refAll.length ? (opts.refImageMode === 'keyframe' ? 'keyframe' : 'reference') : 'text',
                imageUrl: refAll[0] || '',
                imageUrls: refAll
            });
            // 模板里用到了图片占位符才算"这次带了参考图" (用于进度提示)
            if (refAll.length && /\{\{image/.test(this.customJson)) refUsed = refAll.length;
        } else if (this.isArk()) {
            // 火山方舟 (Seedance): 参数以 --key value 形式拼在提示词后, 参考图放 content 里并带 role。
            // 文档写法: content 可含 {type:'image_url', image_url:{url}, role:'first_frame'|'last_frame'};
            // Seedance 2.0 系还支持 role:'reference_image' 作为"参考图"(而非首帧)。最多 9 张。
            url = this.base + '/contents/generations/tasks';
            let text = prompt;
            text += ` --resolution ${resolution} --ratio ${ratio} --duration ${duration} --watermark false`;
            if (this.seed !== null && this.seed !== undefined && this.seed !== '') {
                text += ` --seed ${parseInt(this.seed) || 0}`;
            }
            body = { model: this.model, content: [{ type: 'text', text }] };
            const arkMode = opts.refImageMode || 'reference';
            if (arkMode !== 'off' && refAll.length > 0) {
                const maxArk = 9;
                const use = refAll.slice(0, maxArk);
                if (refAll.length > maxArk) console.warn(`⚠️ 参考图 ${refAll.length} 张超过方舟上限 ${maxArk} 张, 只提交前 ${maxArk} 张`);
                // 只有 Seedance 2.0 系认 reference_image; 更早的版本只认首/尾帧, 这时按首帧发更稳
                const supportsRefImage = /seedance[-_ ]?2|2[-_]0/i.test(this.model || '');
                const entries = use.map((u, i) => ({
                    type: 'image_url',
                    image_url: { url: u },
                    role: arkMode === 'keyframe'
                        ? (i === 0 ? 'first_frame' : 'last_frame')
                        : (supportsRefImage ? 'reference_image' : 'first_frame')
                }));
                body.content = [...entries, ...body.content];
                refUsed = use.length;
            }
        } else {
            // OpenAI 兼容格式 (聚合站/Sora 风格): /videos
            // 生成模式按 Agnes 官方文档 (Agnes Video 2.5 / 2.5 Flash, OpenAI Videos 兼容) 选择:
            //   text      无媒体输入, 纯文生视频
            //   keyframe  首帧/尾帧控制 -> first_frame / last_frame (与 images/audios/videos 互斥)
            //   reference 图片/音频/视频参考 -> images / audios / videos (与 first_frame/last_frame 互斥)
            // ★ 旧代码发的是 image_urls —— 平台没有这个字段, 会直接 400
            //   (image_urls is not an allowed request field), 结果"带参考图的分镜"必挂。
            //   这里改成官方字段, 并按"这一条分镜有没有参考图"自动切换文生/图生。
            // size 使用 "720P" 风格 (apihub 仅接受该格式); Flash 只接受 "720P", 下面会强制收敛。
            // 时长档位吸附: Sora 风格平台仅接受 4/8/12 秒档位, 非法值 (如 10) 会被整单静默回退
            // 到平台默认 (实测 AGNES: 请求 10s -> 输出 5s 且比例丢失; 请求 12s -> 12.2s 且比例生效)
            sentDuration = this._snapOpenAIDuration(duration);
            url = this.base + '/videos';
            body = {
                model: this.model,
                prompt: prompt,
                mode: 'text',
                seconds: String(sentDuration),
                size: resolution === '1080p' ? '1080P' : (resolution === '480p' ? '480P' : '720P'),
                aspect_ratio: ratio
            };
            const refs = refAll;
            const refMode = opts.refImageMode || 'reference';   // reference | keyframe | off
            imageIntent = refMode === 'keyframe' ? 'keyframe' : 'reference';
            const isAgnes25 = /agnes.*2\.5|2\.5[-_]?flash/i.test(this.model || '');
            if (/v2\.0/i.test(this.model)) {
                // AGNES v2.0 系: 单图 -> image; 多图 -> extra_body.image (+ keyframes), 见官方文档示例 2~4
                body.mode = 'ti2vid';
                if (refMode !== 'off' && refs.length === 1) {
                    body.image = refs[0];
                } else if (refMode !== 'off' && refs.length > 1) {
                    body.mode = 'keyframes';
                    body.extra_body = { image: refs, mode: 'keyframes' };
                }
            } else if (refMode !== 'off' && refs.length > 0) {
                if (isAgnes25) {
                    // Agnes Video 2.5 / 2.5 Flash: 用官方文档字段 (images / first_frame), 张数上限 5/8
                    const max = this.maxRefImages();
                    const use = refs.slice(0, max);
                    if (refs.length > max) {
                        console.warn(`⚠️ 参考图 ${refs.length} 张超过该模型上限 ${max} 张, 只提交前 ${max} 张`);
                    }
                    if (refMode === 'keyframe') {
                        body.mode = 'keyframe';    // 首帧图生视频: 画面从这张图开始
                        body.first_frame = use[0];
                    } else {
                        body.mode = 'reference';   // 参考图生成: 人物/风格参考
                        body.images = use;
                    }
                    refUsed = use.length;
                } else {
                    // 其他 OpenAI 兼容平台 (Sora 系 / 各类聚合站): 参考图字段名不统一,
                    // 按候选顺序发第一个, 被平台 400 拒绝就换下一个并记住 (见 _imgRemember);
                    // 这类平台的 mode 用法未知, 带图时不发 mode (不带图时仍按原来的 text 发)。
                    delete body.mode;
                    applyImageField(this.imageFieldCandidates(imageIntent)[0]);
                }
            }
            if (opts.mode) body.mode = opts.mode;  // 显式指定优先 (特殊平台/测试)
            // Flash 只接受 720P: 传别的值会被 400 拒掉 (文档: size must be 720P), 这里直接收敛
            if (this.isFlashVideoModel() && body.size !== '720P') {
                console.warn(`⚠️ ${this.model} 仅支持 720P, 已将 size ${body.size} 收敛为 720P`);
                body.size = '720P';
                sizeClamped = true;
            }
        }

        // 应用已学习的平台参数修正 (首个任务 400 自适应的结果, 后续任务直接带上, 省一次往返)
        if (this._adaptiveFixes) {
            for (const [k, v] of Object.entries(this._adaptiveFixes)) {
                if (k in body && body[k] !== v) {
                    console.log(`🔧 应用已学习的平台参数: ${k}=${v}`);
                    body[k] = v;
                }
            }
        }

        console.log(`🎬 [${this.platform}] 提交生成任务 -> ${url}`);
        console.log('   请求体:', JSON.stringify(body));

        // 429 全局限流退避: 所有提交共享一个串行队列与冷却时钟, 避免多任务互相抢配额。
        // 默认重试窗口约 5.5 分钟 (20s→40s→60s→90s→120s), 可用 opts.submitRetryDelays 覆盖 (测试用)
        const retryDelays = opts.submitRetryDelays || [20000, 40000, 60000, 90000, 120000];
        let data = null;
        const fixedFields = new Set();
        for (let attempt = 0; ; attempt++) {
            if (this.isStopRequested()) throw AgnesAPIClient.cancelledError();
            try {
                data = await this._enqueueSubmit(() => this.request(url, { method: 'POST', body }));
                this._rlUntil = 0;      // 提交成功, 解除全局冷却
                this._resetSubmitGap(); // 恢复用户设置的提交间隔
                break;
            } catch (e) {
                if (e && e.cancelled) throw e;
                // 平台参数自适应: 400 且错误信息指明字段合法取值时 (如 "size must be one of 720P"),
                // 自动修正该字段并立即重试 (每个字段最多修正一次, 不消耗限流重试次数)
                // 两种写法都认: "size must be one of 720P,1080P" 与 "size must be 720P"。
                // 后者只接受"数值/枚举型"取值 (720P / 1080P / 16:9 / 5) —— 否则
                // "prompt must be a string" 这类类型说明会把字段值改成 "a", 越修越坏。
                let m = null;
                if (e.status === 400) {
                    const msg = e.message || '';
                    m = /([a-zA-Z_]\w*)\s+must be one of\s+([^\s(,]+)/i.exec(msg)
                        || /([a-zA-Z_]\w*)\s+must be\s+['"]?(\d+(?:P|K)?|\d+:\d+)['"]?/i.exec(msg);
                }
                // 图生视频字段协商: 平台说"某字段不被允许"时拉黑该字段、换下一个候选立刻重试, 并记住结论 ——
                // 各聚合站的参考图字段名五花八门, 试一次就该一劳永逸, 不该让用户去猜。
                // 只协商图字段与 mode; size/seconds/aspect_ratio 这类核心参数走上面的"取值修正"。
                const rejected = AgnesAPIClient.rejectedField(e);
                if (rejected && AgnesAPIClient.negotiableField(rejected) && !this._imgRec().banned.includes(rejected)) {
                    this._imgRemember({ banned: [...(this._imgRec().banned || []), rejected] });
                    console.warn(`⚠️ 平台不接受字段 ${rejected} (${String(e.message).slice(0, 80)})，已记住并换其他方式重试`);
                    if (IMAGE_FIELD_NAMES.includes(rejected) && refAll.length) {
                        const next = this.imageFieldCandidates(imageIntent)[0];
                        if (next) { applyImageField(next); attempt--; continue; }
                        throw new Error('该平台不接受任何已知的参考图字段 (已试: '
                            + [...this._imgRec().banned].join(', ') + ')。请在「模型设置 → 参考图调用方式」选择'
                            + '"不使用参考图"(文生视频)，或改用支持参考图的模型');
                    }
                    if (rejected === 'mode') { delete body.mode; attempt--; continue; }
                }
                if (m && !fixedFields.has(m[1]) && m[1] in body && String(body[m[1]]) !== m[2] && fixedFields.size < 4) {
                    fixedFields.add(m[1]);
                    // 记忆修正结果, 同一客户端的后续提交直接带上
                    this._adaptiveFixes = this._adaptiveFixes || {};
                    this._adaptiveFixes[m[1]] = m[2];
                    console.warn(`⚠️ 平台要求 ${m[1]}=${m[2]} (当前 ${body[m[1]]})，已自动修正重试 (后续任务将直接使用该值)`);
                    body[m[1]] = m[2];
                    attempt--;
                    continue;
                }
                if ((AgnesAPIClient.isPlatformBusyError(e) || e.transient) && attempt < retryDelays.length) {
                    // 退避加抖动: 多个任务同时被限流时, 若同一秒集体重试会再次撞墙,
                    // 错开 15% 左右能让它们"排队"而不是"冲锋"。
                    const wait = Math.round(retryDelays[attempt] * (0.85 + Math.random() * 0.3));
                    this._rlUntil = Math.max(this._rlUntil || 0, Date.now() + wait);
                    this._widenSubmitGap();   // 重试也遵守(并逐步拉大)提交间隔
                    const why = e.transient ? '本地服务器连不上平台 (请求未发出, 可安全重试)'
                        : (AgnesAPIClient.isRateLimitError(e) ? '触发平台限流 (429)' : '平台排队已满 (503)');
                    console.warn(`⚠️ ${why}，全局冷却 ${Math.round(wait / 1000)}s 后重试提交 (${attempt + 1}/${retryDelays.length})`
                        + `，提交间隔调整为 ${Math.round(this.submitGapMs() / 1000)}s`);
                    if (opts.onRateLimitWait) opts.onRateLimitWait(wait, attempt + 1, retryDelays.length);
                    await this._sleepAbortable(wait);   // 停止时立即中断, 不等完退避时间
                    continue;
                }
                throw e;
            }
        }

        // 这次带图提交被平台接受了: 记住用的字段, 之后的任务不再试错
        if (appliedImageField) this.rememberImageField(appliedImageField);

        const taskId = this.extractTaskId(data);
        if (!taskId) {
            console.error('❌ 提交响应中未找到任务 ID:', data);
            throw new Error('平台未返回任务 ID，无法轮询进度。响应: ' + JSON.stringify(data).slice(0, 300));
        }

        const result = {
            taskId,
            // AGNES 创建任务会同时返回 task_id 与 video_id; video_id 是官方推荐的查询用 ID
            // (非 text 模式尤其推荐带上 model_name), task_id 走旧的 /videos/{id} 兜底
            videoId: this.extractVideoId(data),
            status: this.mapStatus(this.deepGet(data, ['status', 'task_status', 'state'])) || 'queued',
            videoUrl: this.extractVideoUrl(data),
            mode: (body && body.mode) || '',
            refImageCount: refUsed,
            sizeSent: (body && body.size) || '',
            sizeClamped,
            durationSent: sentDuration,
            durationRequested: duration,
            raw: data
        };
        console.log(`✅ 任务已提交: ${taskId}${result.videoId ? ` (video_id: ${result.videoId})` : ''}`
            + ` (初始状态: ${result.status}${result.mode ? `, mode: ${result.mode}` : ''}${refUsed ? `, 参考图 ${refUsed} 张` : ''})`);
        return result;
    }

    /** 参考图归一化: 接受 [{url,role}] / ['url'] / 'url', 去空去重 (方舟与 OpenAI 兼容两条链路共用) */
    static refImageUrls(list) {
        if (!list) return [];
        const arr = Array.isArray(list) ? list : [list];
        const out = [];
        for (const it of arr) {
            const u = typeof it === 'string' ? it : ((it && (it.url || it.image_url || it.image)) || '');
            if (u && !out.includes(u)) out.push(String(u));
        }
        return out;
    }

    /** 本端点的"图生视频字段记忆" (内存 + localStorage): { imageField, banned: [] } */
    _imgRec() {
        if (this._imgRecCache) return this._imgRecCache;
        let all = {};
        try {
            if (typeof localStorage !== 'undefined') all = JSON.parse(localStorage.getItem(IMAGE_FIELD_STORE_KEY) || '{}') || {};
        } catch (_) { all = {}; }
        this._imgRecKey = `${this.platform}|${this.base || ''}|${this.model}`;
        this._imgRecAll = all;
        this._imgRecCache = all[this._imgRecKey] || { imageField: '', banned: [] };
        return this._imgRecCache;
    }

    /** 记住本端点的图生视频结论: 哪个字段可用、哪些字段被平台拒过 (落 localStorage, 刷新后仍有效) */
    _imgRemember(patch) {
        const rec = Object.assign(this._imgRec(), patch);
        rec.banned = [...new Set(rec.banned || [])];
        this._imgRecCache = rec;
        try {
            if (typeof localStorage !== 'undefined') {
                this._imgRecAll[this._imgRecKey] = rec;
                localStorage.setItem(IMAGE_FIELD_STORE_KEY, JSON.stringify(this._imgRecAll));
            }
        } catch (_) { /* 隐私模式/配额满: 只在本次会话内生效 */ }
        return rec;
    }

    /** 记录"这个字段验证可用" (协商成功后调用), 下次直接用 */
    rememberImageField(field) {
        if (field) this._imgRemember({ imageField: field });
        return field;
    }

    /** 参考图字段候选顺序: 学到的优先; 被拉黑的排除; 首帧意图把 first_frame 提前 */
    imageFieldCandidates(intent = 'reference') {
        const rec = this._imgRec();
        const base = intent === 'keyframe'
            ? ['first_frame', 'image_url', 'image', 'image_urls', 'images', 'input_reference']
            : ['image_urls', 'images', 'image_url', 'input_reference', 'image', 'first_frame'];
        const list = (rec.imageField ? [rec.imageField, ...base] : base).filter(f => !rec.banned.includes(f));
        return [...new Set(list)];
    }

    /** 从 400 错误里解析"哪个字段不被允许" (各平台措辞不同, 多认几种写法) */
    static rejectedField(e) {
        const msg = String((e && e.message) || '');
        const m = /([a-zA-Z_]\w*)\s+is not an allowed request field/i.exec(msg)
            || /(?:unknown|unexpected|unsupported|invalid|not allowed|unrecognized)[ _-]*(?:request[ _-])?(?:field|parameter|kye|key)s?\s*[:=]?\s*['"]?([a-zA-Z_]\w*)/i.exec(msg)
            || /(?:field|parameter|key)\s*['"]?([a-zA-Z_]\w*)['"]?\s+is (?:not allowed|unknown|unsupported|invalid|unexpected)/i.exec(msg);
        return m ? m[1] : '';
    }

    /** 该字段能不能"协商"掉: 只动参考图相关字段与 mode, 核心参数不碰 */
    static negotiableField(f) {
        return f === 'mode' || IMAGE_FIELD_NAMES.includes(f);
    }

    /** 参考图张数上限: 2.5 Flash 5 张, 其余(2.5 等) 8 张 —— 见官方文档"参考媒体限制" */
    maxRefImages() {
        return this.isFlashVideoModel() ? 5 : 8;
    }

    /** 是否 Agnes Video 2.5 Flash 系 (只接受 size="720P", 参考图最多 5 张) */
    isFlashVideoModel() {
        return /2\.5[-_]?flash/i.test(this.model || '');
    }

    /** 创建任务响应里的 video_id (官方推荐用它查询任务结果) */
    extractVideoId(data) {
        if (!data) return null;
        return this.deepGet(data, [
            'video_id', 'videoId',
            'data.video_id', 'result.video_id', 'video.id', 'output.video_id'
        ]) || null;
    }

    static isRateLimitError(err) {
        return !!err && (/429/.test(String(err.status || '')) || /429|rate.?limit|too many requests/i.test(err.message || ''));
    }

    /**
     * 平台"余额不足 / 配额耗尽"(欠费)类错误。
     * 和限流(429)的区别很关键: 限流等几分钟就好, 欠费必须充值或换 Key ——
     * 重试多少次都一样, 所以它不能被当成"平台繁忙"去退避重试, 也不能只提示"稍后重试",
     * 必须让用户看到真实原因并停下来 (否则整批分镜会被一个个刷成失败)。
     * 各平台写法差异很大: HTTP 402 / insufficient_quota / insufficient balance /
     * quota exceeded / 余额不足 / 配额已用尽 ... 这里一并覆盖。
     */
    static isBillingError(err) {
        if (!err) return false;
        const status = Number(err.status || err.statusCode || 0);
        if (status === 402) return true;    // Payment Required: 最明确的欠费信号
        let bodyText = '';
        try { bodyText = err.body ? JSON.stringify(err.body) : ''; } catch (_) { /* 循环引用等, 忽略 */ }
        const hay = `${err.message || ''} ${err.error || ''} ${err.raw || ''} ${bodyText}`;
        if (/insufficient[_ ]?(quota|balance|funds|credit|token)|quota[_ ]?(exceeded|exhausted|depleted|reached|used up)|payment[_ ]required|billing|arrears|balance[_ ]?(is[_ ]?)?(not[_ ]?enough|insufficient|depleted|empty|zero)|credit[_ ]?(exhausted|depleted|insufficient)|账户余额|余额不足|余额为\s*0|欠费|配额(不足|耗尽|已?用尽|已?用完)|额度(不足|已用尽|耗尽)|请充值/i.test(hay)) {
            return true;
        }
        // 403/429 也可能是"配额用尽"(部分平台如此表达): 再叠一层状态码 + 额度关键词的兜底
        return (status === 403 || status === 429) && /quota|balance|credit|billing|配额|余额/i.test(hay);
    }

    /**
     * 平台"暂时忙"类错误: 限流(429) 或 排队已满(503 video queue is full / please retry later)。
     * 平台自己都说了"稍后重试", 就该退避重试, 不能当硬失败 ——
     * 否则排队高峰期一撞上, 整批分镜会被直接判死 (表现: 全部"失败: 平台生成失败(服务器内部错误)")。
     * 注意: "模型不存在/无可用渠道" 的 503 是配置问题, 重试没有意义, 必须排除。
     */
    static isPlatformBusyError(err) {
        if (!err) return false;
        if (err.modelUnavailable) return false;
        // 欠费不是"忙": 退避重试只是白等 5 分钟, 最后还给出"调大提交间隔"这种没用的建议。
        // 必须让调用方看到真实原因 (充值/换 Key), 所以这里排除掉。
        if (AgnesAPIClient.isBillingError(err)) return false;
        if (err.transient) return true;   // 本地服务器连不上平台 (请求未发出) 也按"稍后重试"处理
        if (AgnesAPIClient.isRateLimitError(err)) return true;
        const msg = String(err.message || '');
        if (/queue[ _-]?is[ _-]?full|please retry later|temporarily (unavailable|busy)|server is busy|overload|系统繁忙|服务器繁忙|服务繁忙|请稍后重试|排队已满|队列已满/i.test(msg)) {
            return true;
        }
        return err.status === 503 && /unavailable|busy|retry|later/i.test(msg);
    }

    /**
     * 将技术性错误转换为用户友好的中文提示 (卡片/详情展示用)。
     * 完整技术细节仍保留在 record.rawResponse / 错误详情中供排查。
     */
    static friendlyError(err) {
        const raw = String((err && err.message) || err || '');
        const status = err && err.status;
        const has = (re) => re.test(raw);

        // 欠费/配额耗尽: 必须排在"限流"与"密钥无效"之前 ——
        // 403/429 也可能表示额度耗尽, 先判就会给出"稍后重试/换密钥"这种误导性的建议,
        // 用户照着做半天也跑不起来 (真正该做的是充值或换 Key)。
        if (!(err && (err.networkError || err.proxyUnreachable)) && AgnesAPIClient.isBillingError(err)) {
            return '平台账户余额不足/配额已用尽（欠费）：请到对应平台充值，或在「模型设置」更换可用的 API Key / 模型';
        }
        // 本地服务器连不上平台 (DNS 解析不到 / 连接被拒 / 连接超时):
        // 这时本地服务器是好的, 是"到平台的网络"有问题, 别提示成"本地服务器没运行"。
        if (has(/代理请求失败|代理请求超时|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i)) {
            return '本地服务器连不上平台（网络/DNS/连接被拒）：请检查本机网络或稍后点击"重试"';
        }
        // 平台 CDN 断流: 视频已经生成好, 只是下载连接被掐断
        if (has(/下载连接被中断|terminated|socket hang up|premature close/i)) {
            return '平台视频下载被中断（平台 CDN 断流）：点击"重新下载"再试即可';
        }
        if ((err && err.networkError) || has(/failed to fetch|networkerror|econn|socket/i)) {
            return '网络连接失败：请确认本地服务器正在运行、电脑网络正常，然后点击"重试"';
        }
        if (status === 429 || has(/429|rate.?limit|too many requests/i)) {
            return '平台限流：免费配额暂时用尽，请等待几分钟后点击"重试"';
        }
        // 平台排队已满 (503 video queue is full / please retry later): 平台侧繁忙, 稍后重试即可
        if (has(/queue[ _-]?is[ _-]?full|please retry later|temporarily (unavailable|busy)|server is busy|排队已满|队列已满|服务器繁忙|请稍后重试/i)) {
            return '平台排队已满：平台侧瞬间繁忙（不是你这边的问题），稍后点击"重试"即可继续';
        }
        if (status === 401 || status === 403 || has(/401|403|unauthorized|invalid.{0,12}key/i)) {
            return 'API 密钥无效或无权限：请到"模型设置"检查密钥是否正确';
        }
        if (status === 404 || has(/\b404\b|not found/i)) {
            return '接口不存在：请到"模型设置"检查端点地址与模型 ID 是否正确';
        }

        // 从 JSON 错误体中提取平台的可读原因 (如 {"code":"500","message":"Generation failed"})
        let reason = '';
        const jm = raw.match(/\{[\s\S]*\}/);
        if (jm) {
            try {
                const o = JSON.parse(jm[0]);
                reason = String(o.message || o.msg || (o.error && o.error.message) || '');
            } catch (_) { /* 非法 JSON, 走通用清洗 */ }
        }
        if (!reason) {
            reason = raw
                .replace(/^API 错误\s*\d+\s*[:：]\s*/, '')
                .replace(/^网络请求失败\s*\([^)]*\)\s*[:：]\s*/, '')
                .replace(/\(request id:[^)]*\)/gi, '')
                .replace(/^[{"]+|["}]+$/g, '')
                .trim();
        }
        reason = reason.slice(0, 120);

        if ((status && status >= 500) || has(/"code"\s*:\s*"?500"?|generation failed|internal server error/i)) {
            return `平台生成失败（服务器内部错误）${reason ? '：' + reason : '，建议稍后点击"重试"'}`;
        }
        if (status === 400 || has(/\b400\b|bad request/i)) {
            return `请求参数被平台拒绝${reason ? '：' + reason : ''}，请检查模型 ID 与参数设置`;
        }
        return reason ? `生成失败：${reason}` : '生成失败，请点击"重试"';
    }

    /** 提交串行队列: 全局同一时刻只有一个提交在途, 并遵守限流冷却时钟 */
    async _enqueueSubmit(fn) {
        const prev = this._submitChain || Promise.resolve();
        let release;
        this._submitChain = new Promise(r => { release = r; });
        await prev.catch(() => {});
        try {
            for (;;) {
                if (this.isStopRequested()) throw AgnesAPIClient.cancelledError();
                const wait = Math.max((this._rlUntil || 0) - Date.now(), (this._nextSlotAt || 0) - Date.now(), 0);
                if (wait <= 0) break;
                await new Promise(r => setTimeout(r, Math.min(wait, 250)));
            }
            this._nextSlotAt = Date.now() + this.submitGapMs(); // 相邻提交 (含重试) 之间的间隔
            return await fn();
        } finally {
            release();
        }
    }

    renderCustomTemplate(templateJson, vars) {
        // 文本级替换: "{{prompt}}" (带引号) 注入 JSON 转义字符串; 裸 {{duration}} 注入原始值(数字/布尔)
        let s = templateJson;
        const subst = (name, value) => {
            const quoted = '"' + '{{' + name + '}}' + '"';
            s = s.split(quoted).join(JSON.stringify(value === undefined || value === null ? '' : value));
            const bare = '{{' + name + '}}';
            s = s.split(bare).join(typeof value === 'string' ? value : String(value ?? ''));
        };
        subst('prompt', vars.prompt);
        subst('model', this.model);
        subst('duration', vars.duration);
        subst('resolution', vars.resolution);
        subst('ratio', vars.ratio);
        subst('seed', this.seed ?? 0);
        subst('mode', vars.mode || 'text');
        // 参考图: {{image_url}} 是单张 URL (文生视频时为空串); {{image_urls_json}} 裸替换成 JSON 数组,
        // 便于模板里直接写 "images": {{image_urls_json}} —— 这样任何平台的图生视频字段都能自己接
        subst('image_url', vars.imageUrl || '');
        s = s.split('{{image_urls_json}}').join(JSON.stringify(vars.imageUrls || []));

        let parsed;
        try { parsed = JSON.parse(s); } catch (e) {
            throw new Error('自定义 JSON 模板替换后不是合法 JSON: ' + e.message);
        }
        return parsed;
    }

    /* ================= 查询任务状态 (核心修复) ================= */

    async queryTask(taskId, opts = {}) {
        const paths = this.queryPaths(taskId, opts);
        let lastErr = null;

        for (const p of paths) {
            // queryPaths 给的多半是相对路径 (拼 this.base); AGNES 的 /agnesapi 挂在站点根上, 直接给绝对地址
            const url = /^https?:\/\//i.test(p) ? p : this.base + p;
            try {
                const data = await this.request(url);
                const norm = this.normalizeQuery(data);
                if (norm.status === 'succeeded' && !norm.videoUrl) {
                    // OpenAI Sora 风格: 完成响应不含视频地址, 视频经 /videos/{id}/content 端点下载 (需鉴权)
                    norm.videoUrl = `${this.base}/videos/${encodeURIComponent(taskId)}/content`;
                    norm.videoUrlNeedsAuth = true;
                }
                return norm;
            } catch (e) {
                lastErr = e;
                // 404: 该查询路径不存在或任务不存在 -> 尝试下一个候选路径
                if (e.status === 404) continue;
                throw e; // 其它错误 (401/5xx/网络) 直接抛出
            }
        }
        // 所有候选路径都 404
        const err = new Error(`查询接口不存在 (已尝试: ${paths.join(', ')})`);
        err.status = 404;
        throw err;
    }

    queryPaths(taskId, opts = {}) {
        if (this.platform === 'custom' && this.customPollPath.trim()) {
            let p = this.customPollPath.trim();
            if (!p.startsWith('/')) p = '/' + p;
            return [p.replace('{id}', encodeURIComponent(taskId))];
        }
        if (this.isArk()) {
            // 火山方舟唯一正确路径 (旧版代码查 /videos/{id} /tasks/{id} 导致永远排队中)
            return [`/contents/generations/tasks/${encodeURIComponent(taskId)}`];
        }
        // OpenAI 兼容平台主路径 + 常见变体
        const legacy = [
            `/videos/${encodeURIComponent(taskId)}`,
            `/contents/generations/tasks/${encodeURIComponent(taskId)}` // 兼容方舟式聚合站
        ];
        // AGNES 官方推荐: /agnesapi?video_id=..&model_name=.. —— 文档写明"仅 video_id"的形式
        // 只适用于 text 模式, 参考图/首帧这类任务要走带 model_name 的推荐形式。
        // 所以: 非 text 模式把它排在第一位 (旧的 task_id 路径仍作为兜底), text 模式维持原顺序。
        const byVideo = this._agnesQueryUrl(opts.videoId, opts.model);
        if (!byVideo) return legacy;
        return opts.preferVideoId ? [byVideo, ...legacy] : [...legacy, byVideo];
    }

    /** 站点根地址 (去掉 /v1 之类的版本段): /agnesapi 这类接口挂在站点根上, 不在 /v1 下 */
    _rootBase() {
        return String(this.base || '').replace(/\/v\d+\/?$/i, '');
    }

    /** AGNES 推荐查询地址: /agnesapi?video_id=..( &model_name=..) —— 仅在拿得到 video_id 时给出 */
    _agnesQueryUrl(videoId, model) {
        if (!videoId) return '';
        const q = [`video_id=${encodeURIComponent(videoId)}`];
        const m = model || this.model;
        if (m) q.push(`model_name=${encodeURIComponent(m)}`);
        return `${this._rootBase()}/agnesapi?${q.join('&')}`;
    }

    /**
     * 将各平台的原始查询响应规范化:
     * { status: queued|running|succeeded|failed, progress, videoUrl, error, raw }
     */
    normalizeQuery(data) {
        const rawStatus = this.deepGet(data, ['status', 'task_status', 'state']);
        let status = this.mapStatus(rawStatus);
        const videoUrl = this.extractVideoUrl(data);
        const progress = this.deepGet(data, ['progress', 'percent', 'completion']) ?? null;
        const errMsg = this.deepGet(data, ['error', 'failure_reason', 'fail_reason'])
            || (typeof data?.error === 'object' ? data?.error?.message : null);

        // 状态无法识别但有视频地址 -> 视为成功
        if (!status && videoUrl) status = 'succeeded';
        if (!status) status = 'running'; // 未知状态保持等待，raw 留给 UI 显示

        return {
            status,
            rawStatus: rawStatus ?? null,
            progress: typeof progress === 'number' ? progress : null,
            videoUrl,
            error: status === 'failed' ? (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)) : null,
            raw: data
        };
    }

    mapStatus(raw) {
        const s = String(raw || '').toLowerCase();
        if (['queued', 'queue', 'pending', 'submitted', 'waiting'].includes(s)) return 'queued';
        if (['running', 'in_progress', 'processing', 'generating', 'started', 'active'].includes(s)) return 'running';
        if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished', 'ok'].includes(s)) return 'succeeded';
        if (['failed', 'error', 'failure', 'cancelled', 'canceled', 'expired', 'timeout'].includes(s)) return 'failed';
        return null;
    }

    /* ================= 响应字段提取 ================= */

    extractTaskId(data) {
        if (!data) return null;
        return this.deepGet(data, [
            'id', 'task_id', 'taskId', 'job_id',
            'data.id', 'data.task_id', 'data.taskId', 'data.job_id',
            'result.id', 'result.task_id', 'result.taskId',
            'task.id', 'task.task_id'
        ]) || null;
    }

    /** 深度提取视频地址: 覆盖 content.video_url / output.url / data[0].url 等几十种结构 */
    extractVideoUrl(data) {
        if (!data) return null;

        // 1) 用户自定义取值路径优先 (custom-result-path, 如 "content.video_url")
        if (this.customResultPath.trim()) {
            const v = this.dotGet(data, this.customResultPath.trim());
            if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
        }

        // 2) 按平台已知结构精确匹配
        const preferred = this.isArk()
            ? ['content.video_url', 'video_url', 'url', 'metadata.url']
            : ['url', 'video_url', 'output.url', 'data.url', 'content.video_url',
               'result.video_url', 'result.url', 'video.url', 'download_url',
               'assets.video_url', 'videos[0].url', 'data[0].url', 'output[0].url', 'results[0].url',
               'metadata.url'];
        for (const p of preferred) {
            const v = this.dotGet(data, p);
            if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
        }

        // 3) 兜底: 递归找第一个像视频的 http 链接
        return this.deepFindVideoUrl(data, 0) || null;
    }

    deepFindVideoUrl(node, depth) {
        if (depth > 6 || !node || typeof node !== 'object') return null;
        if (typeof node === 'string') {
            return (/^https?:\/\/\S+\.(mp4|mov|webm|avi|mkv)(\?\S*)?$/i.test(node)) ? node : null;
        }
        const keys = Object.keys(node);
        // 优先名为 *url* 的键
        for (const k of keys) {
            if (/url|link|download/i.test(k)) {
                const found = this.deepFindVideoUrl(node[k], depth + 1);
                if (found) return found;
            }
        }
        for (const k of keys) {
            const found = this.deepFindVideoUrl(node[k], depth + 1);
            if (found) return found;
        }
        return null;
    }

    deepGet(obj, keys) {
        for (const k of keys) {
            const v = this.dotGet(obj, k);
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return null;
    }

    dotGet(obj, path) {
        if (!obj || !path) return undefined;
        return path.split('.').reduce((cur, seg) => {
            if (cur === undefined || cur === null) return undefined;
            const m = seg.match(/^([^\[\]]*)\[(\d+)\]$/);
            if (m) {
                const base = m[1] ? cur[m[1]] : cur;
                return Array.isArray(base) ? base[parseInt(m[2])] : undefined;
            }
            return cur[seg];
        }, obj);
    }

    clampInt(v, min, max) {
        const n = parseInt(v) || min;
        return Math.max(min, Math.min(max, n));
    }

    /**
     * OpenAI 兼容 (Sora 风格) 平台的时长档位吸附。
     * 该类平台仅接受 4/8/12 秒档位; 非法值 (如 10) 会被整单静默回退到平台默认
     * (实测 AGNES: 请求 10s -> 输出默认 5s 且比例丢失; 请求 12s -> 12.2s 且比例生效)。
     * ≤5s 保持原样 (5s 为安全默认值, 平台可正常渲染); 6~9s -> 8s; ≥10s -> 12s。
     */
    _snapOpenAIDuration(v) {
        const n = parseInt(v) || 5;
        if (n <= 5) return n;
        return n < 10 ? 8 : 12;
    }

    /**
     * 固定时长模型检测 (实测: AGNES v2.0 系模型固定输出 5 秒 1088x832,
     * 完全忽略 seconds 与 aspect_ratio 参数; 2.5 系模型则正常支持 4/8/12s 档位与比例)。
     * 用于在提交时向用户明确警示, 而不是默默生成 5 秒。
     */
    isFixedDurationModel() {
        return this.platform === 'openai' && /v2\.0/i.test(this.model || '');
    }

    /* ================= 模型时长自动识别 ================= */

    /**
     * 根据模型名返回该视频模型支持的最大时长（秒）。
     * Seedance (方舟): 支持 4/8/12/16/20/24/30/60s → 最大 60s
     * AGNES v2.0 系 (固定5s): 最大 5s
     * AGNES v2.5 系 / flash (OpenAI兼容): 支持 4/8/12s → 最大 12s
     * 未知模型: 默认 12s
     */
    static getModelMaxDuration(modelName) {
        const m = (modelName || '').toLowerCase();
        if (/seedance|doubao/.test(m)) return 60;
        // 精确匹配 v2.0 (不是 v2.5 / v2.10)
        if (/(?<![.\d])2\.0(?! [\d.])/.test(m)) return 5;
        if (/agnes.*video|v2\.5|flash/.test(m)) return 12;
        return 12; // 默认值
    }

    /**
     * 返回该模型支持的时长档位数组 (升序)。
     */
    static getModelDurationOptions(modelName) {
        const m = (modelName || '').toLowerCase();
        if (/seedance|doubao/.test(m)) return [4, 8, 12, 16, 20, 24, 30, 60];
        if (/(?<![.\d])2\.0(?! [\d.])/.test(m)) return [5];
        if (/agnes.*video|v2\.5|flash/.test(m)) return [4, 8, 12];
        return [4, 8, 12]; // 默认
    }

    /* ================= 文本模型 (剧本/编剧 AI) ================= */

    /**
     * OpenAI 兼容对话接口 (火山方舟同样兼容 /chat/completions)
     * @returns {string} 助手回复文本
     */
    async chat(messages, opts = {}) {
        const url = this.base + '/chat/completions';
        const body = {
            model: this.model,
            messages,
            temperature: opts.temperature ?? 0.8
        };
        // 剧本类输出很长 (每个分镜含完整人物锁定描述), 默认放宽输出上限避免被截断
        const maxTokens = opts.maxTokens ?? 8192;
        if (maxTokens) body.max_tokens = maxTokens;

        let data;
        try {
            data = await this.request(url, { method: 'POST', body });
        } catch (e) {
            // 部分平台对 max_tokens 上限做校验, 超限返回 400 -> 去掉该参数重试一次
            if (body.max_tokens && e.status === 400) {
                console.warn('⚠️ 平台拒绝 max_tokens=' + body.max_tokens + '，去掉该参数重试');
                delete body.max_tokens;
                data = await this.request(url, { method: 'POST', body });
            } else {
                throw e;
            }
        }

        const content = this.deepGet(data, ['choices[0].message.content', 'choices[0].text', 'output.text', 'output.content']);
        if (!content) {
            throw new Error('文本模型返回内容为空: ' + JSON.stringify(data).slice(0, 300));
        }
        return content;
    }

    /** 从模型回复中稳健提取 JSON 对象 (容忍 ```json 围栏 / 前后缀文字 / 输出截断 / 字符串内未转义引号等) */
    static extractJson(text) {
        if (!text) return null;
        const raw = String(text).trim();

        // 单次解析: 先严格 JSON, 失败再用容错解析器
        const tryParse = (str) => {
            try { return JSON.parse(str); } catch (_) { /* 继续 */ }
            try { return AgnesAPIClient.lenientJsonParse(str); } catch (_) { return null; }
        };

        // 1) 常规: 依次尝试每个代码围栏, 再尝试整段文本的首尾大括号
        const candidates = [];
        const fences = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
        for (const f of fences) {
            candidates.push(f.replace(/```(?:json)?/i, '').replace(/```/g, '').trim());
        }
        candidates.push(raw);
        for (const c of candidates) {
            const start = c.indexOf('{');
            const end = c.lastIndexOf('}');
            if (start === -1 || end <= start) continue;
            const parsed = tryParse(c.slice(start, end + 1));
            if (parsed) return parsed;
        }

        // 2) 截断修复: 模型输出到 max_tokens 被掐断时, 补齐未闭合的括号
        const start = raw.indexOf('{');
        if (start === -1) return null;
        return AgnesAPIClient.repairTruncatedJson(raw.slice(start), tryParse);
    }

    /**
     * 容错 JSON 解析器 —— 修复大模型最常见的三类输出错误:
     *  1) 字符串内未转义的英文双引号 (如对白: whispers "Agent-0")
     *  2) 字符串内的原始换行/制表符
     *  3) 尾逗号 ([1,2,] / {"a":1,})
     * 引号闭合判定: 仅当引号后是结构字符 (,}]: 或结尾) 时才视为字符串结束
     */
    static lenientJsonParse(s) {
        let out = '';
        let inStr = false;
        const n = s.length;
        for (let i = 0; i < n; i++) {
            const ch = s[i];
            if (!inStr) {
                if (ch === '"') { inStr = true; out += ch; continue; }
                if (ch === ',') {
                    let j = i + 1;
                    while (j < n && /\s/.test(s[j])) j++;
                    if (s[j] === '}' || s[j] === ']') continue; // 丢弃尾逗号
                }
                out += ch;
                continue;
            }
            // 字符串内
            if (ch === '\\') { out += ch + (s[i + 1] || ''); i++; continue; }
            if (ch === '"') {
                let j = i + 1;
                while (j < n && /\s/.test(s[j])) j++;
                const nxt = s[j];
                if (nxt === undefined || ',}]:'.includes(nxt)) { inStr = false; out += ch; continue; }
                out += '\\"'; // 内容引号, 转义
                continue;
            }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return JSON.parse(out);
    }

    /** 计算补齐未闭合括号所需的结束符 (跳过字符串字面量) */
    static jsonClosers(str) {
        const pair = { '{': '}', '[': ']' };
        const stack = [];
        let inStr = false, esc = false;
        for (const ch of str) {
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{' || ch === '[') stack.push(ch);
            else if (ch === '}' || ch === ']') stack.pop();
        }
        return stack.reverse().map(c => pair[c]).join('');
    }

    /** 尝试修复被截断的 JSON: 先整体闭合, 再从后往前在结构边界截断后闭合 (尽量多保留内容) */
    static repairTruncatedJson(s, tryParse) {
        const parse = tryParse || ((str) => { try { return JSON.parse(str); } catch (_) { return null; } });

        // 整体闭合 (截断点落在字符串中间时也能正确保留)
        let r = parse(s + AgnesAPIClient.jsonClosers(s));
        if (r) return r;

        // 从最靠后的结构边界 (}/]/,) 往前试, 丢弃残缺的尾部, 保留已完成的元素
        const cuts = [];
        for (let i = s.length - 1; i >= 0 && cuts.length < 60; i--) {
            if (s[i] === '}' || s[i] === ']' || s[i] === ',') cuts.push(i);
        }
        for (const cut of cuts) {
            const head = s[cut] === ',' ? s.slice(0, cut) : s.slice(0, cut + 1);
            r = parse(head + AgnesAPIClient.jsonClosers(head));
            if (r) return r;
        }
        return null;
    }

    /* ================= 模型列表 / 连接测试 ================= */

    async fetchModels() {
        const url = this.base + '/models';
        try {
            console.log(`🔍 拉取模型列表: ${url}`);
            const data = await this.request(url);
            const list = data?.data || data?.models || (Array.isArray(data) ? data : []);
            return list.map(m => (typeof m === 'string' ? m : (m.id || m.model || m.name))).filter(Boolean);
        } catch (e) {
            console.warn('拉取模型列表失败:', e.message);
            return null;
        }
    }

    async testConnection() {
        console.log('🔍 测试 API 连接...');
        try {
            const models = await this.fetchModels();
            if (models && models.length > 0) {
                return { success: true, platform: this.platform, endpoint: this.base, models };
            }
            // /models 不支持不代表接口不可用 (如方舟) —— 用一次空任务查询探测鉴权
            // 401/403 说明密钥错误，其它错误视为端点可达
            try {
                await this.request(this.base + (this.isArk() ? '/contents/generations/tasks/probe' : '/videos/__probe__'));
            } catch (e) {
                if (e.status === 401 || e.status === 403) {
                    return { success: false, platform: this.platform, error: 'API 密钥无效 (401/403)' };
                }
            }
            return { success: true, platform: this.platform, endpoint: this.base, models: [] };
        } catch (error) {
            return { success: false, platform: this.platform, error: error.message };
        }
    }

    /* ================= 下载 ================= */

    async downloadVideo(videoUrl, filename, needsAuth = false) {
        const headers = needsAuth ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
        const response = await fetch(this.buildUrl(videoUrl), { headers });
        if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
        return true;
    }
}

// 火山方舟常用模型 ID 建议 (可在方舟控制台"开通管理"页查看全部)
AgnesAPIClient.ARK_MODELS = [
    'doubao-seedance-1-0-pro-250528',
    'doubao-seedance-1-0-lite-t2v-250428',
    'doubao-seedance-1-0-lite-i2v-250428'
];
