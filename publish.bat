@echo off
chcp 65001 >nul
REM 一键发布脚本
REM 用法:
REM   publish.bat              打包+安装+提交推送
REM   publish.bat --no-install 跳过安装
REM   publish.bat --no-push    不推送
REM   publish.bat --no-install --no-push  组合使用

cd /d "%~dp0"
node scripts\publish.js %*
pause
