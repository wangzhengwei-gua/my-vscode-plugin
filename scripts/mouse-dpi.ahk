#Requires AutoHotkey v2.0
#SingleInstance Force

APP_TITLE := "DPI 调节器 v1.0"

; 创建 GUI
mainGui := Gui("-MaximizeBox +AlwaysOnTop", APP_TITLE)
mainGui.SetFont("s12 norm", "Microsoft YaHei")

; 标题区
mainGui.SetFont("s12 bold")
mainGui.Add("Text", "Center w480", "多品牌鼠标 DPI 调节器")
mainGui.SetFont("s9 cGray norm")
mainGui.Add("Text", "Center w480", "适用于 PUBG / 桌面 / 通用场景")
mainGui.SetFont("s10 norm")

; 品牌选择
mainGui.Add("Text", "w480", "1. 选择鼠标品牌:")
ddlBrand := mainGui.Add("DropDownList", "vBrand w480",
    ["罗技 (Logitech)", "雷蛇 (Razer)", "赛睿 (SteelSeries)", "其他品牌 / 通用"])
ddlBrand.OnEvent("Change", OnBrandChange)

; DPI 预设
mainGui.Add("Text", "w480", "2. 选择 DPI 预设:")
chk1 := mainGui.Add("CheckBox", "vP1 xs+10", "400 DPI (PUBG 职业赛手)")
chk2 := mainGui.Add("CheckBox", "vP2 xp+10 yp", "800 DPI (PUBG 推荐)")
chk3 := mainGui.Add("CheckBox", "vP3 xs+10", "1600 DPI (桌面)")
chk4 := mainGui.Add("CheckBox", "vP4 xp+10 yp", "3200 DPI (超高 DPI)")
chk1.OnEvent("Click", OnPresetSelect)
chk2.OnEvent("Click", OnPresetSelect)
chk3.OnEvent("Click", OnPresetSelect)
chk4.OnEvent("Click", OnPresetSelect)

; 自定义 DPI
mainGui.Add("Text", "w480", "或自定义 DPI (100-25600):")
customDPI := mainGui.Add("Edit", "vCustomDPI w120 xs+0", "800")
mainGui.Add("Text", "xs+10 cGray", "留空则使用上面的预设")

; 操作按钮组（一行）
mainGui.Add("Text", "w480", "3. 操作:")
btnApply := mainGui.Add("Button", "w140 xs+0", "应用 DPI")
btnCheck := mainGui.Add("Button", "w140 xp+150", "检测当前 DPI")
btnClose := mainGui.Add("Button", "w140 xp+150", "关闭")
btnApply.OnEvent("Click", OnApply)
btnCheck.OnEvent("Click", OnCheck)
btnClose.OnEvent("Click", (*) => ExitApp())

; PUBG eDPI 计算器
mainGui.Add("Text", "w480 cBlue", "PUBG eDPI 计算器")
mainGui.Add("Text", "w480", "PUBG 内灵敏度 (1-100):")
edDPI := mainGui.Add("Edit", "vGameSens w80 xs+0", "50")
mainGui.Add("Text", "xs+10 cGray", "默认 50  范围 1-100")
btnCalc := mainGui.Add("Button", "w140 xs+0", "计算 eDPI")
btnCalc.OnEvent("Click", OnCalc)
edpiResult := mainGui.Add("Text", "w480 cGreen", "")

; 帮助链接
mainGui.Add("Text", "w480 cGray", "品牌官方软件:")
mainGui.SetFont("s9")
mainGui.Add("Link", "w480", '<a href="https://www.logitechg.com/zh-cn/innovation/g-hub.html">罗技 G HUB</a>  |  <a href="https://www.razer.com/synapse-3">雷蛇 Synapse 3</a>  |  <a href="https://steelseries.com/engine">赛睿 GG</a>')

; 默认选 800 DPI
chk2.Value := 1
g_selectedDPI := 800

mainGui.Show("AutoSize")

; 全局
g_lastBrand := 0

; ----- 事件 -----

OnPresetSelect(ctrl, *) {
    global chk1, chk2, chk3, chk4
    boxes := [chk1, chk2, chk3, chk4]
    for b in boxes {
        if b != ctrl
            b.Value := 0
    }
}

OnBrandChange(*) {
    g_lastBrand := ddlBrand.Value
}

OnApply(*) {
    if (g_lastBrand = 0) {
        MsgBox("请先选择鼠标品牌！", "提示", "Icon!")
        return
    }
    dpi := GetDPIValue()
    if (dpi = 0) {
        MsgBox("DPI 值无效", "错误", "Icon!")
        return
    }
    ApplyDPI(g_lastBrand, dpi)
}

OnCheck(*) {
    MsgBox("Windows 系统不存储鼠标 DPI 值（DPI 是硬件参数）。`n`n检测方法:`n1. 查看鼠标底部 DPI 按钮`n2. 打开对应品牌软件（G HUB / Synapse / SteelSeries GG）`n3. 查看鼠标说明书", "提示", "Iconi")
}

OnCalc(*) {
    dpi := GetDPIValue()
    if (dpi = 0) dpi := 800
    sens := Integer(edDPI.Value)
    if (sens < 1 || sens > 100) {
        MsgBox("灵敏度范围 1-100", "错误", "Icon!")
        return
    }
    eDPI := dpi * sens / 50
    cm360 := Round(360 / eDPI * 2.54, 2)
    edpiResult.Value := "eDPI = " eDPI "  |  360度约 " cm360 " cm (PUBG 高手 eDPI 通常 200-400)"
}

; 获取当前选中的 DPI
GetDPIValue() {
    global chk1, chk2, chk3, chk4, customDPI
    if (chk1.Value) {
        return 400
    }
    if (chk2.Value) {
        return 800
    }
    if (chk3.Value) {
        return 1600
    }
    if (chk4.Value) {
        return 3200
    }
    v := customDPI.Value
    if (v != "") {
        return Integer(v)
    }
    return 0
}

; ----- 应用 DPI -----
ApplyDPI(brandIdx, dpi) {
    brandName := ["", "Logitech", "Razer", "SteelSeries", "Generic"][brandIdx]

    if (TryHIDSetDPI(dpi)) {
        MsgBox("DPI 调节请求已发送！`n`n品牌: " brandName "`n目标 DPI: " dpi "`n`n如果没生效，请打开对应品牌官方软件确认", "成功", "Iconi")
    } else {
        msg := "DPI 调节需要通过官方软件完成。`n`n品牌: " brandName "`n目标 DPI: " dpi "`n`n"
        if (brandIdx = 1) {
            msg .= "罗技 G HUB 操作:`n1. 打开 G HUB`n2. 选择你的鼠标`n3. DPI 设置 → " dpi "`n`n下载: https://www.logitechg.com/zh-cn/innovation/g-hub.html"
        } else if (brandIdx = 2) {
            msg .= "雷蛇 Synapse 3 操作:`n1. 打开 Synapse 3`n2. 选择你的鼠标`n3. 性能 → DPI = " dpi "`n`n下载: https://www.razer.com/synapse-3"
        } else if (brandIdx = 3) {
            msg .= "赛睿 SteelSeries GG 操作:`n1. 打开 GG`n2. Engine → 选择鼠标`n3. Sensitivity (DPI) = " dpi "`n`n下载: https://steelseries.com/engine"
        } else {
            msg .= "通用方法:`n1. 查看鼠标底部 DPI 按钮`n2. 按按钮切换到 " dpi " DPI 档位`n3. 或安装厂商官方软件`n`n常见档位: 400 / 800 / 1600 / 3200"
        }
        MsgBox(msg, "DPI 调节指南", "Iconi")
    }
}

TryHIDSetDPI(dpi) {
    ; HID 协议私有，不直接尝试。返回 false 引导用户用官方软件
    return false
}
