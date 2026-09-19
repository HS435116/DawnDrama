@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title AGNES 2.5 Launcher

:menu
cls
echo.
echo ========================================
echo    AGNES 2.5 Video Generator
echo ========================================
echo.
echo    [1] Start Server Mode (Recommended)
echo        - Requires Node.js
echo        - Full API support
echo        - Connect to real AGNES 2.5 API
echo.
echo    [2] Direct Browser Mode
echo        - No Node.js needed
echo        - Uses local simulation
echo        - Data saved in browser
echo.
echo    [3] Open Output Folder
echo        - View generated works
echo.
echo    [4] Clear Cache Data
echo        - Clear local storage history
echo.
echo    [0] Exit
echo.
echo ========================================

set /p choice="Select option (0-4): "

if "%choice%"=="1" goto server
if "%choice%"=="2" goto browser
if "%choice%"=="3" goto folder
if "%choice%"=="4" goto clear
if "%choice%"=="0" goto end

echo.
echo [Error] Invalid option, please try again
timeout /t 1 >nul
goto menu

:server
echo.
echo [Info] Starting server mode...
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] Node.js not found
    pause
    goto menu
)
call start-server.bat
goto menu

:browser
echo.
echo [Info] Opening index.html...
start "" "index.html"
goto menu

:folder
explorer "output"
goto menu

:clear
echo.
echo [Info] Please close the browser first, then reopen index.html.
pause
goto menu

:end
echo.
echo Thank you for using AGNES 2.5!
exit /b 0
