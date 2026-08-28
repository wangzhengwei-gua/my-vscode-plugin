@echo off
chcp 65001 >nul
REM DPI 调节器启动器
REM 双击即可运行，无需编译成 exe
REM 会调用 AutoHotkey v2 加载 mouse-dpi.ahk 脚本

set "SCRIPT_DIR=%~dp0"
set "AHK_V2_64=C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
set "AHK_V2_32=C:\Program Files\AutoHotkey\v2\AutoHotkey32.exe"

if exist "%AHK_V2_64%" (
    start "" "%AHK_V2_64%" "%SCRIPT_DIR%mouse-dpi.ahk"
    exit /b 0
)

if exist "%AHK_V2_32%" (
    start "" "%AHK_V2_32%" "%SCRIPT_DIR%mouse-dpi.ahk"
    exit /b 0
)

REM 尝试默认安装路径
if exist "C:\Program Files\AutoHotkey\AutoHotkey.exe" (
    start "" "C:\Program Files\AutoHotkey\AutoHotkey.exe" "%SCRIPT_DIR%mouse-dpi.ahk"
    exit /b 0
)

echo [错误] 未找到 AutoHotkey v2，请先安装：
echo 下载页：https://www.autohotkey.com/
echo.
pause
exit /b 1
