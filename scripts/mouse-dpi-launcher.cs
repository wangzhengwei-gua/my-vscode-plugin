using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class MouseDpiLauncher {
    static void Main() {
        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string ahkScript = Path.Combine(exeDir, "mouse-dpi.ahk");

        if (!File.Exists(ahkScript)) {
            MessageBox.Show("Script not found: " + ahkScript, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

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
            MessageBox.Show("AutoHotkey v2 not found. Please install from:\nhttps://www.autohotkey.com/", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Process.Start(ahkPath, "\"" + ahkScript + "\"");
    }
}
