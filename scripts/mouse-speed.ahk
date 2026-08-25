#Requires AutoHotkey v2.0
#SingleInstance Force

; ===== 鼠标指针灵敏度调节器 =====
; 修改注册表 HKCU\Control Panel\Mouse\MouseSensitivity（1-20，默认10）
; 同步调用 SystemParametersInfo 让设置立即生效

APP_TITLE := "鼠标指针灵敏度调节器"

; 读取当前值（如果键不存在则用默认值 10）
current := 10
try {
    val := RegRead("HKCU\Control Panel\Mouse\MouseSensitivity", "REG_SZ")
    current := Integer(val)
} catch {
    ; 键不存在或读取失败，用默认 10
    current := 10
}

; 读取当前鼠标加速状态（MouseThreshold1/2 + MouseSpeed）
; MouseSpeed=0 表示无加速，1=低，2=高
mouseSpeedAccel := 0
try {
    mouseSpeedAccel := Integer(RegRead("HKCU\Control Panel\Mouse\MouseSpeed", "REG_SZ"))
} catch {
    mouseSpeedAccel := 1  ; Windows 默认开启
}

; 创建 GUI
mainGui := Gui("-MaximizeBox +AlwaysOnTop", APP_TITLE)
mainGui.SetFont("s12")
mainGui.Add("Text", "Center w380", "拖动滑块调节 Windows 鼠标指针速度")
mainGui.SetFont("s9 cGray")
mainGui.Add("Text", "Center w380", "范围 1（最慢）~ 20（最快）  默认 10")
mainGui.SetFont("s12 norm")

; 数值显示
mainGui.SetFont("s20 bold cBlue")
valText := mainGui.Add("Text", "Center w380 vValText", "10")
mainGui.SetFont("s12 norm")

; 滑块（trackbar）
mainGui.Add("Text", "Section w380", "指针速度:")
slider := mainGui.Add("Slider", "vSpeedSlider w380 Range1-20 ToolTip TickInterval1", current)
slider.OnEvent("Change", OnSliderChange)

; 鼠标加速开关（"提高指针精确度"）
mainGui.SetFont("s11")
mainGui.Add("Text", "w380 xs Section", "鼠标加速（提高指针精确度）:")
chkAccel := mainGui.Add("CheckBox", "vAccel xs+20", "启用鼠标加速")
chkAccel.Value := (mouseSpeedAccel > 0)
chkAccel.OnEvent("Click", OnAccelChange)

; 按钮组
mainGui.SetFont("s11")
btnApply := mainGui.Add("Button", "w90 xs Section", "应用")
btnDefault := mainGui.Add("Button", "w90 xp+100", "恢复默认")
btnOK := mainGui.Add("Button", "w90 xp+100 Default", "确定")

btnApply.OnEvent("Click", OnApply)
btnDefault.OnEvent("Click", OnDefault)
btnOK.OnEvent("Click", OnOK)

; 描述
mainGui.SetFont("s9 cGray")
mainGui.Add("Text", "Center w380", "拖动→点“应用”立即生效  /  “确定”应用并关闭  /  “恢复默认”回到10")

; 显示 GUI
mainGui.Show("AutoSize")

; 状态变量
g_applied := current  ; 已应用的值

; ----- 事件处理 -----
OnAccelChange(*) {
    ; 切换加速状态立即生效
    if (chkAccel.Value) {
        ; 启用加速：MouseSpeed=1, Threshold1=6, Threshold2=10（Windows 默认）
        ApplyAccel(1, 6, 10)
        ToolTip("✅ 鼠标加速已启用（提高指针精确度）", , , 1)
    } else {
        ; 禁用加速：MouseSpeed=0, Threshold1=0, Threshold2=0
        ApplyAccel(0, 0, 0)
        ToolTip("✅ 鼠标加速已禁用（无加速，调节更线性）", , , 1)
    }
    SetTimer(() => ToolTip(, , , 1), -1500)
}

OnSliderChange(*) {
    global valText
    val := slider.Value
    valText.Value := val
    valText.Redraw()
}

OnApply(*) {
    global g_applied
    val := slider.Value
    ApplySpeed(val)
    g_applied := val
    ; 视觉反馈：变绿色 + 提示
    valText.Opt("cGreen")
    valText.Redraw()
    SetTimer(() => (valText.Opt("cBlue"), valText.Redraw()), -1000)
}

OnDefault(*) {
    global valText, g_applied
    slider.Value := 10
    valText.Value := 10
    valText.Redraw()
    ApplySpeed(10)
    g_applied := 10
    valText.Opt("cGreen")
    valText.Redraw()
    SetTimer(() => (valText.Opt("cBlue"), valText.Redraw()), -1000)
}

OnOK(*) {
    global g_applied
    val := slider.Value
    if (val != g_applied)
        ApplySpeed(val)
    mainGui.Destroy()
    ExitApp()
}

; ----- 应用灵敏度（写注册表 + 调系统 API 立即生效） -----
ApplySpeed(val) {
    ; 限制范围 1-20
    if (val < 1)
        val := 1
    if (val > 20)
        val := 20

    ; 1. 写注册表（如果父键不存在则创建）
    try {
        RegWrite(String(val), "REG_SZ", "HKCU\Control Panel\Mouse\MouseSensitivity")
    } catch {
        ; 父键可能不存在，先创建再写
        RunWait("reg add `"HKCU\Control Panel\Mouse`" /f", , "Hide")
        RegWrite(String(val), "REG_SZ", "HKCU\Control Panel\Mouse\MouseSensitivity")
    }

    ; 2. 调用 SystemParametersInfo 让设置立即生效
    ;    SPI_SETMOUSESPEED = 0x0071
    DllCall("user32\SystemParametersInfoW", "UInt", 0x0071, "UInt", val, "Ptr", 0, "UInt", 2)

    ; 3. 鼠标加速相关项：清除"提高指针精确度"会被 SPI_SETMOUSE 影响，这里只改速度
    ;    不动加速设置，保留用户原有偏好

    ; 短暂反馈
    ToolTip("✅ 鼠标指针速度已设为 " val " / 20", , , 1)
    SetTimer(() => ToolTip(, , , 1), -1500)
}

; ----- 应用鼠标加速状态 -----
; speed: 0=关闭加速, 1=低加速, 2=高加速
; thresh1, thresh2: 加速阈值（关闭时设 0,0）
ApplyAccel(speed, thresh1, thresh2) {
    ; 写注册表
    try RegWrite(String(speed), "REG_SZ", "HKCU\Control Panel\Mouse\MouseSpeed")
    try RegWrite(String(thresh1), "REG_SZ", "HKCU\Control Panel\Mouse\MouseThreshold1")
    try RegWrite(String(thresh2), "REG_SZ", "HKCU\Control Panel\Mouse\MouseThreshold2")

    ; 调用 SystemParametersInfo 让设置立即生效
    ; SPI_SETMOUSE = 0x0004, SPIF_SENDCHANGE = 2
    ; 需要传一个 3 个 DWORD 的数组：[speed, thresh1, thresh2]
    buf := Buffer(12)
    NumPut("UInt", speed, buf, 0)
    NumPut("UInt", thresh1, buf, 4)
    NumPut("UInt", thresh2, buf, 8)
    DllCall("user32\SystemParametersInfoW", "UInt", 0x0004, "UInt", 0, "Ptr", buf, "UInt", 2)
}
