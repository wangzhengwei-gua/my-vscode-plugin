#!/usr/bin/env powershell
# 用 C# 编译一个 DPI 调节器 exe 启动器
# 原理：C# exe 内嵌 AHK 脚本字符串，启动时调用 AutoHotkey64.exe 运行

$ErrorActionPreference = "Stop"

$csCode = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace MouseDpiLauncher {
    class Program {
        static void Main(string[] args) {
            // 找到 AutoHotkey v2 解释器
            string[] ahkPaths = {
                @"C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe",
                @"C:\Program Files\AutoHotkey\v2\AutoHotkey32.exe",
                @"C:\Program Files\AutoHotkey\AutoHotkey.exe"
            };

            string ahkPath = null;
            foreach (var p in ahkPaths) {
                if (File.Exists(p)) { ahkPath = p; break; }
            }

            if (ahkPath == null) {
                System.Windows.Forms.MessageBox.Show(
                    "未找到 AutoHotkey v2，请先安装：\nhttps://www.autohotkey.com/",
                    "错误",
                    System.Windows.Forms.MessageBoxButtons.OK,
                    System.Windows.Forms.MessageBoxIcon.Error
                );
                return;
            }

            // 从嵌入资源读取 AHK 脚本
            string script;
            var asm = Assembly.GetExecutingAssembly();
            var resName = "MouseDpiLauncher.mouse-dpi.ahk";
            using (var stream = asm.GetManifestResourceStream(resName))
            using (var reader = new StreamReader(stream)) {
                script = reader.ReadToEnd();
            }

            // 写入临时文件
            string tempAhk = Path.Combine(Path.GetTempPath(), "mouse-dpi-" + Guid.NewGuid().ToString("N") + ".ahk");
            File.WriteAllText(tempAhk, script);

            // 启动 AutoHotkey
            var psi = new ProcessStartInfo {
                FileName = ahkPath,
                Arguments = "\"" + tempAhk + "\"",
                UseShellExecute = false,
                CreateNoWindow = true
            };
            var p = Process.Start(psi);
            p.WaitForExit();

            // 清理临时文件
            try { File.Delete(tempAhk); } catch { }
        }
    }
}
'@

# 嵌入资源：把 mouse-dpi.ahk 作为嵌入文件
$ahkScript = Get-Content -Raw "d:\0.Y003H\Plugin\scripts\mouse-dpi.ahk"

# 临时目录构建
$buildDir = "d:\0.Y003H\Plugin\scripts\_build"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
$ahkResPath = Join-Path $buildDir "mouse-dpi.ahk"
Set-Content -Path $ahkResPath -Value $ahkScript -Encoding UTF8

# 找 csc.exe (.NET 编译器)
$csc = (Get-ChildItem "C:\Windows\Microsoft.NET\Framework64" -Filter "csc.exe" -Recurse |
        Sort-Object FullName -Descending | Select-Object -First 1).FullName
if (-not $csc) {
    $csc = (Get-ChildItem "C:\Windows\Microsoft.NET\Framework" -Filter "csc.exe" -Recurse |
            Sort-Object FullName -Descending | Select-Object -First 1).FullName
}

if (-not $csc) {
    Write-Host "未找到 .NET csc 编译器" -ForegroundColor Red
    exit 1
}

Write-Host "Using compiler: $csc"

# 写 C# 源文件
$csFile = Join-Path $buildDir "Program.cs"
Set-Content -Path $csFile -Value $csCode -Encoding UTF8

# 引用 System.Windows.Forms
$refs = @"
/reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll"
"@

# 编译
$outExe = "d:\0.Y003H\Plugin\scripts\mouse-dpi.exe"
$args = @(
    "/target:winexe",
    "/out:`"$outExe`"",
    "/resource:`"$ahkResPath`,MouseDpiLauncher.mouse-dpi.ahk`"",
    "/reference:`"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll`"",
    "`"$csFile`""
) -join " "

Write-Host "Compiling..."
& $csc $args

if (Test-Path $outExe) {
    $size = (Get-Item $outExe).Length
    Write-Host "✅ Done: $outExe ($size bytes)" -ForegroundColor Green
    Remove-Item -Recurse -Force $buildDir
} else {
    Write-Host "❌ Compile failed" -ForegroundColor Red
}
