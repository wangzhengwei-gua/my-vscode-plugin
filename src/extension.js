const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crawler = require('./crawler');

// 数据目录：优先用插件自己的 data/ 目录，不存在则 fallback 到 dlt-simulator
const PLUGIN_DATA_DIR = path.join(__dirname, '..', 'data');
const DLT_DATA_DIR = 'E:\\dlt-simulator\\data';
const DATA_DIR = fs.existsSync(PLUGIN_DATA_DIR) ? PLUGIN_DATA_DIR : DLT_DATA_DIR;

const LOTTERY_TYPES = [
    {
        key: 'dlt',
        name: '大乐透',
        emoji: '🎲',
        file: 'latest.json',
        positions: [
            { label: '前1', pick: (h) => h.front[0], max: 35 },
            { label: '前2', pick: (h) => h.front[1], max: 35 },
            { label: '前3', pick: (h) => h.front[2], max: 35 },
            { label: '前4', pick: (h) => h.front[3], max: 35 },
            { label: '前5', pick: (h) => h.front[4], max: 35 },
            { label: '后1', pick: (h) => h.back[0], max: 12 },
            { label: '后2', pick: (h) => h.back[1], max: 12 }
        ],
        allNums: (h) => [...h.front, ...h.back],
        bigFn: (n, idx) => idx < 5 ? n >= 18 : n >= 7,
        roadFn: (n) => n % 3
    },
    {
        key: 'ssq',
        name: '双色球',
        emoji: '🔴',
        file: 'ssq.json',
        positions: [
            { label: '红1', pick: (h) => h.red[0], max: 33 },
            { label: '红2', pick: (h) => h.red[1], max: 33 },
            { label: '红3', pick: (h) => h.red[2], max: 33 },
            { label: '红4', pick: (h) => h.red[3], max: 33 },
            { label: '红5', pick: (h) => h.red[4], max: 33 },
            { label: '红6', pick: (h) => h.red[5], max: 33 },
            { label: '蓝', pick: (h) => h.blue[0], max: 16 }
        ],
        allNums: (h) => [...h.red, ...h.blue],
        bigFn: (n, idx) => idx < 6 ? n >= 17 : n >= 9,
        roadFn: (n) => n % 3
    },
    {
        key: 'pl3',
        name: '排列三',
        emoji: '🎯',
        file: 'pl3.json',
        positions: [
            { label: '百', pick: (h) => h.num[0], max: 9 },
            { label: '十', pick: (h) => h.num[1], max: 9 },
            { label: '个', pick: (h) => h.num[2], max: 9 }
        ],
        allNums: (h) => h.num,
        bigFn: (n) => n >= 5,
        roadFn: (n) => n % 3
    },
    {
        key: 'pl5',
        name: '排列五',
        emoji: '🎰',
        file: 'pl5.json',
        positions: [
            { label: '万', pick: (h) => h.num[0], max: 9 },
            { label: '千', pick: (h) => h.num[1], max: 9 },
            { label: '百', pick: (h) => h.num[2], max: 9 },
            { label: '十', pick: (h) => h.num[3], max: 9 },
            { label: '个', pick: (h) => h.num[4], max: 9 }
        ],
        allNums: (h) => h.num,
        bigFn: (n) => n >= 5,
        roadFn: (n) => n % 3
    }
];

function calcStats(cfg, h) {
    const nums = cfg.allNums(h);
    const sum = nums.reduce((a, b) => a + b, 0);
    const sumTail = sum % 10;
    const span = Math.max(...nums) - Math.min(...nums);
    let odd = 0, even = 0;
    nums.forEach(n => n % 2 === 1 ? odd++ : even++);
    let big = 0, small = 0;
    nums.forEach((n, i) => cfg.bigFn(n, i) ? big++ : small++);
    const road = [0, 0, 0];
    nums.forEach(n => road[cfg.roadFn(n)]++);
    return {
        sumTail,
        span,
        oddEven: odd + ':' + even,
        bigSmall: big + ':' + small,
        road012: road[0] + ':' + road[1] + ':' + road[2]
    };
}

function loadLotteryData(cfg) {
    // 动态判断数据目录：优先插件自己的 data/，没有则用 dlt-simulator
    const dir = fs.existsSync(PLUGIN_DATA_DIR) ? PLUGIN_DATA_DIR : DLT_DATA_DIR;
    const filePath = path.join(dir, cfg.file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    return (json.history || []).slice().reverse();
}

function activate(context) {
    console.log('插件 "my-vscode-plugin" 已激活');

    // ===== 侧边栏树视图 =====
    const treeDataProvider = new LotteryTreeDataProvider();
    try {
        vscode.window.registerTreeDataProvider('lotteryMenu', treeDataProvider);
        console.log('树视图注册成功: lotteryMenu');
    } catch (e) {
        console.error('树视图注册失败:', e.message);
    }

    let helloDisposable = vscode.commands.registerCommand('myPlugin.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from My VSCode Plugin!');
    });
    context.subscriptions.push(helloDisposable);

    let timeDisposable = vscode.commands.registerCommand('myPlugin.showTime', () => {
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', { hour12: false });
        vscode.window.showInformationMessage('当前时间: ' + timeStr);
    });
    context.subscriptions.push(timeDisposable);

    let chartDisposable = vscode.commands.registerCommand('myPlugin.openChart', () => {
        let allData;
        try {
            allData = LOTTERY_TYPES.map(cfg => {
                const history = loadLotteryData(cfg);
                const rows = history.map(h => {
                    const stats = calcStats(cfg, h);
                    const positions = cfg.positions.map(p => p.pick(h));
                    return { period: h.period, date: h.date, positions, ...stats };
                });
                return {
                    key: cfg.key,
                    name: cfg.name,
                    emoji: cfg.emoji,
                    positionLabels: cfg.positions.map(p => p.label),
                    positionMax: cfg.positions.map(p => p.max),
                    rows,
                    total: history.length
                };
            });
        } catch (e) {
            // 数据不存在时显示友好提示，并自动触发爬取
            const choice = vscode.window.showInformationMessage(
                '📊 还没有彩票数据，需要先爬取数据才能查看走势图。是否立即爬取？',
                '立即爬取', '稍后再说'
            );
            choice.then(btn => {
                if (btn === '立即爬取') {
                    vscode.commands.executeCommand('myPlugin.refreshData');
                }
            });
            return;
        }

        // 检查是否有空数据
        const emptyTypes = allData.filter(d => d.rows.length === 0);
        if (emptyTypes.length > 0) {
            const choice = vscode.window.showWarningMessage(
                '📊 部分彩种数据为空（' + emptyTypes.map(d => d.name).join('、') + '），是否爬取？',
                '立即爬取', '稍后再说'
            );
            choice.then(btn => {
                if (btn === '立即爬取') {
                    vscode.commands.executeCommand('myPlugin.refreshData');
                }
            });
        }

        const panel = vscode.window.createWebviewPanel(
            'lotteryTrend',
            '彩票走势图',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                // 允许 Webview 加载本地资源
                localResourceRoots: [
                    vscode.Uri.file(path.join(__dirname, 'webview'))
                ]
            }
        );
        panel.webview.html = getTrendHtml(allData, panel.webview);
    });
    context.subscriptions.push(chartDisposable);

    // 刷新彩票数据命令（调用内置爬虫）
    let refreshDisposable = vscode.commands.registerCommand('myPlugin.refreshData', async () => {
        // 选择抓取期数
        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '50 期', value: 50 },
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '500 期', value: 500 },
                { label: '1000 期', value: 1000 }
            ],
            { placeHolder: '选择要爬取的期数' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在爬取彩票数据...',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: '爬取中（可能需要 10-30 秒）...' });
            try {
                // 数据存到插件自己的 data/ 目录
                const results = await crawler.crawlAll(PLUGIN_DATA_DIR, limit);
                let okCount = 0;
                let failMsg = [];
                Object.keys(results).forEach(type => {
                    if (results[type] && !results[type].error) {
                        okCount++;
                    } else {
                        failMsg.push(type + ': ' + (results[type] && results[type].error));
                    }
                });
                if (okCount === 4) {
                    vscode.window.showInformationMessage(
                        '✅ 数据爬取完成！4 个彩种全部成功，各 ' + limit + ' 期。请重新打开走势图查看。'
                    );
                } else {
                    vscode.window.showWarningMessage(
                        '⚠️ 部分爬取失败：' + failMsg.join('; ') + '。成功 ' + okCount + '/4。'
                    );
                }
            } catch (e) {
                vscode.window.showErrorMessage('❌ 爬取失败: ' + e.message);
            }
        });
    });
    context.subscriptions.push(refreshDisposable);

    // 前后期数字转移统计命令（排列三/五）
    let transDisposable = vscode.commands.registerCommand('myPlugin.showTrans', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3' },
                { label: '🎰 排列五', value: 'pl5' }
            ],
            { placeHolder: '选择彩种' }
        );
        if (!pick) return;

        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '50 期', value: 50 },
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '500 期', value: 500 },
                { label: '全部', value: 0 }
            ],
            { placeHolder: '选择统计的历史期数' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        let data;
        try {
            const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
            if (!cfg) return;
            const history = loadLotteryData(cfg);
            if (history.length < 2) {
                vscode.window.showWarningMessage('数据不足，请先刷新数据');
                return;
            }
            // 按期数切片
            const sliced = limit > 0 ? history.slice(-limit) : history;
            const rows = sliced.map(h => {
                const positions = cfg.positions.map(p => p.pick(h));
                return { period: h.period, date: h.date, positions };
            });
            data = {
                key: cfg.key,
                name: cfg.name,
                emoji: cfg.emoji,
                positionLabels: cfg.positions.map(p => p.label),
                rows: rows,
                limit: limit,
                total: history.length
            };
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'transStats',
            '转移统计 - ' + data.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getTransHtml(data);
    });
    context.subscriptions.push(transDisposable);

    // 智能推荐命令（基于转移统计 TOP3 概率）
    let smartPickDisposable = vscode.commands.registerCommand('myPlugin.smartPick', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3' },
                { label: '🎰 排列五', value: 'pl5' },
                { label: '🎲 大乐透', value: 'dlt' },
                { label: '🔴 双色球', value: 'ssq' }
            ],
            { placeHolder: '选择彩种' }
        );
        if (!pick) return;

        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '500 期', value: 500 },
                { label: '全部', value: 0 }
            ],
            { placeHolder: '基于多少期历史数据推荐' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        let data;
        try {
            const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
            if (!cfg) return;
            const history = loadLotteryData(cfg);
            if (history.length < 2) {
                vscode.window.showWarningMessage('数据不足，请先刷新数据');
                return;
            }
            const sliced = limit > 0 ? history.slice(-limit) : history;
            const rows = sliced.map(h => {
                const positions = cfg.positions.map(p => p.pick(h));
                return { period: h.period, date: h.date, positions };
            });
            data = {
                key: cfg.key,
                name: cfg.name,
                emoji: cfg.emoji,
                positionLabels: cfg.positions.map(p => p.label),
                positionMax: cfg.positions.map(p => p.max),
                rows: rows,
                limit: limit,
                total: history.length
            };
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'smartPick',
            '智能推荐 - ' + data.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getSmartPickHtml(data);
    });
    context.subscriptions.push(smartPickDisposable);

    // ===== 自动爬取数据 =====
    // 1. 插件启动时自动爬取（静默，不弹通知，除非失败）
    autoRefresh(500, true);

    // 2. 定时爬取：每天 09:30 和 21:35 各一次
    const SCHEDULE_TIMES = [
        { hour: 9, minute: 30 },
        { hour: 21, minute: 35 }
    ];
    // 记录每个时间点当天是否已触发，格式 "hour:minute" -> "yyyy-m-d"
    let lastTriggered = {};
    const scheduleTimer = setInterval(() => {
        const now = new Date();
        const today = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
        const key = now.getHours() + ':' + now.getMinutes();
        for (const t of SCHEDULE_TIMES) {
            const schedKey = t.hour + ':' + t.minute;
            if (now.getHours() === t.hour && now.getMinutes() === t.minute && lastTriggered[schedKey] !== today) {
                lastTriggered[schedKey] = today;
                autoRefresh(500, false);
                break;
            }
        }
    }, 60 * 1000); // 每分钟检查一次
    context.subscriptions.push({ dispose: () => clearInterval(scheduleTimer) });
}

/**
 * 自动爬取数据（静默模式）
 * @param {number} limit - 期数
 * @param {boolean} silent - 静默模式（成功不弹通知）
 */
async function autoRefresh(limit, silent) {
    try {
        const results = await crawler.crawlAll(PLUGIN_DATA_DIR, limit);
        let okCount = 0;
        let failMsg = [];
        Object.keys(results).forEach(type => {
            if (results[type] && !results[type].error) okCount++;
            else failMsg.push(type + ': ' + (results[type] && results[type].error));
        });
        if (okCount < 4) {
            vscode.window.showWarningMessage('⚠️ 彩票数据自动爬取部分失败：' + failMsg.join('; '));
        } else if (!silent) {
            vscode.window.showInformationMessage('✅ 彩票数据已自动更新（' + limit + ' 期）');
        }
    } catch (e) {
        console.error('自动爬取失败:', e.message);
    }
}

/**
 * 侧边栏树视图：提供功能菜单
 */
class LotteryTreeDataProvider {
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            // 根节点：返回功能菜单项
            return [
                this.createItem('📊 打开走势图', 'myPlugin.openChart', '📊'),
                this.createItem('🔄 刷新彩票数据', 'myPlugin.refreshData', '🔄'),
                this.createItem('🔁 转移统计', 'myPlugin.showTrans', '🔁'),
                this.createItem('🤖 智能推荐', 'myPlugin.smartPick', '🤖'),
                this.createItem('🕐 显示当前时间', 'myPlugin.showTime', '🕐'),
                this.createItem('👋 Hello World', 'myPlugin.helloWorld', '👋')
            ];
        }
        return [];
    }
    createItem(label, command, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.tooltip = label;
        item.description = '';
        // 用 SVG 作为图标（如果存在）
        try {
            const iconPath = path.join(__dirname, '..', 'images', 'icon.svg');
            if (require('fs').existsSync(iconPath)) {
                item.iconPath = vscode.Uri.file(iconPath);
            }
        } catch (e) { /* ignore */ }
        item.command = {
            command: command,
            title: label
        };
        return item;
    }
}

function deactivate() {}

/**
 * 生成随机 nonce（用于 Webview CSP）
 */
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * 表格走势图 HTML
 * 横向：期号 | 段1(0~max1) | 段2(0~max2) | ... | 和尾 | 跨度 | 奇偶比 | 012路
 * 底部：模拟选号（1~5 注，每注独立选 位号）
 */
/**
 * 转移统计 Webview HTML（独立面板）
 */
/**
 * 智能推荐 Webview HTML
 * 算法 1：基于转移统计 TOP3 概率（概率相同时取最近一期）
 * 算法 2：基于趋势分析 —— 取最近若干期同位号码序列，识别趋势（递增/递减/持平/波动），
 *         在历史中搜索匹配该趋势的片段，统计下一期号码分布作为推荐
 */
function getSmartPickHtml(d) {
    const dataJson = JSON.stringify(d);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>智能推荐 - ${d.name}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 8px; }
.desc { color: #aaa; margin-bottom: 16px; line-height: 1.6; }
.limit-badge { display: inline-block; background: #0e639c; color: #fff; padding: 2px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.recommend-section { margin-bottom: 24px; padding: 16px; background: rgba(46,204,113,0.08); border: 1px solid rgba(46,204,113,0.25); border-radius: 8px; }
.recommend-title { color: #2ecc71; font-size: 16px; font-weight: 600; margin-bottom: 12px; }
.recommend-num { display: inline-block; width: 40px; height: 40px; line-height: 38px; text-align: center; background: #e74c3c; color: #fff; border-radius: 50%; font-weight: bold; font-size: 18px; margin: 0 4px; }
.pos-section { margin-bottom: 16px; padding: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
.pos-title { color: #feca57; font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.pick-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.pick-label { color: #888; min-width: 60px; font-size: 12px; }
.pick-num, .pick-num-display { display: inline-block; min-width: 28px; height: 28px; line-height: 26px; text-align: center; border: 2px solid #444; border-radius: 50%; color: #aaa; font-size: 13px; cursor: pointer; user-select: none; background: #1a1a1a; padding: 0 4px; }
.pick-num:hover, .pick-num-display:hover { border-color: #888; color: #fff; }
.pick-num.selected, .pick-num-display.selected { background: #e74c3c; color: #fff; border-color: #e74c3c; font-weight: bold; }
.pick-num.top1, .pick-num-display.top1 { background: #e74c3c; color: #fff; border-color: #e74c3c; font-weight: bold; }
.pick-num.top2, .pick-num-display.top2 { background: #e67e22; color: #fff; border-color: #e67e22; }
.pick-num.top3, .pick-num-display.top3 { background: #f39c12; color: #fff; border-color: #f39c12; }
.pct { color: #888; font-size: 11px; margin-left: 4px; }
.detail-row { font-size: 11px; color: #666; margin-top: 4px; padding-left: 68px; }
.summary-box { margin-top: 16px; padding: 12px; background: #1a2540; border: 1px solid #2a4a7a; border-radius: 6px; }
.summary-box b { color: #fff; }
.copy-btn { background: #0e639c; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 8px; }
.copy-btn:hover { background: #1177bb; }

/* 趋势分析样式 */
.trend-section { margin-bottom: 24px; padding: 16px; background: rgba(155,89,182,0.08); border: 1px solid rgba(155,89,182,0.3); border-radius: 8px; }
.trend-title { color: #9b59b6; font-size: 16px; font-weight: 600; margin-bottom: 12px; }
.trend-seq { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.trend-seq-num { display: inline-block; width: 30px; height: 30px; line-height: 28px; text-align: center; background: #2d2d30; color: #ccc; border-radius: 50%; font-size: 13px; border: 1px solid #555; }
.trend-arrow { color: #888; font-size: 16px; }
.trend-type { display: inline-block; padding: 3px 10px; border-radius: 3px; font-size: 12px; font-weight: 600; margin-left: 8px; }
.trend-type.up { background: rgba(46,204,113,0.2); color: #2ecc71; }
.trend-type.down { background: rgba(231,76,60,0.2); color: #e74c3c; }
.trend-type.flat { background: rgba(149,165,166,0.2); color: #95a5a6; }
.trend-type.mixed { background: rgba(241,196,15,0.2); color: #f1c40f; }
.trend-pos-block { margin-bottom: 14px; padding: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(155,89,182,0.15); border-radius: 6px; }
.trend-pos-title { color: #feca57; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.trend-rec-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.trend-rec-label { color: #888; font-size: 12px; min-width: 80px; }
.trend-rec-num { display: inline-block; min-width: 28px; height: 28px; line-height: 26px; text-align: center; border-radius: 50%; font-size: 13px; font-weight: bold; margin: 0 2px; padding: 0 4px; }
.trend-rec-num.t1 { background: #9b59b6; color: #fff; }
.trend-rec-num.t2 { background: #8e44ad; color: #fff; }
.trend-rec-num.t3 { background: #7d3c98; color: #fff; }
.trend-match-info { color: #666; font-size: 11px; margin-left: 8px; }

/* 复式推荐样式 */
.complex-section { margin-bottom: 24px; padding: 16px; background: rgba(52,152,219,0.08); border: 1px solid rgba(52,152,219,0.3); border-radius: 8px; }
.complex-title { color: #3498db; font-size: 16px; font-weight: 600; margin-bottom: 12px; }
.complex-tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
.complex-tab { padding: 6px 14px; background: #2d2d30; color: #aaa; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
.complex-tab:hover { background: #3a3a3a; color: #fff; border-color: #666; }
.complex-tab.active { background: #0e639c; color: #fff; border-color: #0e639c; font-weight: 600; }
.complex-picks { margin-bottom: 8px; }
.complex-pos-block { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.complex-pos-label { color: #feca57; font-size: 13px; font-weight: 600; min-width: 50px; }
.complex-num { display: inline-block; min-width: 32px; height: 32px; line-height: 30px; text-align: center; border-radius: 50%; font-size: 14px; font-weight: bold; margin: 0 3px; padding: 0 4px; border: 2px solid; position: relative; }
.complex-num sup { font-size: 9px; font-weight: normal; margin-left: 1px; }
.complex-num.algo-pick { box-shadow: 0 0 6px rgba(255,255,255,0.15); }
.complex-num.algo-pick::before { content: "★"; position: absolute; top: -6px; right: -2px; font-size: 10px; color: #f1c40f; text-shadow: 0 0 3px rgba(0,0,0,0.8); }
.complex-num.filler-pick { border-style: dashed !important; opacity: 0.85; }
.complex-num.filler-pick::after { content: "补"; position: absolute; bottom: -6px; right: -2px; font-size: 9px; background: #555; color: #fff; padding: 0 3px; border-radius: 3px; line-height: 12px; }
.complex-num.hot-both { background: #e74c3c; color: #fff; border-color: #c0392b; box-shadow: 0 0 8px rgba(231,76,60,0.6); }
.complex-num.hot-trans { background: #e67e22; color: #fff; border-color: #d35400; }
.complex-num.hot-trend { background: #9b59b6; color: #fff; border-color: #8e44ad; }
.complex-num.warm { background: rgba(241,196,15,0.2); color: #f1c40f; border-color: #f1c40f; }
.complex-num.cold { background: rgba(52,152,219,0.2); color: #5dade2; border-color: #5dade2; }
.complex-tag-demo { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin: 0 2px; }
.complex-tag-demo.algo { background: #e74c3c; color: #fff; }
.complex-tag-demo.warm { background: rgba(241,196,15,0.2); color: #f1c40f; border: 1px dashed #f1c40f; }
.complex-tag-demo.cold { background: rgba(52,152,219,0.2); color: #5dade2; border: 1px dashed #5dade2; }
.complex-summary { margin: 10px 0; padding: 8px 12px; background: rgba(52,152,219,0.15); border-radius: 4px; color: #3498db; font-size: 13px; }
.complex-summary b { color: #fff; font-size: 16px; }
.complex-suggest { margin-top: 16px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; }
.complex-suggest-title { color: #2ecc71; font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.complex-suggest-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding: 6px 8px; background: rgba(46,204,113,0.06); border-radius: 4px; }
.complex-suggest-idx { color: #888; font-size: 12px; min-width: 50px; }
.complex-suggest-num { display: inline-block; width: 28px; height: 28px; line-height: 26px; text-align: center; background: #27ae60; color: #fff; border-radius: 50%; font-weight: bold; font-size: 13px; }
.complex-suggest-score { color: #666; font-size: 11px; margin-left: auto; }

/* 温度分布展示 */
.complex-temp-box { margin-top: 16px; padding: 12px; background: rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
.complex-temp-title { color: #8ec5ff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.complex-temp-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.complex-temp-label { color: #feca57; font-size: 12px; font-weight: 600; min-width: 50px; }
.complex-temp-group { display: flex; align-items: center; gap: 3px; padding: 2px 6px; background: rgba(255,255,255,0.03); border-radius: 4px; }
.complex-temp-sub { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-right: 2px; }
.complex-temp-sub.hot { background: #e74c3c; color: #fff; }
.complex-temp-sub.warm { background: #f1c40f; color: #333; }
.complex-temp-sub.cold { background: #3498db; color: #fff; }
.complex-temp-num { display: inline-block; min-width: 32px; height: 24px; line-height: 22px; text-align: center; border-radius: 3px; font-size: 12px; font-weight: bold; padding: 0 3px; margin: 0 1px; }
.complex-temp-num.hot { background: rgba(231,76,60,0.25); color: #ff6b6b; }
.complex-temp-num.warm { background: rgba(241,196,15,0.25); color: #f1c40f; }
.complex-temp-num.cold { background: rgba(52,152,219,0.25); color: #5dade2; }
.complex-temp-num sub { font-size: 8px; color: #888; font-weight: normal; }

.complex-copy-box { margin-top: 12px; padding: 10px; background: #1a2540; border: 1px solid #2a4a7a; border-radius: 6px; }
.copy-btn.secondary { background: #3a3a3a; }
</style>
</head>
<body>
<h2>🤖 ${d.name} 智能推荐</h2>
<div class="desc" id="desc"></div>
<div id="content"></div>
<div id="trend_content"></div>
<script>
const DATA = ${dataJson};
const LIMIT_LABEL = DATA.limit === 0 ? '全部' : DATA.limit + ' 期';

(function() {
    const rows = DATA.rows;
    const latest = rows[rows.length - 1];
    const posLabels = DATA.positionLabels;
    const posCount = posLabels.length;

    let desc = '<span class="limit-badge">基于 ' + LIMIT_LABEL + ' 历史 (' + rows.length + ' 期)</span><br>';
    desc += '当前最新一期：<b>' + latest.period + '</b>（' + latest.date + '）号码：';
    latest.positions.forEach((n, i) => {
        desc += '<span class="recommend-num" style="width:28px;height:28px;line-height:26px;font-size:14px;">' + n + '</span>';
        if (i < latest.positions.length - 1) desc += ' ';
    });
    desc += '<br>根据<b>转移统计 TOP3 概率</b>推荐下一期号码，概率相同时取最近一期为准。';
    desc += '<br>同时提供<b>趋势分析推荐</b>：基于近期同位号码的递增/递减/持平/波动趋势，从历史匹配趋势中统计下一期号码。';
    document.getElementById('desc').innerHTML = desc;

    function buildTransition(pos) {
        const max = DATA.positionMax[pos];
        const trans = Array.from({length: max + 1}, () => new Array(max + 1).fill(0));
        for (let i = 0; i < rows.length - 1; i++) {
            const prev = rows[i].positions[pos];
            const nxt = rows[i + 1].positions[pos];
            if (prev >= 0 && prev <= max && nxt >= 0 && nxt <= max) trans[prev][nxt]++;
        }
        return trans;
    }

    const recommendations = [];
    let html = '<div class="recommend-section">';
    html += '<div class="recommend-title">🎯 推荐号码（取每位 TOP1）</div>';
    html += '<div style="margin-bottom:8px;">';

    for (let pos = 0; pos < posCount; pos++) {
        const curNum = latest.positions[pos];
        const max = DATA.positionMax[pos];
        const trans = buildTransition(pos);
        const row = trans[curNum] || new Array(max + 1).fill(0);
        const total = row.reduce((a, b) => a + b, 0);

        const candidates = [];
        for (let n = 0; n <= max; n++) {
            if (row[n] > 0) {
                let lastIdx = -1;
                for (let i = rows.length - 2; i >= 0; i--) {
                    if (rows[i].positions[pos] === curNum && rows[i + 1].positions[pos] === n) {
                        lastIdx = i;
                        break;
                    }
                }
                candidates.push({ n: n, cnt: row[n], pct: row[n] / total, lastIdx: lastIdx });
            }
        }

        // 排序：次数降序，次数相同按 lastIdx 降序（越近越优先）
        candidates.sort((a, b) => {
            if (b.cnt !== a.cnt) return b.cnt - a.cnt;
            return b.lastIdx - a.lastIdx;
        });

        const top3 = candidates.slice(0, 3);
        const top1 = top3[0];
        recommendations.push({ pos: pos, label: posLabels[pos], curNum: curNum, top3: top3, total: total });

        if (top1) {
            html += '<span class="recommend-num">' + top1.n + '</span>';
        }
    }
    html += '</div>';
    html += '<div style="color:#888;font-size:12px;">以上为每位转移统计概率最高的号码</div>';
    html += '</div>';

    // 每位详情
    for (const rec of recommendations) {
        html += '<div class="pos-section">';
        html += '<div class="pos-title">' + rec.label + '位（当前=' + rec.curNum + '，历史出现 ' + rec.total + ' 次）</div>';
        html += '<div class="pick-row">';
        html += '<span class="pick-label">TOP3 推荐：</span>';
        rec.top3.forEach((c, idx) => {
            const cls = idx === 0 ? 'top1' : idx === 1 ? 'top2' : 'top3';
            html += '<span class="pick-num-display ' + cls + '">' + c.n + '</span>';
            html += '<span class="pct">' + (c.pct * 100).toFixed(1) + '%</span>';
        });
        html += '</div>';
        // 概率并列提示
        if (rec.top3.length > 1 && rec.top3[0].cnt === rec.top3[1].cnt) {
            html += '<div class="detail-row">⚠️ TOP1 概率并列，已按最近一期选取</div>';
        }
        // 手动选号
        html += '<div class="pick-row">';
        html += '<span class="pick-label">手动选号：</span>';
        const posMax = DATA.positionMax[rec.pos];
        for (let n = 0; n <= posMax; n++) {
            const inTop3 = rec.top3.findIndex(c => c.n === n);
            const cls = inTop3 === 0 ? 'top1' : inTop3 === 1 ? 'top2' : inTop3 === 2 ? 'top3' : '';
            html += '<span class="pick-num ' + cls + '" data-pos="' + rec.pos + '" data-n="' + n + '">' + n + '</span>';
        }
        html += '</div>';
        html += '<div class="detail-row">提示：点击号码选中/取消，每位选中的号码会参与下方"组合预览"</div>';
        html += '</div>';
    }

    // 复制区
    html += '<div class="summary-box">';
    html += '<div style="color:#8ec5ff;font-size:13px;margin-bottom:6px;">📋 复制推荐结果</div>';
    html += '<div id="copyText" style="color:#fff;margin-bottom:8px;font-size:13px;line-height:1.8;"></div>';
    html += '<div id="copyNote" style="color:#888;font-size:11px;margin-bottom:8px;">每位选中多个号码时，将生成所有组合（例如万位[1,6] 千位[1] = 1X1、6X1 共 2 注）</div>';
    html += '<button class="copy-btn" onclick="copyResult()">📋 一键复制</button>';
    html += '<button class="copy-btn" style="background:#3a3a3a;margin-left:8px;" onclick="resetSelection()">🔄 重置为TOP1</button>';
    html += '</div>';

    document.getElementById('content').innerHTML = html;

    // 手动选号
    document.querySelectorAll('.pick-num').forEach(el => {
        el.addEventListener('click', () => {
            el.classList.toggle('selected');
            updateCopyText();
        });
    });

    function updateCopyText() {
        const byPos = {};
        document.querySelectorAll('.pick-num.selected').forEach(el => {
            const p = el.dataset.pos;
            if (!byPos[p]) byPos[p] = [];
            byPos[p].push(parseInt(el.dataset.n));
        });
        const parts = [];
        let totalCombos = 1;
        for (let i = 0; i < posCount; i++) {
            const nums = (byPos[i] || []).sort((a, b) => a - b);
            totalCombos *= Math.max(nums.length, 1);
            // 选中号码用明显的样式
            parts.push('<span style="color:#feca57;">' + posLabels[i] + '位</span>：' +
                (nums.length ?
                    nums.map(n => '<span style="color:#fff;background:#e74c3c;padding:1px 6px;border-radius:3px;margin:0 2px;font-weight:bold;">' + n + '</span>').join(' ')
                    : '<span style="color:#888;">-</span>'));
        }
        document.getElementById('copyText').innerHTML =
            '<span style="color:#2ecc71;">已选：</span>' +
            parts.join(' <span style="color:#555;">|</span> ') +
            '<br><span style="color:#888;font-size:12px;">↓ 组合预览（共 <b style="color:#feca57;">' + totalCombos + '</b> 注）：</span><br>' +
            generateCombosPreview(byPos);
    }

    // 生成所有组合预览（每位选中号码的笛卡尔积，最多展示前20注）
    function generateCombosPreview(byPos) {
        const picks = [];
        for (let i = 0; i < posCount; i++) {
            picks.push((byPos[i] || []).sort((a, b) => a - b));
        }
        const combos = [];
        function rec(idx, cur) {
            if (idx === posCount) {
                combos.push(cur.slice());
                return;
            }
            if (picks[idx].length === 0) return;
            for (const n of picks[idx]) {
                cur[idx] = n;
                rec(idx + 1, cur);
            }
        }
        rec(0, []);
        if (combos.length === 0) return '<span style="color:#888;">未选择任何号码</span>';
        const show = combos.slice(0, 20);
        let html = '<div style="background:rgba(0,0,0,0.2);padding:6px;border-radius:4px;margin-top:4px;">';
        show.forEach((c, i) => {
            html += '<span style="color:#2ecc71;font-size:12px;">第' + (i + 1) + '注：</span>' +
                c.map(n => '<span style="display:inline-block;width:24px;height:24px;line-height:22px;text-align:center;background:#27ae60;color:#fff;border-radius:50%;font-weight:bold;font-size:12px;margin:0 2px;">' + n + '</span>').join('') + '<br>';
        });
        if (combos.length > 20) {
            html += '<span style="color:#888;font-size:11px;">... 还有 ' + (combos.length - 20) + ' 注未显示</span>';
        }
        html += '</div>';
        return html;
    }

    window.copyResult = function() {
        // 生成纯文本格式用于复制
        const byPos = {};
        document.querySelectorAll('.pick-num.selected').forEach(el => {
            const p = el.dataset.pos;
            if (!byPos[p]) byPos[p] = [];
            byPos[p].push(parseInt(el.dataset.n));
        });
        const picks = [];
        let totalCombos = 1;
        for (let i = 0; i < posCount; i++) {
            const nums = (byPos[i] || []).sort((a, b) => a - b);
            picks.push(nums);
            totalCombos *= Math.max(nums.length, 1);
        }
        let text = '【' + DATA.name + ' 智能推荐】\\n';
        text += '每位选中：\\n';
        for (let i = 0; i < posCount; i++) {
            text += '  ' + posLabels[i] + '位：' + (picks[i].length ? picks[i].join(', ') : '未选') + '\\n';
        }
        if (totalCombos > 0 && picks.every(p => p.length > 0)) {
            text += '\\n所有组合（共 ' + totalCombos + ' 注）：\\n';
            const combos = [];
            function rec(idx, cur) {
                if (idx === posCount) { combos.push(cur.slice()); return; }
                for (const n of picks[idx]) { cur[idx] = n; rec(idx + 1, cur); }
            }
            rec(0, []);
            combos.forEach((c, i) => {
                text += '第' + (i + 1) + '注：' + c.join(' ') + '\\n';
            });
        }
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => alert('已复制到剪贴板：\\n\\n' + text));
        } else {
            alert('复制内容：\\n\\n' + text);
        }
    };

    window.resetSelection = function() {
        // 取消所有选中，再默认选中所有 TOP1
        document.querySelectorAll('.pick-num').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.pick-num.top1').forEach(el => el.classList.add('selected'));
        updateCopyText();
    };

    // 默认选中所有 TOP1
    document.querySelectorAll('.pick-num.top1').forEach(el => el.classList.add('selected'));
    updateCopyText();

    // ===== 算法 2：趋势分析 =====
    const TREND_LEN = 4; // 取最近 4 期作为趋势序列

    /**
     * 识别趋势类型
     * @param {number[]} seq - 号码序列
     * @returns {{type:'up'|'down'|'flat'|'mixed', label:string, cls:string, diffs:number[]}}
     */
    function classifyTrend(seq) {
        if (seq.length < 2) return { type: 'flat', label: '数据不足', cls: 'flat', diffs: [] };
        const diffs = [];
        let upCnt = 0, downCnt = 0, flatCnt = 0;
        for (let i = 1; i < seq.length; i++) {
            const d = seq[i] - seq[i - 1];
            diffs.push(d);
            if (d > 0) upCnt++;
            else if (d < 0) downCnt++;
            else flatCnt++;
        }
        if (upCnt === diffs.length) return { type: 'up', label: '持续递增', cls: 'up', diffs };
        if (downCnt === diffs.length) return { type: 'down', label: '持续递减', cls: 'down', diffs };
        if (flatCnt === diffs.length) return { type: 'flat', label: '持续持平', cls: 'flat', diffs };
        // 判断主要方向
        if (upCnt > downCnt && upCnt >= flatCnt) return { type: 'up', label: '增长为主', cls: 'up', diffs };
        if (downCnt > upCnt && downCnt >= flatCnt) return { type: 'down', label: '下降为主', cls: 'down', diffs };
        return { type: 'mixed', label: '波动', cls: 'mixed', diffs };
    }

    /**
     * 在历史数据中搜索与给定趋势匹配的片段
     * 匹配规则：趋势方向序列相同（递增/递减/持平的 pattern 一致）
     * @param {number} pos - 位置索引
     * @param {number[]} recentSeq - 最近几期的号码序列
     * @returns {Array<{idx:number, nextNum:number, period:string}>}
     */
    function findTrendMatches(pos, recentSeq) {
        const seqLen = recentSeq.length;
        const matches = [];
        if (seqLen < 2 || rows.length < seqLen + 1) return matches;

        // 计算目标趋势方向序列：+1 递增, -1 递减, 0 持平
        const targetDir = [];
        for (let i = 1; i < seqLen; i++) {
            const d = recentSeq[i] - recentSeq[i - 1];
            targetDir.push(d > 0 ? 1 : d < 0 ? -1 : 0);
        }

        // 在历史中搜索相同方向 pattern
        for (let i = 0; i <= rows.length - seqLen - 1; i++) {
            let match = true;
            const checkSeq = [];
            for (let j = 0; j < seqLen; j++) {
                checkSeq.push(rows[i + j].positions[pos]);
            }
            for (let j = 1; j < seqLen; j++) {
                const d = checkSeq[j] - checkSeq[j - 1];
                const dir = d > 0 ? 1 : d < 0 ? -1 : 0;
                if (dir !== targetDir[j - 1]) { match = false; break; }
            }
            if (match) {
                const nextRow = rows[i + seqLen];
                if (nextRow) {
                    matches.push({
                        idx: i + seqLen,
                        nextNum: nextRow.positions[pos],
                        period: nextRow.period,
                        seq: checkSeq
                    });
                }
            }
        }
        return matches;
    }

    let trendHtml = '<div class="trend-section">';
    trendHtml += '<div class="trend-title">📈 趋势分析推荐（最近 ' + TREND_LEN + ' 期同位趋势）</div>';
    trendHtml += '<div style="color:#aaa;font-size:12px;margin-bottom:12px;">';
    trendHtml += '取最近 ' + TREND_LEN + ' 期每位号码序列，识别递增/递减/持平/波动趋势，';
    trendHtml += '在历史中搜索<b>相同趋势方向</b>的片段，统计其下一期号码分布。';
    trendHtml += '</div>';

    const trendRecommendations = [];

    for (let pos = 0; pos < posCount; pos++) {
        const max = DATA.positionMax[pos];
        // 取最近 TREND_LEN 期的同位号码
        const recentSeq = [];
        const startIdx = Math.max(0, rows.length - TREND_LEN);
        for (let i = startIdx; i < rows.length; i++) {
            recentSeq.push(rows[i].positions[pos]);
        }

        if (recentSeq.length < 2) continue;

        const trend = classifyTrend(recentSeq);
        const matches = findTrendMatches(pos, recentSeq);

        // 统计下一期号码分布
        const dist = new Array(max + 1).fill(0);
        matches.forEach(m => {
            if (m.nextNum >= 0 && m.nextNum <= max) dist[m.nextNum]++;
        });
        const total = matches.length;

        // TOP3
        const candidates = [];
        for (let n = 0; n <= max; n++) {
            if (dist[n] > 0) candidates.push({ n, cnt: dist[n], pct: dist[n] / total });
        }
        candidates.sort((a, b) => {
            if (b.cnt !== a.cnt) return b.cnt - a.cnt;
            // 概率相同时取最近一次出现的
            let aLast = -1, bLast = -1;
            for (let i = matches.length - 1; i >= 0; i--) {
                if (aLast < 0 && matches[i].nextNum === a.n) aLast = i;
                if (bLast < 0 && matches[i].nextNum === b.n) bLast = i;
                if (aLast >= 0 && bLast >= 0) break;
            }
            return bLast - aLast;
        });
        const top3 = candidates.slice(0, 3);
        trendRecommendations.push({ pos, label: posLabels[pos], recentSeq, trend, top3, total });

        // 渲染
        trendHtml += '<div class="trend-pos-block">';
        trendHtml += '<div class="trend-pos-title">' + posLabels[pos] + '位</div>';

        // 趋势序列
        trendHtml += '<div class="trend-seq">';
        trendHtml += '<span class="trend-rec-label">近期走势：</span>';
        recentSeq.forEach((n, i) => {
            if (i > 0) {
                const d = recentSeq[i] - recentSeq[i - 1];
                const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
                const color = d > 0 ? '#2ecc71' : d < 0 ? '#e74c3c' : '#95a5a6';
                trendHtml += '<span class="trend-arrow" style="color:' + color + '">' + arrow + '</span>';
            }
            trendHtml += '<span class="trend-seq-num">' + n + '</span>';
        });
        trendHtml += '<span class="trend-type ' + trend.cls + '">' + trend.label + '</span>';
        trendHtml += '</div>';

        // 推荐号码
        trendHtml += '<div class="trend-rec-row">';
        trendHtml += '<span class="trend-rec-label">趋势推荐：</span>';
        if (top3.length === 0) {
            trendHtml += '<span style="color:#666;">无匹配趋势</span>';
        } else {
            top3.forEach((c, idx) => {
                const cls = idx === 0 ? 't1' : idx === 1 ? 't2' : 't3';
                trendHtml += '<span class="trend-rec-num ' + cls + '">' + c.n + '</span>';
                trendHtml += '<span class="trend-match-info">' + (c.pct * 100).toFixed(1) + '%</span>';
            });
            trendHtml += '<span class="trend-match-info">（匹配 ' + total + ' 次）</span>';
        }
        trendHtml += '</div>';
        trendHtml += '</div>';
    }

    // 趋势推荐号码汇总
    trendHtml += '<div style="margin-top:8px;padding:10px;background:rgba(155,89,182,0.1);border-radius:6px;">';
    trendHtml += '<span style="color:#9b59b6;font-weight:600;">趋势推荐号码：</span>';
    trendRecommendations.forEach(rec => {
        const t1 = rec.top3[0];
        if (t1) {
            trendHtml += '<span class="trend-rec-num t1">' + t1.n + '</span>';
        }
    });
    trendHtml += '</div>';

    // 混合推荐（转移统计 + 趋势分析）
    trendHtml += '<div style="margin-top:12px;padding:10px;background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.2);border-radius:6px;">';
    trendHtml += '<span style="color:#2ecc71;font-weight:600;">综合推荐（转移统计∩趋势分析）：</span><br>';
    trendHtml += '<span style="color:#888;font-size:12px;">两位算法推荐号码的交集为高置信度推荐</span><br>';
    trendRecommendations.forEach((rec, i) => {
        const transTop1 = recommendations[i] && recommendations[i].top3[0];
        const trendTop1 = rec.top3[0];
        if (transTop1 && trendTop1) {
            const intersect = transTop1.n === trendTop1.n;
            trendHtml += '<span style="color:#aaa;font-size:12px;">' + rec.label + '位：</span>';
            trendHtml += '<span class="trend-rec-num t1" style="' + (intersect ? 'box-shadow:0 0 8px #2ecc71;' : '') + '">' + transTop1.n + '</span>';
            if (!intersect) {
                trendHtml += '<span style="color:#666;font-size:11px;">→ 趋势: ' + trendTop1.n + '</span>';
            } else {
                trendHtml += '<span style="color:#2ecc71;font-size:11px;">★一致</span>';
            }
            if (i < trendRecommendations.length - 1) trendHtml += ' | ';
        }
    });
    trendHtml += '</div>';

    trendHtml += '</div>';

    document.getElementById('trend_content').innerHTML = trendHtml;

    // ===== 复式推荐（仅排三/排五）=====
    // 每位选2~5个号码：热号(TOP3)优先 → 温号(频率中等) → 冷号(频率最低)补足
    // 支持 2^N ~ 5^N 复式切换
    if (DATA.key === 'pl3' || DATA.key === 'pl5') {
        // 计算每位号码的全局频率
        const globalFreq = [];
        for (let pos = 0; pos < posCount; pos++) {
            const max = DATA.positionMax[pos];
            const freq = new Array(max + 1).fill(0);
            for (const r of rows) {
                const v = r.positions[pos];
                if (v >= 0 && v <= max) freq[v]++;
            }
            globalFreq.push(freq);
        }

        // 将每位号码分为热/温/冷三类
        // 热号：频率最高的 TOP3（算法推荐也算热号）
        // 温号：频率中等的号码（非热也非冷）
        // 冷号：频率最低的号码
        const sortedByFreq = []; // 按频率降序
        const coldNumbers = [];  // 按频率升序（冷号）
        const warmNumbers = [];  // 温号（频率中等）
        for (let pos = 0; pos < posCount; pos++) {
            const max = DATA.positionMax[pos];
            const freq = globalFreq[pos];
            const total = freq.reduce((a, b) => a + b, 0) || 1;
            const all = [];
            for (let n = 0; n <= max; n++) {
                all.push({ n, cnt: freq[n], pct: freq[n] / total });
            }
            // 按频率降序
            const sorted = all.slice().sort((a, b) => b.cnt - a.cnt);
            sortedByFreq.push(sorted);
            // 冷号：频率升序
            coldNumbers.push(all.slice().sort((a, b) => a.cnt - b.cnt));
            // 温号：去掉最热3个和最冷3个，剩下的为温号
            const hotSet = new Set(sorted.slice(0, 3).map(x => x.n));
            const coldSet = new Set(coldNumbers[pos].slice(0, 3).map(x => x.n));
            const warms = sorted.filter(x => !hotSet.has(x.n) && !coldSet.has(x.n));
            warmNumbers.push(warms);
        }

        // 获取某位推荐的N个号码（热号优先 → 温号 → 冷号补足）
        function getPicksForPos(pos, pickCount) {
            const transTop3 = recommendations[pos] ? recommendations[pos].top3.map(c => c.n) : [];
            const trendTop3 = trendRecommendations[pos] ? trendRecommendations[pos].top3.map(c => c.n) : [];
            const merged = [];
            const seen = new Set();
            // 1. 热号：算法推荐 TOP3 去重（限制 pickCount）
            for (const n of [...transTop3, ...trendTop3]) {
                if (merged.length >= pickCount) break;
                if (!seen.has(n)) { merged.push(n); seen.add(n); }
            }
            // 2. 不足时从温号中补
            if (merged.length < pickCount) {
                for (const w of warmNumbers[pos]) {
                    if (merged.length >= pickCount) break;
                    if (!seen.has(w.n)) { merged.push(w.n); seen.add(w.n); }
                }
            }
            // 3. 还不足从冷号补
            if (merged.length < pickCount) {
                for (const c of coldNumbers[pos]) {
                    if (merged.length >= pickCount) break;
                    if (!seen.has(c.n)) { merged.push(c.n); seen.add(c.n); }
                }
            }
            merged.sort((a, b) => a - b);
            return merged;
        }

        // 计算号码分类标签
        function getNumTag(pos, n) {
            const inTrans = recommendations[pos] && recommendations[pos].top3.some(c => c.n === n);
            const inTrend = trendRecommendations[pos] && trendRecommendations[pos].top3.some(c => c.n === n);
            if (inTrans && inTrend) return { cls: 'hot-both', tag: '★', label: '双算法命中：转移统计TOP3 + 趋势分析TOP3', algo: true };
            if (inTrans) return { cls: 'hot-trans', tag: 'T', label: '算法推荐：转移统计TOP3', algo: true };
            if (inTrend) return { cls: 'hot-trend', tag: 'R', label: '算法推荐：趋势分析TOP3', algo: true };
            // 温号/冷号属于补足（不是算法直接推荐）
            const isWarm = warmNumbers[pos] && warmNumbers[pos].some(w => w.n === n);
            if (isWarm) {
                const w = warmNumbers[pos].find(x => x.n === n);
                return { cls: 'warm', tag: 'W', label: '补足：温号（历史频率中等 ' + (w ? (w.pct*100).toFixed(1) + '%' : '') + '）', algo: false };
            }
            const c = coldNumbers[pos].find(x => x.n === n);
            return { cls: 'cold', tag: 'C', label: '补足：冷号（历史频率最低 ' + (c ? (c.pct*100).toFixed(1) + '%' : '') + '）', algo: false };
        }

        // 综合概率得分
        const numScores = [];
        for (let pos = 0; pos < posCount; pos++) {
            const max = DATA.positionMax[pos];
            const scores = new Array(max + 1).fill(0);
            const transTop3 = recommendations[pos] ? recommendations[pos].top3 : [];
            const trendTop3 = trendRecommendations[pos] ? trendRecommendations[pos].top3 : [];
            const transTotal = recommendations[pos] ? recommendations[pos].total : 1;
            const trendTotal = trendRecommendations[pos] ? trendRecommendations[pos].total : 1;
            transTop3.forEach(c => { scores[c.n] += (c.cnt / transTotal); });
            trendTop3.forEach(c => { scores[c.n] += (c.cnt / trendTotal); });
            const freq = globalFreq[pos];
            const freqTotal = freq.reduce((a, b) => a + b, 0) || 1;
            for (let n = 0; n <= max; n++) {
                scores[n] += (freq[n] / freqTotal) * 0.1;
            }
            numScores.push(scores);
        }

        // 枚举复式组合并按得分排序
        function enumerateCombos(picks) {
            const combos = [];
            function rec(pos, current) {
                if (pos === posCount) {
                    let score = 0;
                    for (let i = 0; i < posCount; i++) score += numScores[i][current[i]];
                    combos.push({ combo: current.slice(), score });
                    return;
                }
                for (const n of picks[pos]) {
                    current[pos] = n;
                    rec(pos + 1, current);
                }
            }
            rec(0, []);
            combos.sort((a, b) => b.score - a.score);
            return combos;
        }

        const SUGGEST_COUNT = 5;
        const PICK_OPTIONS = [2, 3, 4, 5];

        let complexHtml = '<div class="complex-section" id="complexSection">';
        complexHtml += '<div class="complex-title">🎲 复式推荐</div>';
        complexHtml += '<div style="color:#aaa;font-size:12px;margin-bottom:12px;">';
        complexHtml += '每位选号策略：<b>算法热号</b>（转移统计∩趋势分析）→ <b style="color:#f1c40f">温号补足</b>（频率中等）→ <b style="color:#5dade2">冷号补足</b>（频率最低）<br>';
        complexHtml += '标注：<span class="complex-tag-demo algo">★/T/R</span> <b style="color:#fff">算法直接推荐</b> &nbsp; <span class="complex-tag-demo warm">W</span> <b style="color:#f1c40f">温号补足</b> &nbsp; <span class="complex-tag-demo cold">C</span> <b style="color:#5dade2">冷号补足</b>';
        complexHtml += '</div>';

        // 切换按钮
        complexHtml += '<div class="complex-tabs" id="complexTabs">';
        PICK_OPTIONS.forEach((p, idx) => {
            const combos = Math.pow(p, posCount);
            complexHtml += '<button class="complex-tab' + (idx === PICK_OPTIONS.length - 1 ? ' active' : '') + '" data-pick="' + p + '">' + p + '×' + p + '复式（' + combos + '注）</button>';
        });
        complexHtml += '</div>';

        // 内容容器
        complexHtml += '<div id="complexContent"></div>';

        // 冷温热号展示
        complexHtml += '<div class="complex-temp-box">';
        complexHtml += '<div class="complex-temp-title">🌡️ 各位号码温度分布</div>';
        for (let pos = 0; pos < posCount; pos++) {
            const hots = sortedByFreq[pos].slice(0, 3);
            const warms = warmNumbers[pos].slice(0, 3);
            const colds = coldNumbers[pos].slice(0, 3);
            complexHtml += '<div class="complex-temp-row">';
            complexHtml += '<span class="complex-temp-label">' + posLabels[pos] + '位：</span>';
            complexHtml += '<span class="complex-temp-group"><span class="complex-temp-sub hot">热</span>';
            hots.forEach(c => complexHtml += '<span class="complex-temp-num hot">' + c.n + '<sub>' + (c.pct * 100).toFixed(0) + '%</sub></span>');
            complexHtml += '</span>';
            complexHtml += '<span class="complex-temp-group"><span class="complex-temp-sub warm">温</span>';
            if (warms.length > 0) {
                warms.forEach(c => complexHtml += '<span class="complex-temp-num warm">' + c.n + '<sub>' + (c.pct * 100).toFixed(0) + '%</sub></span>');
            } else {
                complexHtml += '<span style="color:#666;font-size:11px;">无</span>';
            }
            complexHtml += '</span>';
            complexHtml += '<span class="complex-temp-group"><span class="complex-temp-sub cold">冷</span>';
            colds.forEach(c => complexHtml += '<span class="complex-temp-num cold">' + c.n + '<sub>' + (c.pct * 100).toFixed(0) + '%</sub></span>');
            complexHtml += '</span>';
            complexHtml += '</div>';
        }
        complexHtml += '</div>';

        // 复制按钮
        complexHtml += '<div class="complex-copy-box">';
        complexHtml += '<button class="copy-btn" onclick="copyComplexResult()">📋 复制复式推荐</button>';
        complexHtml += '<button class="copy-btn secondary" style="background:#3a3a3a;margin-left:8px;" onclick="copySuggestResult()">📋 复制精选单式</button>';
        complexHtml += '<div id="complexCopyText" style="color:#fff;margin-top:8px;"></div>';
        complexHtml += '</div>';

        complexHtml += '</div>';

        // 添加到内容区
        const complexDiv = document.createElement('div');
        complexDiv.innerHTML = complexHtml;
        document.body.appendChild(complexDiv);

        // 当前选中的每注号码数
        let currentPick = 5;
        let currentPicks = [];
        let currentCombos = [];
        let currentSuggest = [];

        function renderComplex(pickCount) {
            currentPick = pickCount;
            currentPicks = [];
            for (let pos = 0; pos < posCount; pos++) {
                currentPicks.push(getPicksForPos(pos, pickCount));
            }

            const totalCombos = currentPicks.reduce((p, c) => p * c.length, 1);
            let html = '';

            // 每位推荐
            html += '<div class="complex-picks">';
            for (let pos = 0; pos < posCount; pos++) {
                const picks = currentPicks[pos];
                html += '<div class="complex-pos-block">';
                html += '<span class="complex-pos-label">' + posLabels[pos] + '位：</span>';
                picks.forEach(n => {
                    const info = getNumTag(pos, n);
                    const algoCls = info.algo ? ' algo-pick' : ' filler-pick';
                    html += '<span class="complex-num ' + info.cls + algoCls + '" title="' + info.label + '">' + n + '<sup>' + info.tag + '</sup></span>';
                });
                html += '</div>';
            }
            html += '</div>';
            html += '<div class="complex-summary">复式总注数：<b>' + totalCombos + '</b> 注（' + pickCount + '^' + posCount + '）</div>';

            // 精选单式
            currentCombos = enumerateCombos(currentPicks);
            currentSuggest = currentCombos.slice(0, Math.min(SUGGEST_COUNT, currentCombos.length));

            html += '<div class="complex-suggest">';
            html += '<div class="complex-suggest-title">📋 精选单式（按综合概率 TOP' + currentSuggest.length + '）</div>';
            currentSuggest.forEach((s, idx) => {
                html += '<div class="complex-suggest-row">';
                html += '<span class="complex-suggest-idx">第' + (idx + 1) + '注</span>';
                s.combo.forEach(n => {
                    html += '<span class="complex-suggest-num">' + n + '</span>';
                });
                html += '<span class="complex-suggest-score">得分:' + s.score.toFixed(3) + '</span>';
                html += '</div>';
            });
            html += '</div>';

            document.getElementById('complexContent').innerHTML = html;
        }

        // 初始渲染
        renderComplex(5);

        // Tab 切换
        document.querySelectorAll('.complex-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.complex-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderComplex(parseInt(btn.dataset.pick));
            });
        });

        // 复制复式
        window.copyComplexResult = function() {
            const parts = [];
            for (let pos = 0; pos < posCount; pos++) {
                parts.push(posLabels[pos] + ':' + currentPicks[pos].join(''));
            }
            const totalCombos = currentPicks.reduce((p, c) => p * c.length, 1);
            const text = DATA.name + '复式推荐（' + currentPick + '×' + currentPick + '，' + totalCombos + '注）\\n' + parts.join(' ') + '\\n每位' + currentPick + '码：' + currentPicks.map(p => p.join('')).join(' | ');
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(() => alert('已复制：\\n' + text));
            } else {
                alert('复制：\\n' + text);
            }
        };
        // 复制精选单式
        window.copySuggestResult = function() {
            let text = DATA.name + '精选单式 TOP' + currentSuggest.length + '\\n';
            currentSuggest.forEach((s, i) => {
                text += '第' + (i + 1) + '注：' + s.combo.join(' ') + '\\n';
            });
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(() => alert('已复制：\\n' + text));
            } else {
                alert('复制：\\n' + text);
            }
        };
    }
})();
</script>
</body>
</html>`;
}

function getTransHtml(d) {
    const dataJson = JSON.stringify(d);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>转移统计 - ${d.name}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 8px; }
.desc { color: #aaa; margin-bottom: 16px; line-height: 1.6; }
.limit-badge { display: inline-block; background: #0e639c; color: #fff; padding: 2px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.section { margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
.section-title { color: #feca57; font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.bars { display: flex; gap: 6px; align-items: flex-end; margin-bottom: 10px; padding: 10px 6px; background: rgba(0,0,0,0.25); border-radius: 8px; }
.bar-cell { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 32px; }
.bar-cnt { font-size: 12px; color: #aaa; margin-bottom: 4px; min-height: 16px; }
.bar-wrap { width: 100%; height: 80px; display: flex; align-items: flex-end; justify-content: center; }
.bar { width: 65%; background: #3498db; border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.3s ease; }
.bar.top { background: #e74c3c; }
.bar-num { font-size: 12px; color: #888; margin-top: 4px; }
.bar-num.top { color: #e74c3c; font-weight: bold; }
.top3 { font-size: 12px; color: #2ecc71; padding: 8px 12px; background: rgba(46,204,113,0.1); border-radius: 6px; }
.empty { color: #666; padding: 8px 0; }
.trans-detail { margin-top: 10px; }
.trans-detail summary { cursor: pointer; color: #8ec5ff; font-size: 12px; padding: 6px 0; }
.detail-scroll { overflow-x: auto; margin-top: 8px; max-height: 300px; overflow-y: auto; border: 1px solid #333; border-radius: 4px; }
.detail-table { border-collapse: collapse; font-size: 12px; width: 100%; min-width: 600px; }
.detail-table th, .detail-table td { border: 1px solid #333; padding: 4px 8px; text-align: center; white-space: nowrap; }
.detail-table th { background: #2d2d30; color: #8ec5ff; position: sticky; top: 0; z-index: 1; }
.detail-table tr.hit { background: rgba(231,76,60,0.15); }
.detail-table tr:hover { background: rgba(255,255,255,0.05); }

.cur-num { display: inline-block; width: 28px; height: 28px; line-height: 26px; text-align: center; background: #e74c3c; color: #fff; border-radius: 50%; font-weight: bold; margin: 0 2px; }
</style>
</head>
<body>
<h2>🔁 ${d.name} 前后期数字转移统计</h2>
<div class="desc" id="desc"></div>
<div id="content"></div>
<script>
const DATA = ${dataJson};
const LIMIT_LABEL = DATA.limit === 0 ? '全部' : DATA.limit + ' 期';
const ACTUAL_COUNT = DATA.rows.length;
const TOTAL_COUNT = DATA.total;

(function() {
    const rows = DATA.rows;
    const latest = rows[rows.length - 1];
    const posLabels = DATA.positionLabels;

    let desc = '<span class="limit-badge">统计范围：' + LIMIT_LABEL + '</span>（实际 ' + ACTUAL_COUNT + ' 期 / 共 ' + TOTAL_COUNT + ' 期）<br>';
    desc += '当前最新一期：<b>' + latest.period + '</b>（' + latest.date + '）号码：';
    latest.positions.forEach((n, i) => {
        desc += '<span class="cur-num">' + n + '</span>';
        if (i < latest.positions.length - 1) desc += ' ';
    });
    desc += '<br>以下统计在所选期数中，每位出现相同数字时，<b>下一期同位</b>出现的数字分布。';
    document.getElementById('desc').innerHTML = desc;

    // 转移统计
    function buildTransition(pos) {
        const trans = Array.from({length: 10}, () => new Array(10).fill(0));
        for (let i = 0; i < rows.length - 1; i++) {
            const prev = rows[i].positions[pos];
            const nxt = rows[i + 1].positions[pos];
            if (prev >= 0 && prev <= 9 && nxt >= 0 && nxt <= 9) trans[prev][nxt]++;
        }
        return trans;
    }

    let html = '';
    for (let pos = 0; pos < posLabels.length; pos++) {
        const curNum = latest.positions[pos];
        const trans = buildTransition(pos);
        const row = trans[curNum] || new Array(10).fill(0);
        const total = row.reduce((a, b) => a + b, 0);

        html += '<div class="section">';
        html += '<div class="section-title">' + posLabels[pos] + '位（当前=' + curNum + '，历史出现 ' + total + ' 次）</div>';

        if (total === 0) {
            html += '<div class="empty">无历史数据</div>';
        } else {
            html += '<div class="bars">';
            const maxCnt = Math.max.apply(null, row);
            for (let n = 0; n <= 9; n++) {
                const cnt = row[n];
                const pct = (cnt / total * 100);
                const isTop = cnt === maxCnt && cnt > 0;
                const barH = (cnt / maxCnt * 100);
                html += '<div class="bar-cell' + (isTop ? ' top' : '') + '" title="下期=' + n + '：' + cnt + ' 次（' + pct.toFixed(1) + '%）">';
                html += '<div class="bar-cnt">' + (cnt > 0 ? cnt : '') + '</div>';
                html += '<div class="bar-wrap"><div class="bar' + (isTop ? ' top' : '') + '" style="height:' + barH + '%"></div></div>';
                html += '<div class="bar-num' + (isTop ? ' top' : '') + '">' + n + '</div>';
                html += '</div>';
            }
            html += '</div>';
            // TOP3
            const top3 = [];
            for (let n = 0; n <= 9; n++) {
                if (row[n] > 0) top3.push({ n: n, cnt: row[n] });
            }
            top3.sort((a, b) => b.cnt - a.cnt);
            const top3Str = top3.slice(0, 3).map(x => x.n + '（' + x.cnt + '次 ' + (x.cnt/total*100).toFixed(1) + '%）').join('　');
            html += '<div class="top3">下期' + posLabels[pos] + '位 TOP3：' + (top3Str || '无') + '</div>';

            // 逐期明细：列出所有"该位=当前数字"的期次及其下一期号码
            const details = [];
            for (let i = rows.length - 2; i >= 0; i--) {
                const cur = rows[i];
                const nxt = rows[i + 1];
                if (cur.positions[pos] === curNum) {
                    details.push({
                        curPeriod: cur.period,
                        curDate: cur.date,
                        curNums: cur.positions,
                        nxtPeriod: nxt.period,
                        nxtDate: nxt.date,
                        nxtNums: nxt.positions,
                        nxtVal: nxt.positions[pos]
                    });
                }
            }
            if (details.length > 0) {
                html += '<details class="trans-detail" open>';
                html += '<summary>📋 逐期明细（共 ' + details.length + ' 期，按时间倒序）</summary>';
                html += '<div class="detail-scroll"><table class="detail-table">';
                html += '<thead><tr><th>当期期号</th><th>日期</th><th>当期号码</th><th>' + posLabels[pos] + '位</th><th>下期期号</th><th>日期</th><th>下期号码</th><th>下期' + posLabels[pos] + '位</th></tr></thead>';
                html += '<tbody>';
                details.forEach(d => {
                    const isTop = (function() {
                        const maxNxt = Math.max.apply(null, row);
                        return d.nxtVal === maxNxt && d.nxtVal > 0;
                    })();
                    const hitCls = isTop ? ' class="hit"' : '';
                    html += '<tr' + hitCls + '>';
                    html += '<td>' + d.curPeriod + '</td>';
                    html += '<td>' + d.curDate + '</td>';
                    html += '<td>' + d.curNums.join(' ') + '</td>';
                    html += '<td><b style="color:#e74c3c">' + d.curNums[pos] + '</b></td>';
                    html += '<td>' + d.nxtPeriod + '</td>';
                    html += '<td>' + d.nxtDate + '</td>';
                    html += '<td>' + d.nxtNums.join(' ') + '</td>';
                    html += '<td><b style="color:#feca57">' + d.nxtVal + '</b></td>';
                    html += '</tr>';
                });
                html += '</tbody></table></div>';
                html += '</details>';
            }
        }
        html += '</div>';
    }
    document.getElementById('content').innerHTML = html;
})();
</script>
</body>
</html>`;
}

function getTrendHtml(allData, webview) {
    const dataJson = JSON.stringify(allData);
    // 外部 JS 文件 URI（用 asWebviewUri 转成 Webview 可访问的 URL）
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(__dirname, 'webview', 'webview.js'))
    );
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>彩票走势图</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 12px; }
body { display: flex; flex-direction: column; }
.tabs { display: flex; background: #252526; border-bottom: 1px solid #333; padding: 0 8px; flex-shrink: 0; }
.tab { padding: 8px 16px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; }
.tab:hover { color: #ccc; }
.tab.active { color: #fff; border-bottom-color: #0e639c; }
.content { flex: 1 1 auto; overflow: auto; min-height: 0; }
.panel { display: none; padding: 8px; }
.panel.active { display: block; }

.legend { padding: 6px 10px; color: #888; font-size: 12px; background: #252526; border-radius: 4px; margin-bottom: 8px; }
.legend span { display: inline-block; margin-right: 12px; }
.legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.limit-select { background: #2d2d30; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 6px; font-size: 12px; cursor: pointer; margin-left: 6px; }
.limit-select:hover { border-color: #888; }
.limit-select:focus { outline: none; border-color: #4ec9b0; }

.trend-wrap { position: relative; display: inline-block; will-change: transform; }
table.trend { border-collapse: collapse; background: #1e1e1e; border-spacing: 0; }
table.trend th, table.trend td {
    border: 1px solid #333; text-align: center; padding: 0;
    min-width: 28px; height: 24px; line-height: 24px;
    white-space: nowrap;
}
table.trend { table-layout: auto; width: auto; }
/* 行间分隔：每行底加深 */
table.trend tbody tr { border-bottom: 2px solid #000; }
table.trend tbody tr:last-child { border-bottom: 1px solid #333; }

table.trend td.pos-sep, table.trend th.pos-sep { border-left: 3px solid #5a8fbe !important; }
table.trend th { background: #2d2d30; color: #bbb; font-weight: 500; position: sticky; top: 0; z-index: 3; }
table.trend thead tr:nth-child(2) th { top: 24px; }
table.trend th.pos-group { background: #1a3a5a; color: #8ec5ff; height: 22px; line-height: 22px; }
table.trend th.period, table.trend td.period { position: sticky; left: 0; background: #2d2d30; z-index: 2; min-width: 60px; }
table.trend th.stat, table.trend td.stat { background: #3a2d2d; color: #f0a050; min-width: 56px; width: 56px; padding: 0 4px; }

/* 段背景色：鲜明对比 */
table.trend td.seg-0 { background: #2a1a1a; }
table.trend td.seg-1 { background: #2a2519; }
table.trend td.seg-2 { background: #1a2a1a; }
table.trend td.seg-3 { background: #1a2329; }
table.trend td.seg-4 { background: #251a2a; }
table.trend td.seg-5 { background: #1a2a2a; }
table.trend td.seg-6 { background: #2a1a25; }

.num-cell { position: relative; color: #555; }
.num-cell .n { color: #444; font-size: 11px; }
.num-cell.hit { color: #fff; }
.num-cell.hit .n { display: none; }
.num-cell.hit::before {
    content: ""; position: absolute; inset: 2px; border-radius: 50%;
    background: #e74c3c; z-index: 1;
}
.num-cell.hit::after {
    content: attr(data-n); position: relative; color: #fff; font-weight: bold;
    z-index: 2; line-height: 20px;
}

/* 预选区 */
.predict-bar {
    margin-top: 12px; padding: 10px 12px; background: #1a2540; border-radius: 6px;
    border: 1px solid #2a4a7a;
}
.predict-bar h3 { color: #8ec5ff; font-size: 13px; margin-bottom: 8px; }
.predict-line { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 8px; }
.predict-label { color: #ff6b6b; font-size: 12px; margin-right: 6px; margin-left: 12px; font-weight: 500; min-width: 30px; }
.predict-line .predict-label:first-child { margin-left: 0; }
.predict-num {
    display: inline-block; width: 24px; height: 24px; line-height: 22px; text-align: center;
    border: 1px solid #444; border-radius: 50%; color: #aaa; cursor: pointer;
    font-size: 11px; user-select: none; background: #1a1a1a; padding: 0;
}
.predict-num:hover { border-color: #888; color: #fff; }
.predict-num.selected {
    background: #e74c3c; color: #fff; border-color: #e74c3c; font-weight: bold;
}

/* 预选行（直接作为表格最后一行） */
table.trend tr.predict-row { background: #1a1a2e; }
table.trend tr.predict-row td { border: 1px solid #2a4a7a; height: 28px; padding: 2px; text-align: center; }
table.trend td.predict-cell { color: #ff6b6b; font-weight: 500; background: #2a1a25 !important; }
table.trend td.predict-cell-inner { padding: 1px; }
.predict-footer {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
    gap: 12px; padding: 8px 12px; background: #1a2540; border: 1px solid #2a4a7a;
    border-top: none; border-radius: 0 0 4px 4px;
}
.predict-summary { color: #8ec5ff; font-size: 12px; }
.predict-summary b { color: #fff; }
.predict-actions button {
    background: #0e639c; color: #fff; border: none; padding: 4px 12px;
    border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 6px;
}
.predict-actions button:hover { background: #1177bb; }
.predict-actions button.secondary { background: #3a3a3a; }
.predict-actions button.secondary:hover { background: #4a4a4a; }

/* 复制提示 toast */
.copy-toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #2d7d46; color: #fff; padding: 10px 16px; border-radius: 4px;
    font-size: 12px; z-index: 10000; max-width: 80vw; white-space: pre-wrap;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    font-family: "Consolas", "Microsoft YaHei", monospace;
}

/* 前后期数字转移统计面板 */
.trans-panel {
    margin-top: 12px; padding: 12px;
    background: #1a1a2e; border: 1px solid #2a4a7a; border-radius: 6px;
}
.trans-title { color: #8ec5ff; font-size: 13px; margin-bottom: 6px; }
.trans-desc { color: #aaa; font-size: 11px; margin-bottom: 12px; line-height: 1.5; }
.trans-section {
    margin-bottom: 16px; padding: 10px;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
}
.trans-section-title { color: #feca57; font-size: 12px; font-weight: 500; margin-bottom: 8px; }
.trans-empty { color: #666; font-size: 11px; padding: 4px 0; }
.trans-bars { display: flex; gap: 4px; align-items: flex-end; margin-bottom: 8px; padding: 8px 4px; background: rgba(0,0,0,0.2); border-radius: 6px; }
.trans-bar-cell { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 28px; }
.trans-bar-cnt { font-size: 11px; color: #aaa; margin-bottom: 2px; min-height: 14px; }
.trans-bar-wrap { width: 100%; height: 60px; display: flex; align-items: flex-end; justify-content: center; }
.trans-bar { width: 60%; background: #3498db; border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.3s ease; }
.trans-bar.top { background: #e74c3c; }
.trans-bar-num { font-size: 11px; color: #888; margin-top: 2px; }
.trans-bar-num.top { color: #e74c3c; font-weight: bold; }
.trans-top { font-size: 11px; color: #2ecc71; padding: 6px 10px; background: rgba(46,204,113,0.1); border-radius: 4px; }


/* 模拟选号下拉框表格（排列三/五） */
.note-table { width: 100%; border-collapse: collapse; margin-bottom: 6px; background: #1e1e1e; }
.note-table th, .note-table td { border: 1px solid #333; padding: 4px 8px; text-align: center; font-size: 12px; }
.note-table th { background: #2d2d30; color: #8ec5ff; font-weight: 500; }
.note-table td.note-name { color: #aaa; }
.note-table .predict-select { width: 100%; }
.add-row-btn { background: #2d7d46; color: #fff; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; margin: 4px 6px 8px 0; }
.add-row-btn:hover { background: #36945a; }
.del-row-btn { background: #c0392b; color: #fff; border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; }
.del-row-btn:hover { background: #e74c3c; }

.svg-layer { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 1; }
</style>
</head>
<body>
<div id="loadingMark" style="padding:8px;background:#0e639c;color:#fff;font-size:12px;">📊 加载中…</div>
<div class="tabs" id="tabs"></div>
<div class="content" id="content"></div>

<!-- 数据通过 inline 注入（这是数据声明，不是脚本） -->
<script>const ALL_DATA = ${dataJson};</script>
<!-- 真正的逻辑用外部 JS 文件，避免 inline script 被拦截 -->
<script src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = {
    activate,
    deactivate
};
