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
