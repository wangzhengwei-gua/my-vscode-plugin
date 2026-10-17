# Change Log

All notable changes to the "my-vscode-plugin" extension will be documented in this file.

## [0.8.52] - 2026-10-09

✨ Features:
  - 「🔥 热号统计」扩展到 6 个彩种：大乐透 / 双色球 / 快乐8 / 排列三 / 排列五 / 福彩3D
  - 统计期数可选：10 / 20 / 30 / 40 / 50（页面下拉自动重算，数据不足的档位自动禁用）
  - 数字彩按位分组 + 「全部位合计」；快乐8 按 1-80 单组统计（每期 20 个）
  - 原「最近10期热号」更名为「热号统计」

## [0.8.51] - 2026-10-09

✨ Features:
  - 新增「🔥 最近10期热号」（大乐透 / 双色球）：热度矩阵（按次数分档上色）、热号 TOP10、
    未出现过的号码、近 10 期开奖明细、理论期望与下一期单号概率对比

## [0.8.50] - 2026-09-29

✨ Features:
  - 新增「🔢 号码排序」工具：粘贴任意分隔号码 → 升序 / 降序，支持去重、补零、
    输出分隔符选择、个数与重复号统计、一键复制（页面剪贴板失败时回退 VSCode 剪贴板）

## [0.8.49] - 2026-09-28

✨ Features:
  - 大乐透分区统计新增「近 300 期」档位

## [0.8.48] - 2026-09-28

✨ Features:
  - 取消自动保存：只有点「💾 保存当前方案」才写入记录，改号码盘不再产生中间态记录
  - 手动保存也做去重：与最近一条方案完全相同时提示"未重复记录"
  - 新增「🧹 清理中间态记录」：一键删掉前区选号 <5 个或后区选号 <2 个（无法组复式）的旧记录

## [0.8.47] - 2026-09-28

🐛 Fixes:
  - 复式注数口径修正：复式投注 = C(前区选号个数,5) × C(后区选号个数,2)，只按选中的号组复式
    （前区 8 + 后区 4 = 56×6 = 336 注 = 672 元）；原「胆码 + 剩余池全包」改为对比参考小字
  - 选号个数 <5（前区）/ <2（后区）时才提示无法组复式，不再误报"胆码过多"
✨ Features:
  - Markdown 记录文件精简：去掉总览表，每条记录改为与页面「复制当前方案」一致的分行格式
    （🟢 选号 / 🔴 杀号 / ⚪ 剩余池 + 个数 / 💰 复式注数 / 📝 备注）；「导出为 Markdown」同步一致

## [0.8.46] - 2026-09-28

✨ Features:
  - 大乐透选号杀号：复制文本改为分行标注（🟢 选号 / 🔴 杀号 / ⚪ 剩余池 + 个数 + 复式注数 + 备注），
    新增「📋 复制为 Markdown」，记录「复制」按钮同步使用完整格式
  - 方案记录改为以 Markdown 文件保存：globalStoragePath/dltPickKill.md（总览表 + 逐条明细），
    每次保存 / 删除 / 清空同步重写；「📂 打开记录文件（Markdown）」可直接打开，
    「📋 导出为 Markdown」复制全文；json 退化为页面索引 dltPickKill.index.json（含旧文件迁移）

## [0.8.45] - 2026-09-28

✨ Features:
  - 新增「🎯 大乐透选号杀号」功能（功能菜单项 + myPlugin.dltPickKill 命令）
  - 前区 1-35 / 后区 1-12 号码盘三态点选（未选 → 选号胆码 → 杀号），支持批量文本输入与选杀互换
  - 展示胆码 / 杀号 / 剩余池、复式全包注数与金额预估
  - 历史校验：杀号被击穿率、胆码场均命中数，实测 vs 超几何理论 + z 值 + 逐号次数与遗漏
  - 方案记录持久化：自动保存（去重）、手动保存、载入 / 复制 / 删除 / 导出、可打开存储文件
    存储位置 = globalStoragePath/dltPickKill.json

## [0.8.7] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.9.vsix -> my-vscode-plugin-0.8.7.vsix
  - 更新 package.json（版本/依赖）


## [0.9.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.9.vsix


## [0.9.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.9.vsix


## [0.9.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.9.vsix


## [0.9.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
♻️ Refactor:
  - 更新脚本: build-dpi-exe.ps1
  - 更新脚本: mouse-dpi-launcher.bat
  - 更新脚本: mouse-dpi-launcher.cs
  - 更新脚本: mouse-dpi.ahk
  - 更新脚本: mouse-dpi.exe
  - 更新脚本: mouse-speed.ahk
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.9.vsix
  - 更新 package.json（版本/依赖）


## [0.9.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.8.vsix -> my-vscode-plugin-0.9.9.vsix
  - 更新 package.json（版本/依赖）


## [0.9.8] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.7.vsix -> my-vscode-plugin-0.9.8.vsix
  - 更新 package.json（版本/依赖）


## [0.9.7] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 改动: images/time-clock.png
  - 改动: images/time-clock.svg
  - 更新打包文件: my-vscode-plugin-0.9.6.vsix -> my-vscode-plugin-0.9.7.vsix
  - 更新 package.json（版本/依赖）


## [0.9.6] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.5.vsix -> my-vscode-plugin-0.9.6.vsix
  - 更新 package.json（版本/依赖）


## [0.9.5] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 改动: images/time-clock.svg
  - 更新打包文件: my-vscode-plugin-0.9.4.vsix -> my-vscode-plugin-0.9.5.vsix
  - 更新 package.json（版本/依赖）


## [0.9.4] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.3.vsix -> my-vscode-plugin-0.9.4.vsix
  - 更新 package.json（版本/依赖）


## [0.9.3] - 2026-08-25

🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.2.vsix -> my-vscode-plugin-0.9.3.vsix
  - 更新 package.json（版本/依赖）


## [0.9.2] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.2.vsix


## [0.9.2] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.9.1.vsix -> my-vscode-plugin-0.9.2.vsix
  - 更新 package.json（版本/依赖）


## [0.9.1] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 改动: _fix2.js
  - 改动: _fix_quotes.js
  - 更新打包文件: my-vscode-plugin-0.9.0.vsix -> my-vscode-plugin-0.9.1.vsix
  - 更新 package.json（版本/依赖）


## [0.9.0] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 改动: _fix2.js
  - 改动: _fix_quotes.js
  - 更新打包文件: my-vscode-plugin-0.8.9.vsix -> my-vscode-plugin-0.9.0.vsix
  - 更新 package.json（版本/依赖）


## [0.8.9] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.8.vsix -> my-vscode-plugin-0.8.9.vsix
  - 更新 package.json（版本/依赖）


## [0.8.8] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.7.vsix -> my-vscode-plugin-0.8.8.vsix
  - 更新 package.json（版本/依赖）


## [0.8.7] - 2026-08-25

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.6.vsix -> my-vscode-plugin-0.8.7.vsix
  - 更新 package.json（版本/依赖）


## [0.8.6] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.5.vsix -> my-vscode-plugin-0.8.6.vsix
  - 更新 package.json（版本/依赖）


## [0.8.5] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.4.vsix -> my-vscode-plugin-0.8.5.vsix
  - 更新 package.json（版本/依赖）


## [0.8.4] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.3.vsix -> my-vscode-plugin-0.8.4.vsix
  - 更新 package.json（版本/依赖）


## [0.8.3] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.2.vsix -> my-vscode-plugin-0.8.3.vsix
  - 更新 package.json（版本/依赖）


## [0.8.2] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.1.vsix -> my-vscode-plugin-0.8.2.vsix
  - 更新 package.json（版本/依赖）


## [0.8.1] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.8.0.vsix -> my-vscode-plugin-0.8.1.vsix
  - 更新 package.json（版本/依赖）


## [0.8.0] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.9.vsix -> my-vscode-plugin-0.8.0.vsix
  - 更新 package.json（版本/依赖）


## [0.7.9] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.8.vsix -> my-vscode-plugin-0.7.9.vsix
  - 更新 package.json（版本/依赖）


## [0.7.8] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.7.vsix -> my-vscode-plugin-0.7.8.vsix
  - 更新 package.json（版本/依赖）


## [0.7.7] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.6.vsix -> my-vscode-plugin-0.7.7.vsix
  - 更新 package.json（版本/依赖）


## [0.7.6] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.5.vsix -> my-vscode-plugin-0.7.6.vsix
  - 更新 package.json（版本/依赖）


## [0.7.5] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.4.vsix -> my-vscode-plugin-0.7.5.vsix
  - 更新 package.json（版本/依赖）


## [0.7.4] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.3.vsix -> my-vscode-plugin-0.7.4.vsix
  - 更新 package.json（版本/依赖）


## [0.7.3] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.2.vsix -> my-vscode-plugin-0.7.3.vsix
  - 更新 package.json（版本/依赖）


## [0.7.2] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.1.vsix -> my-vscode-plugin-0.7.2.vsix
  - 更新 package.json（版本/依赖）


## [0.7.1] - 2026-08-24

✨ Features:
  - 更新主扩展代码（功能菜单/Webview/命令注册）
🔧 Chore:
  - 更新打包文件: .gitignore
  - 更新打包文件: my-vscode-plugin-0.7.0.vsix -> my-vscode-plugin-0.7.1.vsix
  - 更新 package.json（版本/依赖）


## [0.7.0] - 2026-08-24

### ✨ Features
- 新增「🐦 群鸟生命游戏」菜单功能
- 融合 Boids 群飞算法（凝聚/对齐/分离）与 Conway 生命游戏
- 动态 Webview：飞鸟激活网格细胞，触发生命演化
- 可调节鸟数量、凝聚力、对齐力、分离力、演化速度、网格大小
- 鼠标交互：左键吸引鸟群，右键激活生命，"点燃中心"按钮一键激活
- 实时 HUD：鸟数/活细胞数/FPS/演化代数

## [0.6.7] - 2026-08-20

### 🐛 Fixes
- 模型对比页面显示「基于未知期数」修复：JS 端传完整 period/date 字段
- 推荐号码区增加稳定性提示（集成投票对预测值敏感，结果仅供参考）

## [0.6.6] - 2026-08-20

### ♻️ Refactor
- 性能优化：RandomForest 从「每测试点 fit 一次」改为「单次 fit + 评估」
- n_estimators 50→20、max_depth 8→5，单次训练时间减半
- extract_features 用 numpy 切片向量化替代 Python 列表推导
- kNN 算距离用 numpy 向量化
- 排三回测从 14 秒降至 6 秒，排五从 22 秒降至 4.5 秒

## [0.6.5] - 2026-08-20

### 🐛 Fixes
- Python 依赖检测每次都误判为"缺失"修复：改用 spawnSync 分离 stdout/stderr
- 加入检测结果缓存（globalStorage，7 天有效），首次检测后不再重复
- Python `--version` 走 stderr 时也能正确识别

## [0.6.4] - 2026-08-20

### ✨ Features
- 推荐号码区显示「基于期号 (日期)」让结果可追溯

### 🐛 Fixes
- 排五模型对比报错 ENOENT 修复：数据缺失时自动提示爬取

## [0.6.3] - 2026-08-20

### 🐛 Fixes
- 数据文件不存在时自动提示爬取（不再直接报错）

## [0.6.2] - 2026-08-20

### ✨ Features
- Python 环境自动检测（python / py -3 / python3 多候选）
- 自动 pip install 缺失依赖（numpy/sklearn/pandas）

## [0.6.1] - 2026-08-20

### 🐛 Fixes
- 依赖检测失败时给出明确提示与一键复制命令

## [0.6.0] - 2026-08-20

### ✨ Features
- 模型对比支持排列五（5 位号码）
- Python 端动态探测位数，自动生成位数标签（万/千/百/十/个）
- 推荐号码区动态生成对应位数的球
- 新增「📋 一键复制号码」按钮（clipboard API + fallback）

## [0.5.2] - 2026-08-20

### ✨ Features
- 算法名中文化：AR→自回归, Markov→马尔可夫, kNN→K近邻匹配, RandomForest→随机森林
- 每个模型下显示算法说明
- 推荐号码区增加「集成投票说明」解释加权投票与独立预测的差异

## [0.5.1] - 2026-08-20

### 📝 Docs
- 把页面警告语改为祝福语（🌟 运势如虹 / 🍀 福星高照 / 🎉 心诚则灵）

## [0.5.0] - 2026-08-20

### ✨ Features
- 新增推荐号码区：4 模型加权投票集成，显示每位 Top3 候补
- 各模型独立预测明细表

## [0.4.0] - 2026-08-20

### 🐛 Fixes
- 修复 `undefined / 150` 乱码：Python summary 字典补 strict/top3 字段
- 修复 Node 调 Python 时 stdout 编码丢失字段问题：改用 spawn + 临时输出文件

## [0.3.0] - 2026-08-20

### ✨ Features
- 新增「🧠 模型对比预测」菜单功能
- 集成 4 个模型：AR 自回归 / Markov 马尔可夫 / kNN K近邻 / RandomForest 随机森林
- 自动特征工程（和值/跨度/奇偶/大小/频率/自相关）
- 严格命中 + Top3 命中双指标评估
- 智能结论自动判定（✅ 显著 / 🟡 略高 / ❌ 接近随机）

## [0.0.1] - 2026-07-23

### Added
- 初始化插件项目
- 添加 `Hello World` 命令
- 添加 `Show Current Time` 命令
- 添加 `Ctrl+Alt+H` 快捷键
