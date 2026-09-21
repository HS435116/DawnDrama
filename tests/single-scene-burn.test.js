/* ============================================================
 * 单分镜: 不拼接, 但要把中文字幕烧进画面 (产出带字幕文件 + 原片一字不改)
 *   node tests/single-scene-burn.test.js
 *
 * 规矩 (用户明确要求):
 *   · 单分镜 (1 个片段) 不做拼接合并 —— 拼接一个文件只会白重编码一次
 *   · 但要把中文字幕烧录进画面, 产出 <集名>_完整版.mp4 (带字幕) + <集名>_字幕.srt
 *   · 原片必须原封不动 (字节级不变), 不能被当成临时文件删掉 / 不能被复制充数
 *   · 多分镜维持原行为 (拼接 + 烧录 -> 成片)
 *
 * 用例分四层, 越靠后越接近真实链路:
 *   1. 静态契约: 脚本里单分镜确实走"烧录"而不是"复制原片", 收尾清理不许删原片
 *   2. 真实跑 (无语音夹具): 走 no-speech 分支 -> 不产出假成片, 原片字节不变
 *   3. 真实烧录 (自造静音视频 + 手写 srt): 证明字幕真的被烧进画面 (像素级)
 *   4. 完整链路 (本机有真实带语音片段时才跑): 产出带字幕的成片, 原片不变
 *      —— 没有可用片段时打印"跳过", 不算失败
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'merge_videos.py');

let failures = 0, passed = 0, skipped = 0;
function check(name, actual, expected) {
    if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
    else { failures++; console.log(`  ❌ ${name}\n     期望: ${JSON.stringify(expected)}\n     实际: ${JSON.stringify(actual)}`); }
}
const skip = (why) => { skipped++; console.log(`  ⏭️ 跳过 (${why})`); };
const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');

/** 内置运行环境 (便携版/开发机都有): python 与 ffmpeg */
function findPython() {
    for (const d of ['python_temp', 'python']) {
        const p = path.join(ROOT, 'resources', d, 'python.exe');
        if (fs.existsSync(p)) return p;
    }
    return null;
}
function findFfmpeg() {
    const p = path.join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return r.status === 0 ? 'ffmpeg' : null;
}
function findFfprobe(ffmpeg) {
    const p = path.join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe');
    if (fs.existsSync(p)) return p;
    return ffmpeg === 'ffmpeg' ? 'ffprobe' : null;
}

/** 跑一次合并脚本, 返回 {status, result} */
function runMerge(dir, python) {
    const r = spawnSync(python, [SCRIPT, dir], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    let result = null;
    out.split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t.startsWith('{') || !t.endsWith('}')) return;
        try { const j = JSON.parse(t); if (j.result || j.success === false) result = j; } catch (_) { /* 日志里的花括号 */ }
    });
    return { status: r.status, out, result };
}

/**
 * 逐帧统计"画面下部近白色像素的占比" (0~255), 用来证明字幕像素真的出现了。
 * 做法: 裁出画面下部的一条横带 -> 二值化(>200 记为白) -> signalstats 的 YAVG 就是白色占比×255。
 * 对同一时间轴的成片与原片逐帧相减, 得到的就是"字幕额外带来的白色像素", 不受画面内容干扰。
 */
function whiteSeries(ffmpeg, file, { w = 0.8, x = 0.1, y = 0.8, h = 0.18 } = {}) {
    const vf = `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},format=gray,lut=y='if(gt(val,150),255,0)',signalstats,metadata=mode=print:file=-`;
    const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}`.split(/\r?\n/);
    const vals = [];
    for (const line of out) {
        const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
        if (m) vals.push(parseFloat(m[1]));
    }
    return vals;
}

/** 原片 vs 成片: 字幕区域最多多出多少"白色像素"(0~255) */
function maxSubtitleInk(ffmpeg, original, burned) {
    const bands = [0.72, 0.80];          // 字幕可能在的位置 (底部两条带, 逐条扫)
    let best = { delta: -1, band: null, frame: null };
    for (const y of bands) {
        const a = whiteSeries(ffmpeg, original, { y });
        const b = whiteSeries(ffmpeg, burned, { y });
        if (!a.length || !b.length) continue;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const d = b[i] - a[i];
            if (d > best.delta) best = { delta: d, band: y, frame: i };
        }
    }
    return best;
}

/** 视频时长 (秒), 取不到返回 null */
function duration(ffprobe, file) {
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
        { encoding: 'utf8', timeout: 120000 });
    const v = parseFloat((r.stdout || '').trim());
    return Number.isFinite(v) ? v : null;
}

/** 造一个静音夹具: 3 秒纯色画面 + 静音音轨 (不需要任何外部素材/用户数据) */
function makeSilentClip(ffmpeg, outPath) {
    const r = spawnSync(ffmpeg, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x240:r=25:d=3',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000',
        '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath,
    ], { encoding: 'utf8', timeout: 180000 });
    return r.status === 0 && fs.existsSync(outPath);
}

/** 本机有没有"真实带语音"的片段可以用 (用户自己的作品, 只读复制到临时目录, 不进仓库) */
function findSpeechClip() {
    const outDir = path.join(ROOT, 'output');
    if (!fs.existsSync(outDir)) return null;
    const stack = [outDir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (/^video_.*\.mp4$/i.test(e.name)) return p;   // 分镜片段 (带人声对白)
        }
    }
    return null;
}

(async function run() {
    const python = findPython();
    const ffmpeg = findFfmpeg();
    const ffprobe = findFfprobe(ffmpeg);

    console.log('\n【场景 1】静态契约: 单分镜走"烧录", 原片不许被删');
    {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        check('有"单分镜"判定', /single_input\s*=\s*len\(video_files\)\s*==\s*1/.test(src), true);
        check('单分镜跳过拼接', /单分镜: 跳过拼接/.test(src), true);
        check('单分镜把字幕烧进画面 (burn_subtitles 用的是原片)', /if burn_subtitles\(video_files\[0\], srt_out, output_abs\)/.test(src), true);
        check('单分镜不上拼接临时文件 (不白重编码)', /merged_path = video_files\[0\]/.test(src), true);
        check('收尾清理不会删掉单分镜的原片', /if not single_input:[\s\S]{0,200}?os\.remove\(merged_path\)/.test(src), true);
        check('烧录失败不拿原片复制充数', /烧录失败，未生成带字幕的视频/.test(src), true);
        check('结果 JSON 说明是否合并过 + 字幕文件路径', /"merged": _MERGED_STATUS\["merged"\]/.test(src) && /"subtitlePath": _SUBTITLE_STATUS\["path"\]/.test(src), true);
        check('单分镜交付的字幕文件名是 <集名>_字幕.srt', /\{display_name\}_字幕\.srt/.test(src), true);
    }

    console.log('\n【场景 2】真实跑一个"没有语音"的单分镜: 不产假成片, 原片字节不变');
    if (!python) { skip('找不到内置 python (resources/python_temp)'); }
    else if (!ffmpeg) { skip('找不到 ffmpeg'); }
    else {
        const W = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-single-'));
        const dir = path.join(W, '无语音集');
        fs.mkdirSync(dir, { recursive: true });
        const clip = path.join(dir, 'video_1_a.mp4');
        if (!makeSilentClip(ffmpeg, clip)) { skip('造静音夹具失败'); }
        else {
            const before = sha1(clip);
            const r = runMerge(dir, python);
            const res = r.result && r.result.result;
            check('脚本正常结束并返回结果', !!res, true);
            check('如实说明没有合并', res && res.merged, false);
            check('如实说明没生成字幕 (无语音)', res && res.subtitles, false);
            check('说明了原因 (未识别到语音)', /语音/.test(String(res && res.subtitleReason)), true);
            check('原片被完整保留 (字节级不变)', sha1(clip), before);
            check('没有留下一堆没用的成片副本', fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).length, 1);
            check('目录里只剩原片 (外加可能的字幕文件)', fs.readdirSync(dir).some(f => /_完整版\.mp4$/.test(f)), false);
        }
        fs.rmSync(W, { recursive: true, force: true });
    }

    console.log('\n【场景 3】真实烧录: 给定字幕, 字幕真的会出现在画面上 (像素级)');
    if (!python || !ffmpeg) { skip('缺少内置 python / ffmpeg'); }
    else {
        const W = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-burn-'));
        const clip = path.join(W, 'video_1_a.mp4');
        const srt = path.join(W, '手写字幕.srt');
        const burned = path.join(W, '烧录后.mp4');
        if (!makeSilentClip(ffmpeg, clip)) { skip('造夹具失败'); }
        else {
            fs.writeFileSync(srt, '1\n00:00:00,200 --> 00:00:02,800\n这是中文字幕测试\n\n', 'utf8');
            // 直接调用脚本里的烧录函数 (单分镜路径用的就是它)
            const code = [
                'import sys', `sys.path.insert(0, r"${ROOT}")`,
                'import merge_videos as m',
                `ok = m.burn_subtitles(r"${clip}", r"${srt}", r"${burned}")`,
                'print("BURN_OK" if ok else "BURN_FAIL")',
            ].join('\n');
            const r = spawnSync(python, ['-c', code], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
            check('burn_subtitles 返回成功', /BURN_OK/.test(r.stdout || ''), true);
            check('产出了新的带字幕文件', fs.existsSync(burned), true);
            check('不是原片副本 (确实重编码过)', fs.existsSync(burned) && sha1(burned) !== sha1(clip), true);
            if (ffprobe) {
                const d1 = duration(ffprobe, clip), d2 = duration(ffprobe, burned);
                check('时长没有变化 (烧录不改时长)', d1 !== null && Math.abs(d2 - d1) < 0.3, true);
            } else skip('没有 ffprobe, 跳过时长校验');
            const ink3 = maxSubtitleInk(ffmpeg, clip, burned);
            if (ink3.delta < 0) skip('取不到逐帧统计值');
            else {
                check('字幕像素确实出现在画面上 (逐帧比对原片)', ink3.delta > 5, true);
                console.log(`     (字幕区域最多多出 ${ink3.delta.toFixed(1)}/255 的白色像素 · 第 ${ink3.frame} 帧 · 下 ${(ink3.band * 100).toFixed(0)}% 处)`);
            }
        }
        fs.rmSync(W, { recursive: true, force: true });
    }

    console.log('\n【场景 4】完整链路: 单分镜 -> 产出带字幕的成片, 原片一字不改');
    if (!python || !ffmpeg) { skip('缺少内置 python / ffmpeg'); }
    else {
        const speech = findSpeechClip();
        if (!speech) { skip('本机没有可用的真实分镜片段 (只读用户作品做夹具, 不进仓库)'); }
        else {
            const W = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-e2e-single-'));
            const dir = path.join(W, '单镜集');
            fs.mkdirSync(dir, { recursive: true });
            const clip = path.join(dir, 'video_1_x.mp4');
            fs.copyFileSync(speech, clip);
            const before = sha1(clip);
            console.log(`     夹具: ${path.relative(ROOT, speech)} (只读复制)`);

            const r = runMerge(dir, python);
            const res = r.result && r.result.result;
            check('脚本正常结束并返回结果', !!res, true);
            check('明确说明没有合并 (单分镜不拼接)', res && res.merged, false);
            check('明确说明字幕已生成', res && res.subtitles, true);
            const out = res ? res.finalVideoPath : '';
            check('成片文件名是 <集名>_完整版.mp4', /单镜集_完整版\.mp4$/.test(String(out)), true);
            check('成片真的落盘了', !!out && fs.existsSync(out), true);
            check('字幕文件也留下了 (<集名>_字幕.srt)', !!res && res.subtitlePath && fs.existsSync(res.subtitlePath), true);
            check('原片字节级不变 (没被当成临时文件删掉/改写)', sha1(clip), before);
            if (out && fs.existsSync(out)) {
                check('成片是重编码的带字幕版本 (与原片不同)', sha1(out) !== before, true);
                const ink4 = maxSubtitleInk(ffmpeg, clip, out);
                if (ink4.delta < 0) skip('取不到逐帧统计值');
                else {
                    check('成片字幕像素确实出现在画面上 (逐帧比对原片)', ink4.delta > 5, true);
                    console.log(`     (字幕区域最多多出 ${ink4.delta.toFixed(1)}/255 的白色像素 · 第 ${ink4.frame} 帧 · 下 ${(ink4.band * 100).toFixed(0)}% 处)`);
                }
            }
            fs.rmSync(W, { recursive: true, force: true });
        }
    }

    console.log('\n【场景 5】多分镜维持原行为: 仍然拼接 + 烧录 -> 一个成片');
    if (!python) { skip('找不到内置 python'); }
    else {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        check('多分镜仍走 concat_videos', /if not concat_videos\(video_files, merged_path\)/.test(src), true);
        check('多分镜仍烧录并输出成片', /if burn_subtitles\(merged_path, srt_path, output_abs\)/.test(src), true);
        check('多分镜的临时文件照旧清理', /if not single_input:[\s\S]{0,200}?os\.remove\(merged_path\)/.test(src), true);
        check('至少 2 个文件的旧限制已去掉 (单分镜不再报错)', /至少需要 2 个视频文件才能合并/.test(src), false);
    }

    console.log(`\n结果: ${passed} 通过, ${failures} 失败${skipped ? `, ${skipped} 跳过` : ''}\n`);
    process.exit(failures ? 1 : 0);
})();
