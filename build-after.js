/* ============================================================
 * AGNES 2.5 - electron-builder 打包钩子: 打完包自动盖更新清单
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 解决什么问题:
 *   以前发版全靠手工 —— 打完包要记得去改 latest.json 的版本号、算两个包的 SHA256、
 *   再把中文文件名百分号编码进 url、上传下载站、同步站点清单。漏一步或算错一个包,
 *   客户端就会"下载到校验失败"或者"永远发现不了新版本", 而且很难看出是哪一步错的。
 *   现在 `npm run desktop:build` 打完包会在这里自动收尾, 顺序和数值都不可能对不上。
 *
 * 为什么是 afterAllArtifactBuild (打包之后) 而不是打包之前:
 *   哈希必须对"最终产物"算, 打包前文件还不存在。应用内虽然也带了一份 latest.json,
 *   但运行时不读它 (版本信息一律走远端清单 + 本地缓存), 所以不存在先后依赖。
 *
 * 失败会让整个构建失败 —— 这是故意的: 宁可构建红一次, 也不要发出去一个清单对不上的版本。
 * 只想临时打个测试包不盖清单: 设环境变量 AGNES_SKIP_STAMP=1
 * 换下载站目录: AGNES_SITE_DIR=<路径>; 不想自动复制包过去: AGNES_NO_SITE_COPY=1
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { stampLatest, DEFAULT_SITE } = require('./stamp-latest');

/** 把 stampLatest 的多行输出统一切上 [发版] 前缀, 混在 electron-builder 日志里也好认 */
const prefixed = (m) => {
    for (const line of String(m).split('\n')) console.log(line ? `[发版] ${line}` : '');
};

/**
 * 这一版的更新说明从哪来。
 * 优先环境变量, 其次项目根目录的 release-notes.txt (没有就返回空)。
 * 必须让打包这一步拿到新说明: 版本号变化时 stampLatest 会把"上一条"归档进 history ——
 * 如果此时清单里的 notes 还是上一版文字, 新版本的说明就会缺失 (或者反过来把新说明
 * 记到旧版本头上)。所以宁可直接报错, 也不发一个说明对不上版本的清单。
 */
function readReleaseNotes() {
    // 按行写更好读, 但清单里的 notes 一直是单段文本 (界面按整段显示), 所以把换行折叠成空格
    const tidy = (s) => String(s).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
    if (process.env.AGNES_RELEASE_NOTES) {
        return { text: tidy(process.env.AGNES_RELEASE_NOTES), file: '' };
    }
    const file = process.env.AGNES_RELEASE_NOTES_FILE
        ? path.resolve(String(process.env.AGNES_RELEASE_NOTES_FILE))
        : path.join(__dirname, 'release-notes.txt');
    if (!fs.existsSync(file)) return { text: '', file };
    return { text: tidy(fs.readFileSync(file, 'utf8')), file };
}

/**
 * 从 package.json 的 artifactName 模板推出这次构建该产出的两个文件名。
 * 不写死文件名: 以后改了模板 (去掉版本号、换名字) 这里自动跟着变, 不会静默找不到文件;
 * 版本号也直接取模板里的 ${version}, 和 electron-builder 用的是同一个来源。
 */
function expectedNames(version) {
    const build = require('./package.json').build || {};
    const fromTemplate = (section, fallback) => String((section && section.artifactName) || fallback)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{ext\}/g, 'exe');
    return {
        installerName: fromTemplate(build.nsis, `晨曦短剧梦工坊-安装版-v${version}.exe`),
        portableName: fromTemplate(build.portable, `晨曦短剧梦工坊-v${version}-便携版.exe`),
    };
}

async function afterAllArtifactBuild(buildResult) {
    if (process.env.AGNES_SKIP_STAMP === '1' || process.env.AGNES_SKIP_STAMP === 'true') {
        console.log('[发版] AGNES_SKIP_STAMP=1, 跳过盖更新清单 (这个包不会被自动更新识别)');
        return [];
    }

    const artifacts = ((buildResult && buildResult.artifactPaths) || []).map(String);
    const version = String(require('./package.json').version || '').trim();
    const { installerName, portableName } = expectedNames(version);

    // 按"模板算出来的确切文件名"挑, 不用通配: blockmap / nsis.7z / 旧版本的包 都不会被误认
    const pick = (name) => artifacts.find((p) => path.basename(p) === name);
    const install = pick(installerName);
    const portable = pick(portableName);
    if (!install || !portable) {
        throw new Error(
            `本次构建没找到 v${version} 的两个安装包, 无法盖更新清单\n`
            + `  期待安装版: ${installerName}${install ? ' (已找到)' : ''}\n`
            + `  期待便携版: ${portableName}${portable ? ' (已找到)' : ''}\n`
            + `  实际产出: ${artifacts.map((p) => path.basename(p)).join(', ') || '(空)'}\n`
            + `  版本号不一致时先 npm version <新版本> 再打包; 只打单个目标时用 AGNES_SKIP_STAMP=1 跳过`);
    }

    // 版本号变了就必须有新说明: 否则清单上会留着上一版的文字 (用户看到的"本版更新"是错的),
    // 或者把新说明错记到旧版本头上。这是唯一一处宁可让构建失败也要拦住的地方。
    const notes = readReleaseNotes();
    const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'latest.json'), 'utf8'));
    const versionChanged = String(before.version) !== version;
    if (versionChanged && !notes.text) {
        throw new Error(
            `要发 v${version} (清单里还是 v${before.version}), 但没有本版说明\n`
            + `  把这一版的更新内容写进 ${path.join(__dirname, 'release-notes.txt')} 再打包\n`
            + `  (界面"版本更新"页显示的说明就是它; 只想打个测试包不出清单: AGNES_SKIP_STAMP=1)`);
    }

    try {
        const r = await stampLatest({
            version,
            install,
            portable,
            notes: notes.text,
            // 下载站目录: 默认 D:\DawnDrama; 置空(AGNES_SITE_DIR=)则完全不碰下载站
            site: process.env.AGNES_SITE_DIR !== undefined ? process.env.AGNES_SITE_DIR : DEFAULT_SITE,
            copyToSite: process.env.AGNES_NO_SITE_COPY !== '1',
            log: prefixed,
        });
        // 说明文件用过就改名: 下次发版忘写新说明时, 不会把这一版的文字静默复用一遍
        if (versionChanged && notes.file && fs.existsSync(notes.file)) {
            try {
                fs.renameSync(notes.file, notes.file + '.used');
                prefixed(`  ℹ️ 已把 ${path.basename(notes.file)} 改名为 .used (下次发版请写新的本版说明)`);
            } catch (_) { /* 改名失败不影响发版, 只是下次要自己注意 */ }
        }
        console.log(`[发版] ✓ v${r.version} 收尾完成 (清单已就绪${r.site.synced ? ', 下载站已同步' : ''})`);
    } catch (e) {
        // 让构建失败, 并把原因说清楚 (而不是让用户拿到一个清单对不上的安装包)
        throw new Error('盖更新清单失败: ' + (e.friendly ? e.message : (e.stack || e.message)));
    }
    return [];   // 不额外产出 artifact
}

module.exports = { afterAllArtifactBuild };
