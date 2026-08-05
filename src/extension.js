const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crawler = require('./crawler');

// 插件安装目录下的 data/（兜底，用于彩票历史数据）
const PLUGIN_DATA_DIR = path.join(__dirname, '..', 'data');

// 保存 extension context，用于 globalStoragePath（预测记录统一存储位置）
let _context = null;

/**
 * 获取彩票历史数据目录，优先级：
 *   1. 当前工作区文件夹下的 data/（通用，换电脑只需打开工程文件夹即可）
 *   2. 插件安装目录下的 data/（兜底）
 * @returns {string}
 */
function getDataDir() {
    // 1. 尝试当前工作区
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
        const wsDataDir = path.join(wsFolders[0].uri.fsPath, 'data');
        if (fs.existsSync(wsDataDir)) return wsDataDir;
    }
    // 2. 兜底：插件安装目录
    return PLUGIN_DATA_DIR;
}

/**
 * 获取预测记录统一存储目录（context.globalStoragePath）
 * 该目录与工作区无关，任何工程窗口下都能共享同一份预测记录。
 * 如果 context 还未初始化（activate 之前），fallback 到工作区/插件目录。
 * @returns {string}
 */
function getPredDir() {
    if (_context && _context.globalStoragePath) {
        return _context.globalStoragePath;
    }
    // activate 之前的兜底
    return getDataDir();
}

/**
 * 动态获取 predictions.json 路径
 * @returns {string}
 */
function getPredictionsFile() {
    return path.join(getPredDir(), 'predictions.json');
}

/**
 * 读取预测记录
 * @returns {Array<Object>} 预测记录列表
 */
function loadPredictions() {
    try {
        const file = getPredictionsFile();
        if (!fs.existsSync(file)) return [];
        const raw = fs.readFileSync(file, 'utf-8');
        return JSON.parse(raw) || [];
    } catch (e) {
        console.error('读取预测记录失败:', e.message);
        return [];
    }
}

/**
 * 保存预测记录
 * @param {Array<Object>} predictions - 预测记录列表
 */
function savePredictions(predictions) {
    try {
        const file = getPredictionsFile();
        const predDir = path.dirname(file);
        if (!fs.existsSync(predDir)) {
            fs.mkdirSync(predDir, { recursive: true });
        }
        fs.writeFileSync(file, JSON.stringify(predictions, null, 2), 'utf-8');
        console.log('预测记录已保存:', file);
    } catch (e) {
        console.error('保存预测记录失败:', e.message);
    }
}

/**
 * 判断一条预测记录是否中奖（仅判断"位置全中"，即直选）
 * @param {Object} pred - 预测记录 {type, targetPeriod, picks, note}
 * @param {Object} history - 该彩种历史数据（已 reverse，最新在末尾）
 * @returns {Object|null} 中奖详情，未中返回 null
 */
function checkPrediction(pred, history) {
    if (!history || history.length === 0) return null;
    // 在历史中查找匹配期号的记录
    const match = history.find(h => h.period === pred.targetPeriod);
    if (!match) return null;

    // match 的号码：根据彩种提取每位号码数组
    const cfg = LOTTERY_TYPES.find(c => c.key === pred.type);
    if (!cfg) return null;
    const drawNums = cfg.positions.map(p => p.pick(match));

    // pred.picks: 每位选中的号码数组，如 [[1,6],[3],[7,0],[1],[4]]
    // 判断 drawNums 的每位是否都在对应 picks 中（即"直选"中奖）
    const posResults = [];
    let allHit = true;
    for (let i = 0; i < drawNums.length; i++) {
        const drawN = drawNums[i];
        const picksAtPos = pred.picks[i] || [];
        const hit = picksAtPos.includes(drawN);
        posResults.push({ pos: cfg.positions[i].label, drawNum: drawN, picks: picksAtPos, hit });
        if (!hit) allHit = false;
    }

    // 排列三/排列五/福彩3D：要求每位都命中（直选）
    // 大乐透/双色球：要求"选中号码集合" ⊇ "开奖号码集合"（复式命中）
    if (pred.type === 'pl3' || pred.type === 'pl5' || pred.type === 'fc3d') {
        if (!allHit) return null;
    } else {
        // dlt/ssq: 检查所有开奖号码是否都在用户选号池中（不区分位置）
        const allPicksFlat = pred.picks.flat();
        const allDrawFlat = drawNums.slice();
        const allCovered = allDrawFlat.every(n => allPicksFlat.includes(n));
        if (!allCovered) return null;
    }

    return {
        period: match.period,
        date: match.date,
        drawNums,
        posResults,
        prizeLevel: allHit ? '直选全中' : '复式命中'
    };
}

/**
 * 对比所有未开奖的预测记录，返回中奖列表
 * @returns {Array<Object>} 中奖记录列表
 */
function checkAllPredictions() {
    const predictions = loadPredictions();
    const wins = [];
    for (const pred of predictions) {
        if (pred.checked) continue; // 已对比过的跳过
        const cfg = LOTTERY_TYPES.find(c => c.key === pred.type);
        if (!cfg) continue;
        try {
            const history = loadLotteryData(cfg);
            const result = checkPrediction(pred, history);
            if (result) {
                wins.push({ prediction: pred, result });
                // 标记已对比且中奖
                pred.checked = true;
                pred.winResult = result;
            } else {
                // 检查目标期号是否已经在历史中（已开奖但未中）
                const match = history.find(h => h.period === pred.targetPeriod);
                if (match) {
                    pred.checked = true;
                    pred.winResult = null; // 已开奖但未中
                }
            }
        } catch (e) {
            console.error('对比预测失败:', pred.type, e.message);
        }
    }
    // 保存更新后的状态
    savePredictions(predictions);
    return wins;
}

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
    },
    {
        key: 'fc3d',
        name: '福彩3D',
        emoji: '🎁',
        file: 'fc3d.json',
        positions: [
            { label: '百', pick: (h) => h.num[0], max: 9 },
            { label: '十', pick: (h) => h.num[1], max: 9 },
            { label: '个', pick: (h) => h.num[2], max: 9 }
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

/**
 * 计算移动平均线（MA）
 * @param {Array<number>} values - 数值序列（按时间正序，旧→新）
 * @param {number} period - 周期
 * @returns {Array<number|null>} 每个点对应的 MA 值，不够周期返回 null
 */
function calcMA(values, period) {
    const result = [];
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) {
            result.push(null);
        } else {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) sum += values[j];
            result.push(sum / period);
        }
    }
    return result;
}

/**
 * 在最近 N 期数据上识别 8 种均线形态
 * @param {Array<number>} series - 某位号的历史值序列（旧→新）
 * @returns {Object} 识别结果 {patterns: [{name, signal, desc, numbers}], maData}
 */
function detectMAPatterns(series) {
    const N = 20; // 取最近 20 期
    const recent = series.slice(-N);
    if (recent.length < 20) {
        return { patterns: [], maData: null, error: '数据不足（需要 ≥20 期）' };
    }

    const ma5 = calcMA(recent, 5);
    const ma10 = calcMA(recent, 10);
    const ma20 = calcMA(recent, 20);

    const patterns = [];

    // 取最近几期的有效值
    const i = recent.length - 1; // 最新一期
    const i1 = recent.length - 2;
    const i2 = recent.length - 3;
    const i3 = recent.length - 4;

    const cur = { ma5: ma5[i], ma10: ma10[i], ma20: ma20[i] };
    const prev = { ma5: ma5[i1], ma10: ma10[i1], ma20: ma20[i1] };
    const prev2 = { ma5: ma5[i2], ma10: ma10[i2], ma20: ma20[i2] };

    // 辅助：取最近 K 期 MA 均值
    const avg = (arr, k) => {
        const start = arr.length - k;
        const slice = arr.slice(start).filter(v => v !== null);
        return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
    };

    // 辅助：把 MA 浮点值四舍五入为号码（限定 0-9 范围内最接近的整数）
    const toNum = (v) => Math.max(0, Math.min(9, Math.round(v)));
    // 最新一期实际开奖号码
    const latestNum = recent[i];
    // 上期号码
    const prevNum = recent[i1];

    // ① 多头排列：MA5 > MA10 > MA20，且三条均线最近几期都向上
    if (cur.ma5 > cur.ma10 && cur.ma10 > cur.ma20) {
        const upCount = (cur.ma5 > prev.ma5 ? 1 : 0) + (cur.ma10 > prev.ma10 ? 1 : 0) + (cur.ma20 > prev.ma20 ? 1 : 0);
        if (upCount >= 2) {
            patterns.push({
                name: '多头排列', signal: 'bull',
                desc: '短期均线在最上，中期在中间，长期在最下，三条均线同时向上，看涨信号，可做多',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    // ② 空头排列：MA5 < MA10 < MA20，且三条均线最近几期都向下
    if (cur.ma5 < cur.ma10 && cur.ma10 < cur.ma20) {
        const downCount = (cur.ma5 < prev.ma5 ? 1 : 0) + (cur.ma10 < prev.ma10 ? 1 : 0) + (cur.ma20 < prev.ma20 ? 1 : 0);
        if (downCount >= 2) {
            patterns.push({
                name: '空头排列', signal: 'bear',
                desc: '长期均线在最上，中期在中间，短期在最下，三条均线同时向下，看跌信号，应做空',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    // ③ 黄金交叉：MA5 由下向上穿越 MA10 或 MA20，且形成后均线走平或向上
    if (prev.ma5 < prev.ma10 && cur.ma5 > cur.ma10) {
        patterns.push({
            name: '黄金交叉', signal: 'bull',
            desc: '短期均线由下向上穿越长期均线，看涨信号，可积极介入',
            numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma10)],
            numbersLabel: ['上期', '本期', 'MA5≈', 'MA10≈']
        });
    } else if (prev.ma5 < prev.ma20 && cur.ma5 > cur.ma20) {
        patterns.push({
            name: '黄金交叉', signal: 'bull',
            desc: '短期均线由下向上穿越长期均线，看涨信号，可积极介入',
            numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma20)],
            numbersLabel: ['上期', '本期', 'MA5≈', 'MA20≈']
        });
    }

    // ④ 死亡交叉：MA5 由上向下穿越 MA10 或 MA20
    if (prev.ma5 > prev.ma10 && cur.ma5 < cur.ma10) {
        patterns.push({
            name: '死亡交叉', signal: 'bear',
            desc: '短期均线由上向下穿越长期均线，看跌信号，应坚决看空',
            numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma10)],
            numbersLabel: ['上期', '本期', 'MA5≈', 'MA10≈']
        });
    } else if (prev.ma5 > prev.ma20 && cur.ma5 < cur.ma20) {
        patterns.push({
            name: '死亡交叉', signal: 'bear',
            desc: '短期均线由上向下穿越长期均线，看跌信号，应坚决看空',
            numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma20)],
            numbersLabel: ['上期', '本期', 'MA5≈', 'MA20≈']
        });
    }

    // ⑤ 银山谷：MA5 和 MA10 先后上穿 MA20，形成向上三角形
    // 检测：最近几期内 MA5 先上穿 MA20，之后 MA10 再上穿 MA20
    let silverCross1 = false; // MA5 上穿 MA20
    let silverCross2 = false; // MA10 上穿 MA20
    for (let k = i2; k < i; k++) {
        if (!silverCross1 && ma5[k - 1] < ma20[k - 1] && ma5[k] > ma20[k]) silverCross1 = true;
        if (silverCross1 && !silverCross2 && ma10[k - 1] < ma20[k - 1] && ma10[k] > ma20[k]) silverCross2 = true;
    }
    if (silverCross1 && silverCross2 && cur.ma5 > cur.ma20 && cur.ma10 > cur.ma20) {
        patterns.push({
            name: '银山谷', signal: 'bull',
            desc: '短期和中期均线先后上穿长期均线形成向上三角形，见底上涨信号，可买入',
            numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
            numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
        });
    }

    // ⑥ 死亡谷：MA5 和 MA10 先后下穿 MA20
    let deathCross1 = false;
    let deathCross2 = false;
    for (let k = i2; k < i; k++) {
        if (!deathCross1 && ma5[k - 1] > ma20[k - 1] && ma5[k] < ma20[k]) deathCross1 = true;
        if (deathCross1 && !deathCross2 && ma10[k - 1] > ma20[k - 1] && ma10[k] < ma20[k]) deathCross2 = true;
    }
    if (deathCross1 && deathCross2 && cur.ma5 < cur.ma20 && cur.ma10 < cur.ma20) {
        patterns.push({
            name: '死亡谷', signal: 'bear',
            desc: '短期和中期均线先后下穿长期均线形成向下三角形，看跌信号，应警惕',
            numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
            numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
        });
    }

    // ⑦ 粘合向上发散：MA5/MA10/MA20 缠绕后向上发散
    // 检测：前 5 期 max-min 较小（缠绕），最近 5 期 max-min 扩大且向上
    const convergeWindow = ma5.slice(0, 15).map((v, idx) => ({
        ma5: ma5[idx + 5], ma10: ma10[idx + 5], ma20: ma20[idx + 5]
    })).filter(x => x.ma5 !== null && x.ma10 !== null && x.ma20 !== null);
    const divergeWindow = ma5.slice(15).map((v, idx) => ({
        ma5: ma5[idx + 15], ma10: ma10[idx + 15], ma20: ma20[idx + 15]
    })).filter(x => x.ma5 !== null);

    if (convergeWindow.length >= 5 && divergeWindow.length >= 3) {
        const convSpread = Math.max(...convergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const divSpread = Math.max(...divergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const recentUp = divergeWindow.slice(-3).every((x, idx, arr) => idx === 0 || (x.ma5 > arr[idx - 1].ma5));
        if (convSpread < 1.0 && divSpread > convSpread * 1.5 && recentUp && cur.ma5 > cur.ma10 && cur.ma10 > cur.ma20) {
            patterns.push({
                name: '粘合向上发散', signal: 'bull',
                desc: '均线缠绕后向上发散，强烈的买入信号',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    // ⑧ 粘合向下发散：均线缠绕后向下发散
    if (convergeWindow.length >= 5 && divergeWindow.length >= 3) {
        const convSpread = Math.max(...convergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const divSpread = Math.max(...divergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const recentDown = divergeWindow.slice(-3).every((x, idx, arr) => idx === 0 || (x.ma5 < arr[idx - 1].ma5));
        if (convSpread < 1.0 && divSpread > convSpread * 1.5 && recentDown && cur.ma5 < cur.ma10 && cur.ma10 < cur.ma20) {
            patterns.push({
                name: '粘合向下发散', signal: 'bear',
                desc: '均线缠绕后向下发散，下跌警告信号，应注意风险',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    // ⑨ 上山爬坡形：三条均线基本沿着一定坡度上移
    // 检测：最近 10 期三条均线都在稳步上升
    const climbWindow = ma5.slice(10).map((v, idx) => ({
        ma5: ma5[idx + 10], ma10: ma10[idx + 10], ma20: ma20[idx + 10]
    })).filter(x => x.ma5 !== null && x.ma10 !== null && x.ma20 !== null);
    if (climbWindow.length >= 8) {
        const allUp = climbWindow.every((x, idx, arr) => idx === 0 ||
            (x.ma5 > arr[idx - 1].ma5 && x.ma10 > arr[idx - 1].ma10 && x.ma20 > arr[idx - 1].ma20));
        if (allUp) {
            patterns.push({
                name: '上山爬坡形', signal: 'bull',
                desc: '三条均线沿着一定坡度上移，看涨做多信号，可买入等待上涨',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    // ⑩ 下山滑坡形：三条均线基本沿着一定坡度下移
    if (climbWindow.length >= 8) {
        const allDown = climbWindow.every((x, idx, arr) => idx === 0 ||
            (x.ma5 < arr[idx - 1].ma5 && x.ma10 < arr[idx - 1].ma10 && x.ma20 < arr[idx - 1].ma20));
        if (allDown) {
            patterns.push({
                name: '下山滑坡形', signal: 'bear',
                desc: '三条均线沿着一定坡度下移，后市看跌信号，应敬而远之',
                numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum],
                numbersLabel: ['MA5≈', 'MA10≈', 'MA20≈', '最新']
            });
        }
    }

    return {
        patterns,
        maData: {
            series: recent,
            ma5, ma10, ma20,
            currentValues: cur,
            prevValues: prev
        }
    };
}

function loadLotteryData(cfg) {
    // 动态获取数据目录：优先当前工作区 data/，兜底插件安装目录 data/
    const dir = getDataDir();
    const filePath = path.join(dir, cfg.file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    return (json.history || []).slice().reverse();
}

function activate(context) {
    console.log('插件 "my-vscode-plugin" 已激活');
    _context = context;

    // 确保 globalStoragePath 目录存在（预测记录统一存储位置）
    const predDir = getPredDir();
    if (!fs.existsSync(predDir)) {
        try { fs.mkdirSync(predDir, { recursive: true }); } catch (e) { /* ignore */ }
    }

    // 一次性迁移：把旧的 predictions.json（工作区/插件目录）复制到 globalStoragePath
    try {
        const predFile = getPredictionsFile();
        if (!fs.existsSync(predFile) || fs.readFileSync(predFile, 'utf-8').trim() === '[]') {
            const candidates = [
                path.join(getDataDir(), 'predictions.json'),
                path.join(PLUGIN_DATA_DIR, 'predictions.json')
            ];
            for (const oldFile of candidates) {
                if (fs.existsSync(oldFile) && oldFile !== predFile) {
                    const oldData = fs.readFileSync(oldFile, 'utf-8').trim();
                    if (oldData && oldData !== '[]') {
                        fs.writeFileSync(predFile, oldData, 'utf-8');
                        console.log('[迁移] 预测记录已迁移到:', predFile);
                        break;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[迁移] 预测记录迁移失败:', e.message);
    }

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

        // 接收 Webview 消息（保存预测）
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'savePredictionBatch' && msg.predictions) {
                try {
                    const predictions = loadPredictions();
                    let savedCount = 0;
                    for (const pred of msg.predictions) {
                        predictions.push({
                            id: Date.now() * 1000 + savedCount,
                            type: pred.type,
                            typeName: pred.typeName,
                            basePeriod: pred.basePeriod,
                            targetPeriod: pred.targetPeriod,
                            picks: pred.picks,
                            totalCombos: pred.totalCombos,
                            note: pred.note,
                            source: pred.source || 'chart',
                            savedAt: new Date().toISOString(),
                            checked: false,
                            winResult: null
                        });
                        savedCount++;
                    }
                    savePredictions(predictions);
                    if (savedCount > 0) {
                        vscode.window.showInformationMessage(
                            '💾 预测已保存！共 ' + savedCount + ' 条\n' +
                            '目标期号：' + msg.predictions[0].targetPeriod + '\n' +
                            '开奖后将自动对比是否中奖'
                        );
                    }
                } catch (e) {
                    vscode.window.showErrorMessage('保存预测失败: ' + e.message);
                }
            }
        }, null, context.subscriptions);
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
                // 数据存到当前工作区 data/ 目录（通用，兜底插件安装目录）
                const saveDir = getDataDir();
                const results = await crawler.crawlAll(saveDir, limit);
                let okCount = 0;
                let failMsg = [];
                const totalCount = Object.keys(results).length;
                Object.keys(results).forEach(type => {
                    if (results[type] && !results[type].error) {
                        okCount++;
                    } else {
                        failMsg.push(type + ': ' + (results[type] && results[type].error));
                    }
                });
                if (okCount === totalCount) {
                    vscode.window.showInformationMessage(
                        '✅ 数据爬取完成！' + totalCount + ' 个彩种全部成功，各 ' + limit + ' 期。请重新打开走势图查看。'
                    );
                } else {
                    const retryBtn = await vscode.window.showWarningMessage(
                        '⚠️ 部分爬取失败：' + failMsg.join('; ') + '。成功 ' + okCount + '/' + totalCount + '。',
                        '🔄 重试',
                        '稍后再试'
                    );
                    if (retryBtn === '🔄 重试') {
                        vscode.commands.executeCommand('myPlugin.refreshData');
                    }
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
                { label: '🎰 排列五', value: 'pl5' },
                { label: '🎁 福彩3D', value: 'fc3d' }
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
                { label: '🎁 福彩3D', value: 'fc3d' },
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

        // 接收 Webview 消息（保存预测）
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'savePrediction') {
                try {
                    const predictions = loadPredictions();
                    // 计算 targetPeriod：当前最新期号 + 1（粗略估算）
                    // 对于排列三/五、双色球、大乐透，期号是递增的数字
                    let targetPeriod = msg.basePeriod;
                    const periodNum = parseInt(msg.basePeriod, 10);
                    if (!isNaN(periodNum)) {
                        targetPeriod = String(periodNum + 1);
                    }
                    predictions.push({
                        id: Date.now(),
                        type: msg.type,
                        typeName: msg.typeName,
                        basePeriod: msg.basePeriod,
                        targetPeriod: targetPeriod,
                        picks: msg.picks,
                        totalCombos: msg.totalCombos,
                        note: msg.note,
                        savedAt: new Date().toISOString(),
                        checked: false,
                        winResult: null
                    });
                    savePredictions(predictions);
                    vscode.window.showInformationMessage(
                        '💾 预测已保存！\n' +
                        msg.typeName + ' 目标期号：' + targetPeriod + '\n' +
                        '开奖后将自动对比是否中奖'
                    );
                } catch (e) {
                    vscode.window.showErrorMessage('保存预测失败: ' + e.message);
                }
            }
        }, null, context.subscriptions);
    });
    context.subscriptions.push(smartPickDisposable);

    // 概率统计智能推荐命令
    let probPickDisposable = vscode.commands.registerCommand('myPlugin.probabilityPick', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '统计概率智能推荐' },
                { label: '🎰 排列五', value: 'pl5', description: '统计概率智能推荐' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '统计概率智能推荐' }
            ],
            { placeHolder: '选择要分析的彩种（仅支持数字彩）' }
        );
        if (!pick) return;

        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '500 期', value: 500 },
                { label: '全部', value: 0 }
            ],
            { placeHolder: '基于多少期历史数据进行概率分析' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        const compoundPick = await vscode.window.showQuickPick(
            [
                { label: '🤖 自动模式', value: 'auto', description: '基于评分落差阈值动态决定每位选 2~5 个' },
                { label: '2 × 2 × ... (每位2个)', value: 2, description: '最小复式，注数最少' },
                { label: '3 × 3 × ... (每位3个)', value: 3, description: '中等复式' },
                { label: '4 × 4 × ... (每位4个)', value: 4, description: '较大复式' },
                { label: '5 × 5 × ... (每位5个)', value: 5, description: '最大复式' },
                { label: '🎛️ 自定义每位选号数', value: 'custom', description: '每位独立指定 2~5 个' }
            ],
            { placeHolder: '选择复式推荐规格' }
        );
        if (!compoundPick) return;
        let compoundSpec;
        if (compoundPick.value === 'auto') {
            compoundSpec = undefined;
        } else if (compoundPick.value === 'custom') {
            const cfg2 = LOTTERY_TYPES.find(c => c.key === pick.value);
            const customArr = [];
            for (let i = 0; i < cfg2.positions.length; i++) {
                const kPick = await vscode.window.showQuickPick(
                    [
                        { label: '2 个', value: 2 },
                        { label: '3 个', value: 3 },
                        { label: '4 个', value: 4 },
                        { label: '5 个', value: 5 }
                    ],
                    { placeHolder: cfg2.positions[i].label + '位 选几个号码？' }
                );
                if (!kPick) return;
                customArr.push(kPick.value);
            }
            compoundSpec = customArr;
        } else {
            compoundSpec = compoundPick.value;
        }

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let analysis;
        try {
            const history = loadLotteryData(cfg);

            if (history.length < 10) {
                vscode.window.showWarningMessage('数据不足（需要 ≥10 期），请先刷新数据');
                return;
            }

            const sliced = limit > 0 ? history.slice(-limit) : history;
            analysis = computeProbabilityAnalysis(sliced, cfg, compoundSpec);
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'probabilityPick',
            '🧬 概率统计智能推荐 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getProbabilityPickHtml(analysis);
    });
    context.subscriptions.push(probPickDisposable);

    // ========== 012路趋势+奇偶比深度分析 ==========
    let roadAnalysisDisposable = vscode.commands.registerCommand('myPlugin.roadAnalysis', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '3位012路趋势+奇偶比分析' },
                { label: '🎰 排列五', value: 'pl5', description: '5位012路趋势+奇偶比分析' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '3位012路趋势+奇偶比分析' }
            ],
            { placeHolder: '选择要分析的彩种（012路趋势 + 奇偶比）' }
        );
        if (!pick) return;

        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '最近 50 期', value: 50, description: '短期趋势' },
                { label: '最近 100 期', value: 100, description: '中期趋势' },
                { label: '最近 200 期', value: 200, description: '中长趋势' },
                { label: '最近 300 期', value: 300, description: '长趋势（推荐）' },
                { label: '全部数据', value: 0, description: '使用所有历史数据' }
            ],
            { placeHolder: '选择分析期数范围' }
        );
        if (!limitPick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let history;
        try {
            history = loadLotteryData(cfg);
            if (history.length < 20) {
                vscode.window.showWarningMessage('数据不足（需要 ≥20 期），请先刷新数据');
                return;
            }
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        // 按时间正序排列
        const sortedHistory = history.slice().reverse();
        const dataToAnalyze = limitPick.value > 0 ? sortedHistory.slice(-limitPick.value) : sortedHistory;
        const N = dataToAnalyze.length;

        // 执行012路分析
        const analysisResult = computeRoadAnalysis(dataToAnalyze, cfg);

        // 创建Webview面板展示结果
        const panel = vscode.window.createWebviewPanel(
            'roadAnalysis',
            '🛤️ 012路趋势分析 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        // 监听来自 Webview 的消息（用于复制功能）
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                // 通知前端复制成功
                panel.webview.postMessage({ command: 'copySuccess' });
                return;
            }
        });

        panel.webview.html = getRoadAnalysisHtml(analysisResult, cfg, N);
    });
    context.subscriptions.push(roadAnalysisDisposable);

    // 概率推荐历史回测命令
    let probBacktestDisposable = vscode.commands.registerCommand('myPlugin.probabilityBacktest', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '概率推荐历史回测' },
                { label: '🎰 排列五', value: 'pl5', description: '概率推荐历史回测' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '概率推荐历史回测' }
            ],
            { placeHolder: '选择要回测的彩种' }
        );
        if (!pick) return;

        const trainPick = await vscode.window.showQuickPick(
            [
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '500 期', value: 500 }
            ],
            { placeHolder: '每次预测使用的训练样本期数（越大越慢但更稳定）' }
        );
        if (!trainPick) return;

        const stepPick = await vscode.window.showQuickPick(
            [
                { label: '每 1 期', value: 1, description: '最密集（最慢，最细）' },
                { label: '每 5 期', value: 5 },
                { label: '每 10 期', value: 10, description: '推荐（默认）' },
                { label: '每 20 期', value: 20, description: '最快速' }
            ],
            { placeHolder: '回测步长（每隔多少期做一次预测）' }
        );
        if (!stepPick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let bt;
        try {
            const history = loadLotteryData(cfg);
            if (history.length < trainPick.value + 20) {
                vscode.window.showWarningMessage('历史数据不足（需要 ≥' + (trainPick.value + 20) + ' 期），请先刷新数据');
                return;
            }
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '🧪 正在执行概率推荐回测...',
                cancellable: false
            }, async () => {
                bt = backtestProbabilityAnalysis(history, cfg, {
                    trainSize: trainPick.value,
                    step: stepPick.value,
                    topK: 8,
                    hitMode: 'exact'
                });
            });
        } catch (e) {
            vscode.window.showErrorMessage('回测失败: ' + e.message);
            return;
        }

        if (!bt || bt.totalTests === 0) {
            vscode.window.showWarningMessage('回测无有效结果，请调整参数或刷新数据');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'probabilityBacktest',
            '🧪 概率推荐回测 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getBacktestHtml(bt);
    });
    context.subscriptions.push(probBacktestDisposable);

    // 查看预测记录命令
    let showPredDisposable = vscode.commands.registerCommand('myPlugin.showPredictions', () => {
        const predictions = loadPredictions();
        const panel = vscode.window.createWebviewPanel(
            'predictions',
            '🔮 预测记录',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getPredictionsHtml(predictions);

        // 接收删除消息
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'deletePrediction') {
                const preds = loadPredictions();
                const filtered = preds.filter(p => p.id !== msg.id);
                savePredictions(filtered);
                // 重新生成 HTML 并更新 webview（而不是让前端 location.reload）
                panel.webview.html = getPredictionsHtml(filtered);
            }
        }, null, context.subscriptions);
    });
    context.subscriptions.push(showPredDisposable);

    // 均线形态识别命令
    let maPatternsDisposable = vscode.commands.registerCommand('myPlugin.maPatterns', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3' },
                { label: '🎰 排列五', value: 'pl5' },
                { label: '🎁 福彩3D', value: 'fc3d' },
                { label: '🎲 大乐透', value: 'dlt' },
                { label: '🔴 双色球', value: 'ssq' }
            ],
            { placeHolder: '选择要分析的彩种' }
        );
        if (!pick) return;

        let data;
        try {
            const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
            if (!cfg) return;
            const history = loadLotteryData(cfg);
            if (history.length < 20) {
                vscode.window.showWarningMessage('数据不足（需要 ≥20 期），请先刷新数据');
                return;
            }
            // 取最近 20 期数据（旧→新）
            const recent = history.slice(-20);
            // 对每位分别识别形态
            const posResults = [];
            for (let pos = 0; pos < cfg.positions.length; pos++) {
                const series = recent.map(h => cfg.positions[pos].pick(h));
                const result = detectMAPatterns(series);
                posResults.push({
                    pos: pos,
                    label: cfg.positions[pos].label,
                    patterns: result.patterns,
                    maData: result.maData,
                    error: result.error
                });
            }
            // 总览：取所有位中"最显著的形态"
            const allPatterns = [];
            posResults.forEach(pr => {
                pr.patterns.forEach(p => {
                    allPatterns.push({ ...p, posLabel: pr.label });
                });
            });

            data = {
                key: cfg.key,
                name: cfg.name,
                emoji: cfg.emoji,
                positionLabels: cfg.positions.map(p => p.label),
                recentPeriod: recent[recent.length - 1].period,
                posResults: posResults,
                summary: {
                    bullCount: allPatterns.filter(p => p.signal === 'bull').length,
                    bearCount: allPatterns.filter(p => p.signal === 'bear').length,
                    patternNames: Array.from(new Set(allPatterns.map(p => p.name)))
                }
            };
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'maPatterns',
            '均线形态识别 - ' + data.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getMAPatternsHtml(data);
    });
    context.subscriptions.push(maPatternsDisposable);

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
        const saveDir = getDataDir();
        const results = await crawler.crawlAll(saveDir, limit);
        let okCount = 0;
        let failMsg = [];
        const totalCount = Object.keys(results).length;
        Object.keys(results).forEach(type => {
            if (results[type] && !results[type].error) okCount++;
            else failMsg.push(type + ': ' + (results[type] && results[type].error));
        });
        if (okCount < totalCount) {
            vscode.window.showWarningMessage('⚠️ 彩票数据自动爬取部分失败：' + failMsg.join('; ') + '（成功 ' + okCount + '/' + totalCount + '）');
        } else if (!silent) {
            vscode.window.showInformationMessage('✅ 彩票数据已自动更新（' + limit + ' 期）');
        }

        // 爬取成功后对比预测记录是否中奖
        if (okCount > 0) {
            try {
                const wins = checkAllPredictions();
                if (wins.length > 0) {
                    showWinNotification(wins);
                }
            } catch (e) {
                console.error('对比预测失败:', e.message);
            }
        }
    } catch (e) {
        console.error('自动爬取失败:', e.message);
    }
}

/**
 * 显示中奖庆祝窗口
 * @param {Array<Object>} wins - 中奖记录列表
 */
function showWinNotification(wins) {
    for (const win of wins) {
        const pred = win.prediction;
        const result = win.result;
        const cfg = LOTTERY_TYPES.find(c => c.key === pred.type);
        const emoji = cfg ? cfg.emoji : '🎉';

        // 构建中奖详情
        let detail = '彩种：' + pred.typeName + '\n';
        detail += '期号：' + result.period + '（' + result.date + '）\n';
        detail += '中奖等级：' + result.prizeLevel + '\n';
        detail += '开奖号码：' + result.drawNums.join(' ') + '\n';
        detail += '您的选号：' + pred.picks.map(p => p.join(',')).join(' | ') + '\n';
        detail += '复式注数：' + pred.totalCombos + ' 注';

        // 弹出庆祝窗口
        const choice = vscode.window.showInformationMessage(
            '🎉🎉🎉 恭喜中奖！' + emoji + ' ' + pred.typeName + ' 第 ' + result.period + ' 期 ' + result.prizeLevel + '！',
            { modal: false },
            '查看详情', '查看所有预测', '关闭'
        );
        choice.then(btn => {
            if (btn === '查看详情') {
                const detailPanel = vscode.window.createWebviewPanel(
                    'winDetail',
                    '中奖详情 - ' + pred.typeName + ' 第' + result.period + '期',
                    vscode.ViewColumn.One,
                    { enableScripts: false }
                );
                detailPanel.webview.html = getWinDetailHtml(win);
            } else if (btn === '查看所有预测') {
                vscode.commands.executeCommand('myPlugin.showPredictions');
            }
        });
    }
}

/**
 * 生成中奖详情 HTML
 * @param {Object} win - 中奖记录
 * @returns {string} HTML
 */
function getWinDetailHtml(win) {
    const pred = win.prediction;
    const result = win.result;
    const cfg = LOTTERY_TYPES.find(c => c.key === pred.type);
    const posLabels = cfg ? cfg.positions.map(p => p.label) : [];

    let posRows = '';
    for (let i = 0; i < result.drawNums.length; i++) {
        const pr = result.posResults[i];
        const picksStr = pr.picks.join(', ');
        const hitIcon = pr.hit ? '✅' : '❌';
        const hitColor = pr.hit ? '#2ecc71' : '#e74c3c';
        posRows += '<tr>' +
            '<td>' + (posLabels[i] || '位' + (i + 1)) + '</td>' +
            '<td style="color:#feca57;font-weight:bold;font-size:16px;">' + pr.drawNum + '</td>' +
            '<td>' + picksStr + '</td>' +
            '<td style="color:' + hitColor + ';font-weight:bold;">' + hitIcon + ' ' + (pr.hit ? '命中' : '未中') + '</td>' +
            '</tr>';
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>中奖详情</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 14px; padding: 20px; }
.win-banner { text-align: center; padding: 20px; background: linear-gradient(135deg, rgba(241,196,15,0.15), rgba(231,76,60,0.15)); border: 2px solid rgba(241,196,15,0.4); border-radius: 12px; margin-bottom: 20px; }
.win-title { font-size: 28px; color: #f1c40f; font-weight: bold; margin-bottom: 8px; }
.win-sub { color: #aaa; font-size: 14px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
th, td { border: 1px solid #444; padding: 8px 12px; text-align: center; }
th { background: #2d2d30; color: #8ec5ff; }
.info-box { padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; }
.info-box b { color: #feca57; }
</style>
</head>
<body>
<div class="win-banner">
    <div class="win-title">🎉 恭喜中奖！🎉</div>
    <div class="win-sub">${pred.typeName} 第 ${result.period} 期 · ${result.prizeLevel}</div>
</div>
<div class="info-box"><b>开奖日期：</b>${result.date}</div>
<div class="info-box"><b>复式注数：</b>${pred.totalCombos} 注</div>
<table>
<thead><tr><th>位置</th><th>开奖号码</th><th>您的选号</th><th>命中情况</th></tr></thead>
<tbody>${posRows}</tbody>
</table>
<div class="info-box"><b>保存时间：</b>${new Date(pred.savedAt).toLocaleString('zh-CN')}</div>
<div class="info-box"><b>基于期号：</b>${pred.basePeriod}</div>
</body>
</html>`;
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
                this.createItem('🧬 概率推荐', 'myPlugin.probabilityPick', '🧬'),
                this.createItem('🛤️ 012路趋势', 'myPlugin.roadAnalysis', '🛤️'),
                this.createItem('🧪 概率回测', 'myPlugin.probabilityBacktest', '🧪'),
                this.createItem('📈 均线形态', 'myPlugin.maPatterns', '📈'),
                this.createItem('🔮 预测记录', 'myPlugin.showPredictions', '🔮'),
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
 * 生成均线形态识别 Webview HTML
 * @param {Object} d - {key, name, emoji, positionLabels, recentPeriod, posResults, summary}
 * @returns {string} HTML
 */
function getMAPatternsHtml(d) {
    const dataJson = JSON.stringify(d);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>均线形态识别 - ${d.name}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 8px; }
.desc { color: #aaa; margin-bottom: 16px; line-height: 1.6; }
.limit-badge { display: inline-block; background: #0e639c; color: #fff; padding: 2px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; }

/* 总览卡片 */
.summary-section { margin-bottom: 20px; padding: 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
.summary-title { color: #feca57; font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.summary-stats { display: flex; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.summary-stat { padding: 8px 16px; background: rgba(0,0,0,0.2); border-radius: 4px; text-align: center; min-width: 80px; }
.summary-stat-num { font-size: 24px; font-weight: bold; }
.summary-stat-label { font-size: 11px; color: #888; margin-top: 2px; }
.summary-stat.bull .summary-stat-num { color: #e74c3c; }
.summary-stat.bear .summary-stat-num { color: #27ae60; }
.summary-stat.all .summary-stat-num { color: #8ec5ff; }

/* 形态徽章 */
.pattern-badge { display: inline-block; padding: 4px 10px; margin: 3px 4px 3px 0; border-radius: 4px; font-size: 12px; font-weight: 600; }
.pattern-badge.bull { background: rgba(231,76,60,0.15); color: #ff6b6b; border: 1px solid rgba(231,76,60,0.4); }
.pattern-badge.bear { background: rgba(39,174,96,0.15); color: #2ecc71; border: 1px solid rgba(39,174,96,0.4); }

/* 每个位置的结果 */
.pos-section { margin-bottom: 16px; padding: 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
.pos-title { color: #feca57; font-size: 14px; font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.pos-title .pos-name { font-size: 16px; }
.pos-empty { color: #666; padding: 12px; text-align: center; }

/* 图表区 */
.chart-wrap { margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.3); border-radius: 6px; }
.chart-title { color: #aaa; font-size: 11px; margin-bottom: 6px; }
.chart-svg-wrap { background: #252526; border-radius: 4px; padding: 6px; overflow-x: auto; }

/* 形态详情 */
.pattern-detail { padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 4px; margin-top: 6px; }
.pattern-detail .name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.pattern-detail .name.bull { color: #ff6b6b; }
.pattern-detail .name.bear { color: #2ecc71; }
.pattern-detail .desc-text { color: #aaa; font-size: 11px; line-height: 1.5; }

/* 形态对应号码球 */
.pattern-numbers { margin-top: 6px; padding: 6px 8px; background: rgba(255,255,255,0.04); border-radius: 4px; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.pattern-numbers-label { color: #888; font-size: 11px; margin-right: 4px; }
.num-ball { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-width: 30px; padding: 2px 4px; border-radius: 4px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); }
.num-ball .num-ball-label { font-size: 9px; color: #888; line-height: 1; margin-bottom: 1px; }
.num-ball .num-ball-value { font-size: 14px; font-weight: bold; color: #ddd; line-height: 1.2; }
.num-ball.bull { border-color: rgba(231,76,60,0.5); background: rgba(231,76,60,0.12); }
.num-ball.bull .num-ball-value { color: #ff6b6b; }
.num-ball.bear { border-color: rgba(39,174,96,0.5); background: rgba(39,174,96,0.12); }
.num-ball.bear .num-ball-value { color: #2ecc71; }
.num-ball.latest { border-color: rgba(254,202,87,0.7); background: rgba(254,202,87,0.15); }
.num-ball.latest .num-ball-value { color: #feca57; }

/* 推荐选号建议区 */
.suggest-section { margin-bottom: 20px; padding: 14px; background: rgba(254,202,87,0.06); border: 1px solid rgba(254,202,87,0.3); border-radius: 8px; }
.suggest-title { color: #feca57; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.suggest-hint { color: #888; font-size: 11px; line-height: 1.6; margin-bottom: 10px; }
.suggest-row { display: flex; align-items: flex-start; margin-bottom: 8px; padding: 8px 10px; background: rgba(0,0,0,0.2); border-radius: 4px; flex-wrap: wrap; gap: 6px; }
.suggest-row-label { color: #aaa; font-size: 12px; min-width: 70px; padding-top: 3px; }
.suggest-row.bull { border-left: 3px solid #e74c3c; }
.suggest-row.bear { border-left: 3px solid #27ae60; }
.suggest-row.neutral { border-left: 3px solid #888; }
.suggest-nums { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.suggest-pos-tag { display: inline-block; padding: 1px 6px; background: rgba(255,255,255,0.08); border-radius: 3px; font-size: 10px; color: #ccc; margin-right: 4px; }
.suggest-big-ball { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; font-size: 13px; font-weight: bold; margin: 0 1px; }
.suggest-big-ball.bull { background: rgba(231,76,60,0.25); color: #ff6b6b; border: 1px solid rgba(231,76,60,0.5); }
.suggest-big-ball.bear { background: rgba(39,174,96,0.25); color: #2ecc71; border: 1px solid rgba(39,174,96,0.5); text-decoration: line-through; }
.suggest-empty { color: #666; font-size: 11px; padding: 4px 0; }
.suggest-tip { width: 100%; margin-top: 6px; padding: 5px 8px; background: rgba(254,202,87,0.08); border-left: 2px solid #feca57; border-radius: 3px; font-size: 11px; color: #feca57; line-height: 1.5; }

.copy-btn { background: #0e639c; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 8px; }
.copy-btn:hover { background: #1177bb; }
</style>
</head>
<body>
<h2>📈 ${d.name} 均线形态识别</h2>
<div class="desc">
    <span class="limit-badge">基于最近 20 期数据 · 最新期号 ${d.recentPeriod}</span><br>
    对每位号码计算 <b>MA5（短期）</b>、<b>MA10（中期）</b>、<b>MA20（长期）</b> 三条移动平均线，
    识别 10 种典型均线形态。
</div>
<div id="content"></div>
<script>
const DATA = ${dataJson};

const ALL_PATTERNS = [
    { name: '多头排列', signal: 'bull', desc: '短期均线在最上，中期在中间，长期在最下，三条均线同时向上移动的排列形态即为多头排列。技术含义：做多信号，继续看涨。' },
    { name: '空头排列', signal: 'bear', desc: '三条均线同时以圆弧状向下运行，且从上到下时间越来越短，形成空头排列。技术含义：做空信号，继续看跌。' },
    { name: '黄金交叉', signal: 'bull', desc: '短期均线由下向上穿越长期均线，且均线形式走平或向上。技术含义：看涨信号，两线交叉的角度越大，上涨的信号越强烈。' },
    { name: '死亡交叉', signal: 'bear', desc: '短期均线由上向下穿越长期均线，且长期均线走势疲软。技术含义：看跌信号，两根均线的夹角越大，下跌越猛烈。' },
    { name: '银山谷', signal: 'bull', desc: '短期均线和中期均线先后向上穿越长期均线，三根均线形成一个一角向上的不规则三角形，多出现在上涨的初期。技术含义：见底开始上涨的信号，后市看涨。' },
    { name: '死亡谷', signal: 'bear', desc: '多出现在下跌的初期，短期均线和中期均线先后下穿长期均线，形成一个一角向下的不规则三角形。技术含义：看跌的信号，应提高警惕。' },
    { name: '粘合向上发散', signal: 'bull', desc: '出现在上涨的初期或趋势继中，短期、中期以及长期均线缠绕粘连，后向上发散，上涨趋势明显。技术含义：买入上涨信号，投资者可在发散初期及时介入。' },
    { name: '粘合向下发散', signal: 'bear', desc: '出现在横盘末期，短期、中期和长期均线缠绕粘连，横盘选择方向，后均线发散开始下跌走势。技术含义：下跌警告信号，应注意风险。' },
    { name: '上山爬坡形', signal: 'bull', desc: '出现在上涨趋势中，短期、中期和长期均线基本都沿着一定坡度往上移。技术含义：看涨做多的信号，可逢低买入，等待上涨。' },
    { name: '下山滑坡形', signal: 'bear', desc: '出现在跌势中，均线基本沿着一定的坡度往下移动，是后市看跌信号。技术含义：最好的策略还是敬而远之，下跌趋势中每次反弹都是逃跑的机会。' }
];

(function() {
    let html = '';

    // 总览区
    const detected = DATA.summary.patternNames;
    html += '<div class="summary-section">';
    html += '<div class="summary-title">🎯 总览</div>';
    html += '<div class="summary-stats">';
    html += '<div class="summary-stat bull"><div class="summary-stat-num">' + DATA.summary.bullCount + '</div><div class="summary-stat-label">看涨信号</div></div>';
    html += '<div class="summary-stat bear"><div class="summary-stat-num">' + DATA.summary.bearCount + '</div><div class="summary-stat-label">看跌信号</div></div>';
    html += '<div class="summary-stat all"><div class="summary-stat-num">' + (DATA.summary.bullCount + DATA.summary.bearCount) + '</div><div class="summary-stat-label">总信号</div></div>';
    html += '</div>';
    if (detected.length > 0) {
        html += '<div style="margin-top:8px;">';
        html += '<div style="color:#aaa;font-size:11px;margin-bottom:4px;">已识别的形态：</div>';
        detected.forEach(name => {
            const p = ALL_PATTERNS.find(x => x.name === name);
            if (p) {
                html += '<span class="pattern-badge ' + p.signal + '">' + p.name + '</span>';
            }
        });
        html += '</div>';
    } else {
        html += '<div style="color:#888;font-size:12px;margin-top:8px;">暂未识别到典型形态（市场处于震荡或无明显趋势）</div>';
    }
    html += '</div>';

    // 推荐选号建议区：按位归类看涨/看跌号码
    html += '<div class="suggest-section">';
    html += '<div class="suggest-title">🎯 推荐选号建议</div>';
    html += '<div class="suggest-hint">' +
        '根据各位置识别到的均线形态自动归类：<b style="color:#ff6b6b;">看涨信号</b>的号码建议<b>优先选择</b>（趋势向上），' +
        '<b style="color:#2ecc71;">看跌信号</b>的号码建议<b>避开</b>（趋势向下，已加删除线标记）。' +
        '号码来源：该位置形态对应的 MA5/MA10/MA20 均线值四舍五入 + 最新一期实际号码。</div>';

    DATA.posResults.forEach((pr, idx) => {
        const bullNums = [];
        const bearNums = [];
        pr.patterns.forEach(p => {
            if (p.numbers && p.numbers.length > 0) {
                p.numbers.forEach(n => {
                    if (p.signal === 'bull') {
                        if (bullNums.indexOf(n) === -1) bullNums.push(n);
                    } else {
                        if (bearNums.indexOf(n) === -1) bearNums.push(n);
                    }
                });
            }
        });
        // 排序
        bullNums.sort((a, b) => a - b);
        bearNums.sort((a, b) => a - b);

        html += '<div class="suggest-row ' + (bullNums.length >= bearNums.length ? (bullNums.length > 0 ? 'bull' : 'neutral') : 'bear') + '">';
        html += '<div class="suggest-row-label">' + pr.label + '位</div>';
        html += '<div class="suggest-nums">';
        if (bullNums.length === 0 && bearNums.length === 0) {
            html += '<span class="suggest-empty">无形态信号，参考其他分析</span>';
        } else {
            if (bullNums.length > 0) {
                html += '<span class="suggest-pos-tag">📈 优选</span>';
                bullNums.forEach(n => {
                    html += '<span class="suggest-big-ball bull">' + n + '</span>';
                });
            }
            if (bearNums.length > 0) {
                if (bullNums.length > 0) html += '<span style="color:#555;margin:0 4px;">|</span>';
                html += '<span class="suggest-pos-tag">📉 避开</span>';
                bearNums.forEach(n => {
                    html += '<span class="suggest-big-ball bear">' + n + '</span>';
                });
            }
        }

        // 生成具体选号建议文字
        if (bullNums.length > 0 || bearNums.length > 0) {
            const latestNum = pr.maData && pr.maData.series ? pr.maData.series[pr.maData.series.length - 1] : null;
            let suggest = '';
            if (bullNums.length > 0 && bearNums.length === 0) {
                // 纯看涨：号码往上走，选偏大或优选号码附近
                suggest = '→ 该位看涨，号码有上升趋势，建议优先选上面红色号码';
                if (latestNum !== null) {
                    suggest += '（当前' + latestNum + '，下期可能 ≥' + latestNum + '）';
                }
            } else if (bearNums.length > 0 && bullNums.length === 0) {
                // 纯看跌：号码往下走，选偏小或避开号码之外的小号
                suggest = '→ 该位看跌，号码有下降趋势，建议避开上面绿色号码，选偏小号码';
                if (latestNum !== null) {
                    suggest += '（当前' + latestNum + '，下期可能 ≤' + latestNum + '）';
                }
            } else {
                // 多空交织：信号矛盾，谨慎
                suggest = '→ 该位多空信号交织，趋势不明，建议参考其他分析（转移统计/走势图）再定';
            }
            html += '<div class="suggest-tip">' + suggest + '</div>';
        }
        html += '</div>';
        html += '</div>';
    });
    html += '</div>';

    // 每位详情
    DATA.posResults.forEach((pr, idx) => {
        html += '<div class="pos-section">';
        html += '<div class="pos-title">';
        html += '<span class="pos-name">🎯 ' + pr.label + '位</span>';
        if (pr.patterns.length > 0) {
            html += '<span style="font-size:11px;color:#888;">识别到 ' + pr.patterns.length + ' 个形态</span>';
        }
        html += '</div>';

        if (pr.error) {
            html += '<div class="pos-empty">' + pr.error + '</div>';
        } else {
            // 当前均线值
            const cv = pr.maData.currentValues;
            html += '<div style="margin-bottom:8px;font-size:11px;color:#aaa;">';
            html += '当前 MA5=<b style="color:#f39c12;">' + cv.ma5.toFixed(2) + '</b>, ';
            html += 'MA10=<b style="color:#9b59b6;">' + cv.ma10.toFixed(2) + '</b>, ';
            html += 'MA20=<b style="color:#3498db;">' + cv.ma20.toFixed(2) + '</b>';
            html += '</div>';

            // 形态列表
            if (pr.patterns.length > 0) {
                pr.patterns.forEach(p => {
                    html += '<div class="pattern-detail">';
                    html += '<div class="name ' + p.signal + '">' +
                        (p.signal === 'bull' ? '📈 ' : '📉 ') + p.name + '</div>';
                    html += '<div class="desc-text">' + p.desc + '</div>';
                    // 显示该形态对应的关键号码
                    if (p.numbers && p.numbers.length > 0) {
                        html += '<div class="pattern-numbers">';
                        html += '<span class="pattern-numbers-label">对应号码：</span>';
                        const labels = p.numbersLabel || [];
                        p.numbers.forEach((num, ni) => {
                            const lbl = labels[ni] || '';
                            const isLatest = lbl === '最新' || lbl === '本期';
                            const cls = isLatest ? 'num-ball latest' : 'num-ball ' + p.signal;
                            html += '<span class="' + cls + '" title="' + lbl + '">' +
                                (lbl ? '<span class="num-ball-label">' + lbl + '</span>' : '') +
                                '<span class="num-ball-value">' + num + '</span></span>';
                        });
                        html += '</div>';
                    }
                    html += '</div>';
                });
            } else {
                html += '<div style="color:#888;font-size:12px;padding:6px;">未识别到典型形态</div>';
            }

            // 走势图
            html += '<div class="chart-wrap">';
            html += '<div class="chart-title">📊 最近 20 期均线走势</div>';
            html += '<div class="chart-svg-wrap">';
            html += renderChart(pr.maData);
            html += '</div></div>';
        }
        html += '</div>';
    });

    // 形态图例
    html += '<div class="summary-section">';
    html += '<div class="summary-title">📚 形态说明（10 种）</div>';
    html += '<div style="color:#888;font-size:11px;margin-bottom:8px;line-height:1.6;">' +
        '每种形态识别后会显示对应的<b style="color:#feca57;">关键号码</b>：' +
        '<span style="color:#f39c12;">MA5≈</span> 表示短期均线四舍五入的号码、' +
        '<span style="color:#9b59b6;">MA10≈</span> 中期、' +
        '<span style="color:#3498db;">MA20≈</span> 长期，' +
        '<span style="color:#feca57;">最新/本期</span> 为最近一期实际开奖号码。' +
        '可根据这些号码作为该位的候选参考。</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-top:8px;">';
    ALL_PATTERNS.forEach(p => {
        html += '<div class="pattern-detail">';
        html += '<div class="name ' + p.signal + '">' +
            (p.signal === 'bull' ? '📈 ' : '📉 ') + p.name + '</div>';
        html += '<div class="desc-text">' + p.desc + '</div>';
        html += '</div>';
    });
    html += '</div></div>';

    document.getElementById('content').innerHTML = html;

    function renderChart(maData) {
        const series = maData.series;
        const ma5 = maData.ma5;
        const ma10 = maData.ma10;
        const ma20 = maData.ma20;
        const n = series.length;

        // 图表尺寸
        const W = Math.max(400, n * 22);
        const H = 160;
        const padL = 30, padR = 10, padT = 10, padB = 20;

        // 计算 y 轴范围
        const allVals = [...series, ...ma5.filter(v => v !== null), ...ma10.filter(v => v !== null), ...ma20.filter(v => v !== null)];
        const minV = Math.min(...allVals);
        const maxV = Math.max(...allVals);
        const range = maxV - minV || 1;
        const yMin = minV - range * 0.1;
        const yMax = maxV + range * 0.1;

        const xStep = (W - padL - padR) / (n - 1);
        const yScale = (v) => padT + (H - padT - padB) * (1 - (v - yMin) / (yMax - yMin));

        let svg = '<svg width="' + W + '" height="' + H + '" style="background:#1a1a1a;border-radius:4px;">';

        // y 轴参考线
        for (let k = 0; k <= 4; k++) {
            const yVal = yMin + (yMax - yMin) * k / 4;
            const y = yScale(yVal);
            svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#333" stroke-width="0.5"/>';
            svg += '<text x="2" y="' + (y + 3) + '" fill="#666" font-size="9">' + yVal.toFixed(1) + '</text>';
        }

        // 原始数据点
        let ptsStr = '';
        series.forEach((v, i) => {
            const x = padL + i * xStep;
            const y = yScale(v);
            ptsStr += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
        });
        svg += '<path d="' + ptsStr + '" stroke="#888" stroke-width="1" fill="none" opacity="0.6"/>';

        // 每个数据点画圆 + 标注号码
        series.forEach((v, i) => {
            const x = padL + i * xStep;
            const y = yScale(v);
            const isLatest = (i === n - 1);
            if (isLatest) {
                // 最新一期：高亮黄色大圆 + 号码
                svg += '<circle cx="' + x + '" cy="' + y + '" r="5" fill="#feca57" stroke="#000" stroke-width="1"/>';
                svg += '<text x="' + x + '" y="' + (y - 9) + '" fill="#feca57" font-size="11" font-weight="bold" text-anchor="middle">' + v + '</text>';
            } else if (i % 2 === 0 || n <= 12) {
                // 普通点：小圆 + 号码（数据少时全标，数据多时隔点标）
                svg += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#aaa"/>';
                svg += '<text x="' + x + '" y="' + (y - 7) + '" fill="#bbb" font-size="9" text-anchor="middle">' + v + '</text>';
            } else {
                svg += '<circle cx="' + x + '" cy="' + y + '" r="2" fill="#888"/>';
            }
        });

        // MA5
        svg += drawMALine(ma5, '#f39c12', padL, xStep, yScale);
        // MA10
        svg += drawMALine(ma10, '#9b59b6', padL, xStep, yScale);
        // MA20
        svg += drawMALine(ma20, '#3498db', padL, xStep, yScale);

        // x 轴期号
        for (let i = 0; i < n; i += Math.ceil(n / 10)) {
            const x = padL + i * xStep;
            svg += '<text x="' + x + '" y="' + (H - 5) + '" fill="#888" font-size="9" text-anchor="middle">' + (i + 1) + '</text>';
        }

        // 图例
        svg += '<rect x="' + (W - 130) + '" y="5" width="125" height="40" fill="#000" opacity="0.5" rx="3"/>';
        svg += '<text x="' + (W - 125) + '" y="18" fill="#f39c12" font-size="10">━ MA5 (短期)</text>';
        svg += '<text x="' + (W - 125) + '" y="30" fill="#9b59b6" font-size="10">━ MA10 (中期)</text>';
        svg += '<text x="' + (W - 125) + '" y="42" fill="#3498db" font-size="10">━ MA20 (长期)</text>';

        svg += '</svg>';
        return svg;
    }

    function drawMALine(ma, color, padL, xStep, yScale) {
        let d = '';
        let started = false;
        ma.forEach((v, i) => {
            if (v === null) return;
            const x = padL + i * xStep;
            const y = yScale(v);
            d += (started ? 'L' : 'M') + x + ',' + y + ' ';
            started = true;
        });
        return '<path d="' + d + '" stroke="' + color + '" stroke-width="1.5" fill="none"/>';
    }
})();
</script>
</body>
</html>`;
}

/**
 * 生成预测记录 HTML
 * @param {Array<Object>} predictions - 预测记录列表
 * @returns {string} HTML
 */
function getPredictionsHtml(predictions) {
    const total = predictions.length;
    const wins = predictions.filter(p => p.checked && p.winResult);
    const checked = predictions.filter(p => p.checked);
    const pending = predictions.filter(p => !p.checked);

    let rows = '';
    if (total === 0) {
        rows = '<div style="text-align:center;padding:40px;color:#666;">暂无预测记录<br><span style="font-size:12px;">使用"智能推荐"功能后点击"💾 保存预测"即可记录</span></div>';
    } else {
        // 按保存时间倒序
        const sorted = predictions.slice().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
        for (const p of sorted) {
            const cfg = LOTTERY_TYPES.find(c => c.key === p.type);
            const emoji = cfg ? cfg.emoji : '🔮';
            const posLabels = cfg ? cfg.positions.map(pl => pl.label) : [];

            // 状态
            let statusBadge, statusColor;
            if (p.checked && p.winResult) {
                statusBadge = '🎉 中奖(' + p.winResult.prizeLevel + ')';
                statusColor = '#f1c40f';
            } else if (p.checked) {
                statusBadge = '❌ 未中奖';
                statusColor = '#e74c3c';
            } else {
                statusBadge = '⏳ 等待开奖';
                statusColor = '#3498db';
            }

            // 开奖号码：已开奖的记录都有 drawNums（无论是否中奖），用于高亮和展示
            let drawNums = null;
            if (p.checked) {
                if (p.winResult && p.winResult.drawNums) {
                    drawNums = p.winResult.drawNums;
                } else {
                    // 已开奖但未中奖：从历史数据中查 targetPeriod 的开奖号
                    try {
                        const cfg = LOTTERY_TYPES.find(c => c.key === p.type);
                        if (cfg) {
                            const history = loadLotteryData(cfg);
                            const match = history.find(h => h.period === p.targetPeriod);
                            if (match) {
                                drawNums = cfg.positions.map(pos => pos.pick(match));
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            // 选号展示（含中奖高亮）
            let picksHtml = '';
            for (let i = 0; i < p.picks.length; i++) {
                picksHtml += '<span style="color:#aaa;font-size:11px;">' + (posLabels[i] || '') + '：</span>';
                for (const n of p.picks[i]) {
                    // 判断该号码是否在开奖号中（高亮显示，但不作为"中奖"）
                    let isHit = false;
                    if (drawNums) {
                        if (p.type === 'pl3' || p.type === 'pl5' || p.type === 'fc3d') {
                            isHit = (drawNums[i] === n);
                        } else {
                            isHit = drawNums.indexOf(n) !== -1;
                        }
                    }
                    if (isHit) {
                        picksHtml += '<span style="display:inline-block;min-width:22px;height:22px;line-height:20px;text-align:center;background:#f1c40f;color:#000;border-radius:50%;font-size:11px;margin:0 1px;font-weight:bold;border:2px solid #fff;box-shadow:0 0 8px rgba(241,196,15,0.8);">' + n + '</span>';
                    } else {
                        picksHtml += '<span style="display:inline-block;min-width:22px;height:22px;line-height:20px;text-align:center;background:#333;color:#fff;border-radius:50%;font-size:11px;margin:0 1px;font-weight:bold;">' + n + '</span>';
                    }
                }
                picksHtml += ' ';
            }

            // 开奖号码（放在最上面，醒目展示）
            let drawNumsHtml = '';
            if (drawNums) {
                drawNumsHtml = '<div style="margin:6px 0 10px 0;padding:8px 10px;background:rgba(241,196,15,0.12);border-left:3px solid #f1c40f;border-radius:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';
                drawNumsHtml += '<span style="color:#f1c40f;font-size:12px;font-weight:600;">🎯 开奖号码：</span>';
                for (let i = 0; i < drawNums.length; i++) {
                    const num = drawNums[i];
                    // 判断每位是否完全命中（用于附加标记）
                    let posHit = false;
                    if (p.type === 'pl3' || p.type === 'pl5' || p.type === 'fc3d') {
                        posHit = (p.picks[i] && p.picks[i].indexOf(num) !== -1);
                    } else {
                        posHit = true; // 复式不区分位
                    }
                    const lbl = posLabels[i] || '';
                    drawNumsHtml += '<span style="display:inline-flex;flex-direction:column;align-items:center;margin:0 2px;">';
                    if (lbl && (p.type === 'pl3' || p.type === 'pl5' || p.type === 'fc3d')) {
                        drawNumsHtml += '<span style="color:#888;font-size:9px;line-height:1;">' + lbl + '</span>';
                    }
                    drawNumsHtml += '<span style="display:inline-block;min-width:24px;height:24px;line-height:22px;text-align:center;background:' + (posHit ? '#f1c40f' : '#555') + ';color:' + (posHit ? '#000' : '#aaa') + ';border-radius:50%;font-size:12px;font-weight:bold;' + (posHit ? 'box-shadow:0 0 6px rgba(241,196,15,0.6);' : '') + '">' + num + '</span>';
                    drawNumsHtml += '</span>';
                }
                drawNumsHtml += '</div>';
            }

            // 未中奖的已开奖记录（drawNums 已显示），追加红色"未中奖"提示
            if (p.checked && !p.winResult && drawNumsHtml) {
                drawNumsHtml += '<div style="margin-top:6px;padding:6px 10px;background:rgba(231,76,60,0.08);border-left:3px solid #e74c3c;border-radius:4px;font-size:12px;color:#e74c3c;display:inline-block;">❌ 已开奖但未中奖</div>';
            }
            // 已 checked 但找不到开奖号（历史数据里没这条记录）
            if (p.checked && !drawNumsHtml) {
                drawNumsHtml = '<div style="margin:6px 0 10px 0;padding:8px 10px;background:rgba(231,76,60,0.08);border-left:3px solid #e74c3c;border-radius:4px;font-size:12px;color:#e74c3c;">❌ 已开奖但未中奖（未找到开奖号）</div>';
            }

            rows += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;">';
            rows += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
            rows += '<span style="font-size:15px;font-weight:600;">' + emoji + ' ' + p.typeName + ' · 目标期号 ' + p.targetPeriod + '</span>';
            rows += '<span style="background:' + statusColor + ';color:#fff;padding:2px 10px;border-radius:3px;font-size:11px;font-weight:600;">' + statusBadge + '</span>';
            rows += '</div>';
            rows += drawNumsHtml;
            rows += '<div style="margin-bottom:6px;">' + picksHtml + '</div>';
            rows += '<div style="color:#888;font-size:11px;">复式 ' + p.totalCombos + ' 注 · 基于 ' + p.basePeriod + ' 期 · 保存于 ' + new Date(p.savedAt).toLocaleString('zh-CN') + '</div>';
            rows += '<button class="copy-btn" style="margin-top:6px;font-size:11px;padding:2px 8px;" onclick="deletePrediction(' + p.id + ')">🗑️ 删除</button>';
            rows += '</div>';
        }
    }

    const winRate = checked.length > 0 ? (wins.length / checked.length * 100).toFixed(1) : '0.0';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>预测记录</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 8px; }
.stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.stat-card { padding: 10px 16px; background: rgba(255,255,255,0.05); border-radius: 6px; text-align: center; min-width: 100px; }
.stat-num { font-size: 24px; font-weight: bold; }
.stat-label { font-size: 11px; color: #888; margin-top: 2px; }
.stat-num.total { color: #8ec5ff; }
.stat-num.win { color: #f1c40f; }
.stat-num.pending { color: #3498db; }
.stat-num.rate { color: #2ecc71; }
.copy-btn { background: #0e639c; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.copy-btn:hover { background: #1177bb; }
</style>
</head>
<body>
<h2>🔮 预测记录</h2>
<div class="stats">
    <div class="stat-card"><div class="stat-num total">${total}</div><div class="stat-label">总预测</div></div>
    <div class="stat-card"><div class="stat-num win">${wins.length}</div><div class="stat-label">中奖</div></div>
    <div class="stat-card"><div class="stat-num pending">${pending.length}</div><div class="stat-label">等待开奖</div></div>
    <div class="stat-card"><div class="stat-num rate">${winRate}%</div><div class="stat-label">中奖率</div></div>
</div>
<div id="list">${rows}</div>
<div id="confirm-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;justify-content:center;align-items:center;">
    <div style="background:#2d2d2d;border:1px solid #555;border-radius:8px;padding:20px;max-width:360px;text-align:center;">
        <div style="color:#ddd;font-size:14px;margin-bottom:16px;">确认删除这条预测记录？</div>
        <div style="display:flex;gap:10px;justify-content:center;">
            <button id="confirm-yes" style="background:#e74c3c;color:#fff;border:none;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:13px;">确认删除</button>
            <button id="confirm-no" style="background:#555;color:#fff;border:none;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:13px;">取消</button>
        </div>
    </div>
</div>
<script>
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
let pendingDeleteId = null;
window.deletePrediction = function(id) {
    pendingDeleteId = id;
    var modal = document.getElementById('confirm-modal');
    if (modal) modal.style.display = 'flex';
};
document.addEventListener('DOMContentLoaded', function() {
    var btnYes = document.getElementById('confirm-yes');
    var btnNo = document.getElementById('confirm-no');
    var modal = document.getElementById('confirm-modal');
    if (btnYes) {
        btnYes.onclick = function() {
            if (pendingDeleteId !== null && vscode) {
                vscode.postMessage({ command: 'deletePrediction', id: pendingDeleteId });
            }
            if (modal) modal.style.display = 'none';
            pendingDeleteId = null;
        };
    }
    if (btnNo) {
        btnNo.onclick = function() {
            if (modal) modal.style.display = 'none';
            pendingDeleteId = null;
        };
    }
});
</script>
</body>
</html>`;
}

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
    html += '<button class="copy-btn" style="background:#2d7d46;margin-left:8px;" onclick="savePrediction()">💾 保存预测</button>';
    html += '<div id="saveResult" style="margin-top:8px;"></div>';
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

    // 保存预测：将当前每位选中号码发送给插件保存
    window.savePrediction = function() {
        const byPos = {};
        document.querySelectorAll('.pick-num.selected').forEach(el => {
            const p = el.dataset.pos;
            if (!byPos[p]) byPos[p] = [];
            byPos[p].push(parseInt(el.dataset.n));
        });
        const picks = [];
        for (let i = 0; i < posCount; i++) {
            picks.push((byPos[i] || []).sort((a, b) => a - b));
        }
        // 至少每位要有1个号码
        if (picks.some(p => p.length === 0)) {
            document.getElementById('saveResult').innerHTML = '<span style="color:#e74c3c;">⚠️ 每位至少选一个号码才能保存</span>';
            return;
        }
        // 计算总注数
        const totalCombos = picks.reduce((p, c) => p * c.length, 1);
        // 发送给插件
        const msg = {
            command: 'savePrediction',
            type: DATA.key,
            typeName: DATA.name,
            targetPeriod: latest.period,  // 目标期号 = 当前最新期号的下一期（实际上爬取后才能知道下一期号，这里保存"基于哪一期"）
            basePeriod: latest.period,
            picks: picks,
            totalCombos: totalCombos,
            note: '智能推荐 ' + DATA.name + ' (基于' + LIMIT_LABEL + ')'
        };
        // 通过 vscode.postMessage 发送
        if (typeof acquireVsCodeApi !== 'undefined') {
            const vscode = acquireVsCodeApi();
            vscode.postMessage(msg);
            document.getElementById('saveResult').innerHTML =
                '<span style="color:#2ecc71;">✅ 预测已保存！</span><br>' +
                '<span style="color:#888;font-size:11px;">目标期号：' + latest.period + ' 的下一期开奖后自动对比</span>';
        } else {
            document.getElementById('saveResult').innerHTML = '<span style="color:#e74c3c;">⚠️ 无法保存（Webview API 不可用）</span>';
        }
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

    // ===== 复式推荐（仅排三/排五/福彩3D）=====
    // 每位选2~5个号码：热号(TOP3)优先 → 温号(频率中等) → 冷号(频率最低)补足
    // 支持 2^N ~ 5^N 复式切换
    if (DATA.key === 'pl3' || DATA.key === 'pl5' || DATA.key === 'fc3d') {
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

/**
 * ============================================================
 *  概率统计智能推荐系统
 *  — 基于频次、遗漏、Z分数、卡方检验、分布模式的多维度分析
 * ============================================================
 */

/**
 * 核心分析引擎：计算所有统计量
 * @param {Array} history - 开奖历史数据
 * @param {Object} cfg - 彩种配置
 * @returns {Object} analysis
 */
function computeProbabilityAnalysis(history, cfg, compoundSpec) {
    const N = history.length;
    const posCount = cfg.positions.length;
    const latest = history[N - 1];

    // 提取每位号码序列
    const posSeries = [];
    for (let p = 0; p < posCount; p++) {
        posSeries.push(history.map(h => cfg.positions[p].pick(h)));
    }

    // ---- 1. 多窗口频次统计 ----
    const windows = [10, 30, 50, 100, N];
    const freqWindows = [];
    for (const w of windows) {
        if (w > N) continue;
        const start = N - w;
        const counts = [];
        for (let p = 0; p < posCount; p++) {
            const arr = new Array(10).fill(0);
            for (let i = start; i < N; i++) {
                arr[posSeries[p][i]]++;
            }
            counts.push(arr);
        }
        freqWindows.push({ window: w, counts: counts });
    }

    // ---- 2. 遗漏值分析（每位每个号码距今多少期未出现）----
    const missing = []; // missing[pos][num] = 遗漏期数
    for (let p = 0; p < posCount; p++) {
        const miss = new Array(10).fill(0);
        for (let n = 0; n <= 9; n++) {
            let found = false;
            for (let i = N - 1; i >= 0; i--) {
                if (posSeries[p][i] === n) {
                    miss[n] = N - 1 - i;
                    found = true;
                    break;
                }
            }
            if (!found) miss[n] = N; // 从未出现
        }
        missing.push(miss);
    }

    // ---- 3. 理论频率 & Z分数 ----
    const expectedFreq = N / 10; // 每个号码期望出现次数
    const allCounts = [];
    const zScores = [];
    for (let p = 0; p < posCount; p++) {
        const cnt = new Array(10).fill(0);
        for (let i = 0; i < N; i++) cnt[posSeries[p][i]]++;
        allCounts.push(cnt);
        const se = Math.sqrt(N * 0.1 * 0.9); // 二项分布标准差
        const z = cnt.map(c => (c - expectedFreq) / se);
        zScores.push(z);
    }

    // ---- 4. 冷热号分类（基于Z分数）----
    // Z > 1.0 → 热号, Z < -1.0 → 冷号, -1.0~1.0 → 温号
    const classification = [];
    for (let p = 0; p < posCount; p++) {
        const cls = new Array(10).fill('温');
        for (let n = 0; n <= 9; n++) {
            if (zScores[p][n] > 1.0) cls[n] = '热';
            else if (zScores[p][n] < -1.0) cls[n] = '冷';
        }
        classification.push(cls);
    }

    // ---- 5. 卡方拟合优度检验 ----
    const chiSquareResults = [];
    for (let p = 0; p < posCount; p++) {
        const observed = allCounts[p];
        const expected = new Array(10).fill(expectedFreq);
        let chi2 = 0;
        for (let n = 0; n <= 9; n++) {
            const e = expected[n] > 0 ? expected[n] : 1;
            chi2 += (observed[n] - e) ** 2 / e;
        }
        // 自由度 = 9，p值近似
        const dof = 9;
        const pValue = chiSquarePValue(chi2, dof);
        chiSquareResults.push({
            chi2: parseFloat(chi2.toFixed(3)),
            dof: dof,
            pValue: parseFloat(pValue.toFixed(4)),
            significant: pValue < 0.05 // 是否显著偏离均匀分布
        });
    }

    // ---- 6. 和值分布分析 ----
    // 计算所有期次的和值
    const sums = [];
    for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let p = 0; p < posCount; p++) sum += posSeries[p][i];
        sums.push(sum);
    }
    // 理论均值：每位期望4.5，posCount位
    const theoreticalMean = posCount * 4.5;
    const theoreticalStdDev = Math.sqrt(posCount * 8.25); // 每位方差 8.25
    const sumStats = {
        min: Math.min.apply(null, sums),
        max: Math.max.apply(null, sums),
        mean: parseFloat((sums.reduce((a, b) => a + b, 0) / N).toFixed(2)),
        theoreticalMean: theoreticalMean,
        theoreticalStdDev: parseFloat(theoreticalStdDev.toFixed(2)),
        recent: sums.slice(-10),  // 最近10期和值
        latest: sums[N - 1]
    };

    // ---- 7. 跨度分布（每位 max-min）----
    const spans = [];
    for (let i = 0; i < N; i++) {
        const vals = [];
        for (let p = 0; p < posCount; p++) vals.push(posSeries[p][i]);
        spans.push(Math.max.apply(null, vals) - Math.min.apply(null, vals));
    }
    const spanDist = new Array(10).fill(0);
    spans.forEach(s => { if (s >= 0 && s <= 9) spanDist[s]++; });

    // ---- 8. 奇偶比/大小比/012路 ----
    const patterns = [];
    for (let i = 0; i < N; i++) {
        let oddCnt = 0, bigCnt = 0;
        const routeCnt = [0, 0, 0]; // 0路/1路/2路
        for (let p = 0; p < posCount; p++) {
            const v = posSeries[p][i];
            if (v % 2 === 1) oddCnt++;
            if (v >= 5) bigCnt++;
            routeCnt[v % 3]++;
        }
        patterns.push({ odd: oddCnt, even: posCount - oddCnt, big: bigCnt, small: posCount - bigCnt, route012: routeCnt });
    }

    // 各种模式频次统计
    const patternStats = { oddEven: {}, bigSmall: {}, route: {} };
    patterns.forEach(pt => {
        const oeKey = pt.odd + ':' + pt.even;
        patternStats.oddEven[oeKey] = (patternStats.oddEven[oeKey] || 0) + 1;
        const bsKey = pt.big + ':' + pt.small;
        patternStats.bigSmall[bsKey] = (patternStats.bigSmall[bsKey] || 0) + 1;
        const rtKey = pt.route012.join(':');
        patternStats.route[rtKey] = (patternStats.route[rtKey] || 0) + 1;
    });
    const latestPattern = patterns[N - 1];

    // ---- 9. 综合智能评分 ----
    // 权重：近期频次 30%、遗漏调整 25%、Z分数 20%、趋势动量 15%、模式分布 10%
    const scores = [];
    for (let p = 0; p < posCount; p++) {
        const posScores = [];
        const recentCounts = freqWindows[0] ? freqWindows[0].counts[p] : allCounts[p]; // 最近10期

        // 归一化因子
        const maxFreq = Math.max.apply(null, recentCounts);
        const maxMiss = Math.max.apply(null, missing[p]);

        for (let n = 0; n <= 9; n++) {
            // (a) 近期频次分数 (30%)
            const freqScore = maxFreq > 0 ? (recentCounts[n] / maxFreq) * 0.30 : 0;

            // (b) 遗漏调整分数 (25%)：遗漏越大越有"回归"可能
            // 使用泊松回归概率模型：P(至少出现1次) = 1 - e^(-λ)
            const lambda = allCounts[p][n] / N; // 历史出现率
            const missAdj = maxMiss > 0 ? 1 - Math.exp(-lambda * missing[p][n]) : 0;
            const missScore = missAdj * 0.25;

            // (c) Z分数 (20%)：修正偏差
            const zAdj = Math.max(-2, Math.min(2, zScores[p][n]));
            const zScoreNorm = ((zAdj + 2) / 4) * 0.20; // 归一化到[0, 0.20]

            // (d) 趋势动量 (15%)：最近5期是否有升温趋势
            const recent5 = posSeries[p].slice(-5);
            let momentum = 0;
            for (let i = 0; i < recent5.length; i++) {
                if (recent5[i] === n) momentum += (i + 1) / 5; // 越近期权重越大
            }
            const momentumScore = Math.min(momentum / 3, 1) * 0.15;

            // (e) 模式分布 (10%)：基于号码属性调整
            // 如果已经连续多期奇数/偶数/大数/小数占主导，则反方向号码加分
            const isOdd = n % 2 === 1;
            const isBig = n >= 5;
            const recent10Patterns = patterns.slice(-10);
            let oddDom = 0, bigDom = 0;
            recent10Patterns.forEach(pt => {
                if (pt.odd >= posCount / 2) oddDom++;
                if (pt.big >= posCount / 2) bigDom++;
            });
            // 如果奇数主导过多，偶数加分
            let patternAdj = 0.05;
            if (oddDom >= 7 && !isOdd) patternAdj = 0.10;
            if (bigDom >= 7 && !isBig) patternAdj = 0.10;
            if (oddDom >= 7 && !isOdd && bigDom >= 7 && !isBig) patternAdj = 0.10; // 两者都偏离

            const totalScore = freqScore + missScore + zScoreNorm + momentumScore + patternAdj;
            posScores.push({ num: n, score: parseFloat(totalScore.toFixed(4)), detail: { freqScore, missScore, zScoreNorm, momentumScore, patternAdj } });
        }
        posScores.sort((a, b) => b.score - a.score);
        scores.push(posScores);
    }

    // ---- 10. 智能推荐组合 ----
    // 从每位取TOP4，筛选合理组合
    const topPerPos = scores.map(s => s.slice(0, 4).map(x => x.num));
    const totalCombos = topPerPos.reduce((a, b) => a * b.length, 1);

    // 生成推荐组合（每位独立排列，从scores中取TOP组合）
    function generateCombos(tops, maxCombos) {
        const result = [];
        function backtrack(depth, current) {
            if (result.length >= maxCombos) return;
            if (depth === tops.length) {
                result.push([...current]);
                return;
            }
            for (const n of tops[depth]) {
                current.push(n);
                backtrack(depth + 1, current);
                current.pop();
            }
        }
        backtrack(0, []);
        return result;
    }

    const topCombos = generateCombos(topPerPos, Math.min(totalCombos, 64));

    // 对组合按概率评分排序
    const scoredCombos = topCombos.map(combo => {
        let totalScore = 0;
        for (let p = 0; p < posCount; p++) {
            const numScore = scores[p].find(s => s.num === combo[p]);
            totalScore += numScore ? numScore.score : 0;
        }
        return { combo: combo, score: parseFloat(totalScore.toFixed(4)) };
    });
    scoredCombos.sort((a, b) => b.score - a.score);

    // 选出最佳单式TOP8
    const bestSingles = scoredCombos.slice(0, 8);

    // ---- 11. 复式推荐（混合模式：每位基于评分阈值独立取 2~5 个号码）----
    // 策略：每位先按评分降序，使用"评分落差阈值"动态决定每位选号数（2~5）。
    //   - 计算相邻号码评分差：score[i] - score[i+1]
    //   - 找到第一个显著落差（差 > 平均落差的 1.5 倍）作为切点，切点前都入选
    //   - 限制每位 [2, 5]，总注数 ≤ 5^posCount
    // 这样高分离度号码会多选，相近号码会少选，避免一刀切
    function selectCompoundPerPos(posScoreList, minK, maxK) {
        const sorted = posScoreList.slice(0, maxK); // 候选最多 maxK 个
        if (sorted.length <= minK) return sorted.map(s => s.num);

        // 评分落差数组
        const drops = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            drops.push(sorted[i].score - sorted[i + 1].score);
        }
        const avgDrop = drops.reduce((a, b) => a + b, 0) / drops.length;
        const threshold = avgDrop * 1.5;

        // 找第一个显著落差
        let cutIdx = sorted.length; // 默认全选
        for (let i = 0; i < drops.length; i++) {
            if (drops[i] > threshold && (i + 1) >= minK) {
                cutIdx = i + 1;
                break;
            }
        }
        // 保证至少 minK 个
        if (cutIdx < minK) cutIdx = minK;
        return sorted.slice(0, cutIdx).map(s => s.num);
    }

    const compoundPerPos = scores.map((s, p) => {
        // 若指定了复式规格（每位的固定 k 或自定义数组），则按规格取前 k 个
        if (compoundSpec) {
            // compoundSpec 可以是数字（每位统一取 k 个）或数组（每位独立 k）
            const k = Array.isArray(compoundSpec) ? (compoundSpec[p] || 2) : compoundSpec;
            return s.slice(0, Math.max(2, Math.min(5, k))).map(x => x.num);
        }
        // 自动模式：基于评分落差阈值
        return selectCompoundPerPos(s, 2, 5);
    });
    const compoundTotalCombos = compoundPerPos.reduce((a, b) => a * b.length, 1);
    // 复式总分 = 该位所有入选号码评分之和 / 入选数 （归一化便于对比）
    const compoundScore = compoundPerPos.reduce((sum, picks, p) => {
        const s = picks.reduce((acc, n) => acc + (scores[p].find(x => x.num === n)?.score || 0), 0);
        return sum + s / picks.length;
    }, 0);
    // 复式覆盖号码集（每位）
    const compoundSets = compoundPerPos.map(picks => picks.slice().sort((a, b) => a - b));

    return {
        cfgName: cfg.name,
        cfgEmoji: cfg.emoji,
        cfgKey: cfg.key,
        posLabels: cfg.positions.map(p => p.label),
        posCount: posCount,
        N: N,
        latestPeriod: latest.period,
        latestDate: latest.date,
        latestNums: posSeries.map(s => s[N - 1]),
        freqWindows: freqWindows,
        missing: missing,
        allCounts: allCounts,
        zScores: zScores,
        classification: classification,
        chiSquareResults: chiSquareResults,
        sumStats: sumStats,
        spanDist: spanDist,
        spans: spans.slice(-20),
        patternStats: patternStats,
        latestPattern: latestPattern,
        scores: scores,
        topPerPos: topPerPos,
        totalCombos: totalCombos,
        bestSingles: bestSingles,
        compoundPerPos: compoundPerPos,
        compoundTotalCombos: compoundTotalCombos,
        compoundScore: parseFloat(compoundScore.toFixed(4)),
        compoundSets: compoundSets
    };
}

/**
 * 卡方检验 P 值近似
 */
function chiSquarePValue(chi2, dof) {
    // Wilson-Hilferty 变换近似
    if (dof <= 0) return 1;
    const x = Math.pow(chi2 / dof, 1 / 3);
    const z = (x - (1 - 2 / (9 * dof))) / Math.sqrt(2 / (9 * dof));
    // 标准正态累积分布函数近似
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429;
    const p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    const xAbs = Math.abs(z) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * xAbs);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xAbs * xAbs);
    return sign > 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * 概率推荐算法 — 历史回测
 * @param {Array} history 完整历史（按时间正序，旧→新）
 * @param {Object} cfg 彩种配置
 * @param {Object} options { trainSize, step, topK, hitMode }
 *   - trainSize: 训练样本期数（默认200）
 *   - step:      每隔多少期做一次预测（默认10，避免每次都跑）
 *   - topK:      取推荐组合前K注用于命中判定（默认8）
 *   - hitMode:   'exact' 严格位置命中 | 'any' 包含命中（默认 exact）
 * @returns {Object} 回测统计结果
 */
function backtestProbabilityAnalysis(history, cfg, options) {
    const opts = Object.assign({ trainSize: 200, step: 10, topK: 8, hitMode: 'exact' }, options || {});
    const N = history.length;
    const posCount = cfg.positions.length;
    const minTrain = 50; // 训练样本下限
    const results = []; // 每次预测的详细记录

    // 从 trainSize 期开始，每次向前推进 step 期，预测下期
    for (let i = Math.max(minTrain, opts.trainSize); i < N; i += opts.step) {
        const train = history.slice(0, i);     // 训练集 [0..i-1]
        const target = history[i];              // 待预测目标期

        // 用训练集做概率分析（避免数据泄露：不使用 target 及之后的数据）
        let analysis;
        try {
            analysis = computeProbabilityAnalysis(train, cfg);
        } catch (e) {
            continue; // 训练数据异常则跳过
        }
        if (!analysis.bestSingles || analysis.bestSingles.length === 0) continue;

        // 取 TOP-K 推荐组合
        const picks = analysis.bestSingles.slice(0, opts.topK).map(s => s.combo);

        // 目标号码
        const targetNums = cfg.positions.map(p => p.pick(target));

        // 命中判定
        let hitExact = false;   // 严格位置命中：存在一注组合与目标完全相同（按位）
        let hitAny = false;     // 包含命中：存在一注组合的所有号码集合 ⊆ 目标号码集合（多注可中）
        let hitPositions = new Array(posCount).fill(false); // 各位是否被任意推荐命中
        let maxHitPos = 0;      // 单注最大命中位数

        for (const combo of picks) {
            let posHitCnt = 0;
            for (let p = 0; p < posCount; p++) {
                if (combo[p] === targetNums[p]) {
                    posHitCnt++;
                    hitPositions[p] = true;
                }
            }
            if (posHitCnt === posCount) hitExact = true;
            if (posHitCnt > maxHitPos) maxHitPos = posHitCnt;
            // 包含命中：组合的所有号码都在目标号码集合中
            const targetSet = targetNums.slice().sort();
            const comboSet = combo.slice().sort();
            if (comboSet.every((v, idx) => v === targetSet[idx])) hitAny = true;
        }

        // 复式命中判定（全位覆盖）：目标号码的每一位都落在复式该位的选号集合内
        let compoundHit = false;
        let compoundPosHit = new Array(posCount).fill(false);
        const compoundPerPos = analysis.compoundPerPos;
        if (compoundPerPos) {
            compoundHit = true;
            for (let p = 0; p < posCount; p++) {
                if (compoundPerPos[p].indexOf(targetNums[p]) >= 0) {
                    compoundPosHit[p] = true;
                } else {
                    compoundHit = false;
                }
            }
        }
        const compoundMissCount = compoundPosHit.filter(h => !h).length;

        results.push({
            targetPeriod: target.period,
            targetDate: target.date,
            targetNums: targetNums,
            picks: picks,
            hitExact: hitExact,
            hitAny: hitAny,
            maxHitPos: maxHitPos,
            hitPositions: hitPositions,
            compoundPerPos: compoundPerPos,
            compoundHit: compoundHit,
            compoundPosHit: compoundPosHit,
            compoundMissCount: compoundMissCount,
            compoundTotalCombos: analysis.compoundTotalCombos,
            trainSize: train.length
        });
    }

    // 汇总统计
    const totalTests = results.length;
    const exactHits = results.filter(r => r.hitExact).length;
    const anyHits = results.filter(r => r.hitAny).length;
    // 命中位数分布（单注最大命中位数）
    const hitPosDist = new Array(posCount + 1).fill(0);
    results.forEach(r => { hitPosDist[r.maxHitPos]++; });
    // 各位命中频次
    const posHitFreq = new Array(posCount).fill(0);
    results.forEach(r => { r.hitPositions.forEach((h, p) => { if (h) posHitFreq[p]++; }); });

    // 理论基准（随机猜测期望命中率）
    // 严格命中：每注独立均匀分布概率 (1/10)^posCount
    // 取 topK 注，期望至少命中 = 1 - (1 - p)^K
    const pExactSingle = Math.pow(0.1, posCount);
    const expectedExactRate = 1 - Math.pow(1 - pExactSingle, opts.topK);
    // 至少命中 posCount-1 位 的概率
    const pNMinus1Single = posCount * Math.pow(0.1, posCount - 1) * 0.9; // C(N, N-1) * p^(N-1) * (1-p)
    const expectedNMinus1Rate = 1 - Math.pow(1 - pNMinus1Single, opts.topK);

    // 复式命中统计
    const compoundHits = results.filter(r => r.compoundHit).length;
    // 复式缺位分布：缺0位=全中，缺1位=差1位...
    const compoundMissDist = new Array(posCount + 1).fill(0);
    results.forEach(r => { if (r.compoundMissCount !== undefined) compoundMissDist[r.compoundMissCount]++; });
    // 复式各位置命中频次
    const compoundPosHitFreq = new Array(posCount).fill(0);
    results.forEach(r => { if (r.compoundPosHit) r.compoundPosHit.forEach((h, p) => { if (h) compoundPosHitFreq[p]++; }); });
    // 平均复式注数
    const avgCompoundCombos = totalTests > 0
        ? results.reduce((s, r) => s + (r.compoundTotalCombos || 0), 0) / totalTests
        : 0;
    // 复式理论基准：每注严格命中概率 (k_p/10)，复式整体命中率 = Π (k_p/10)
    // 由于每位 k 动态变化，取平均每位选号数近似
    const avgKPerPos = totalTests > 0
        ? results.reduce((acc, r) => {
            if (r.compoundPerPos) r.compoundPerPos.forEach((picks, pi) => { acc[pi] = (acc[pi] || 0) + picks.length; });
            return acc;
        }, new Array(posCount).fill(0)).map(v => v / totalTests)
        : new Array(posCount).fill(2);
    const expectedCompoundRate = avgKPerPos.reduce((p, k) => p * (k / 10), 1);

    return {
        cfgName: cfg.name,
        cfgEmoji: cfg.emoji,
        cfgKey: cfg.key,
        posCount: posCount,
        posLabels: cfg.positions.map(p => p.label),
        options: opts,
        totalTests: totalTests,
        exactHits: exactHits,
        anyHits: anyHits,
        exactHitRate: totalTests > 0 ? parseFloat((exactHits / totalTests * 100).toFixed(2)) : 0,
        anyHitRate: totalTests > 0 ? parseFloat((anyHits / totalTests * 100).toFixed(2)) : 0,
        hitPosDist: hitPosDist,
        posHitFreq: posHitFreq,
        posHitRate: posHitFreq.map(v => totalTests > 0 ? parseFloat((v / totalTests * 100).toFixed(2)) : 0),
        expectedExactRate: parseFloat((expectedExactRate * 100).toFixed(4)),
        expectedNMinus1Rate: parseFloat((expectedNMinus1Rate * 100).toFixed(4)),
        compoundHits: compoundHits,
        compoundHitRate: totalTests > 0 ? parseFloat((compoundHits / totalTests * 100).toFixed(2)) : 0,
        compoundMissDist: compoundMissDist,
        compoundPosHitFreq: compoundPosHitFreq,
        compoundPosHitRate: compoundPosHitFreq.map(v => totalTests > 0 ? parseFloat((v / totalTests * 100).toFixed(2)) : 0),
        avgCompoundCombos: parseFloat(avgCompoundCombos.toFixed(1)),
        expectedCompoundRate: parseFloat((expectedCompoundRate * 100).toFixed(4)),
        avgKPerPos: avgKPerPos.map(k => parseFloat(k.toFixed(2))),
        // 取最近30条用于明细展示
        recentResults: results.slice(-30).reverse()
    };
}

/**
 * 生成概率推荐回测结果 HTML
 */
function getBacktestHtml(bt) {
    const dataJson = JSON.stringify(bt);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>概率推荐回测 - ${bt.cfgName}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1b1b2f; color: #e0e0e0; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; line-height: 1.5; }
.header { background: linear-gradient(135deg, #16213e, #0f3460); padding: 20px; border-radius: 12px; margin-bottom: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.1); }
.header h1 { font-size: 22px; color: #e94560; margin-bottom: 6px; }
.header .sub { color: #a0a0b0; font-size: 13px; }
.section { margin-bottom: 18px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; }
.section-title { background: rgba(255,255,255,0.05); padding: 10px 16px; font-size: 14px; font-weight: 600; color: #feca57; border-bottom: 1px solid rgba(255,255,255,0.06); }
.section-body { padding: 14px 16px; }
.stats-row { display: flex; gap: 14px; flex-wrap: wrap; }
.stat-card { flex: 1; min-width: 130px; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 14px; text-align: center; border: 1px solid rgba(255,255,255,0.06); }
.stat-card .val { font-size: 24px; font-weight: bold; }
.stat-card .lbl { font-size: 11px; color: #888; margin-top: 4px; }
.stat-card.hit .val { color: #2ecc71; }
.stat-card.miss .val { color: #e94560; }
.stat-card.bench .val { color: #8ec5ff; }
.stat-card.warn .val { color: #feca57; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid rgba(255,255,255,0.1); padding: 6px 8px; text-align: center; }
th { background: rgba(255,255,255,0.06); color: #8ec5ff; font-weight: 600; }
.ball { display: inline-block; width: 22px; height: 22px; line-height: 22px; border-radius: 50%; text-align: center; font-weight: bold; font-size: 12px; color: #fff; margin: 0 1px; }
.ball.red { background: #e94560; }
.ball.blue { background: #0984e3; }
.ball.green { background: #27ae60; }
.ball.purple { background: #8e44ad; }
.ball.orange { background: #f39c12; }
.ball.gray { background: #555; }
.tag-hit { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; background: rgba(46,204,113,0.2); color: #2ecc71; }
.tag-miss { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; background: rgba(233,69,96,0.15); color: #e94560; }
.tag-partial { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; background: rgba(254,202,87,0.2); color: #feca57; }
.info-box { background: rgba(52,152,219,0.1); border: 1px solid rgba(52,152,219,0.3); padding: 10px 14px; border-radius: 6px; color: #3498db; font-size: 12px; margin: 8px 0; }
.warn-box { background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.3); padding: 10px 14px; border-radius: 6px; color: #e74c3c; font-size: 12px; margin: 8px 0; }
.success-box { background: rgba(46,204,113,0.1); border: 1px solid rgba(46,204,113,0.3); padding: 10px 14px; border-radius: 6px; color: #2ecc71; font-size: 12px; margin: 8px 0; }
.bar-wrap { height: 18px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow: hidden; position: relative; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s; }
.picks-cell { font-size: 11px; color: #aaa; max-width: 320px; word-break: break-all; }
</style>
</head>
<body>
<div class="header">
    <h1>🧪 ${bt.cfgEmoji} ${bt.cfgName} — 概率推荐历史回测</h1>
    <div class="sub">训练样本：${bt.options.trainSize} 期 | 步长：${bt.options.step} 期/次 | 推荐注数：TOP ${bt.options.topK} | 命中模式：${bt.options.hitMode === 'exact' ? '严格位置' : '包含'}</div>
    <div class="sub" style="margin-top:6px;">共 ${bt.totalTests} 次独立预测</div>
</div>

<div class="section">
    <div class="section-title">📊 总体命中率 vs 随机基准</div>
    <div class="section-body">
        <div class="stats-row">
            <div class="stat-card hit"><div class="val">${bt.exactHitRate}%</div><div class="lbl">严格命中（${bt.exactHits}/${bt.totalTests}）</div></div>
            <div class="stat-card warn"><div class="val">${bt.anyHitRate}%</div><div class="lbl">包含命中（${bt.anyHits}/${bt.totalTests}）</div></div>
            <div class="stat-card bench"><div class="val">${bt.expectedExactRate}%</div><div class="lbl">随机严格基准</div></div>
            <div class="stat-card bench"><div class="val">${bt.expectedNMinus1Rate}%</div><div class="lbl">随机(N-1位)基准</div></div>
        </div>
        <div id="verdict-box"></div>
    </div>
</div>

<div class="section">
    <div class="section-title">🎯 命中位数分布（单注最大命中位数）</div>
    <div class="section-body">
        <div id="hitpos-dist"></div>
    </div>
</div>

<div class="section">
    <div class="section-title">📍 各位置被任意推荐命中频次</div>
    <div class="section-body">
        <div id="pos-hit"></div>
    </div>
</div>

<div class="section" style="border-color: rgba(142,197,255,0.4);">
    <div class="section-title" style="color:#8ec5ff;">🎰 复式推荐命中率（全位覆盖）</div>
    <div class="section-body">
        <div class="stats-row" style="margin-bottom:14px;">
            <div class="stat-card hit"><div class="val">${bt.compoundHitRate}%</div><div class="lbl">复式命中（${bt.compoundHits}/${bt.totalTests}）</div></div>
            <div class="stat-card bench"><div class="val">${bt.expectedCompoundRate}%</div><div class="lbl">随机复式基准</div></div>
            <div class="stat-card warn"><div class="val">${bt.avgCompoundCombos}</div><div class="lbl">平均复式注数</div></div>
        </div>
        <div id="compound-verdict"></div>
        <div style="margin-top:14px;">
            <div style="font-size:13px;color:#feca57;margin-bottom:8px;">缺位分布（缺0位=全中）</div>
            <div id="compound-miss-dist"></div>
        </div>
        <div style="margin-top:14px;">
            <div style="font-size:13px;color:#feca57;margin-bottom:8px;">复式各位置命中频次</div>
            <div id="compound-pos-hit"></div>
        </div>
        <div class="info-box" style="margin-top:10px;">复式判定：目标号码的<b>每一位</b>都落在复式该位的选号集合内才算命中（全位覆盖）。随机基准 = Π(k_p/10)，其中 k_p 为第p位平均选号数。</div>
    </div>
</div>

<div class="section">
    <div class="section-title">📝 最近 ${bt.recentResults.length} 次预测明细</div>
    <div class="section-body" style="overflow-x:auto;">
        <table>
            <thead><tr><th>目标期号</th><th>开奖号码</th><th>TOP${bt.options.topK} 推荐</th><th>单注最大命中</th><th>复式方案</th><th>复式缺位</th><th>复式命中</th></tr></thead>
            <tbody id="detail-body"></tbody>
        </table>
    </div>
</div>

<div class="warn-box">
    ⚠️ <b>统计学解读：</b>彩票开奖是独立同分布的均匀随机事件，理论期望命中率应接近"随机基准"。若实测命中率显著高于基准，可能是样本量不足导致的偶然现象；若接近或低于基准，则说明算法在长期统计上无超额预测能力。请理性看待回测结果。
</div>

<script>
const BT = ${dataJson};
const COLORS = ['red','blue','green','purple','orange'];

// 1. 总体判定
(function() {
    const box = document.getElementById('verdict-box');
    const diff = BT.exactHitRate - BT.expectedExactRate;
    let html = '';
    if (BT.totalTests < 20) {
        html = '<div class="warn-box" style="margin-top:10px;">⚠️ 样本量过少（${bt.totalTests} < 20），统计意义有限，建议增加历史数据或缩小步长。</div>';
    } else if (diff > 0.5) {
        html = '<div class="success-box" style="margin-top:10px;">✅ 实测命中率 ' + BT.exactHitRate + '% 高于随机基准 ' + BT.expectedExactRate + '%（差值 +' + diff.toFixed(2) + '%）。但请注意：这可能源于小样本偶然性，不构成"算法有效"的充分证据。</div>';
    } else if (diff < -0.3) {
        html = '<div class="warn-box" style="margin-top:10px;">⚠️ 实测命中率 ' + BT.exactHitRate + '% 低于随机基准 ' + BT.expectedExactRate + '%（差值 ' + diff.toFixed(2) + '%），算法在该数据集上无超额预测能力。</div>';
    } else {
        html = '<div class="info-box" style="margin-top:10px;">ℹ️ 实测命中率 ' + BT.exactHitRate + '% 与随机基准 ' + BT.expectedExactRate + '% 接近（差值 ' + diff.toFixed(2) + '%），符合"独立均匀分布"零假设，算法无统计显著的预测优势。</div>';
    }
    box.innerHTML = html;
})();

// 2. 命中位数分布
(function() {
    const dist = BT.hitPosDist;
    const maxV = Math.max.apply(null, dist);
    let html = '<div style="display:flex;gap:10px;align-items:flex-end;height:140px;padding:10px 0;">';
    for (let i = 0; i < dist.length; i++) {
        const v = dist[i];
        const h = maxV > 0 ? (v / maxV * 100) : 0;
        const pct = BT.totalTests > 0 ? (v / BT.totalTests * 100).toFixed(1) : '0.0';
        const color = i === BT.posCount ? '#2ecc71' : (i >= BT.posCount - 1 ? '#feca57' : '#8ec5ff');
        html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;">';
        html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + v + ' (' + pct + '%)</div>';
        html += '<div style="width:60%;height:' + h + '%;background:' + color + ';border-radius:3px 3px 0 0;min-height:2px;"></div>';
        html += '<div style="font-size:12px;color:#ddd;margin-top:6px;">命中 ' + i + ' 位</div>';
        html += '</div>';
    }
    html += '</div>';
    html += '<div class="info-box" style="margin-top:8px;">"命中 N 位"表示在 TOP' + BT.options.topK + ' 推荐中，单注最大命中位数。' + BT.posCount + ' 位全中即严格命中。</div>';
    document.getElementById('hitpos-dist').innerHTML = html;
})();

// 3. 各位置命中频次
(function() {
    let html = '<div style="display:flex;gap:14px;flex-wrap:wrap;">';
    for (let p = 0; p < BT.posCount; p++) {
        const rate = BT.posHitRate[p];
        const color = COLORS[p % COLORS.length];
        html += '<div style="flex:1;min-width:140px;background:rgba(255,255,255,0.04);border-radius:8px;padding:12px;text-align:center;">';
        html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + BT.posLabels[p] + '位</div>';
        html += '<div style="font-size:22px;font-weight:bold;color:#' + (p===0?'e94560':p===1?'0984e3':p===2?'27ae60':p===3?'8e44ad':'f39c12') + ';">' + rate + '%</div>';
        html += '<div style="font-size:10px;color:#888;margin-top:2px;">' + BT.posHitFreq[p] + '/' + BT.totalTests + ' 次</div>';
        html += '<div class="bar-wrap" style="margin-top:6px;"><div class="bar-fill" style="width:' + rate + '%;background:#' + (p===0?'e94560':p===1?'0984e3':p===2?'27ae60':p===3?'8e44ad':'f39c12') + ';"></div></div>';
        html += '</div>';
    }
    html += '</div>';
    html += '<div class="info-box" style="margin-top:8px;">随机基准：每位 10%（每注推荐 ' + BT.options.topK + ' 个号码，期望覆盖率 ' + (BT.options.topK * 10) + '%，上限100%）</div>';
    document.getElementById('pos-hit').innerHTML = html;
})();

// 3.5 复式判定 + 缺位分布 + 各位置命中
(function() {
    // 判定
    const vBox = document.getElementById('compound-verdict');
    const diff = BT.compoundHitRate - BT.expectedCompoundRate;
    let vh = '';
    if (BT.totalTests < 20) {
        vh = '<div class="warn-box" style="margin-top:6px;">⚠️ 样本量过少，复式统计意义有限。</div>';
    } else if (diff > 1) {
        vh = '<div class="success-box" style="margin-top:6px;">✅ 复式实测 ' + BT.compoundHitRate + '% 高于随机基准 ' + BT.expectedCompoundRate + '%（+' + diff.toFixed(2) + '%）。注意小样本偶然性。</div>';
    } else if (diff < -1) {
        vh = '<div class="warn-box" style="margin-top:6px;">⚠️ 复式实测 ' + BT.compoundHitRate + '% 低于随机基准 ' + BT.expectedCompoundRate + '%（' + diff.toFixed(2) + '%），无超额能力。</div>';
    } else {
        vh = '<div class="info-box" style="margin-top:6px;">ℹ️ 复式实测 ' + BT.compoundHitRate + '% 与随机基准 ' + BT.expectedCompoundRate + '% 接近（差 ' + diff.toFixed(2) + '%），符合独立均匀分布假设。</div>';
    }
    vBox.innerHTML = vh;

    // 缺位分布柱状图
    const dist = BT.compoundMissDist;
    const maxV = Math.max.apply(null, dist);
    let dh = '<div style="display:flex;gap:10px;align-items:flex-end;height:120px;padding:8px 0;">';
    for (let i = 0; i < dist.length; i++) {
        const v = dist[i];
        const h = maxV > 0 ? (v / maxV * 100) : 0;
        const pct = BT.totalTests > 0 ? (v / BT.totalTests * 100).toFixed(1) : '0.0';
        const color = i === 0 ? '#2ecc71' : (i === 1 ? '#feca57' : '#8ec5ff');
        dh += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;">';
        dh += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + v + ' (' + pct + '%)</div>';
        dh += '<div style="width:60%;height:' + h + '%;background:' + color + ';border-radius:3px 3px 0 0;min-height:2px;"></div>';
        dh += '<div style="font-size:12px;color:#ddd;margin-top:4px;">缺 ' + i + ' 位</div>';
        dh += '</div>';
    }
    dh += '</div>';
    document.getElementById('compound-miss-dist').innerHTML = dh;

    // 复式各位置命中频次
    let ph = '<div style="display:flex;gap:14px;flex-wrap:wrap;">';
    for (let p = 0; p < BT.posCount; p++) {
        const rate = BT.compoundPosHitRate[p];
        const avgK = BT.avgKPerPos[p];
        const expectedRate = (avgK * 10).toFixed(1);
        ph += '<div style="flex:1;min-width:140px;background:rgba(255,255,255,0.04);border-radius:8px;padding:12px;text-align:center;border-left:3px solid #' + (p===0?'e94560':p===1?'0984e3':p===2?'27ae60':p===3?'8e44ad':'f39c12') + ';">';
        ph += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + BT.posLabels[p] + '位 (平均选 ' + avgK + ' 个)</div>';
        ph += '<div style="font-size:22px;font-weight:bold;color:#' + (p===0?'e94560':p===1?'0984e3':p===2?'27ae60':p===3?'8e44ad':'f39c12') + ';">' + rate + '%</div>';
        ph += '<div style="font-size:10px;color:#888;margin-top:2px;">' + BT.compoundPosHitFreq[p] + '/' + BT.totalTests + ' 次 | 基准 ' + expectedRate + '%</div>';
        ph += '<div class="bar-wrap" style="margin-top:6px;"><div class="bar-fill" style="width:' + rate + '%;background:#' + (p===0?'e94560':p===1?'0984e3':p===2?'27ae60':p===3?'8e44ad':'f39c12') + ';"></div></div>';
        ph += '</div>';
    }
    ph += '</div>';
    document.getElementById('compound-pos-hit').innerHTML = ph;
})();

// 4. 明细表
(function() {
    let html = '';
    BT.recentResults.forEach(r => {
        const balls = r.targetNums.map((n, i) => '<span class="ball ' + COLORS[i % COLORS.length] + '">' + n + '</span>').join('');
        const picksStr = r.picks.map(c => c.join('')).join(' | ');
        const maxPosTag = r.maxHitPos === BT.posCount
            ? '<span class="tag-hit">' + r.maxHitPos + '/' + BT.posCount + '</span>'
            : (r.maxHitPos >= BT.posCount - 1 ? '<span class="tag-partial">' + r.maxHitPos + '/' + BT.posCount + '</span>' : '<span class="tag-miss">' + r.maxHitPos + '/' + BT.posCount + '</span>');
        // 复式方案展示
        const compoundStr = r.compoundPerPos ? r.compoundPerPos.map((picks, p) => picks.slice().sort((a,b)=>a-b).join('')).join('|') : '-';
        const compoundMissTag = r.compoundMissCount === 0
            ? '<span class="tag-hit">缺0</span>'
            : (r.compoundMissCount === 1 ? '<span class="tag-partial">缺1</span>' : '<span class="tag-miss">缺' + r.compoundMissCount + '</span>');
        const compoundHitTag = r.compoundHit ? '<span class="tag-hit">✓ 命中</span>' : '<span class="tag-miss">✗</span>';
        html += '<tr>' +
            '<td>' + r.targetPeriod + '<br><span style="color:#666;font-size:10px;">' + r.targetDate + '</span></td>' +
            '<td>' + balls + '</td>' +
            '<td class="picks-cell">' + picksStr + '</td>' +
            '<td>' + maxPosTag + '</td>' +
            '<td class="picks-cell">' + compoundStr + ' <span style="color:#666;font-size:10px;">(' + r.compoundTotalCombos + '注)</span></td>' +
            '<td>' + compoundMissTag + '</td>' +
            '<td>' + compoundHitTag + '</td>' +
            '</tr>';
    });
    document.getElementById('detail-body').innerHTML = html;
})();
</script>
</body>
</html>`;
}

/**
 * 012路趋势+奇偶比深度分析 - 核心计算
 */
function computeRoadAnalysis(history, cfg) {
    const posCount = cfg.positions.length; // 3或5
    const posNames = cfg.positions.map(p => p.label.replace('位', '')); // ['百','十','个'] 或 ['万','千','百','十','个']
    
    function getRoad(n) { return n % 3; }
    function isOdd(n) { return n % 2 === 1; }
    const roadNums = { 0: '0,3,6,9', 1: '1,4,7', 2: '2,5,8' };
    const theoryPct = { 0: 40, 1: 30, 2: 30 };
    const N = history.length;

    // ========== 1. 基础统计 ==========
    const roadStats = [];
    for (let p = 0; p < posCount; p++) {
        roadStats[p] = {};
        for (let r = 0; r <= 2; r++) {
            roadStats[p][r] = { total: 0, odd: 0, even: 0 };
        }
    }

    for (let i = 0; i < N; i++) {
        for (let p = 0; p < posCount; p++) {
            const num = history[i].num[p];
            const road = getRoad(num);
            roadStats[p][road].total++;
            if (isOdd(num)) roadStats[p][road].odd++;
            else roadStats[p][road].even++;
        }
    }

    // ========== 2. 分段趋势 ==========
    const segments = [
        { name: '近20%', count: Math.max(20, Math.floor(N * 0.2)) },
        { name: '近33%', count: Math.floor(N * 0.33) },
        { name: '近50%', count: Math.floor(N * 0.5) },
        { name: '100%', count: N }
    ];
    const segData = [];
    segments.forEach(seg => {
        const segHist = history.slice(-seg.count);
        const sd = { name: seg.name, count: seg.count, roads: [] };
        for (let p = 0; p < posCount; p++) {
            sd.roads[p] = [0, 0, 0];
            for (let i = 0; i < segHist.length; i++) {
                sd.roads[p][getRoad(segHist[i].num[p])]++;
            }
            // 转为百分比
            sd.roads[p] = sd.roads[p].map(c => ((c / seg.count) * 100).toFixed(1));
        }
        segData.push(sd);
    });

    // ========== 3. 遗漏分析 ==========
    const missData = [];
    for (let p = 0; p < posCount; p++) {
        missData[p] = {};
        for (let r = 0; r <= 2; r++) {
            let miss = 0;
            for (let i = N - 1; i >= 0; i--) {
                if (getRoad(history[i].num[p]) === r) break;
                miss++;
            }
            const avgMiss = N / roadStats[p][r].total;
            
            // 最大遗漏和最大连出
            let maxMiss = 0, maxStreak = 0, tempMiss = 0, tempStreak = 0;
            for (let i = 0; i < N; i++) {
                if (getRoad(history[i].num[p]) === r) {
                    maxMiss = Math.max(maxMiss, tempMiss);
                    tempMiss = 0;
                    tempStreak++;
                    maxStreak = Math.max(maxStreak, tempStreak);
                } else {
                    tempStreak = 0;
                    tempMiss++;
                }
            }
            maxMiss = Math.max(maxMiss, tempMiss);

            missData[p][r] = { current: miss, avg: avgMiss.toFixed(1), max: maxMiss, maxStreak: maxStreak };
        }
    }

    // ========== 4. 组合形态统计 ==========
    const comboCount = {};
    for (let i = 0; i < N; i++) {
        let combo = '';
        for (let p = 0; p < posCount; p++) {
            combo += getRoad(history[i].num[p]);
        }
        comboCount[combo] = (comboCount[combo] || 0) + 1;
    }
    const sortedCombos = Object.entries(comboCount).sort((a, b) => b[1] - a[1]);

    // ========== 5. 最近30期走势 ==========
    const recentTrend = history.slice(-30).slice().reverse().map(item => ({
        period: item.period,
        nums: item.num.map((n, p) => ({ val: n, road: getRoad(n), odd: isOdd(n) })),
        roadCombo: item.num.map(n => getRoad(n)).join('')
    }));

    // ========== 6. 趋势判断 ==========
    const trendAdvice = [];
    for (let p = 0; p < posCount; p++) {
        const last10Count = [0, 0, 0];
        for (let i = N - 10; i < N; i++) {
            last10Count[getRoad(history[i].num[p])]++;
        }
        
        trendAdvice[p] = {};
        for (let r = 0; r <= 2; r++) {
            const shortRate = last10Count[r] / 10;
            const longRate = roadStats[p][r].total / N;
            const theory = r === 0 ? 0.4 : 0.3;
            
            let status = 'normal';
            if (shortRate > theory + 0.15) status = 'hot';
            else if (shortRate < theory - 0.15) status = 'cold';
            
            const missNow = missData[p][r].current;
            const avgM = parseFloat(missData[p][r].avg);
            
            trendAdvice[p][r] = {
                status: status,
                shortPct: (shortRate * 100).toFixed(1),
                longPct: (longRate * 100).toFixed(1),
                miss: missNow,
                avgMiss: missData[p][r].avg,
                alert: missNow > avgM * 2 ? '超漏' : missNow < avgM * 0.5 ? '活跃' : ''
            };
        }
    }

    // ========== 7. 智能号码推荐 ==========
    
    // 7.1 每位每个号码的综合评分
    const numScores = [];
    for (let p = 0; p < posCount; p++) {
        numScores[p] = [];
        for (let n = 0; n <= 9; n++) {
            const road = getRoad(n);
            const odd = isOdd(n);
            
            let score = 0;
            const weights = { freq: 0.25, miss: 0.30, roadTrend: 0.20, oddEven: 0.10, momentum: 0.15 };
            
            // 因子1: 频次得分
            let numCount = 0;
            for (let i = 0; i < N; i++) { if (history[i].num[p] === n) numCount++; }
            score += (numCount / N) * 10 * weights.freq;
            
            // 因子2: 遗漏回归得分
            let numMiss = 0;
            for (let i = N - 1; i >= 0; i--) { if (history[i].num[p] === n) break; numMiss++; }
            const avgMissAll = N / 10;
            if (numMiss > avgMissAll * 2) score += 0.25 * weights.miss;
            else if (numMiss > avgMissAll * 1.3) score += 0.18 * weights.miss;
            else if (numMiss > avgMissAll * 0.8) score += 0.10 * weights.miss;
            else score += 0.05 * weights.miss;
            
            // 因子3: 012路趋势得分
            const advice = trendAdvice[p][road];
            if (advice.status === 'cold' || advice.alert === '超漏') score += 0.20 * weights.roadTrend;
            else if (advice.status === 'hot') score += 0.10 * weights.roadTrend;
            else score += 0.15 * weights.roadTrend;
            
            // 因子4: 奇偶平衡补偿
            const rs = roadStats[p][road];
            if (rs.total > 0) {
                const actualOddPct = rs.odd / rs.total;
                const numsInRoad = road === 0 ? [0,3,6,9] : road === 1 ? [1,4,7] : [2,5,8];
                const theoryOddPct = numsInRoad.filter(x => x % 2 === 1).length / numsInRoad.length;
                if (odd && actualOddPct < theoryOddPct - 0.03) score += 0.10 * weights.oddEven;
                else if (!odd && actualOddPct > theoryOddPct + 0.03) score += 0.10 * weights.oddEven;
                else score += 0.05 * weights.oddEven;
            }
            
            // 因子5: 近期动量
            let recentCount = 0;
            for (let i = Math.max(0, N - 20); i < N; i++) { if (history[i].num[p] === n) recentCount++; }
            score += (recentCount / 20) * weights.momentum;
            
            numScores[p].push({ num: n, score: parseFloat(score.toFixed(4)), road: road, miss: numMiss });
        }
        numScores[p].sort((a, b) => b.score - a.score);
    }
    
    // 7.2 复式推荐（多规格可选）
    // 排三/3D: 2/3/4/5 每位选号数，排五: 2/3/4/5 每位选号数
    const complexOptions = [2, 3, 4, 5];
    
    const complexRec = complexOptions.map(size => {
        const nums = numScores.map(ps => ps.slice(0, size).map(x => x.num));
        const count = nums.reduce((a, b) => a * b.length, 1);
        // 生成多行格式的复制文本（带彩种标题）
        const copyLines = `${cfg.name}：\n` + nums.map((arr, idx) => `${R.posNames[idx]}位：${arr.join(' ')}`).join('\n');
        return {
            size: size,
            nums: nums,
            count: count,
            formula: nums.map(arr => arr.join('')).join('*'),
            display: nums.map(arr => arr.join(',')),
            copyText: copyLines
        };
    });
    
    // 7.3 精选单注推荐
    function generateTopSingles(numScoresArr, maxResults, posCnt) {
        const results = [];
        const tops = numScoresArr.map(ps => ps.slice(0, 4).map(x => x.num));
        
        function genCombo(depth, currentCombo, currentScore) {
            if (depth === posCnt) {
                results.push({ combo: [...currentCombo], score: parseFloat(currentScore.toFixed(4)) });
                return;
            }
            for (let i = 0; i < tops[depth].length && results.length < maxResults * 3; i++) {
                const n = tops[depth][i];
                const s = numScoresArr[depth].find(x => x.num === n)?.score || 0;
                currentCombo.push(n);
                genCombo(depth + 1, currentCombo, currentScore + s);
                currentCombo.pop();
            }
        }
        genCombo(0, [], 0);
        results.sort((a, b) => b.score - a.score);
        
        const seen = new Set();
        const unique = [];
        for (const r of results) {
            const key = r.combo.join('');
            if (!seen.has(key)) { seen.add(key); unique.push(r); if (unique.length >= maxResults) break; }
        }
        return unique;
    }
    
    const rawSingles = generateTopSingles(numScores, posCount === 3 ? 25 : 60, posCount);
    const hotCombos = sortedCombos.slice(0, 5).map(c => c[0]);
    
    for (const rs of rawSingles) {
        const comboRoad = rs.combo.map(n => getRoad(n)).join('');
        let bonus = 0;
        const comboIdx = hotCombos.indexOf(comboRoad);
        if (comboIdx !== -1) bonus += (5 - comboIdx) * 0.02;
        
        const sumVal = rs.combo.reduce((a, b) => a + b, 0);
        const theorySum = posCount === 3 ? 13.5 : 22.5;
        if (Math.abs(sumVal - theorySum) <= (posCount === 3 ? 9 : 15)) bonus += 0.01;
        
        const sorted = [...rs.combo].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i + 1] - sorted[i] === 1) { bonus += 0.008; break; }
        }
        
        rs.finalScore = parseFloat((rs.score + bonus).toFixed(4));
    }
    rawSingles.sort((a, b) => b.finalScore - a.finalScore);

    return {
        posCount: posCount,
        posNames: posNames,
        N: N,
        roadStats: roadStats,
        segData: segData,
        missData: missData,
        combos: sortedCombos.slice(0, 20),
        recentTrend: recentTrend,
        trendAdvice: trendAdvice,
        latestPeriod: history[N - 1]?.period || '',
        firstPeriod: history[0]?.period || '',
        numScores: numScores,
        complexRec: complexRec,
        singleRec: rawSingles.slice(0, posCount === 3 ? 10 : 15)
    };
}

/**
 * 生成012路分析 HTML 报告
 */
function getRoadAnalysisHtml(result, cfg, N) {
    const R = result;
    // 从 result 和参数中提取所有 HTML 模板需要的变量
    const posCount = R.posCount || (cfg && cfg.positions ? cfg.positions.length : 3);
    const posNames = R.posNames || [];
    const posColors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6'];
    const roadColors = { 0: '#06b6d4', 1: '#8b5cf6', 2: '#f59e0b' };
    const roadNums = { 0: '0,3,6,9', 1: '1,4,7', 2: '2,5,8' };
    const lotteryName = (cfg && cfg.name) || '';

    // 工具函数（本函数内使用）
    function getRoad(n) { return n % 3; }
    function isOdd(n) { return n % 2 === 1; }

    // 从 result 中提取热门路组合（HTML模板中使用）
    const hotCombos = (R.combos || []).slice(0, 5).map(c => c[0] || c);

    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>012路趋势分析 - ${cfg.name}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;line-height:1.6}
.container{max-width:1400px;margin:0 auto}
h1{text-align:center;font-size:22px;margin-bottom:18px;color:#38bdf8;border-bottom:2px solid #334155;padding-bottom:12px}
h2{font-size:17px;color:#818cf8;margin:25px 0 12px;padding-left:10px;border-left:4px solid #6366f1}
.card{background:#1e293b;border-radius:10px;padding:16px;margin-bottom:14px;box-shadow:0 2px 4px rgba(0,0,0,.3)}
.card-title{font-size:13px;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#334155;padding:8px 6px;text-align:center;color:#cbd5e1;font-weight:600}
td{padding:7px 6px;text-align:center;border-bottom:1px solid #1e293b}
tr:hover td{background:rgba(99,102,241,.08)}
.dev-up{color:#ef4444;font-weight:bold}.dev-down{color:#22c55e;font-weight:bold}
.tag-hot{background:linear-gradient(135deg,#ef4444,#dc2626);color:white;padding:2px 7px;border-radius:4px;font-size:11px}
.tag-cold{background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;padding:2px 7px;border-radius:4px;font-size:11px}
.tag-warm{background:#f59e0b;color:white;padding:2px 7px;border-radius:4px;font-size:11px}
.tag-alert{background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:white;padding:2px 7px;border-radius:4px;font-size:11px}
.chart-bar{height:22px;border-radius:4px;display:flex;align-items:flex-end;justify-content:flex-end;padding-right:6px;color:white;font-size:11px;min-width:50px;transition:width .5s}
.bar-0{background:linear-gradient(90deg,#06b6d4,#0891b2)}.bar-1{background:linear-gradient(90deg,#8b5cf6,#7c3aed)}.bar-2{background:linear-gradient(90deg,#f59e0b,#d97706)}
.combo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${R.posCount > 3 ? '90' : '75'}px,1fr));gap:8px;margin-top:10px}
.combo-item{text-align:center;padding:10px 5px;border-radius:8px;cursor:pointer;transition:transform .2s}
.combo-item:hover{transform:scale(1.05)}
.combo-item.hot{background:linear-gradient(135deg,rgba(239,68,68,.25),rgba(220,38,38,.15));border:1px solid #ef4444}
.combo-item.cold{background:linear-gradient(135deg,rgba(59,130,246,.25),rgba(37,99,235,.15));border:1px solid #3b82f6}
.combo-item.normal{background:#334155;border:1px solid #475569}
.combo-code{font-size:${R.posCount > 3 ? '14' : '16'}px;font-weight:bold;font-family:monospace}
.combo-count{font-size:11px;color:#94a3b8;margin-top:3px}
.road-cell{display:inline-block;width:26px;height:26px;line-height:26px;border-radius:50%;font-weight:bold;font-size:11px;color:white}
.r0{background:linear-gradient(135deg,#06b6d4,#0891b2)}
.r1{background:linear-gradient(135deg,#8b5cf6,#7c3aed)}
.r2{background:linear-gradient(135deg,#f59e0b,#d97706)}
.insight-box{background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(139,92,246,.08));border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:14px;margin-top:12px}
.insight-title{color:#a78bfa;font-weight:bold;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.insight-list li{margin:6px 0;padding-left:14px;position:relative;list-style:none;font-size:13px}
.insight-list li::before{content:'▸';position:absolute;left:0;color:#818cf8}
.grid-${R.posCount}{display:grid;gap:14px;grid-template-columns:repeat(${R.posCount},1fr)}
.summary-box{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.summary-item{flex:1;min-width:120px;background:#334155;padding:12px;border-radius:8px;text-align:center}
.summary-value{font-size:24px;font-weight:bold;margin:4px 0}
.summary-label{font-size:11px;color:#94a3b8}
.timeline{overflow-x:auto}
.timeline table{min-width:${R.posCount * 180 + 100}px}
.footer{text-align:center;margin:25px 0 15px;padding:15px;color:#64748b;font-size:11px;border-top:1px solid #334155}
.pos-header{padding:6px 10px;border-radius:6px;margin-bottom:10px;font-weight:bold;color:white}
.copy-btn{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border:none;padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.copy-btn:hover{transform:scale(1.05);box-shadow:0 2px 8px rgba(99,102,241,.4)}
.copy-btn:active{transform:scale(.95)}
.copy-btn.copied{background:linear-gradient(135deg,#10b981,#059669)}
.copy-all-btn{background:linear-gradient(135deg,#f59e0b,#d97706);color:white;border:none;padding:8px 18px;border-radius:8px;font-size:13px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:6px;margin:10px 0}
.copy-all-btn:hover{transform:scale(1.03);box-shadow:0 3px 12px rgba(245,158,11,.4)}
.copy-all-btn.copied{background:linear-gradient(135deg,#10b981,#059669)}
</style>
</head>
<body>
<div class="container">
<h1>🛤️ ${cfg.name} 012路趋势 + 奇偶比深度分析 (${N}期)</h1>

<!-- 第一部分：基础分布 -->
<h2>一、各位012路基础分布</h2>
<div class="grid-${R.posCount}">`;

    // 各位分布卡片
    for (let p = 0; p < R.posCount; p++) {
        const color = posColors[p];
        html += `<div class="card">
<div class="pos-header" style="background:${color}">${R.posNames[p]}位 012路分布</div>
<table>
<tr><th>路别</th><th>号码</th><th>出现次数</th><th>占比</th><th>理论</th><th>偏差</th></tr>`;
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            const pct = ((s.total / N) * 100).toFixed(1);
            const dev = (parseFloat(pct) - (r === 0 ? 40 : 30)).toFixed(1);
            const sign = parseFloat(dev) >= 0 ? '+' : '';
            const devClass = parseFloat(dev) >= 0 ? 'dev-up' : 'dev-down';
            html += `<tr><td>${r}路</td><td>${roadNums[r]}</td><td>${s.total}</td><td>${pct}%</td><td>${r===0?'40':'30'}%</td><td class="${devClass}">${sign}${dev}%</td></tr>`;
        }
        html += `</table>
<div style="margin-top:12px;">`;
        for (let r = 0; r <= 2; r++) {
            const pct = ((R.roadStats[p][r].total / N) * 100);
            const barW = Math.max(pct / 45 * 100, 15);
            html += `<div style="display:flex;align-items:center;margin:4px 0;">
<span style="width:30px;font-size:11px;">${r}路:</span>
<div class="chart-bar bar-${r}" style="width:${barW}%">${pct.toFixed(1)}%</div>
</div>`;
        }
        html += `</div></div>`;
    }

    html += `</div>

<!-- 第二部分：分段趋势 -->
<h2>二、分段趋势演变</h2>
<div class="card">
<table>
<tr><th rowspan="2">位置</th>`;
    R.segData.forEach(seg => {
        html += `<th colspan="3">${seg.name}<br/><small>${seg.count}期</small></th>`;
    });
    html += `</tr><tr>`;
    R.segData.forEach(() => {
        html += `<th>0路</th><th>1路</th><th>2路</th>`;
    });
    html += `</tr>`;

    for (let p = 0; p < R.posCount; p++) {
        html += `<tr style="color:${posColors[p]};font-weight:bold;"><td>${R.posNames[p]}位</td>`;
        R.segData.forEach(seg => {
            for (let r = 0; r <= 2; r++) {
                html += `<td>${seg.roads[p][r]}%</td>`;
            }
        });
        html += `</tr>`;
    }
    html += `</table>

<div class="insight-box">
<div class="insight-title">💡 趋势洞察</div>
<ul class="insight-list">`;
    
    // 自动生成趋势洞察
    for (let p = 0; p < R.posCount; p++) {
        const firstSeg = R.segData[0];
        const lastSeg = R.segData[R.segData.length - 1];
        for (let r = 0; r <= 2; r++) {
            const firstVal = parseFloat(firstSeg.roads[p][r]);
            const lastVal = parseFloat(lastSeg.roads[p][r]);
            const diff = lastVal - firstVal;
            const theory = r === 0 ? 40 : 30;
            if (Math.abs(diff) > 5) {
                const direction = diff > 0 ? '走强↑' : '走弱↓';
                html += `<li><strong>${R.posNames[p]}位${r}路</strong>：${direction}（从${firstVal.toFixed(1)}%到${lastVal.toFixed(1)}%，变化${diff > 0 ? '+' : ''}${diff.toFixed(1)}%）</li>`;
            } else if (Math.abs(lastVal - theory) > 5) {
                const status = lastVal > theory ? '偏热' : '偏冷';
                html += `<li><strong>${R.posNames[p]}位${r}路</strong>：整体${status}（当前${lastVal.toFixed(1)}%，理论${theory}%）</li>`;
            }
        }
    }
    html += `</ul></div></div>`;

    // 第三部分：奇偶比分析
    html += `
<h2>三、012路内奇偶比分析</h2>
<div class="grid-${R.posCount}">`;
    
    for (let p = 0; p < R.posCount; p++) {
        html += `<div class="card">
<div class="pos-header" style="background:${posColors[p]}">${R.posNames[p]}位 - 奇偶详情</div>
<table>
<tr><th>路别</th><th>总次</th><th>奇数</th><th>偶数</th><th>奇占比</th><th>理论奇</th><th>偏差</th></tr>`;
        
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            const oddPct = s.total > 0 ? ((s.odd / s.total) * 100).toFixed(1) : '0.0';
            
            // 该路的奇偶理论值
            const numsInRoad = r === 0 ? [0,3,6,9] : r === 1 ? [1,4,7] : [2,5,8];
            const oddsInRoad = numsInRoad.filter(n => n % 2 === 1).length;
            const tOdd = ((oddsInRoad / numsInRoad.length) * 100).toFixed(1);
            
            const oddDev = (parseFloat(oddPct) - parseFloat(tOdd)).toFixed(1);
            const sign = parseFloat(oddDev) >= 0 ? '+' : '';
            const devClass = Math.abs(parseFloat(oddDev)) > 5 ? (parseFloat(oddDev) > 0 ? 'dev-up' : 'dev-down') : '';
            const alertTag = Math.abs(parseFloat(oddDev)) > 6 ? '<span class="tag-alert">异常</span>' : '';
            
            html += `<tr><td>${r}路</td><td>${s.total}</td><td>${s.odd}</td><td>${s.even}</td><td>${oddPct}%</td><td>${tOdd}%</td><td class="${devClass}">${sign}${oddDev}% ${alertTag}</td></tr>`;
        }
        html += `</table></div>`;
    }
    html += `</div>`;

    // 第四部分：遗漏分析
    html += `
<h2>四、遗漏与连出分析</h2>
<div class="grid-${R.posCount}">`;
    
    for (let p = 0; p < R.posCount; p++) {
        html += `<div class="card">
<div class="pos-header" style="background:${posColors[p]}">${R.posNames[p]}位 遗漏状态</div>
<table>
<tr><th>路别</th><th>当前遗漏</th><th>平均遗漏</th><th>最大遗漏</th><th>最大连出</th><th>状态</th></tr>`;
        
        for (let r = 0; r <= 2; r++) {
            const m = R.missData[p][r];
            const avgM = parseFloat(m.avg);
            let statusTag = '<span class="tag-warm">正常</span>';
            if (m.current >= m.max * 0.9) statusTag = '<span class="tag-alert">⚠极值!</span>';
            else if (m.current > avgM * 2) statusTag = '<span class="tag-alert">超漏</span>';
            else if (m.current === 0) statusTag = '<span class="tag-hot">刚出</span>';
            else if (m.current < avgM * 0.5) statusTag = '<span class="tag-warm">活跃</span>';
            
            html += `<tr><td>${r}路</td><td>${m.current}</td><td>${m.avg}</td><td>${m.max}</td><td>${m.maxStreak}</td><td>${statusTag}</td></tr>`;
        }
        html += `</table></div>`;
    }
    html += `</div>`;

    // 预警信号
    html += `<div class="insight-box" style="background:linear-gradient(135deg,rgba(245,158,11,.12),rgba(217,119,6,.08));border-color:#f59e0b;">
<div class="insight-title" style="color:#f59e0b;">⚡ 关键预警信号</div>
<ul class="insight-list">`;
    
    let hasAlert = false;
    for (let p = 0; p < R.posCount; p++) {
        for (let r = 0; r <= 2; r++) {
            const m = R.missData[p][r];
            const avgM = parseFloat(m.avg);
            if (m.current > avgM * 2) {
                hasAlert = true;
                html += `<li><strong>${R.posNames[p]}位${r}路</strong> 当前遗漏<strong>${m.current}期</strong>（平均${m.avg}期），已达${(m.current/m.max*100).toFixed(0)}%历史最大遗漏！强烈关注</li>`;
            }
        }
    }
    if (!hasAlert) {
        html += `<li>当前各位置各路遗漏均在正常范围内，无明显超漏信号</li>`;
    }
    html += `</ul></div>`;

    // 第五部分：组合形态
    html += `
<h2>五、012路组合形态统计（TOP热/冷）</h2>
<div class="card">
<div class="combo-grid">`;
    
    const maxComboCount = R.combos.length > 0 ? R.combos[0][1] : 1;
    R.combos.forEach(([combo, count]) => {
        const pct = ((count / N) * 100).toFixed(2);
        const ratio = count / maxComboCount;
        let itemClass = 'normal';
        if (ratio >= 0.7) itemClass = 'hot';
        else if (ratio <= 0.25) itemClass = 'cold';
        const tag = ratio >= 0.7 ? '★热' : (ratio <= 0.25 ? '☆冷' : '');
        
        html += `<div class="combo-item ${itemClass}">
<div class="combo-code">${combo}</div>
<div class="combo-count">${count}次(${pct}%) ${tag}</div>
</div>`;
    });
    
    html += `</div></div>`;

    // 第六部分：走势图
    html += `
<h2>六、最近30期详细走势</h2>
<div class="card timeline">
<table>
<tr><th>期号</th>`;
    for (let p = 0; p < R.posCount; p++) {
        html += `<th>${R.posNames[p]}位<br/><small>(号|路|奇偶)</small></th>`;
    }
    html += `<th>路组合</th></tr>`;

    R.recentTrend.forEach(item => {
        html += `<tr><td>${item.period}</td>`;
        item.nums.forEach((n, idx) => {
            const parity = n.odd ? '奇' : '偶';
            html += `<td>${n.val}|<span class="road-cell r${n.road}">${n.road}</span>|${parity}</td>`;
        });
        html += `<td>`;
        item.roadCombo.split('').forEach(r => {
            html += `<span class="road-cell r${r}">${r}</span>`;
        });
        html += `</td></tr>`;
    });
    html += `</table></div>`;

    // 第七部分：下期推荐
    html += `
<h2>七、下期预测参考</h2>
<div class="grid-${R.posCount}">`;
    
    for (let p = 0; p < R.posCount; p++) {
        html += `<div class="card" style="border-top:3px solid ${posColors[p]}">
<div class="card-title" style="color:${posColors[p]}">${R.posNames[p]}位推荐</div>
<div class="summary-box">`;

        // 找出推荐的路
        const advice = R.trendAdvice[p];
        const recommendations = [];
        for (let r = 0; r <= 2; r++) {
            const a = advice[r];
            recommendations.push({ road: r, ...a });
        }
        // 按综合评分排序：优先考虑超漏，其次考虑偏冷
        recommendations.sort((a, b) => {
            if (a.alert && !b.alert) return -1;
            if (!a.alert && b.alert) return 1;
            if (a.status === 'cold' && b.status !== 'cold') return -1;
            if (a.status !== 'cold' && b.status === 'cold') return 1;
            return a.miss - b.miss;
        });

        for (let i = 0; i < Math.min(2, recommendations.length); i++) {
            const rec = recommendations[i];
            const rc = roadColors[rec.road];
            const label = i === 0 ? '首选' : '次选';
            const tagClass = rec.alert ? 'tag-alert' : rec.status === 'cold' ? 'tag-cold' : rec.status === 'hot' ? 'tag-hot' : 'tag-warm';
            html += `<div class="summary-item">
<div class="summary-label">${label}路</div>
<div class="summary-value" style="color:${rc}">${rec.road}路</div>
<div style="font-size:10px;color:#94a3b8;">遗漏${rec.miss}(均${rec.avgMiss}) ${rec.alert}</div>
<span class="${tagClass}" style="margin-top:4px;display:inline-block">${rec.status==='hot'?'偏热':rec.status==='cold'?'偏冷':'正常'}</span>
</div>`;
        }

        html += `</div>
<div style="margin-top:12px;padding:10px;background:#334155;border-radius:8px;font-size:12px;">
<strong>推荐号码：</strong><br/>`;
        recommendations.forEach((rec, idx) => {
            const tagCls = idx === 0 ? 'tag-hot' : 'tag-warm';
            html += `<span class="${tagCls}">${rec.road}路: ${roadNums[rec.road]}</span><br/>`;
        });
        html += `</div></div>`;
    }
    html += `</div>`;

    // 综合推荐 - 012路形态
    html += `<div class="insight-box" style="background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(6,182,212,.08));border-color:#10b981;">
<div class="insight-title" style="color:#10b981;">🎯 综合推荐 - 012路组合形态</div>
<p style="font-size:13px;line-height:1.8;">
基于以上数据分析，下期推荐的<strong>012路组合形态</strong>：<br/>
`;
    
    const topCombos = R.combos.slice(0, 3);
    topCombos.forEach(([combo, count], idx) => {
        const stars = idx === 0 ? '⭐' : idx === 1 ? '🌟' : '✨';
        html += `${stars} <strong>${combo}</strong> (${count}次, ${((count/N)*100).toFixed(1)}%) &nbsp;&nbsp;`;
    });
    
    html += `</p></div>`;

    // ========== 八、智能号码推荐 ==========
    if (R.complexRec && R.singleRec) {
        html += `
<h2>八、🎲 智能号码推荐</h2>

<!-- 复式推荐 - 多规格可选 -->
<div class="card" style="border-left:4px solid #f59e0b;">
<div class="card-title" style="color:#f59e0b;font-size:15px;">📋 复式推荐（多规格可选）</div>
<div style="display:grid;grid-template-columns:repeat(${Math.min(R.complexRec.length, 4)}, 1fr);gap:14px;margin-top:10px;">`;

        const sizeLabels = { 2: '精简', 3: '标准', 4: '扩展', 5: '全覆盖' };
        const sizeColors = { 2: '#38bdf8', 3: '#a78bfa', 4: '#f59e0b', 5: '#ef4444' };

        R.complexRec.forEach((rec, idx) => {
            const label = sizeLabels[rec.size] || rec.size + '码';
            const color = sizeColors[rec.size] || '#94a3b8';
            const tagClass = idx === 0 ? 'tag-hot' : idx < 2 ? 'tag-warm' : 'tag-alert';
            // 将复制文本编码为 base64 避免特殊字符问题
            const copyBase64 = Buffer.from(rec.copyText).toString('base64');

            html += `
<div style="background:#334155;border-radius:8px;padding:14px;border-top:3px solid ${color};">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
<span style="font-weight:bold;color:${color};">${label}复式 (${rec.size}*${rec.size}${posCount===3?'':('×'+posCount+'位')})</span>
<div style="display:flex;align-items:center;gap:8px;">
<span class="${tagClass}">${rec.count}注</span>
<button class="copy-btn" data-copy="${copyBase64}" onclick="copyFromData(this)">📋 复制</button>
</div>
</div>
<div style="font-size:${posCount > 3 ? '16' : '20'}px;font-family:monospace;font-weight:bold;text-align:center;padding:12px;background:#1e293b;border-radius:6px;margin-bottom:10px;letter-spacing:${posCount > 3 ? '2' : '4'}px;">
${rec.formula}
</div>
<div style="font-size:11px;color:#94a3b8;line-height:1.8;">`;
            for (let p = 0; p < R.posCount; p++) {
                const nums = rec.nums[p];
                html += `<div>${R.posNames[p]}位: <span style="color:${posColors[p]}">${nums.join(', ')}</span></div>`;
            }
            html += `</div></div>`;
        });

        html += `</div></div>

<!-- 精选单注 -->
<div class="card" style="border-left:4px solid #ef4444;margin-top:14px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
<div class="card-title" style="color:#ef4444;font-size:15px;margin:0;">🏆 精选单注推荐（按综合评分排序）</div>
<span style="font-size:11px;color:#94a3b8;">基于五维评分+形态匹配+和值优化</span>
</div>
<div style="text-align:right;margin-bottom:10px;">
<button class="copy-all-btn" id="copyAllSingleBtn" onclick="copyAllSingles()">📋 复制全部单注</button>
<span id="singlesData" data-singles="${(R.singleRec || []).map(item => item.combo.join('')).join('\\n')}"></span>
</div>
<table style="font-size:13px;">
<tr style="background:#334155;">
<th width="50">排名</th>
<th width="100">号码</th>
<th width="80">012路</th>
<th width="70">和值</th>
<th width="80">综合分</th>
<th>特征标签</th>
</tr>`;

        R.singleRec.forEach((item, idx) => {
            const comboStr = item.combo.join('');
            const roadStr = item.combo.map(n => getRoad(n)).join('');
            const sumVal = item.combo.reduce((a, b) => a + b, 0);
            
            // 特征标签
            const tags = [];
            // 奇偶形态
            const oddCnt = item.combo.filter(n => isOdd(n)).length;
            tags.push(oddCnt > R.posCount / 2 ? '奇多' : oddCnt < R.posCount / 2 ? '偶多' : '均衡');
            // 大小形态
            const bigCnt = item.combo.filter(n => n >= 5).length;
            tags.push(bigCnt > R.posCount / 2 ? '大多' : bigCnt < R.posCount / 2 ? '小多' : '中小');
            // 连号
            const sortedCombo = [...item.combo].sort((a, b) => a - b);
            let hasConsec = false;
            for (let i = 0; i < sortedCombo.length - 1; i++) { if (sortedCombo[i+1] - sortedCombo[i] === 1) hasConsec = true; }
            if (hasConsec) tags.push('连号');
            // 路形态是否热门
            if (hotCombos.includes(roadStr)) tags.push('热形态');
            
            const rankTag = idx === 0 ? '<span class="tag-hot">TOP1</span>' : 
                           idx < 3 ? '<span class="tag-warm">TOP' + (idx+1) + '</span>' :
                           '<span style="color:#64748b">' + (idx+1) + '</span>';
            
            const rowBg = idx % 2 === 0 ? '' : 'style="background:rgba(51,65,85,.3)"';
            
            html += `<tr ${rowBg}>
<td style="text-align:center;font-weight:bold;">${rankTag}</td>
<td style="text-align:center;font-family:monospace;font-size:16px;font-weight:bold;color:#38bdf8;letter-spacing:3px;">
${comboStr}
<button class="copy-btn" style="margin-left:6px;padding:2px 8px;font-size:10px;" onclick="doCopy(this, '${comboStr}')">复制</button>
</td>
<td style="text-align:center;">`;
            roadStr.split('').forEach(r => {
                html += `<span class="road-cell r${r}" style="width:22px;height:22px;font-size:10px;line-height:22px;">${r}</span>`;
            });
            html += `</td>
<td style="text-align:center;font-weight:bold;color:#f59e0b;">${sumVal}</td>
<td style="text-align:center;color:#10b981;font-weight:bold;">${item.finalScore.toFixed(3)}</td>
<td style="text-align:left;font-size:11px;">${tags.map(t => '<span style="background:#475569;padding:1px 6px;border-radius:3px;margin:1px;display:inline-block;">' + t + '</span>').join(' ')}</td>
</tr>`;
        });

        html += `
</table>

<div class="insight-box" style="margin-top:14px;background:linear-gradient(135deg,rgba(239,68,68,.08),rgba(245,158,11,.05));border-color:rgba(239,68,68,.3);">
<div class="insight-title" style="color:#f59e0b;">💡 推荐说明</div>
<ul class="insight-list">`;
        R.complexRec.forEach((rec) => {
            const lbl = rec.size === 2 ? '精简' : rec.size === 3 ? '标准' : rec.size === 4 ? '扩展' : '全覆盖';
            html += `<li><strong>${lbl}复式 (${rec.formula})</strong>：每位取评分最高的${rec.size}个号码，共 <strong>${rec.count}</strong> 注</li>`;
        });
        html += `
<li><strong>精选单注</strong>：基于频次、遗漏回归、012路趋势、奇偶补偿、近期动量五维加权评分，结合历史热门形态和连号/和值优化</li>
<li>评分越高代表该组合在当前数据特征下的出现概率越大</li>
</ul>
</div>
</div>`;
    }

    html += `
<small style="color:#94a3b8;display:block;margin-top:15px;text-align:center;">数据范围：${R.firstPeriod} ~ ${R.latestPeriod} | 分析期数：${N}期<br/>

<div class="footer">
<p>🛤️ 012路趋势分析 | ${cfg.name} | 数据驱动 · 智能分析</p>
</div>
</div>

<script>
// 使用 VSCode 原生 API 复制（通过消息机制）
function copyToClipboard(text) {
    if (typeof acquireVsCodeApi !== 'undefined') {
        const vscode = acquireVsCodeApi();
        vscode.postMessage({ command: 'copy', text: text });
    }
}

// 监听复制成功消息
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'copySuccess') {
        // 找到所有复制按钮并显示成功状态
        document.querySelectorAll('.copy-btn, .copy-all-btn').forEach(btn => {
            if (btn.dataset.copied !== 'true') return;
            btn.innerHTML = '✅ 已复制';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.innerHTML = btn.dataset.originalText || '📋 复制';
                btn.classList.remove('copied');
                btn.dataset.copied = 'false';
            }, 1500);
        });
    }
});

// 从 data 属性复制
function copyFromData(btn) {
    const text = decodeBase64(btn.getAttribute('data-copy'));
    doCopy(btn, text);
}

// Base64 解码
function decodeBase64(str) {
    try { return atob(str); } catch(e) { return str; }
}

// 执行复制并显示状态
function doCopy(btn, text) {
    btn.dataset.originalText = btn.innerHTML;
    btn.dataset.copied = 'true';
    copyToClipboard(text);
}

// 复制全部精选单注
function copyAllSingles() {
    const btn = document.getElementById('copyAllSingleBtn');
    const singlesData = document.getElementById('singlesData');
    const text = singlesData ? singlesData.getAttribute('data-singles') : '';
    if (text) {
        doCopy(btn, text);
    }
}
</script>

</body>
</html>`;

    return html;
}

/**
 * 生成概率统计智能推荐 HTML
 */
function getProbabilityPickHtml(analysis) {
    const A = analysis;
    const dataJson = JSON.stringify(A);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>概率统计智能推荐 - ${A.cfgName}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1b1b2f; color: #e0e0e0; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; line-height: 1.5; }
.header { background: linear-gradient(135deg, #16213e, #0f3460); padding: 20px; border-radius: 12px; margin-bottom: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.1); }
.header h1 { font-size: 22px; color: #e94560; margin-bottom: 6px; }
.header .sub { color: #a0a0b0; font-size: 13px; }
.header .latest { margin-top: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.latest .ball { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; font-weight: bold; font-size: 18px; color: #fff; }
.ball.red { background: linear-gradient(135deg, #e94560, #c0392b); }
.ball.blue { background: linear-gradient(135deg, #0984e3, #0652DD); }
.ball.green { background: linear-gradient(135deg, #27ae60, #1e8449); }
.ball.purple { background: linear-gradient(135deg, #8e44ad, #6c3483); }
.ball.orange { background: linear-gradient(135deg, #f39c12, #d68910); }
.section { margin-bottom: 18px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; }
.section-title { background: rgba(255,255,255,0.05); padding: 10px 16px; font-size: 14px; font-weight: 600; color: #feca57; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.section-body { padding: 14px 16px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid rgba(255,255,255,0.1); padding: 5px 8px; text-align: center; }
th { background: rgba(255,255,255,0.06); color: #8ec5ff; font-weight: 600; font-size: 11px; white-space: nowrap; }
td { font-size: 12px; }
.hot { color: #e94560; font-weight: bold; }
.cold { color: #0984e3; font-weight: bold; }
.warm { color: #2ecc71; }
.badge-hot { display: inline-block; background: rgba(233,69,96,0.2); color: #e94560; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
.badge-cold { display: inline-block; background: rgba(9,132,227,0.2); color: #0984e3; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
.badge-warm { display: inline-block; background: rgba(46,204,113,0.2); color: #2ecc71; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
.score-bar-wrap { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; margin-top: 2px; overflow: hidden; }
.score-bar { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #e94560, #feca57, #2ecc71); transition: width 0.4s; }
.chart-bar-wrap { display: flex; align-items: flex-end; gap: 3px; height: 60px; padding: 0 4px; }
.chart-bar-cell { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.chart-bar { width: 70%; border-radius: 2px 2px 0 0; min-height: 1px; transition: height 0.3s; }
.chart-label { font-size: 10px; color: #888; margin-top: 2px; }
.chart-label-top { font-size: 9px; color: #e94560; font-weight: bold; }
.warn-box { background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.3); padding: 10px 14px; border-radius: 6px; color: #e74c3c; font-size: 12px; margin: 8px 0; }
.info-box { background: rgba(52,152,219,0.1); border: 1px solid rgba(52,152,219,0.3); padding: 10px 14px; border-radius: 6px; color: #3498db; font-size: 12px; margin: 8px 0; }
.success-box { background: rgba(46,204,113,0.1); border: 1px solid rgba(46,204,113,0.3); padding: 10px 14px; border-radius: 6px; color: #2ecc71; font-size: 12px; margin: 8px 0; }
.rec-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 12px; text-align: center; }
.rec-card .rank { font-size: 11px; color: #888; }
.rec-card .nums { font-size: 20px; font-weight: bold; color: #feca57; margin: 6px 0; letter-spacing: 4px; }
.rec-card .score { font-size: 11px; color: #aaa; }
.rec-card.top1 { border-color: rgba(233,69,96,0.5); background: rgba(233,69,96,0.08); }
.rec-card.top1 .nums { color: #e94560; font-size: 24px; }
.pos-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 4px; }
.pos-tag.pos0 { background: #e94560; color: #fff; }
.pos-tag.pos1 { background: #0984e3; color: #fff; }
.pos-tag.pos2 { background: #27ae60; color: #fff; }
.pos-tag.pos3 { background: #8e44ad; color: #fff; }
.pos-tag.pos4 { background: #f39c12; color: #fff; }
.recommend-area { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 600px) { .recommend-area { grid-template-columns: repeat(2, 1fr); } }
.highlight-num { display: inline-block; padding: 3px 7px; border-radius: 4px; font-weight: bold; }
.stats-row { display: flex; gap: 16px; flex-wrap: wrap; }
.stat-card { flex: 1; min-width: 120px; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 12px; text-align: center; }
.stat-card .val { font-size: 22px; font-weight: bold; color: #feca57; }
.stat-card .lbl { font-size: 11px; color: #888; margin-top: 4px; }
.btn-copy { display: inline-block; padding: 4px 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(255,255,255,0.05); color: #bbb; cursor: pointer; font-size: 11px; transition: all 0.2s; }
.btn-copy:hover { background: rgba(233,69,96,0.2); border-color: #e94560; color: #e94560; }
.btn-copy.copied { background: rgba(46,204,113,0.2); border-color: #2ecc71; color: #2ecc71; }
.btn-copy-sm { padding: 2px 8px; font-size: 10px; margin-top: 6px; }
.copy-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
</style>
</head>
<body>
<div class="header">
    <h1>🧬 ${A.cfgEmoji} ${A.cfgName} — 概率统计智能推荐</h1>
    <div class="sub">样本量：${A.N} 期 | 方法：多维度频率分析 + 遗漏回归 + Z分数检验 + 卡方检验</div>
    <div class="latest">
        <span style="color:#aaa">第 ${A.latestPeriod} 期 (${A.latestDate})：</span>
        ${A.latestNums.map((n, i) => '<span class="ball ' + ['red','blue','green','purple','orange'][i] + '">' + n + '</span>').join('')}
    </div>
</div>

<div id="prob-app">
<!-- ===== 1. 频次分布对比 ===== -->
<div class="section">
    <div class="section-title">📊 多窗口频次分布（各位号码出现次数）</div>
    <div class="section-body">
        <div id="freq-tabs" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"></div>
        <div id="freq-charts"></div>
    </div>
</div>

<!-- ===== 2. 遗漏值 & Z分数冷热 ===== -->
<div class="section">
    <div class="section-title">🎯 遗漏值 & Z分数冷热分析</div>
    <div class="section-body">
        <div class="grid-2" id="missing-z-grid"></div>
    </div>
</div>

<!-- ===== 3. 卡方检验 ===== -->
<div class="section">
    <div class="section-title">📐 卡方拟合优度检验（H₀：每位号码均匀分布）</div>
    <div class="section-body" id="chi-square-section"></div>
</div>

<!-- ===== 4. 和值分布 ===== -->
<div class="section">
    <div class="section-title">🔢 和值统计</div>
    <div class="section-body">
        <div class="stats-row" id="sum-stats"></div>
        <div style="margin-top:10px;position:relative;height:32px;background:rgba(0,0,0,0.2);border-radius:4px;">
            <div id="sum-indicator" style="position:absolute;top:0;left:0;width:4px;height:100%;background:#e94560;border-radius:2px;"></div>
            <div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:11px;color:#888;pointer-events:none;" id="sum-label"></div>
        </div>
    </div>
</div>

<!-- ===== 5. 跨度分布 ===== -->
<div class="section">
    <div class="section-title">📏 跨度分布（${A.posCount}位号码最大值-最小值）</div>
    <div class="section-body">
        <div class="chart-bar-wrap" id="span-chart"></div>
    </div>
</div>

<!-- ===== 6. 模式分布 ===== -->
<div class="section">
    <div class="section-title">🔍 模式分布：奇偶比 · 大小比 · 012路</div>
    <div class="section-body">
        <div class="grid-3" id="pattern-grid"></div>
    </div>
</div>

<!-- ===== 7. 综合智能评分 ===== -->
<div class="section">
    <div class="section-title">🏆 综合智能评分（多维加权）</div>
    <div class="section-body">
        <div class="info-box" style="margin-top:0;">
            评分权重：近期频次 30% + 遗漏回归 25% + Z分数修正 20% + 趋势动量 15% + 模式均衡 10%
        </div>
        <div id="score-tables"></div>
    </div>
</div>

<!-- ===== 8. 智能推荐 ===== -->
<div class="section" style="border-color: rgba(233,69,96,0.4);">
    <div class="section-title" style="color:#e94560;">💎 智能推荐组合（基于概率评分）</div>
    <div class="section-body">
        <div class="copy-bar" id="copy-bar"></div>
        <div id="recommend-area"></div>
    </div>
</div>

<!-- ===== 9. 复式推荐 ===== -->
<div class="section" style="border-color: rgba(142,197,255,0.4);">
    <div class="section-title" style="color:#8ec5ff;">🎰 复式推荐（混合模式：每位动态选 2~5 个号码）</div>
    <div class="section-body">
        <div class="info-box" style="margin-top:0;">
            每位基于评分落差阈值动态决定选号数（2~5），高分离度号码多选、相近号码少选。复式总注数 = 各位选号数之乘积。
        </div>
        <div id="compound-info" style="margin:12px 0;"></div>
        <div id="compound-display" style="margin:12px 0;"></div>
        <div class="copy-bar" id="compound-copy-bar"></div>
        <div class="warn-box" style="margin-top:12px;">
            ⚠️ <b>免责声明：</b>彩票本质是独立随机事件，任何统计方法都无法准确预测未来开奖结果。本推荐仅基于历史数据的概率统计模型，仅供娱乐参考，请理性购彩。
        </div>
    </div>
</div>
</div>

<script>
const A = ${dataJson};
const COLORS = ['#e94560','#0984e3','#27ae60','#8e44ad','#f39c12'];
const CLS_POS = ['pos0','pos1','pos2','pos3','pos4'];

// ===== 1. 频次分布 =====
(function() {
    const tabsDiv = document.getElementById('freq-tabs');
    const chartsDiv = document.getElementById('freq-charts');
    const winLabels = ['最近10期','最近30期','最近50期','最近100期','全部' + A.N + '期'];

    A.freqWindows.forEach((fw, wi) => {
        const btn = document.createElement('button');
        btn.textContent = winLabels[wi] || ('最近' + fw.window + '期');
        btn.style.cssText = 'padding:4px 12px;border:1px solid rgba(255,255,255,0.2);border-radius:4px;background:' + (wi===0?'rgba(233,69,96,0.2)':'transparent') + ';color:#ddd;cursor:pointer;font-size:12px;';
        btn.onclick = () => renderFreqCharts(wi, fw, btn);
        tabsDiv.appendChild(btn);
    });

    function renderFreqCharts(wi, fw, activeBtn) {
        tabsDiv.querySelectorAll('button').forEach(b => { b.style.background = 'transparent'; });
        activeBtn.style.background = 'rgba(233,69,96,0.2)';
        let html = '<div class="grid-3">';
        for (let p = 0; p < A.posCount; p++) {
            const counts = fw.counts[p];
            const maxCnt = Math.max.apply(null, counts);
            html += '<div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:10px;">';
            html += '<span class="pos-tag ' + CLS_POS[p] + '">' + A.posLabels[p] + '位</span>';
            html += '<div class="chart-bar-wrap" style="height:40px;margin-top:6px;">';
            for (let n = 0; n <= 9; n++) {
                const h = maxCnt > 0 ? (counts[n] / maxCnt * 100) : 0;
                const isTop = counts[n] === maxCnt && counts[n] > 0;
                html += '<div class="chart-bar-cell" title="号码' + n + '：' + counts[n] + '次">';
                html += '<div class="chart-bar" style="height:' + h + '%;background:' + (isTop ? COLORS[p] : 'rgba(255,255,255,0.25)') + ';"></div>';
                html += '<div class="' + ('chart-label' + (isTop ? ' chart-label-top' : '')) + '">' + n + '</div>';
                html += '</div>';
            }
            html += '</div><div style="font-size:10px;color:#aaa;margin-top:4px;text-align:center;">'
                + counts.join(' | ') + '</div></div>';
        }
        html += '</div>';
        html += '<div class="info-box" style="margin-top:10px;">理论均匀频率：每号 ' + (fw.window/10).toFixed(1) + ' 次（每号概率 1/10）</div>';
        chartsDiv.innerHTML = html;
    }
    if (A.freqWindows.length > 0) {
        renderFreqCharts(0, A.freqWindows[0], tabsDiv.querySelector('button'));
    }
})();

// ===== 2. 遗漏值 & Z分数 =====
(function() {
    let html = '';
    for (let p = 0; p < A.posCount; p++) {
        html += '<div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:10px;">';
        html += '<div style="font-weight:600;margin-bottom:8px;"><span class="pos-tag ' + CLS_POS[p] + '">' + A.posLabels[p] + '位</span></div>';
        html += '<table><thead><tr><th>号码</th><th>出现次数</th><th>理论期望</th><th>Z分数</th><th>分类</th><th>遗漏值</th></tr></thead><tbody>';
        for (let n = 0; n <= 9; n++) {
            const cnt = A.allCounts[p][n];
            const z = A.zScores[p][n].toFixed(2);
            const cls = A.classification[p][n];
            const mis = A.missing[p][n];
            const clsBadge = cls === '热' ? '<span class="badge-hot">热号</span>'
                : cls === '冷' ? '<span class="badge-cold">冷号</span>'
                : '<span class="badge-warm">温号</span>';
            const zColor = z >= 1.5 ? '#e94560' : z <= -1.5 ? '#0984e3' : '#aaa';
            const misColor = mis >= 15 ? '#e94560' : mis >= 8 ? '#feca57' : '#2ecc71';
            html += '<tr>' +
                '<td><span class="highlight-num" style="background:rgba(255,255,255,0.08);color:#feca57;font-size:14px;">' + n + '</span></td>' +
                '<td>' + cnt + '</td>' +
                '<td>' + (A.N/10).toFixed(1) + '</td>' +
                '<td style="color:' + zColor + ';font-weight:bold;">' + z + '</td>' +
                '<td>' + clsBadge + '</td>' +
                '<td style="color:' + misColor + ';font-weight:bold;">' + mis + '期</td>' +
                '</tr>';
        }
        html += '</tbody></table></div>';
    }
    document.getElementById('missing-z-grid').innerHTML = html;
})();

// ===== 3. 卡方检验 =====
(function() {
    let html = '';
    for (let p = 0; p < A.posCount; p++) {
        const cr = A.chiSquareResults[p];
        const sigColor = cr.significant ? '#e94560' : '#2ecc71';
        const sigText = cr.significant ? '⚠ 显著偏离均匀分布（p<0.05）' : '✅ 未显著偏离均匀分布（p≥0.05）';
        html += '<div style="margin-bottom:8px;">';
        html += '<span class="pos-tag ' + CLS_POS[p] + '">' + A.posLabels[p] + '位</span> ';
        html += '<span>χ² = <b>' + cr.chi2 + '</b> (df=' + cr.dof + ') &nbsp; p = <b style="color:' + sigColor + '">' + cr.pValue + '</b></span>';
        html += ' &nbsp; <span style="color:' + sigColor + ';font-size:11px;">' + sigText + '</span>';
        html += '</div>';
    }
    html += '<div class="info-box" style="margin-top:4px;">卡方检验验证每位号码是否服从均匀分布(1/10)。若p<0.05，说明该位号码可能存在偏差；若p≥0.05，说明统计上未检测到显著偏差，符合随机分布。</div>';
    document.getElementById('chi-square-section').innerHTML = html;
})();

// ===== 4. 和值 =====
(function() {
    const ss = A.sumStats;
    let html = '<div class="stat-card"><div class="val">' + ss.latest + '</div><div class="lbl">最新和值</div></div>';
    html += '<div class="stat-card"><div class="val">' + ss.mean + '</div><div class="lbl">实际均值</div></div>';
    html += '<div class="stat-card"><div class="val">' + ss.theoreticalMean.toFixed(1) + '</div><div class="lbl">理论均值</div></div>';
    html += '<div class="stat-card"><div class="val">' + ss.min + '~' + ss.max + '</div><div class="lbl">极值范围</div></div>';
    html += '<div class="stat-card"><div class="val">' + ss.theoreticalStdDev + '</div><div class="lbl">理论标准差</div></div>';
    document.getElementById('sum-stats').innerHTML = html;

    // 和值指示器
    const fullRange = A.posCount * 9;
    const minRange = 0;
    const ratio = (ss.latest - minRange) / (fullRange - minRange);
    document.getElementById('sum-indicator').style.left = (ratio * 100) + '%';
    document.getElementById('sum-label').textContent = '← 最新和值 ' + ss.latest + '（理论：每位4.5×' + A.posCount + '=' + ss.theoreticalMean.toFixed(1) + '）';
})();

// ===== 5. 跨度分布 =====
(function() {
    const maxSpan = Math.max.apply(null, A.spanDist);
    let html = '';
    for (let s = 0; s <= 9; s++) {
        const cnt = A.spanDist[s];
        const h = maxSpan > 0 ? (cnt / maxSpan * 100) : 0;
        html += '<div class="chart-bar-cell" title="跨度' + s + '：' + cnt + '次">';
        html += '<div class="chart-bar" style="height:' + h + '%;background:' + (h > 50 ? '#e94560' : 'rgba(255,255,255,0.3)') + ';"></div>';
        html += '<div class="chart-label">' + s + (cnt > 0 ? '<br>' + cnt : '') + '</div>';
        html += '</div>';
    }
    document.getElementById('span-chart').innerHTML = html;
})();

// ===== 6. 模式分布 =====
(function() {
    const ps = A.patternStats;
    const buildTable = (title, data) => {
        const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
        let t = '<table><thead><tr><th>模式</th><th>次数</th><th>占比</th></tr></thead><tbody>';
        sorted.forEach(([k, v]) => {
            const pct = (v/A.N*100).toFixed(1);
            t += '<tr><td>' + k + '</td><td>' + v + '</td><td>' + pct + '%</td></tr>';
        });
        t += '</tbody></table>';
        return t;
    };

    let html = '<div><div style="font-weight:600;margin-bottom:6px;color:#feca57;">奇:偶</div>' + buildTable('odd:even', ps.oddEven) + '</div>';
    html += '<div><div style="font-weight:600;margin-bottom:6px;color:#feca57;">大:小（≥5为大）</div>' + buildTable('big:small', ps.bigSmall) + '</div>';
    html += '<div><div style="font-weight:600;margin-bottom:6px;color:#feca57;">0路:1路:2路</div>' + buildTable('route', ps.route) + '</div>';
    document.getElementById('pattern-grid').innerHTML = html;
})();

// ===== 7. 综合智能评分表 =====
(function() {
    let html = '';
    for (let p = 0; p < A.posCount; p++) {
        const scores = A.scores[p];
        html += '<div style="margin-bottom:12px;">';
        html += '<span class="pos-tag ' + CLS_POS[p] + '">' + A.posLabels[p] + '位</span>';
        html += '<table style="margin-top:6px;"><thead><tr><th>排名</th><th>号码</th><th>综合评分</th><th>频次(30%)</th><th>遗漏(25%)</th><th>Z分数(20%)</th><th>动量(15%)</th><th>模式(10%)</th></tr></thead><tbody>';
        scores.forEach((s, i) => {
            const d = s.detail;
            const barClass = i < 3 ? 'style="color:#e94560;font-weight:bold"' : '';
            html += '<tr' + (i < 3 ? ' style="background:rgba(233,69,96,0.05)"' : '') + '>' +
                '<td>' + (i + 1) + '</td>' +
                '<td ' + barClass + '>' + s.num + '</td>' +
                '<td style="font-weight:bold;color:#feca57;">' + s.score.toFixed(4) + '</td>' +
                '<td>' + d.freqScore.toFixed(4) + '</td>' +
                '<td>' + d.missScore.toFixed(4) + '</td>' +
                '<td>' + d.zScoreNorm.toFixed(4) + '</td>' +
                '<td>' + d.momentumScore.toFixed(4) + '</td>' +
                '<td>' + d.patternAdj.toFixed(4) + '</td>' +
                '</tr>';
        });
        html += '</tbody></table></div>';
    }
    document.getElementById('score-tables').innerHTML = html;
})();

// ===== 8. 智能推荐 =====
(function() {
    // 全部号码字符串，用于整体复制
    const singlesTitle = '【' + A.cfgEmoji + A.cfgName + ' 概率推荐单式TOP8】\\n' +
        '基础期号：第' + A.latestPeriod + '期（' + A.latestDate + '）\\n' +
        '样本量：' + A.N + '期 | 每位TOP4组合 | 共' + A.totalCombos + '注取TOP8\\n' +
        '----------------------------------------';
    const allNumStr = singlesTitle + '\\n' + A.bestSingles.map(s => s.combo.join(' ')).join('\\n');

    // 顶部全局复制按钮
    const copyBar = document.getElementById('copy-bar');
    copyBar.innerHTML = '<button class="btn-copy" id="btn-copy-all" title="复制全部推荐号码">📋 一键复制全部推荐号码</button>';
    document.getElementById('btn-copy-all').onclick = () => {
        navigator.clipboard.writeText(allNumStr).then(() => {
            const btn = document.getElementById('btn-copy-all');
            btn.textContent = '✅ 已复制！';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = '📋 一键复制全部推荐号码'; btn.classList.remove('copied'); }, 2000);
        });
    };

    let html = '';
    A.bestSingles.forEach((s, i) => {
        const isTop = i === 0;
        const comboStr = s.combo.join(' ');
        html += '<div class="rec-card' + (isTop ? ' top1' : '') + '">';
        html += '<div class="rank">推荐 #' + (i + 1) + (isTop ? ' 🥇 最佳' : '') + '</div>';
        html += '<div class="nums" id="combo-' + i + '">';
        s.combo.forEach((n, pi) => {
            html += '<span style="color:' + COLORS[pi % COLORS.length] + '">' + n + '</span>';
            if (pi < s.combo.length - 1) html += ' ';
        });
        html += '</div>';
        html += '<div class="score">综合评分：<b style="color:#feca57">' + s.score.toFixed(4) + '</b></div>';
        html += '<button class="btn-copy btn-copy-sm" data-combo="' + comboStr + '" data-idx="' + i + '">📋 复制</button>';
        html += '</div>';
    });
    html += '<div style="margin-top:12px;font-size:12px;color:#aaa;">每位选TOP4，共 ' + A.totalCombos + ' 种组合，按综合评分排序取TOP8</div>';
    document.getElementById('recommend-area').innerHTML = '<div class="recommend-area">' + html + '</div>';

    // 单个复制按钮事件
    document.querySelectorAll('.btn-copy-sm').forEach(btn => {
        btn.onclick = function(e) {
            e.stopPropagation();
            const comboText = this.getAttribute('data-combo');
            navigator.clipboard.writeText(comboText).then(() => {
                this.textContent = '✅ 已复制';
                this.classList.add('copied');
                setTimeout(() => { this.textContent = '📋 复制'; this.classList.remove('copied'); }, 2000);
            });
        };
    });
})();

// ===== 9. 复式推荐 =====
(function() {
    if (!A.compoundPerPos) return;
    const infoDiv = document.getElementById('compound-info');
    const dispDiv = document.getElementById('compound-display');
    const copyBar = document.getElementById('compound-copy-bar');

    // 信息条
    const perPosStr = A.compoundPerPos.map((p, i) => A.posLabels[i] + ':' + p.length + '个').join(' · ');
    infoDiv.innerHTML = '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">' +
        '<span style="background:rgba(142,197,255,0.15);color:#8ec5ff;padding:4px 12px;border-radius:4px;font-size:13px;">📋 ' + perPosStr + '</span>' +
        '<span style="background:rgba(254,202,87,0.15);color:#feca57;padding:4px 12px;border-radius:4px;font-size:13px;">🔢 总注数：' + A.compoundTotalCombos + ' 注</span>' +
        '<span style="background:rgba(46,204,113,0.15);color:#2ecc71;padding:4px 12px;border-radius:4px;font-size:13px;">⭐ 综合评分：' + A.compoundScore.toFixed(4) + '</span>' +
        '</div>';

    // 各位号码展示
    let html = '<div style="display:flex;gap:12px;flex-wrap:wrap;">';
    A.compoundPerPos.forEach((picks, p) => {
        const color = COLORS[p % COLORS.length];
        html += '<div style="flex:1;min-width:180px;background:rgba(0,0,0,0.2);border-radius:8px;padding:12px;border-left:3px solid ' + color + ';">';
        html += '<div style="font-weight:600;margin-bottom:8px;"><span class="pos-tag ' + CLS_POS[p] + '">' + A.posLabels[p] + '位</span> <span style="color:#888;font-size:11px;">选 ' + picks.length + ' 个</span></div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        // 按号码排序展示
        picks.slice().sort((a, b) => a - b).forEach(n => {
            const scoreObj = A.scores[p].find(s => s.num === n);
            const score = scoreObj ? scoreObj.score.toFixed(4) : '?';
            const rank = A.scores[p].findIndex(s => s.num === n) + 1;
            html += '<div style="text-align:center;">';
            html += '<div style="width:36px;height:36px;line-height:36px;border-radius:50%;background:' + color + ';color:#fff;font-weight:bold;font-size:16px;margin:0 auto;">' + n + '</div>';
            html += '<div style="font-size:10px;color:#888;margin-top:2px;">#' + rank + '</div>';
            html += '<div style="font-size:9px;color:#666;">' + score + '</div>';
            html += '</div>';
        });
        html += '</div></div>';
    });
    html += '</div>';
    dispDiv.innerHTML = html;

    // 复制按钮
    const compoundTitle = '【' + A.cfgEmoji + A.cfgName + ' 概率推荐复式方案】\\n' +
        '基础期号：第' + A.latestPeriod + '期（' + A.latestDate + '）\\n' +
        '样本量：' + A.N + '期 | 复式规格：' + A.compoundPerPos.map((picks, p) => A.posLabels[p] + '位' + picks.length + '个').join(' · ') + ' | 总注数：' + A.compoundTotalCombos + '注\\n' +
        '综合评分：' + A.compoundScore.toFixed(4) + '\\n' +
        '----------------------------------------';
    const compoundNumStr = A.compoundPerPos.map((picks, p) => A.posLabels[p] + '位: ' + picks.slice().sort((a, b) => a - b).join(',')).join('\\n');
    const compoundStr = compoundTitle + '\\n' + compoundNumStr;
    copyBar.innerHTML = '<button class="btn-copy" id="btn-copy-compound">📋 一键复制复式方案</button>';
    document.getElementById('btn-copy-compound').onclick = () => {
        navigator.clipboard.writeText(compoundStr).then(() => {
            const btn = document.getElementById('btn-copy-compound');
            btn.textContent = '✅ 已复制！';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = '📋 一键复制复式方案'; btn.classList.remove('copied'); }, 2000);
        });
    };
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
