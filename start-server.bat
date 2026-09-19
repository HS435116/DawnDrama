@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title AGNES Video Generator

echo.
echo ========================================
echo   AGNES 2.5 Video Generator
echo ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] Node.js not found. Please install it first.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

echo [Info] Node.js version:
node --version
echo.

:: Check if dependencies are installed
if not exist "node_modules" (
    echo [Info] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [Error] Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
)

:: 释放上次未正常退出时残留的旧实例占用的端口
echo [Info] Checking port 3000...
node free-port.js 3000
echo [Info] Checking port 3001...
node free-port.js 3001
echo [Info] Checking port 3002...
node free-port.js 3002
echo.

echo ========================================
echo    Starting server...
echo ========================================
echo.
echo Access: http://localhost:3000
echo.
echo Save location is configured in the app: "模型设置 - 保存位置"
echo (stored in agnes-data-dir.json, used for BOTH images/ and video/ output)
echo.
echo Press Ctrl+C to stop the server
echo.

:: Start server
call node server.js

pause
