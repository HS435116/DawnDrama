#!/usr/bin/env node
/* ============================================================
 * AGNES 2.5 — 释放被"旧实例"占用的端口 (命令行入口)
 * Copyright (c) 2026 @ 晨曦微光工作室
 *
 * 用法: node free-port.js [端口] [--all]
 *   默认只结束命令行中包含 server.js 的进程 (即本项目的旧实例),
 *   不会误杀其它程序; 加 --all 才会结束占用该端口的任意进程。
 *
 * 具体实现见 port-utils.js (server.js 启动时的端口回收也用它)。
 * ============================================================ */
const { freePort } = require('./port-utils');

const args = process.argv.slice(2);
const killAll = args.includes('--all');
const port = parseInt(args.find(a => /^\d+$/.test(a)) || '3000', 10);

const { freed, occupied } = freePort(port, { all: killAll, log: console.log });

if (freed === 0 && occupied) {
    process.exit(1);   // 端口仍被占着, 启动脚本据此知道没能腾出端口
}
