#!/usr/bin/env node
/* ============================================================
 * AGNES 2.5 - 发版: 把安装包/便携包的 SHA256 盖进更新清单
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 为什么要有这个脚本:
 *   客户端从 v2.8.11 起会校验更新包的 SHA256 —— 清单里的哈希必须和"实际传上去的那个包"
 *   完全对得上, 否则所有用户的更新都会被判成校验失败、直接拒绝安装。
 *   手工用 certutil 算两次再粘进 JSON, 还要把中文文件名百分号编码进 url, 太容易出错
 *   (填串两个包的哈希、漏改一个 url、算的是上一版的文件), 所以做成一条命令。
 *
 * 用法:
 *   npm run stamp                                # 按 package.json 的版本号盖哈希 (默认从 desktop-dist 找包)
 *   npm run stamp -- --site D:\DawnDrama         # 同时校验并补齐下载站, 并把清单同步过去
 *   npm run stamp -- --version 2.8.11 --notes "本版更新…"
 *   npm run stamp -- --check                     # 只校验现有清单, 不写文件
 *   npm run stamp -- --no-copy                   # 站点缺包时只提醒, 不自动复制
 *
 * 打包时会自动跑 (见 build-after.js / package.json 的 afterAllArtifactBuild),
 * 不需要手动执行 —— 这样清单永远不可能和刚打出来的包对不上。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const MANIFEST = path.join(ROOT, 'latest.json');
const HISTORY_MAX = 5;
const DEFAULT_SITE = 'D:\\DawnDrama';

/** 用户能看懂的失败 (CLI 只打印 message, 不糊一屏堆栈) */
function friendly(msg) {
    const e = new Error(msg);
    e.friendly = true;
    return e;
}

/** 解析命令行参数 (只认 --flag value 和 --flag) */
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

/** 流式计算 SHA256 (包有 300MB+, 不整块读进内存) */
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(file);
        rs.on('data', (c) => h.update(c));
        rs.on('error', (e) => reject(new Error(`读取失败 ${file}: ${e.message}`)));
        rs.on('end', () => resolve(h.digest('hex')));
    });
}

const fmtSize = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

/** 在目录里按版本号找那两个包 (electron-builder 的 artifactName 模板决定文件名) */
function discoverArtifacts(dir, version) {
    const installerName = `晨曦短剧梦工坊-安装版-v${version}.exe`;
    const portableName = `晨曦短剧梦工坊-v${version}-便携版.exe`;
    return { installerName, portableName, installer: path.join(dir, installerName), portable: path.join(dir, portableName) };
}

/** url 前缀沿用清单里原有的主机与目录 (换域名只需改清单, 不用改脚本) */
function resolvePrefix(manifest, override) {
    if (override) return String(override);
    if (manifest.url) {
        try { const u = new URL(manifest.url); return u.origin + u.pathname.replace(/[^/]*$/, ''); } catch (_) { /* 清单里的地址坏了, 用默认 */ }
    }
    return 'http://29b7a853.r21.cpolar.top/data/';
}

/**
 * 盖清单: 算哈希 → 自查 → 写 latest.json → (可选) 校验并补齐下载站。
 * CLI 和打包钩子共用这一份实现, 保证两条路径行为完全一致。
 *
 * @param {object} opts
 * @param {string} [opts.version]      版本号, 默认取 package.json
 * @param {string} [opts.install]      安装包绝对路径 (给了就不按文件名猜)
 * @param {string} [opts.portable]     便携包绝对路径
 * @param {string} [opts.dir]          包目录, 默认 desktop-dist
 * @param {string} [opts.notes]        新版本的功能说明 (仅在版本号变化时写入)
 * @param {string} [opts.base]         覆盖 url 前缀
 * @param {string} [opts.site]         下载站目录 (同步清单 + 校验/补齐 data/, 传 '' 表示不处理)
 * @param {boolean} [opts.check]       只校验现有清单, 不写文件
 * @param {boolean} [opts.copyToSite]  站点 data/ 缺包或对不上时自动复制 (默认 true)
 * @param {(msg:string)=>void} [opts.log] 输出函数 (默认 console.log)
 * @returns {Promise<object>} 结果摘要
 */
async function stampLatest(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    // root 可覆盖, 只为测试: 回归测试在临时目录里放一份 package.json/latest.json,
    // 这样验证"拒绝写入"这类行为时不会碰到真实的发版清单
    const root = path.resolve(String(opts.root || ROOT));
    const manifestPath = path.join(root, 'latest.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const version = String(opts.version || pkg.version || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw friendly(`版本号不像样: "${version}"`);

    // 包位置: 打包钩子会直接把 electron-builder 产出的路径传进来, CLI 则按版本号找
    let { installerName, portableName, installer, portable } = discoverArtifacts(
        path.resolve(String(opts.dir || path.join(root, 'desktop-dist'))), version);
    if (opts.install) { installer = path.resolve(String(opts.install)); installerName = path.basename(installer); }
    if (opts.portable) { portable = path.resolve(String(opts.portable)); portableName = path.basename(portable); }
    for (const f of [installer, portable]) {
        if (!fs.existsSync(f)) {
            throw friendly(`缺少 v${version} 的包: ${f}\n(先 npm run desktop:build, 或用 --dir/--install/--portable 指定)`);
        }
    }

    const prefix = resolvePrefix(manifest, opts.base);
    const url = prefix + encodeURIComponent(installerName);
    const portableUrl = prefix + encodeURIComponent(portableName);

    log(`\n发版清单: v${version}`);
    log(`  安装包: ${installerName}  (${fmtSize(fs.statSync(installer).size)})`);
    log(`  便携包: ${portableName}  (${fmtSize(fs.statSync(portable).size)})`);
    const sha256 = await sha256File(installer);
    const portableSha256 = await sha256File(portable);
    log('  sha256        : ' + sha256);
    log('  portableSha256: ' + portableSha256);

    // 自查 1: 两个包内容不同, 哈希绝不该相同 —— 相同说明算的是同一个文件, 一定是搞错了
    if (sha256 === portableSha256) {
        throw friendly('两个包的哈希一模一样, 说明算成了同一个文件 —— 拒绝写入');
    }
    // 自查 2: 地址里的文件名解回来必须正好是包名 —— 编码错了用户点更新就是 404
    for (const [label, uri, name] of [['url', url, installerName], ['portableUrl', portableUrl, portableName]]) {
        let back = '';
        try { back = decodeURIComponent(new URL(uri).pathname.split('/').pop()); } catch (_) { /* 下面统一报错 */ }
        if (back !== name) throw friendly(`${label} 里的文件名解出来是 "${back}", 应该是 "${name}" —— 拒绝写入`);
    }
    log(`  url          : ${url}`);
    log(`  portableUrl  : ${portableUrl}`);

    if (opts.check) {
        const ok = manifest.sha256 === sha256 && manifest.portableSha256 === portableSha256;
        log(ok ? '\n✓ 清单里的哈希与本地包一致' : '\n✗ 清单里的哈希与本地包不一致 (需要重新盖)');
        return { version, sha256, portableSha256, url, portableUrl, changed: !ok, wrote: false, checked: true };
    }

    // 版本号变了: 把上一条挪进 history (清单只留最近 5 条), 并换上新说明
    const next = { ...manifest };
    const versionChanged = String(manifest.version) !== version;
    if (versionChanged) {
        const history = Array.isArray(manifest.history) ? manifest.history.slice() : [];
        history.unshift({ version: String(manifest.version || ''), date: String(manifest.date || ''), notes: String(manifest.notes || '') });
        next.history = history.filter((it, i) => it.version && history.findIndex((x) => x.version === it.version) === i).slice(0, HISTORY_MAX);
        next.version = version;
        next.date = new Date().toISOString().slice(0, 10);
        log(`  ℹ️ 版本号 ${manifest.version} -> ${version}, 上一条已挪进 history`);
    }
    if (opts.notes) next.notes = String(opts.notes);
    else if (versionChanged) log('  ⚠️ 版本号变了但没给 --notes: 功能说明还是上一版的文字, 记得补 (界面上"本版更新"就是它)');
    next.url = url;
    next.portableUrl = portableUrl;
    next.sha256 = sha256;
    next.portableSha256 = portableSha256;

    const before = fs.readFileSync(manifestPath, 'utf8');
    const after = JSON.stringify(next, null, 2) + '\n';
    if (before !== after) fs.writeFileSync(manifestPath, after, 'utf8');
    log(before === after ? `\n✓ ${manifestPath} 本来就是最新, 无需改动` : `\n✓ 已写入 ${manifestPath}`);

    // 下载站: 清单要同步过去, data/ 里两个包也必须和刚打出来的一模一样 ——
    // 缺包/传坏的包会让用户点更新直接 404 或校验失败, 所以这里顺手补齐
    const siteDir = opts.site === undefined ? DEFAULT_SITE : String(opts.site);
    const site = { dir: '', synced: false, copied: [], mismatched: [] };
    if (!siteDir) {
        return { version, sha256, portableSha256, url, portableUrl, changed: before !== after, wrote: true, site };
    }
    if (!fs.existsSync(siteDir)) {
        log(`\n  ⚠️ 下载站目录不存在, 跳过: ${siteDir}`);
        return { version, sha256, portableSha256, url, portableUrl, changed: before !== after, wrote: true, site };
    }
    site.dir = siteDir;

    // 清单必须放在 data/ 里: 下载站的 serve.js 只对外暴露 data 目录, 客户端请求
    // /latest.json 和 /data/latest.json 都会被映射到 <站点>/data/latest.json
    const siteManifest = path.join(siteDir, 'data', 'latest.json');
    fs.mkdirSync(path.dirname(siteManifest), { recursive: true });
    const manifestSame = fs.existsSync(siteManifest) && fs.readFileSync(siteManifest, 'utf8') === after;
    if (!manifestSame) fs.writeFileSync(siteManifest, after, 'utf8');
    site.synced = true;
    log(manifestSame ? `  ✓ 下载站清单已是最新: ${siteManifest}` : `  ✓ 已同步清单到下载站: ${siteManifest}`);

    const copyToSite = opts.copyToSite !== false;
    for (const [name, localFile, localHash] of [['安装包', installer, sha256], ['便携包', portable, portableSha256]]) {
        const siteFile = path.join(siteDir, 'data', name === '安装包' ? installerName : portableName);
        let why = '';
        if (!fs.existsSync(siteFile)) why = '下载站里没有这个文件';
        else if (fs.statSync(siteFile).size !== fs.statSync(localFile).size) why = '体积与刚打出来的包不一致 (可能是上一次的/传坏了)';
        else if (await sha256File(siteFile) !== localHash) why = '内容与刚打出来的包不一致 (同名但不同文件)';
        if (!why) { log(`  ✓ 下载站 ${name} 与本次构建完全一致`); continue; }
        site.mismatched.push({ name, why });
        if (copyToSite) {
            fs.mkdirSync(path.dirname(siteFile), { recursive: true });
            fs.copyFileSync(localFile, siteFile);
            site.copied.push({ name, file: siteFile });
            log(`  ⇪ 下载站 ${name} ${why} —— 已复制过去: ${siteFile}`);
        } else {
            log(`  ⚠️ 下载站 ${name} ${why} —— 请手动上传 (否则用户点更新会 404)`);
        }
    }

    // 老布局(或旧版 serve.js)把清单放在站点根目录。新版 serve.js 只读 data/ 下那一份,
    // 根目录那份不再生效 —— 两个同名文件正是"版本出错"的温床, 发现就提醒移走 (不自动删)。
    const legacyManifest = path.join(siteDir, 'latest.json');
    if (fs.existsSync(legacyManifest)) {
        let same = false;
        try { same = fs.readFileSync(legacyManifest, 'utf8') === after; } catch (_) { /* 读不了也算隐患 */ }
        site.legacyManifest = { file: legacyManifest, same };
        log(`  ⚠️ ${legacyManifest} 还留着一份清单${same ? ' (内容相同)' : ' (内容已和 data/ 那份不一致)'}`);
        log('     新版 serve.js 只读 data/latest.json, 根目录这份不再生效 —— 建议移走, 只留 data/ 里那一份');
    }

    return { version, sha256, portableSha256, url, portableUrl, changed: before !== after, wrote: true, site };
}

module.exports = { stampLatest, sha256File, discoverArtifacts, DEFAULT_SITE };

// ==================== 命令行入口 ====================
if (require.main === module) {
    (async () => {
        const args = parseArgs(process.argv.slice(2));
        try {
            const r = await stampLatest({
                version: typeof args.version === 'string' ? args.version : undefined,
                install: typeof args.install === 'string' ? args.install : undefined,
                portable: typeof args.portable === 'string' ? args.portable : undefined,
                dir: typeof args.dir === 'string' ? args.dir : undefined,
                notes: typeof args.notes === 'string' ? args.notes : undefined,
                base: typeof args.base === 'string' ? args.base : undefined,
                site: typeof args.site === 'string' ? args.site : (args['no-site'] ? '' : undefined),
                check: !!args.check,
                copyToSite: !args['no-copy'],
            });
            if (!args.check) {
                console.log('\n发完版还有两件事:');
                console.log('  ① 下载站: 两个包已在 data/ 就位、data/latest.json 已同步 (上面已自动做完);');
                console.log('  ② 仓库: 把 latest.json 提交并推到 GitHub —— raw 是客户端内置的备用源, 也是');
                console.log('     老客户端唯一的兜底 (它们内置的第一个源是上次的隧道域名, 早就失效了)。');
                console.log('     忘了推这一步的表现是: 老用户那边静悄悄、永远发现不了新版本,');
                console.log('     而下载站清单看着一切正常, 极难排查。\n');
            }
            process.exit(0);
        } catch (e) {
            console.error('\n✗ ' + (e.friendly ? e.message : (e.stack || e.message)));
            process.exit(1);
        }
    })();
}
