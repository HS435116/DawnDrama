#!/usr/bin/env node
/* ============================================================
 * AGNES 2.5 — 端口占用排查与回收
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 被两处共用:
 *   1. free-port.js (命令行工具, 启动脚本调用)
 *   2. server.js (启动时若端口被"本项目的旧实例"占用, 自动回收,
 *      不再静默改用 3001/3002 —— 否则 open-browser.bat 里写死的
 *      http://localhost:3000 会连到旧实例上, 且旧实例越积越多)
 *
 * 安全约定: 默认只结束命令行中包含 server.js 的进程 (即本项目的旧实例),
 * 不会误杀其它程序; 只有显式 all=true 才结束占用该端口的任意进程。
 * ============================================================ */
const { execSync } = require('child_process');

function sh(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
        return '';
    }
}

/** 找出监听指定端口的 PID 列表 (兼容 netstat / ss 两种输出) */
function listeningPids(port) {
    const pids = new Set();
    const p = String(port);

    const out = sh('netstat -ano -p tcp');
    if (out) {
        const re = new RegExp(`^TCP\\s+\\S*:${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');
        out.split(/\r?\n/).forEach(line => {
            const m = line.trim().match(re);
            if (m) pids.add(m[1]);
        });
    }

    // Linux/macOS 回退: ss 的进程列形如 users:(("node",pid=1234,fd=20))
    if (pids.size === 0) {
        const ss = sh(`ss -ltnp 2>/dev/null | grep ':${p} '`);
        for (const m of ss.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
    }
    return [...pids];
}

/** 取进程命令行 (用于判断是不是本项目的 server.js) */
function commandLine(pid) {
    const ps = sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`);
    if (ps.trim()) return ps.trim();
    const wmic = sh(`wmic process where "ProcessId=${pid}" get CommandLine /format:list`);
    const m = wmic.match(/CommandLine=(.+)/);
    if (m) return m[1].trim();
    // POSIX 回退
    return sh(`ps -p ${pid} -o args=`).trim();
}

/** 是否是本项目自己的服务器进程 */
function isOurServer(cmd) {
    return /server\.js/i.test(cmd);
}

function killPid(pid) {
    try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: ['ignore', 'ignore', 'ignore'] });
        return true;
    } catch (_) {
        try {
            execSync(`kill -9 ${pid}`, { stdio: ['ignore', 'ignore', 'ignore'] });
            return true;
        } catch (_) { return false; }
    }
}

/**
 * 释放端口。
 * @param {number|string} port
 * @param {{all?: boolean, log?: Function}} [opts] all=true 时结束任意占用进程
 * @returns {{freed: number, skipped: number, occupied: boolean}} 实际结束/跳过的进程数, 以及原本是否被占用
 */
function freePort(port, opts = {}) {
    const all = !!opts.all;
    const log = opts.log || (() => {});
    const pids = listeningPids(port);
    if (pids.length === 0) {
        log(`✅ 端口 ${port} 未被占用`);
        return { freed: 0, skipped: 0, occupied: false };
    }

    let freed = 0;
    let skipped = 0;
    for (const pid of pids) {
        const cmd = commandLine(pid);
        if (!isOurServer(cmd) && !all) {
            log(`⏭️ 跳过 PID ${pid} (不是本项目的 server.js): ${cmd.slice(0, 120) || '无法读取命令行'}`);
            log(`   如确认要结束它, 请运行: node free-port.js ${port} --all`);
            skipped++;
            continue;
        }
        log(`🛑 结束占用端口 ${port} 的进程 PID ${pid}${isOurServer(cmd) ? ' (旧版 AGNES 服务器实例)' : ''}`);
        if (killPid(pid)) freed++;
    }

    if (freed > 0) {
        log(`✅ 已释放端口 ${port} (结束 ${freed} 个进程)`);
    } else if (skipped === 0) {
        log(`⚠️ 端口 ${port} 仍被占用。可手动执行: netstat -ano | findstr :${port}  然后 taskkill /F /PID <PID>`);
    }
    return { freed, skipped, occupied: true };
}

/** 结束占用该端口的旧实例 (只认本项目的 server.js), 返回结束的进程数 */
function reclaimStaleInstance(port, log) {
    return freePort(port, { all: false, log }).freed;
}

/**
 * 等待端口真正空出来 (进程被结束后监听套接字可能还要一小会儿才消失)。
 * @returns {Promise<boolean>} 超时前是否变为空闲
 */
function waitPortFree(port, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const tick = () => {
            if (listeningPids(port).length === 0) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, 200);
        };
        tick();
    });
}

module.exports = { listeningPids, commandLine, isOurServer, killPid, freePort, reclaimStaleInstance, waitPortFree };
