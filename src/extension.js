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
    },
    {
        key: 'kl8',
        name: '快乐8',
        emoji: '🎱',
        file: 'kl8.json',
        positions: [],
        allNums: (h) => h.num,
        bigFn: (n) => n >= 41,
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

    // 快乐8遗漏分层命令
    let kl8MissDisposable = vscode.commands.registerCommand('myPlugin.kl8Miss', async () => {
        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '10 期', value: 10 },
                { label: '20 期', value: 20 },
                { label: '30 期', value: 30 },
                { label: '50 期', value: 50 },
                { label: '80 期', value: 80 },
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '全部', value: 0 }
            ],
            { placeHolder: '选择统计的历史期数' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        let history;
        try {
            const cfg = LOTTERY_TYPES.find(c => c.key === 'kl8');
            if (!cfg) return;
            history = loadLotteryData(cfg);
            if (history.length === 0) {
                vscode.window.showWarningMessage('快乐8数据为空，请先刷新数据');
                return;
            }
        } catch (e) {
            const choice = vscode.window.showInformationMessage(
                '🎱 还没有快乐8数据，需要先爬取数据。是否立即爬取？',
                '立即爬取', '稍后再说'
            );
            choice.then(btn => {
                if (btn === '立即爬取') {
                    vscode.commands.executeCommand('myPlugin.refreshData');
                }
            });
            return;
        }

        // 注意：loadLotteryData 内部已 reverse（旧→新），这里切片后要还原为最新在前
        const sliced = (limit > 0 ? history.slice(-limit) : history);
        const rows = sliced.slice().reverse();

        const panel = vscode.window.createWebviewPanel(
            'kl8Miss',
            '快乐8 遗漏/走势分析',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        // 监听来自 Webview 的消息（用于复制功能）
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                panel.webview.postMessage({ command: 'copySuccess' });
                return;
            }
        });
        panel.webview.html = getKl8MissHtml(rows);
    });
    context.subscriptions.push(kl8MissDisposable);

    // 大乐透遗漏分层命令（照搬快乐8模式）
    let dltMissDisposable = vscode.commands.registerCommand('myPlugin.dltMiss', async () => {
        const limitPick = await vscode.window.showQuickPick(
            [
                { label: '10 期', value: 10 },
                { label: '20 期', value: 20 },
                { label: '30 期', value: 30 },
                { label: '50 期', value: 50 },
                { label: '80 期', value: 80 },
                { label: '100 期', value: 100 },
                { label: '200 期', value: 200 },
                { label: '全部', value: 0 }
            ],
            { placeHolder: '选择统计的历史期数' }
        );
        if (!limitPick) return;
        const limit = limitPick.value;

        let history;
        try {
            const cfg = LOTTERY_TYPES.find(c => c.key === 'dlt');
            if (!cfg) return;
            history = loadLotteryData(cfg);
            if (history.length === 0) {
                vscode.window.showWarningMessage('大乐透数据为空，请先刷新数据');
                return;
            }
        } catch (e) {
            const choice = vscode.window.showInformationMessage(
                '🎯 还没有大乐透数据，需要先爬取数据。是否立即爬取？',
                '立即爬取', '稍后再说'
            );
            choice.then(btn => {
                if (btn === '立即爬取') {
                    vscode.commands.executeCommand('myPlugin.refreshData');
                }
            });
            return;
        }

        const sliced = (limit > 0 ? history.slice(-limit) : history);
        const rows = sliced.slice().reverse();

        const panel = vscode.window.createWebviewPanel(
            'dltMiss',
            '大乐透 遗漏/走势分析',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getDltMissHtml(rows);
    });
    context.subscriptions.push(dltMissDisposable);

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

        // history 已是升序（旧→新），直接取末尾即最新
        const dataToAnalyze = limitPick.value > 0 ? history.slice(-limitPick.value) : history;
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

    // ========== 排三口诀工具 ==========
    let pl3FormulaDisposable = vscode.commands.registerCommand('myPlugin.pl3Formula', async () => {
        // 先加载最新一期数据用于实战推导
        const cfg = LOTTERY_TYPES.find(c => c.key === 'pl3');
        let latest = null, history = [];
        try {
            if (cfg) {
                history = loadLotteryData(cfg);
                if (history.length > 0) latest = history[history.length - 1];
            }
        } catch (e) { /* 数据缺失也允许查看口诀 */ }

        const panel = vscode.window.createWebviewPanel(
            'pl3Formula',
            '📜 排列三必背口诀',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                return;
            }
        });
        panel.webview.html = getPl3FormulaHtml(latest, history);
    });
    context.subscriptions.push(pl3FormulaDisposable);

    // ========== 排列五口诀工具 ==========
    let pl5FormulaDisposable = vscode.commands.registerCommand('myPlugin.pl5Formula', async () => {
        const cfg = LOTTERY_TYPES.find(c => c.key === 'pl5');
        let latest = null, history = [];
        try {
            if (cfg) {
                history = loadLotteryData(cfg);
                if (history.length > 0) latest = history[history.length - 1];
            }
        } catch (e) { /* 数据缺失也允许查看口诀 */ }

        const panel = vscode.window.createWebviewPanel(
            'pl5Formula',
            '🎲 排列五口诀',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                return;
            }
        });
        panel.webview.html = getPl5FormulaHtml(latest, history);
    });
    context.subscriptions.push(pl5FormulaDisposable);

    // ========== 福彩3D口诀工具 ==========
    let fc3dFormulaDisposable = vscode.commands.registerCommand('myPlugin.fc3dFormula', async () => {
        const cfg = LOTTERY_TYPES.find(c => c.key === 'fc3d');
        let latest = null, history = [];
        try {
            if (cfg) {
                history = loadLotteryData(cfg);
                if (history.length > 0) latest = history[history.length - 1];
            }
        } catch (e) { /* 数据缺失也允许查看口诀 */ }

        const panel = vscode.window.createWebviewPanel(
            'fc3dFormula',
            '🎁 福彩3D口诀',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                return;
            }
        });
        panel.webview.html = getFc3dFormulaHtml(latest, history);
    });
    context.subscriptions.push(fc3dFormulaDisposable);

    // ========== 大乐透智能精选 ==========
    let smartFilterDisposable = vscode.commands.registerCommand('myPlugin.smartFilter', async () => {
        // 创建Webview面板
        const panel = vscode.window.createWebviewPanel(
            'smartFilter',
            '🎯 大乐透智能精选',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        // 监听消息
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'runFilter') {
                try {
                    const result = await runSmartFilter(message.reds, message.blues, message.count);
                    panel.webview.postMessage({ command: 'filterResult', data: result });
                } catch (e) {
                    panel.webview.postMessage({ command: 'error', message: e.message });
                }
                return;
            }
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                panel.webview.postMessage({ command: 'copySuccess' });
                return;
            }
        });

        // 初始界面
        panel.webview.html = getSmartFilterHtml();
    });

    context.subscriptions.push(smartFilterDisposable);

    // 双色球智能精选命令
    let ssqFilterDisposable = vscode.commands.registerCommand('myPlugin.ssqFilter', async () => {
        const panel = vscode.window.createWebviewPanel(
            'ssqFilter',
            '🔴 双色球智能精选',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'runFilter') {
                try {
                    const result = await runSsqFilter(message.reds, message.blues, message.count);
                    panel.webview.postMessage({ command: 'filterResult', data: result });
                } catch (e) {
                    panel.webview.postMessage({ command: 'error', message: e.message });
                }
                return;
            }
            if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
                panel.webview.postMessage({ command: 'copySuccess' });
                return;
            }
        });

        panel.webview.html = getSsqFilterHtml();
    });
    context.subscriptions.push(ssqFilterDisposable);
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

    // ========== ML 多模型对比预测 ==========
    let mlCompareDisposable = vscode.commands.registerCommand('myPlugin.mlCompare', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '3位号码 多模型对比' },
                { label: '🎰 排列五', value: 'pl5', description: '5位号码 多模型对比' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '3位号码 多模型对比' }
            ],
            { placeHolder: '选择彩种' }
        );
        if (!pick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let history;
        try {
            history = loadLotteryData(cfg);
            if (history.length < 100) {
                // 数据不足，先尝试自动爬取
                const crawlAction = await vscode.window.showInformationMessage(
                    `数据不足（仅 ${history.length} 期，需 ≥100 期）。\n是否自动爬取最新数据？`,
                    { modal: true },
                    '自动爬取',
                    '取消'
                );
                if (crawlAction !== '自动爬取') return;
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `正在爬取 ${cfg.name} 数据...`,
                    cancellable: false
                }, async () => {
                    await autoRefresh(500, true);
                });
                history = loadLotteryData(cfg);
                if (history.length < 100) {
                    vscode.window.showWarningMessage('爬取后数据仍不足，请检查网络后重试「🔄 刷新彩票数据」');
                    return;
                }
            }
        } catch (e) {
            // 数据文件不存在，自动爬取
            const crawlAction = await vscode.window.showInformationMessage(
                `数据文件不存在（${cfg.name}）。是否自动爬取？`,
                { modal: true },
                '自动爬取',
                '取消'
            );
            if (crawlAction !== '自动爬取') return;
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `正在爬取 ${cfg.name} 数据...`,
                    cancellable: false
                }, async () => {
                    await autoRefresh(500, true);
                });
                history = loadLotteryData(cfg);
                if (history.length < 100) {
                    vscode.window.showWarningMessage('爬取后数据仍不足，请检查网络后重试');
                    return;
                }
            } catch (e2) {
                vscode.window.showErrorMessage('爬取失败: ' + e2.message + '\n请尝试点击侧边栏的「🔄 刷新彩票数据」');
                return;
            }
        }

        const testPick = await vscode.window.showQuickPick(
            [
                { label: '30 期回测', value: 30, description: '快速（30次预测/位）' },
                { label: '50 期回测', value: 50, description: '标准（50次预测/位）' },
                { label: '100 期回测', value: 100, description: '较长（耗时）' }
            ],
            { placeHolder: '选择回测期数（越大越慢）' }
        );
        if (!testPick) return;

        // 创建并显示进度
        const panel = vscode.window.createWebviewPanel(
            'mlCompare',
            '🧠 模型对比 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = getMLCompareLoadingHtml(cfg.name);

        try {
            const result = await runMLCompare(history, testPick.value);
            panel.webview.html = getMLCompareHtml(result, cfg, history.length, testPick.value);
        } catch (e) {
            panel.webview.html = `<h2 style="color:red;font-family:sans-serif;padding:20px">错误：${e.message}</h2>
                <pre style="padding:20px;font-family:monospace;background:#f5f5f5">${e.stack || ''}</pre>`;
        }
    });
    context.subscriptions.push(mlCompareDisposable);

    // ========== 群鸟生命游戏 ==========
    let boidsLifeDisposable = vscode.commands.registerCommand('myPlugin.boidsLife', () => {
        const panel = vscode.window.createWebviewPanel(
            'boidsLife',
            '🐦 群鸟生命游戏',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getBoidsLifeHtml();
    });
    context.subscriptions.push(boidsLifeDisposable);

    // ========== 群鸟号码模拟（真实历史数据驱动）==========
    let boidsNumberDisposable = vscode.commands.registerCommand('myPlugin.boidsNumber', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '3位号码 一起分析' },
                { label: '🎰 排列五', value: 'pl5', description: '5位号码 一起分析' }
            ],
            { placeHolder: '选择彩种' }
        );
        if (!pick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let history;
        try {
            history = loadLotteryData(cfg);
            if (history.length < 50) {
                vscode.window.showWarningMessage('数据不足（需 ≥50 期），请先刷新数据');
                return;
            }
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        // 取所有位数的数据（不再分位选择）
        const posLabels = cfg.positions.map(p => p.label + '位');
        const allNumbers = cfg.positions.map(p => history.map(h => p.pick(h)));
        const periods = history.map(h => h.period);

        const panel = vscode.window.createWebviewPanel(
            'boidsNumber',
            '🎲 号码分析 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getBoidsNumberHtml(cfg.name, posLabels, allNumbers, periods);
    });
    context.subscriptions.push(boidsNumberDisposable);

    // ========== 质合形态分析 ==========
    let zhiHeDisposable = vscode.commands.registerCommand('myPlugin.zhiHeAnalysis', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '3位 质合形态分析' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '3位 质合形态分析' },
                { label: '🎰 排列五', value: 'pl5', description: '5位 质合形态分析' }
            ],
            { placeHolder: '选择彩种' }
        );
        if (!pick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        let history;
        try {
            history = loadLotteryData(cfg);
            if (history.length < 50) {
                vscode.window.showWarningMessage('数据不足（需 ≥50 期），请先刷新数据');
                return;
            }
        } catch (e) {
            vscode.window.showErrorMessage('读取数据失败: ' + e.message);
            return;
        }

        const posLabels = cfg.positions.map(p => p.label + '位');
        const allNumbers = cfg.positions.map(p => history.map(h => p.pick(h)));
        const periods = history.map(h => h.period);

        const panel = vscode.window.createWebviewPanel(
            'zhiHeAnalysis',
            '📐 质合形态分析 - ' + cfg.name,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getZhiHeHtml(cfg.name, posLabels, allNumbers, periods);
    });
    context.subscriptions.push(zhiHeDisposable);

    // ===== 状态栏时间 + 每日温馨话语（hover tooltip） =====
    // 在状态栏显示 🕐 HH:MM:SS 图标，鼠标悬停显示日期 + 温馨话语
    // 不影响代码阅读区域，完全在状态栏里

    // 状态栏 item（始终创建，通过 visibility 控制显示）
    const timeStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    timeStatusItem.command = 'myPlugin.refreshTimeStatus';
    // 用 codicon + 颜色 - VSCode 内置图标，用 color 属性让它变成彩色
    timeStatusItem.text = '$(clock) --:--:--';
    // 关键：color 让图标 + 文字一起变彩色（橘黄色）
    timeStatusItem.color = '#FFB45B';
    context.subscriptions.push(timeStatusItem);

    // 启动时根据之前的设置决定是否显示
    if (context.globalState.get('timeStatusMode', 'shown') === 'shown') {
        timeStatusItem.show();
    }
    updateTimeStatusItem(timeStatusItem);

    // 每秒更新（每分钟在用户视觉上更省心，但每秒更准）
    const timeStatusTimer = setInterval(() => updateTimeStatusItem(timeStatusItem), 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timeStatusTimer) });

    // 切换显示/隐藏（每次点击重新读取 globalState，避免 const 缓存旧值）
    let toggleTimeBgDisposable = vscode.commands.registerCommand('myPlugin.toggleTimeBackground', async () => {
        const currentMode = context.globalState.get('timeStatusMode', 'shown');
        const newMode = currentMode === 'shown' ? 'hidden' : 'shown';
        await context.globalState.update('timeStatusMode', newMode);
        if (newMode === 'shown') {
            timeStatusItem.show();
            updateTimeStatusItem(timeStatusItem);
            vscode.window.showInformationMessage('时间状态栏已显示 - 鼠标悬停查看日期和温馨话语');
        } else {
            timeStatusItem.hide();
            vscode.window.showInformationMessage('时间状态栏已隐藏');
        }
    });
    context.subscriptions.push(toggleTimeBgDisposable);

    // 手动刷新（点击图标触发）
    let refreshTimeStatusDisposable = vscode.commands.registerCommand('myPlugin.refreshTimeStatus', () => {
        updateTimeStatusItem(timeStatusItem);
        // 短暂显示 tooltip
        vscode.window.showInformationMessage(timeStatusItem.tooltip || '时间', { modal: false });
    });
    context.subscriptions.push(refreshTimeStatusDisposable);

    // ===== 3D 摇奖机动画 =====
    let drawMachineDisposable = vscode.commands.registerCommand('myPlugin.drawMachine', async () => {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '🎯 排列三', value: 'pl3', description: '3 位号码 0-9' },
                { label: '🎰 排列五', value: 'pl5', description: '5 位号码 0-9' },
                { label: '🎁 福彩3D', value: 'fc3d', description: '3 位号码 0-9' }
            ],
            { placeHolder: '选择要模拟摇奖的彩种' }
        );
        if (!pick) return;

        const cfg = LOTTERY_TYPES.find(c => c.key === pick.value);
        if (!cfg) return;

        const panel = vscode.window.createWebviewPanel(
            'drawMachine',
            '3D 摇奖机 - ' + cfg.name,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = getDrawMachineHtml(cfg);
    });
    context.subscriptions.push(drawMachineDisposable);


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
                this.createItem('🎱 快乐8遗漏分层', 'myPlugin.kl8Miss', '🎱'),
                this.createItem('🎯 大乐透遗漏分层', 'myPlugin.dltMiss', '🎯'),
                this.createItem('🛤️ 012路趋势', 'myPlugin.roadAnalysis', '🛤️'),
                this.createItem('📜 排三口诀', 'myPlugin.pl3Formula', '📜'),
                this.createItem('🎲 排五口诀', 'myPlugin.pl5Formula', '🎲'),
                this.createItem('🎁 3D口诀', 'myPlugin.fc3dFormula', '🎁'),
                this.createItem('🎯 大乐透精选', 'myPlugin.smartFilter', '🎯'),
                this.createItem('🔴 双色球精选', 'myPlugin.ssqFilter', '🔴'),
                this.createItem('🧪 概率回测', 'myPlugin.probabilityBacktest', '🧪'),
                this.createItem('📈 均线形态', 'myPlugin.maPatterns', '📈'),
                this.createItem('🧠 模型对比预测', 'myPlugin.mlCompare', '🧠'),
                this.createItem('🐦 群鸟生命游戏', 'myPlugin.boidsLife', '🐦'),
                this.createItem('🎲 群鸟号码模拟', 'myPlugin.boidsNumber', '🎲'),
                this.createItem('📐 质合形态分析', 'myPlugin.zhiHeAnalysis', '📐'),
                this.createItem('🔮 预测记录', 'myPlugin.showPredictions', '🔮'),
                this.createItem('🕐 显示当前时间', 'myPlugin.showTime', '🕐'),
                this.createItem('🕙 时间背景水印', 'myPlugin.toggleTimeBackground', '🕙'),
                this.createItem('🎰 3D摇奖机', 'myPlugin.drawMachine', '🎰'),
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
 * 3D 摇奖机动画 HTML
 * 使用 Three.js（CDN）模拟真实摇奖机：透明球体 + 内部翻滚的号码球
 * @param {Object} cfg - LOTTERY_TYPES 中的彩种配置
 */
function getDrawMachineHtml(cfg) {
    const posCount = cfg.positions.length;
    const posLabels = cfg.positions.map(p => p.label).join(' / ');
    // 多位独立摇奖机：每位一台机器，并排排列
    // 每台机器独立有自己的玻璃球、号码球、出球口、展示槽
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>3D 摇奖机 - ${cfg.name}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; color: #fff; font-family: "Segoe UI","Microsoft YaHei",sans-serif; }
#app { position: relative; width: 100vw; height: 100vh; background: radial-gradient(ellipse at 50% 35%, #1a1f3a 0%, #0a0c1a 60%, #050610 100%); }
#canvas3d { display: block; width: 100%; height: 100%; }

.top-bar { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); z-index: 10; text-align: center; pointer-events: none; }
.top-bar h1 { font-size: 22px; font-weight: 700; color: #ffd700; text-shadow: 0 0 12px rgba(255,215,0,.6), 0 2px 4px rgba(0,0,0,.8); letter-spacing: 1px; }
.top-bar .sub { font-size: 12px; color: #8a93b8; margin-top: 4px; text-shadow: 0 1px 2px rgba(0,0,0,.8); }

.controls { position: absolute; bottom: 28px; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; gap: 14px; }
.btn { padding: 11px 28px; font-size: 15px; font-weight: 600; border: none; border-radius: 28px; cursor: pointer; color: #fff; background: linear-gradient(135deg,#11998e,#38ef7d); box-shadow: 0 6px 18px rgba(56,239,125,.45), inset 0 1px 0 rgba(255,255,255,.3); transition: transform .15s, box-shadow .15s; }
.btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(56,239,125,.6), inset 0 1px 0 rgba(255,255,255,.3); }
.btn:disabled { opacity: .35; cursor: not-allowed; }
.btn.secondary { background: linear-gradient(135deg,#4b6cb7,#182848); box-shadow: 0 6px 18px rgba(75,108,183,.45), inset 0 1px 0 rgba(255,255,255,.2); }

.result-panel { position: absolute; top: 18px; right: 18px; z-index: 10; background: linear-gradient(135deg, rgba(30,32,55,.92), rgba(20,22,40,.92)); border: 1px solid rgba(255,215,0,.35); border-radius: 12px; padding: 14px 18px; min-width: ${Math.max(200, posCount * 46 + 30)}px; box-shadow: 0 8px 24px rgba(0,0,0,.5); backdrop-filter: blur(6px); }
.result-panel .label { font-size: 12px; color: #ffd700; margin-bottom: 8px; letter-spacing: 1px; }
.result-panel .nums { display: flex; flex-wrap: nowrap; gap: 8px; justify-content: center; }
.result-panel .pos-label { display: flex; gap: 8px; justify-content: center; margin-bottom: 6px; }
.result-panel .pos-label span { width: 38px; text-align: center; font-size: 11px; color: #6ea0ff; }
.result-panel .ball { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 800; color: #fff; background: radial-gradient(circle at 32% 28%, #ff8a8a, #c0392b 60%, #7a1a14 100%); box-shadow: 0 0 12px rgba(231,76,60,.7), inset -2px -3px 6px rgba(0,0,0,.4), inset 2px 2px 4px rgba(255,255,255,.3); }
.result-panel .ball.empty { background: radial-gradient(circle at 32% 28%, #2a2a3a, #15151f); box-shadow: inset 0 0 6px rgba(0,0,0,.6); color: #445; }

.history-panel { position: absolute; top: 18px; left: 18px; z-index: 10; background: linear-gradient(135deg, rgba(30,32,55,.92), rgba(20,22,40,.92)); border: 1px solid rgba(80,120,255,.35); border-radius: 12px; padding: 12px 16px; max-height: 55vh; overflow-y: auto; min-width: 170px; box-shadow: 0 8px 24px rgba(0,0,0,.5); backdrop-filter: blur(6px); }
.history-panel .label { font-size: 12px; color: #6ea0ff; margin-bottom: 8px; letter-spacing: 1px; }
.history-panel .item { font-size: 13px; color: #cde; margin: 5px 0; font-family: "Consolas",monospace; }
.history-panel .item .badge { display: inline-block; min-width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 5px; background: linear-gradient(135deg,#2d4a8a,#1a3a6a); margin-right: 6px; font-size: 11px; color: #fff; }
.history-panel::-webkit-scrollbar { width: 6px; }
.history-panel::-webkit-scrollbar-thumb { background: rgba(120,160,255,.4); border-radius: 3px; }

.status-text { position: absolute; bottom: 88px; left: 50%; transform: translateX(-50%); z-index: 10; font-size: 14px; color: #ffcc00; text-shadow: 0 1px 4px rgba(0,0,0,.8); pointer-events: none; }

.hint { position: absolute; bottom: 12px; right: 18px; z-index: 10; font-size: 11px; color: #555a72; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <canvas id="canvas3d"></canvas>
  <div class="top-bar">
    <h1>🎰 ${cfg.name} · 3D 摇奖机</h1>
    <div class="sub">位号：${posLabels} ｜ 每位 0-9</div>
  </div>
  <div class="history-panel">
    <div class="label">📜 历史摇奖</div>
    <div id="historyList"></div>
  </div>
  <div class="result-panel">
    <div class="label">🎯 本期结果（每位独立摇奖机）</div>
    <div class="pos-label">${cfg.positions.map(p => `<span>${p.label}位</span>`).join('')}</div>
    <div class="nums" id="resultNums"></div>
  </div>
  <div class="status-text" id="statusText">点击"开始摇奖"启动</div>
  <div class="controls">
    <button class="btn" id="btnStart">🎰 开始摇奖</button>
    <button class="btn secondary" id="btnReset" disabled>🔄 重置</button>
  </div>
  <div class="hint">🖱️ 拖拽旋转 · 滚轮缩放</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
<script>
(function(){
  const POS_COUNT = ${posCount};
  const NUM_RANGE = 10;
  // 位号标签
  const POS_LABELS = ${JSON.stringify(cfg.positions.map(p => p.label))};

  // ====== Renderer + Scene ======
  const canvas = document.getElementById('canvas3d');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070810);
  scene.fog = new THREE.Fog(0x070810, 14, 32);

  // ====== 程序化环境贴图 ======
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 512; envCanvas.height = 256;
  const ectx = envCanvas.getContext('2d');
  const eg = ectx.createLinearGradient(0, 0, 0, 256);
  eg.addColorStop(0, '#3a2a1a');
  eg.addColorStop(0.35, '#1a1f3a');
  eg.addColorStop(0.55, '#0a0c1a');
  eg.addColorStop(1, '#050610');
  ectx.fillStyle = eg; ectx.fillRect(0, 0, 512, 256);
  const lights = [{x:100,y:40,r:50,c:'rgba(255,220,150,0.9)'},{x:380,y:30,r:40,c:'rgba(150,180,255,0.85)'},{x:256,y:20,r:35,c:'rgba(255,255,200,0.7)'}];
  lights.forEach(l => {
    const rg = ectx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
    rg.addColorStop(0, l.c); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ectx.fillStyle = rg; ectx.fillRect(0, 0, 512, 256);
  });
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;
  scene.environment = envTex;

  // ====== 相机 ======
  let camera = new THREE.PerspectiveCamera(42, window.innerWidth/window.innerHeight, 0.1, 100);
  // 自动机位：根据位数横向拉远，保证所有机器都在画面里
  const MACHINE_SPACING = 3.4;          // 每台机器横向间距（加大间隔，避免拥挤）
  const MACHINE_RADIUS = 1.55;          // 单台玻璃球半径（缩小一些以并排显示）
  const TOTAL_WIDTH = (POS_COUNT - 1) * MACHINE_SPACING;
  let camDist = Math.max(9, TOTAL_WIDTH * 1.4 + 4);
  camera.position.set(0, 2.5, camDist);

  // ====== 灯光 ======
  scene.add(new THREE.AmbientLight(0x404868, 0.4));

  const keyLight = new THREE.DirectionalLight(0xfff0d0, 1.3);
  keyLight.position.set(4, 10, 5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -TOTAL_WIDTH/2 - 3;
  keyLight.shadow.camera.right = TOTAL_WIDTH/2 + 3;
  keyLight.shadow.camera.top = 5;
  keyLight.shadow.camera.bottom = -3;
  keyLight.shadow.bias = -0.0005;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x6088ff, 0.5);
  fillLight.position.set(-5, 3, 3);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xff88cc, 0.4);
  rimLight.position.set(0, -2, -6);
  scene.add(rimLight);

  // ====== 舞台地板 ======
  const floorGeo = new THREE.CircleGeometry(Math.max(6, TOTAL_WIDTH/2 + 3), 64);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x12152a, metalness: 0.85, roughness: 0.35, envMapIntensity: 1.2
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI/2;
  floor.position.y = -2.2;
  floor.receiveShadow = true;
  scene.add(floor);

  // 地板呼吸光环（每位下方一个）
  const floorRings = [];
  for (let i = 0; i < POS_COUNT; i++) {
    const x = (i - (POS_COUNT-1)/2) * MACHINE_SPACING;
    const rg = new THREE.RingGeometry(MACHINE_RADIUS + 0.3, MACHINE_RADIUS + 0.45, 64);
    const rm = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const r = new THREE.Mesh(rg, rm);
    r.rotation.x = -Math.PI/2;
    r.position.set(x, -2.19, 0);
    scene.add(r);
    floorRings.push(r);
  }

  // 长条底座（所有机器共用一个长台基）
  const baseGeo = new THREE.BoxGeometry(TOTAL_WIDTH + 3, 0.45, 1.6);
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x2a2d4a, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.5
  });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = -2.0;
  base.castShadow = true; base.receiveShadow = true;
  scene.add(base);

  // 长条底座金色顶边
  const baseTopGeo = new THREE.BoxGeometry(TOTAL_WIDTH + 3.1, 0.04, 1.7);
  const baseTopMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 1.0, roughness: 0.2, envMapIntensity: 2.0 });
  const baseTop = new THREE.Mesh(baseTopGeo, baseTopMat);
  baseTop.position.y = -1.77;
  baseTop.receiveShadow = true;
  scene.add(baseTop);

  // ====== 号码球纹理生成（共享函数）======
  const BALL_COLORS = [
    { base: '#e74c3c', dark: '#922b21', light: '#ff8a80' },
    { base: '#f39c12', dark: '#9c6c0a', light: '#ffd180' },
    { base: '#f1c40f', dark: '#9c7c0a', light: '#fff44f' },
    { base: '#1abc9c', dark: '#0e7c66', light: '#5fffd0' },
    { base: '#3498db', dark: '#1c6090', light: '#7ec6ff' },
    { base: '#9b59b6', dark: '#5e3370', light: '#d09bdb' },
    { base: '#e84393', dark: '#8a2858', light: '#ff7dba' },
    { base: '#00b894', dark: '#00705a', light: '#3fffd0' },
    { base: '#fd79a8', dark: '#8a4060', light: '#ffb0c8' },
    { base: '#6c5ce7', dark: '#3a3090', light: '#a89bff' },
  ];

  function makeBallTexture(num, color) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, color.light);
    grad.addColorStop(0.45, color.base);
    grad.addColorStop(0.55, color.base);
    grad.addColorStop(1, color.dark);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S*0.5, S*0.4);
    ctx.rotate(-0.4);
    const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, S*0.35);
    hg.addColorStop(0, 'rgba(255,255,255,0.55)');
    hg.addColorStop(0.6, 'rgba(255,255,255,0.1)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.ellipse(0, 0, S*0.35, S*0.18, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    const cx = S/2, cy = S/2;
    const diskR = S * 0.28;
    const dg = ctx.createRadialGradient(cx - diskR*0.3, cy - diskR*0.3, diskR*0.1, cx, cy, diskR);
    dg.addColorStop(0, 'rgba(255,255,255,0.15)');
    dg.addColorStop(0.8, 'rgba(0,0,0,0.25)');
    dg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(cx, cy, diskR, 0, Math.PI*2); ctx.fill();
    ctx.font = 'bold 180px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#fff';
    ctx.fillText(String(num), cx, cy + 8);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(String(num), cx, cy + 8);
    const vg = ctx.createRadialGradient(cx, cy, S*0.3, cx, cy, S*0.5);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  // 预生成 10 个号码球的纹理和材质（每位机器共享同一套材质，节省内存）
  const sharedBallTextures = [];
  const sharedBallMaterials = [];
  for (let i = 0; i < NUM_RANGE; i++) {
    const tex = makeBallTexture(i, BALL_COLORS[i]);
    sharedBallTextures.push(tex);
    sharedBallMaterials.push(new THREE.MeshStandardMaterial({
      map: tex,
      metalness: 0.15,
      roughness: 0.35,
      envMapIntensity: 1.4,
      emissive: new THREE.Color(BALL_COLORS[i].base),
      emissiveIntensity: 0.06
    }));
  }

  const ballRadius = 0.32;
  const ballGeo = new THREE.SphereGeometry(ballRadius, 36, 28);

  // ====== 创建 POS_COUNT 个独立的摇奖机 ======
  // 每位一台：自己的玻璃球、10 个号码球、出球口、展示槽
  // 每位用 Group 组织，便于整体管理
  const machines = [];
  for (let i = 0; i < POS_COUNT; i++) {
    const x = (i - (POS_COUNT-1)/2) * MACHINE_SPACING;
    const group = new THREE.Group();
    group.position.set(x, 0, 0);

    // 玻璃球壳（外层）
    const outerGeo = new THREE.SphereGeometry(MACHINE_RADIUS, 48, 36);
    const outerMat = new THREE.MeshPhysicalMaterial({
      color: 0xaaccff, metalness: 0, roughness: 0.02,
      transmission: 0.95, transparent: true, opacity: 0.35,
      thickness: 0.4, ior: 1.45, envMapIntensity: 2.5,
      clearcoat: 1.0, clearcoatRoughness: 0.02,
      side: THREE.DoubleSide
    });
    const outerSphere = new THREE.Mesh(outerGeo, outerMat);
    group.add(outerSphere);

    // 内层薄壳
    const innerGeo = new THREE.SphereGeometry(MACHINE_RADIUS - 0.04, 36, 28);
    const innerMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.05,
      transmission: 0.9, transparent: true, opacity: 0.15,
      thickness: 0.2, ior: 1.4, side: THREE.BackSide
    });
    const innerSphere = new THREE.Mesh(innerGeo, innerMat);
    group.add(innerSphere);

    // 赤道金属环
    const equatorGeo = new THREE.TorusGeometry(MACHINE_RADIUS, 0.04, 10, 64);
    const equatorMat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1.0, roughness: 0.3, envMapIntensity: 2.0 });
    const equator = new THREE.Mesh(equatorGeo, equatorMat);
    group.add(equator);

    // 出球口金属环（顶部）
    const exitRingGeo = new THREE.TorusGeometry(0.18, 0.04, 10, 24);
    const exitRing = new THREE.Mesh(exitRingGeo, equatorMat);
    exitRing.position.set(0, MACHINE_RADIUS + 0.02, 0);
    exitRing.rotation.x = Math.PI/2;
    group.add(exitRing);

    // 机器下方展示凹槽（球出球后落点）：在底座顶部
    // 局部坐标 y = -底座顶面到机器中心 = -(2.0 + 0.45/2 + 0.04) ≈ -1.78（机器中心 0，底座顶面在 -1.77）
    // 用一个金色环 + 凹陷圆盘表示
    const slotLocalY = -1.77 + 0.04; // 凹槽中心略高于底座顶面
    const slotRingGeo = new THREE.TorusGeometry(0.42, 0.05, 12, 32);
    const slotRing = new THREE.Mesh(slotRingGeo, equatorMat);
    slotRing.position.set(0, slotLocalY + 0.02, 0);
    slotRing.rotation.x = Math.PI/2;
    slotRing.receiveShadow = true;
    group.add(slotRing);
    // 凹槽内深色圆盘
    const slotDiskGeo = new THREE.CircleGeometry(0.42, 32);
    const slotDiskMat = new THREE.MeshStandardMaterial({ color: 0x0a0c1a, metalness: 0.4, roughness: 0.5 });
    const slotDisk = new THREE.Mesh(slotDiskGeo, slotDiskMat);
    slotDisk.rotation.x = -Math.PI/2;
    slotDisk.position.set(0, slotLocalY + 0.005, 0);
    slotDisk.receiveShadow = true;
    group.add(slotDisk);

    // 位号标签（机器上方 3D 文字）
    const labelTex = (function(){
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 80px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 8;
      ctx.fillText(POS_LABELS[i], 64, 70);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true });
    const labelGeo = new THREE.PlaneGeometry(0.6, 0.6);
    const labelMesh = new THREE.Mesh(labelGeo, labelMat);
    labelMesh.position.set(0, MACHINE_RADIUS + 0.7, 0);
    group.add(labelMesh);

    // 创建本机位的 10 个号码球
    const balls = [];
    for (let n = 0; n < NUM_RANGE; n++) {
      const mesh = new THREE.Mesh(ballGeo, sharedBallMaterials[n]);
      mesh.castShadow = true;
      mesh.userData.number = n;
      mesh.userData.color = BALL_COLORS[n];
      resetBall(mesh, MACHINE_RADIUS);
      group.add(mesh);
      balls.push(mesh);
    }

    // 本机位的小型接触阴影
    const shadowMeshes = [];
    balls.forEach(() => {
      const sg = new THREE.CircleGeometry(ballRadius * 0.9, 20);
      const sm = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });
      const s = new THREE.Mesh(sg, sm);
      s.rotation.x = -Math.PI/2;
      s.visible = false;
      group.add(s);
      shadowMeshes.push(s);
    });

    scene.add(group);
    machines.push({
      group, x,
      outerSphere, innerSphere, equator,
      balls, shadowMeshes,
      // 状态
      status: 'idle',            // idle | running | done
      pickedBall: null,          // 已出的号码球 mesh
      pickedNumber: null,        // 已出的号码
      spinTimer: 0,
      spinningBoost: 0,
      exitCooldown: 0,
      startDelay: i * 50         // 错峰启动，避免所有机器同时出球
    });
  }

  function resetBall(mesh, sphereRadius) {
    mesh.userData.exited = false;
    mesh.userData.ejecting = false;
    mesh.userData.ejectTime = 0;
    mesh.userData.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.10,
      Math.random() * 0.12,
      (Math.random() - 0.5) * 0.10
    );
    mesh.userData.angularVel = new THREE.Vector3(
      (Math.random() - 0.5) * 0.20,
      (Math.random() - 0.5) * 0.20,
      (Math.random() - 0.5) * 0.20
    );
    const r = sphereRadius - ballRadius - 0.08;
    mesh.position.set(
      (Math.random() - 0.5) * r * 1.3,
      (Math.random() - 0.2) * r * 1.0,
      (Math.random() - 0.5) * r * 1.3
    );
  }

  // ====== 单台机器物理模拟 ======
  const SPIN_DURATION = 200;

  function stepMachinePhysics(m) {
    const innerR = MACHINE_RADIUS - ballRadius - 0.05;
    const forceStrength = 0.020 + m.spinningBoost;
    m.spinTimer++;
    const fx = Math.sin(m.spinTimer * 0.05 + m.x) * forceStrength * 0.5;
    const fy = (Math.cos(m.spinTimer * 0.07 + m.x) * 0.5 + 0.5) * forceStrength * 0.8;
    const fz = Math.cos(m.spinTimer * 0.04 + m.x) * forceStrength * 0.5;

    m.balls.forEach(ball => {
      if (ball.userData.exited) return;
      ball.userData.velocity.x += fx + (Math.random() - 0.5) * forceStrength * 0.4;
      ball.userData.velocity.y += fy + (Math.random() - 0.2) * forceStrength * 0.5;
      ball.userData.velocity.z += fz + (Math.random() - 0.5) * forceStrength * 0.4;
      ball.userData.velocity.y -= 0.003;
      ball.userData.velocity.multiplyScalar(0.991);
      ball.userData.angularVel.multiplyScalar(0.988);
      const maxV = 0.22;
      if (ball.userData.velocity.length() > maxV) ball.userData.velocity.setLength(maxV);
      // 注意：球的位置在 group 局部坐标系
      ball.position.add(ball.userData.velocity);
      ball.rotation.x += ball.userData.angularVel.x;
      ball.rotation.y += ball.userData.angularVel.y;
      ball.rotation.z += ball.userData.angularVel.z;
      const dist = ball.position.length();
      if (dist > innerR) {
        ball.position.normalize().multiplyScalar(innerR);
        const n = ball.position.clone().normalize();
        const dot = ball.userData.velocity.dot(n);
        if (dot > 0) {
          ball.userData.velocity.sub(n.multiplyScalar(dot * 1.7));
          ball.userData.angularVel.x += (Math.random() - 0.5) * 0.1;
          ball.userData.angularVel.z += (Math.random() - 0.5) * 0.1;
        }
      }
      // 球-球碰撞（同机内）
      for (let j = 0; j < m.balls.length; j++) {
        const b2 = m.balls[j];
        if (b2 === ball || b2.userData.exited) continue;
        const diff = ball.position.clone().sub(b2.position);
        const d = diff.length();
        const minD = ballRadius * 2;
        if (d < minD && d > 0.0001) {
          const n = diff.normalize();
          const overlap = minD - d;
          ball.position.add(n.clone().multiplyScalar(overlap * 0.5));
          b2.position.sub(n.clone().multiplyScalar(overlap * 0.5));
          const va = ball.userData.velocity.dot(n);
          const vb = b2.userData.velocity.dot(n);
          if (va - vb < 0) {
            const mm = 0.6;
            ball.userData.velocity.add(n.clone().multiplyScalar((vb - va) * mm));
            b2.userData.velocity.sub(n.clone().multiplyScalar((vb - va) * mm));
            ball.userData.angularVel.y += (Math.random() - 0.5) * 0.05;
            b2.userData.angularVel.y += (Math.random() - 0.5) * 0.05;
          }
        }
      }
    });
  }

  // 单台机器出球：球从顶部出口弹出（不再走长导轨，直接落到底座上方的展示位）
  function ejectBallFromMachine(m) {
    const candidates = m.balls.filter(b => !b.userData.exited);
    if (candidates.length === 0) return false;
    // 取离顶部出口最近的球
    const topPos = new THREE.Vector3(0, MACHINE_RADIUS, 0);
    candidates.sort((a, b) => a.position.distanceTo(topPos) - b.position.distanceTo(topPos));
    const target = candidates[0];
    target.userData.exited = true;
    target.userData.ejecting = true;
    target.userData.ejectTime = 0;
    target.userData.fallTarget = new THREE.Vector3(0, -MACHINE_RADIUS - 0.55, 0); // 落到机器正下方底座展示槽
    m.pickedBall = target;
    m.pickedNumber = target.userData.number;
    return true;
  }

  // ====== 鼠标交互 ======
  let isDragging = false, lastX = 0, lastY = 0;
  let camTheta = 0, camPhi = 0.18;
  function updateCamera() {
    camera.position.x = camDist * Math.cos(camPhi) * Math.sin(camTheta);
    camera.position.z = camDist * Math.cos(camPhi) * Math.cos(camTheta);
    camera.position.y = 1.8 + camDist * Math.sin(camPhi);
    camera.lookAt(0, 0.3, 0);
  }
  updateCamera();
  canvas.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    camTheta -= (e.clientX - lastX) * 0.005;
    camPhi = Math.max(-0.4, Math.min(1.0, camPhi + (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
    updateCamera();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camDist *= e.deltaY > 0 ? 1.08 : 0.93;
    camDist = Math.max(Math.max(7, TOTAL_WIDTH * 1.2 + 3), Math.min(22, camDist));
    updateCamera();
  }, { passive: false });

  // ====== 渲染循环 ======
  let globalStatus = 'idle'; // idle | running | done
  let globalTimer = 0;
  const MACHINE_DONE_TARGET = 60; // 出球后 1s 落到展示位

  function animate() {
    requestAnimationFrame(animate);
    globalTimer++;

    if (globalStatus === 'running') {
      // 更新每台机器
      let allDone = true;
      machines.forEach((m, idx) => {
        if (m.status === 'idle') {
          // 错峰启动
          if (globalTimer > m.startDelay) {
            m.status = 'running';
            m.spinTimer = 0;
            m.spinningBoost = 0.025;
          }
          allDone = false;
        }
        if (m.status === 'running') {
          if (m.spinTimer < SPIN_DURATION) {
            m.spinningBoost = Math.min(0.05, m.spinningBoost + 0.003);
          } else {
            m.spinningBoost = Math.max(0.015, m.spinningBoost - 0.001);
          }
          stepMachinePhysics(m);
          // 玻璃球微转
          m.outerSphere.rotation.y += 0.002;
          m.innerSphere.rotation.y -= 0.001;
          m.equator.rotation.y += 0.002;
          // 出球
          if (m.exitCooldown > 0) m.exitCooldown--;
          if (m.spinTimer > SPIN_DURATION && m.exitCooldown === 0 && !m.pickedBall) {
            if (ejectBallFromMachine(m)) {
              m.exitCooldown = 99999; // 不再出球
              updateResultUI();
            }
          }
          allDone = false;
        }
        if (m.status === 'ejecting') {
          allDone = false;
        }
      });
      if (allDone && machines.every(m => m.pickedBall && !m.pickedBall.userData.ejecting)) {
        globalStatus = 'done';
        const nums = machines.map(m => m.pickedNumber);
        setStatusText('🎉 摇奖结束！号码：' + nums.join(' '));
        saveToHistory(nums);
        document.getElementById('btnReset').disabled = false;
      }
    }

    // 出球动画：球从机器顶部弹出 → 弧线落到机器前方底座上的展示位
    machines.forEach((m, mi) => {
      m.balls.forEach(ball => {
        if (ball.userData.ejecting) {
          ball.userData.ejectTime++;
          const t = ball.userData.ejectTime;
          if (t < 25) {
            // 阶段1：冲向出口（局部坐标向上）
            ball.userData.velocity.y = Math.max(0.12, ball.userData.velocity.y * 0.93);
            ball.position.add(ball.userData.velocity);
            ball.rotation.y += 0.15;
          } else if (t < 60) {
            // 阶段2：飞到机器前方底座顶部（世界坐标）
            // 切换到世界坐标
            if (!ball.userData.worldMode) {
              // 把球从 group 中移除，加到 scene
              m.group.remove(ball);
              scene.add(ball);
              // 计算当前位置的世界坐标
              const worldPos = new THREE.Vector3();
              ball.getWorldPosition(worldPos);
              ball.position.copy(worldPos);
              ball.userData.worldMode = true;
              // 目标位置：机器正下方展示凹槽中心（世界坐标）
              // 凹槽在底座顶面（局部 y=-1.77），球落点 = 底座顶面 + 球半径
              ball.userData.targetWorld = new THREE.Vector3(
                m.x,
                -1.77 + 0.04 + ballRadius,
                0
              );
              ball.userData.startWorld = ball.position.clone();
              ball.userData.arcT = 0;
            }
            ball.userData.arcT += 1/35;
            const p = ball.userData.arcT;
            const s = ball.userData.startWorld;
            const e = ball.userData.targetWorld;
            // 抛物线（出球弹起后落下）
            ball.position.x = s.x + (e.x - s.x) * p;
            ball.position.z = s.z + (e.z - s.z) * p;
            ball.position.y = s.y + (e.y - s.y) * p + Math.sin(p * Math.PI) * 0.5;
            ball.rotation.x += 0.2;
            ball.rotation.y += 0.15;
            if (p >= 1) {
              ball.position.copy(e);
              ball.userData.velocity.set(0, 0, 0);
              ball.userData.angularVel.set(0, 0, 0);
              ball.userData.ejecting = false;
              m.status = 'ejecting_done';
            }
          }
        }
      });
    });

    // 待机时球微动
    if (globalStatus === 'idle' || globalStatus === 'done') {
      machines.forEach(m => {
        m.balls.forEach(b => {
          if (!b.userData.exited) b.rotation.y += 0.004;
        });
        m.outerSphere.rotation.y += 0.0008;
        m.innerSphere.rotation.y -= 0.0004;
        m.equator.rotation.y += 0.0008;
      });
    }

    // 接触阴影
    machines.forEach(m => {
      m.balls.forEach((ball, i) => {
        const sm = m.shadowMeshes[i];
        if (ball.userData.exited || ball.userData.ejecting) {
          sm.visible = false;
        } else {
          sm.visible = true;
          // 局部坐标
          sm.position.set(ball.position.x, -MACHINE_RADIUS - 0.45, ball.position.z);
          const h = ball.position.y + MACHINE_RADIUS + 0.45;
          sm.scale.setScalar(Math.max(0.3, 1 - h * 0.15));
          sm.material.opacity = Math.max(0.05, 0.35 - h * 0.06);
        }
      });
    });

    // 地板光环呼吸
    floorRings.forEach((r, i) => {
      r.material.opacity = 0.4 + Math.sin(Date.now() * 0.002 + i * 0.5) * 0.2;
    });

    renderer.render(scene, camera);
  }
  animate();

  // ====== UI ======
  const btnStart = document.getElementById('btnStart');
  const btnReset = document.getElementById('btnReset');
  const statusText = document.getElementById('statusText');
  const resultNums = document.getElementById('resultNums');
  const historyList = document.getElementById('historyList');

  function setStatusText(s) { statusText.textContent = s; }

  function updateResultUI() {
    let html = '';
    for (let i = 0; i < POS_COUNT; i++) {
      const m = machines[i];
      if (m.pickedNumber !== null) {
        const c = BALL_COLORS[m.pickedNumber];
        html += '<div class="ball" style="background: radial-gradient(circle at 32% 28%, ' + c.light + ', ' + c.base + ' 60%, ' + c.dark + ' 100%);">' + m.pickedNumber + '</div>';
      } else {
        html += '<div class="ball empty">?</div>';
      }
    }
    resultNums.innerHTML = html;
  }

  const history = [];
  function saveToHistory(nums) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    history.unshift({ time, nums: nums.slice() });
    if (history.length > 20) history.pop();
    renderHistory();
  }
  function renderHistory() {
    let html = '';
    history.forEach((h, i) => {
      html += '<div class="item"><span class="badge">' + (i+1) + '</span>' +
        h.nums.join(' ') + ' <span style="color:#666">(' + h.time + ')</span></div>';
    });
    historyList.innerHTML = html || '<div class="item" style="color:#555">暂无记录</div>';
  }
  renderHistory();
  updateResultUI();

  btnStart.addEventListener('click', () => {
    if (globalStatus !== 'idle') return;
    globalStatus = 'running';
    globalTimer = 0;
    // 重置每台机器状态（保留 3D 位置）
    machines.forEach((m, i) => {
      m.status = 'idle';
      m.pickedBall = null;
      m.pickedNumber = null;
      m.spinTimer = 0;
      m.spinningBoost = 0;
      m.exitCooldown = 0;
      m.startDelay = i * 50; // 错峰
    });
    btnStart.disabled = true;
    btnReset.disabled = true;
    setStatusText('🌀 正在摇奖...');
    updateResultUI();
  });

  btnReset.addEventListener('click', () => {
    machines.forEach(m => {
      // 复位所有球（包括已出球的）
      m.balls.forEach(b => {
        // 如果之前从 group 移到 scene 了，要移回 group
        if (b.userData.worldMode) {
          scene.remove(b);
          m.group.add(b);
          b.userData.worldMode = false;
        }
        resetBall(b, MACHINE_RADIUS);
      });
      m.status = 'idle';
      m.pickedBall = null;
      m.pickedNumber = null;
      m.spinTimer = 0;
      m.spinningBoost = 0;
      m.exitCooldown = 0;
    });
    globalStatus = 'idle';
    btnStart.disabled = false;
    btnReset.disabled = true;
    setStatusText('已重置，点击"开始摇奖"启动');
    updateResultUI();
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
})();
</script>
</body>
</html>`;
}

/**
 * 每日温馨话语（按一年中的第几天取用，51 条足够一年循环）
 */
function getDailyQuote() {
    var quotes = [
        '每一天都是新的开始，加油！',
        '今天的努力，是明天的底气。',
        '心怀热爱，奔赴山海。',
        '你只管努力，剩下的交给时间。',
        '愿所有的美好，都如约而至。',
        '生活明朗，万物可爱，人间值得，未来可期。',
        '认真生活，就能找到被人生偷藏起来的糖果。',
        '星光不问赶路人，时光不负有心人。',
        '你现在的付出，都是一种沉淀。',
        '愿你有前进一步的勇气，亦有退后一步的从容。',
        '保持热爱，奔赴下一场山海。',
        '愿你眼中有光，心中有爱，脚下有路。',
        '微笑面对每一天，阳光会照亮每个角落。',
        '愿你的努力，都不被辜负。',
        '种一棵树最好的时间是十年前，其次是现在。',
        '细节决定成败，态度决定一切。',
        '行动是治愈恐惧的良药。',
        '宁可辛苦一阵子，不要苦一辈子。',
        '每一个不曾起舞的日子，都是对生命的辜负。',
        '愿你成为自己的太阳，无需借谁的光。',
        '时光知味，岁月沉香。',
        '愿你出走半生，归来仍是少年。',
        '心若向阳，无谓悲伤。',
        '慢慢来，比较快。',
        '想全是问题，做全是答案。',
        '越努力，越幸运。',
        '不乱于心，不困于情，不畏将来，不念过往。',
        '你若盛开，清风自来。',
        '愿所有的遗憾，都是惊喜的铺垫。',
        '愿你被这世界温柔以待。',
        '人生没有白走的路，每一步都算数。',
        '愿时光能缓，愿故人不散。',
        '愿你三冬暖，愿你春不寒。',
        '愿你天黑有灯，下雨有伞。',
        '愿你所求皆如愿，所行皆坦途。',
        '愿你的生活，如诗如画。',
        '愿你的日子，每天都是好天气。',
        '一切都会过去，一切都会好起来。',
        '愿你成为自己喜欢的样子。',
        '不必太纠结于当下，也不必太忧虑未来。',
        '愿你历尽千帆，归来仍是少年。',
        '愿你眼中星辰大海，心中日月星光。',
        '愿你余生有风也有酒，有诗也有茶。',
        '愿你今后眼里是阳光，笑里是坦荡。',
        '愿你遍历山河，觉得人间值得。',
        '愿你前程似锦，不负韶华。',
        '愿你不负光阴，不负自己。',
        '生活不止眼前的苟且，还有诗和远方。',
        '面朝大海，春暖花开。',
        '笑口常开，好运自然来。',
        '今天的你，也是限量版。'
    ];
    var now = new Date();
    var start = new Date(now.getFullYear(), 0, 0);
    var dayOfYear = Math.floor((now - start) / 86400000);
    return quotes[dayOfYear % quotes.length];
}

/**
 * 更新状态栏时间项
 * 状态栏右侧显示 HH:MM:SS，鼠标悬停 tooltip 显示日期+温馨话语
 */
function updateTimeStatusItem(item) {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    // codicon 时钟图标，color 已在外部设置成彩色
    item.text = '$(clock) ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    var dateStr = d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 星期' + week;
    item.tooltip = '🕐 ' + dateStr + '\n\n✨ ' + getDailyQuote() + '\n\n(点击查看，菜单"时间背景水印"可隐藏)';
}

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
 * 调用 Python 后端跑多模型对比
 * 通过临时文件传递输入输出，避开 stdout 编码问题
 */
async function runMLCompare(history, testCount) {
    const { spawn, execSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    // ========== Python 环境自动检测 + 自动安装依赖 ==========
    const REQUIRED_PKGS = ['numpy', 'sklearn', 'pandas'];
    const PKG_TO_PIP = { 'numpy': 'numpy', 'sklearn': 'scikit-learn', 'pandas': 'pandas' };

    // 检测结果缓存到 globalStorage，避免每次都跑检测
    const ENV_CACHE_FILE = path.join(getPredDir(), 'python_env_cache.json');

    function loadEnvCache() {
        try {
            const c = JSON.parse(fs.readFileSync(ENV_CACHE_FILE, 'utf-8'));
            // 缓存7天内有效
            if (Date.now() - c.ts < 7 * 24 * 3600 * 1000) return c;
        } catch (e) {}
        return null;
    }

    function saveEnvCache(pythonCmd, missing) {
        try {
            fs.writeFileSync(ENV_CACHE_FILE, JSON.stringify({
                pythonCmd, missing, ts: Date.now()
            }), 'utf-8');
        } catch (e) {}
    }

    // 在多个候选里找一个可用的 Python 命令
    function findPythonCmd() {
        const candidates = ['python', 'py -3', 'python3'];
        for (const cmd of candidates) {
            try {
                execSync(`${cmd} --version`, {
                    encoding: 'utf-8',
                    timeout: 5000,
                    windowsHide: true,
                    stdio: 'pipe'  // 不让 stderr 抛错
                });
                return cmd;
            } catch (e) {
                // 检查 stdout 是否有 "Python x.y" 即可（version 走 stdout 也走 stderr）
                if (e.stdout && /Python\s+\d/i.test(e.stdout)) return cmd;
            }
        }
        return null;
    }

    // 检测 Python 缺哪些库（用 spawnSync 分离 stdout/stderr）
    function findMissingPkgs(pythonCmd) {
        const { spawnSync } = require('child_process');
        // 简洁检测代码：尝试 import，没缺就输出 OK
        const checkScript =
            "import sys\n" +
            "ok=[]\n" +
            "for p in ['numpy','sklearn','pandas']:\n" +
            "    try:\n" +
            "        __import__(p)\n" +
            "        ok.append(p)\n" +
            "    except ImportError:\n" +
            "        pass\n" +
            "print('OK:' + ','.join(ok))\n";

        const pythonBin = pythonCmd.split(' ')[0];
        const pythonArgs = pythonCmd.includes(' ') ? ['-3', '-c', checkScript] : ['-c', checkScript];

        const r = spawnSync(pythonBin, pythonArgs, {
            encoding: 'utf-8',
            timeout: 15000,
            windowsHide: true
        });

        const stdout = (r.stdout || '').trim();
        // 提取 OK: 后面的列表
        const m = stdout.match(/OK:([^\n]*)/);
        if (m) {
            const installed = m[1].split(',').filter(x => x);
            return REQUIRED_PKGS.filter(p => installed.indexOf(p) === -1);
        }
        // 检测失败：当成全部缺失
        return REQUIRED_PKGS.slice();
    }

    // 显示进度通道
    let channel;
    function ensureChannel() {
        if (!channel) {
            channel = vscode.window.createOutputChannel('Python 环境');
            channel.show();
        }
        return channel;
    }

    // 自动 pip install
    async function autoPipInstall(pythonCmd, pkgs) {
        const ch = ensureChannel();
        const pipNames = pkgs.map(p => PKG_TO_PIP[p] || p).join(' ');
        ch.appendLine('────────────────────────────────────');
        ch.appendLine(`正在自动安装依赖: ${pipNames}`);
        ch.appendLine('可能需要 30-120 秒，请耐心等待...');
        ch.appendLine('────────────────────────────────────');

        const pythonBin = pythonCmd.split(' ')[0];
        const pythonArgs = pythonCmd.includes(' ') ? ['-3', '-m', 'pip', 'install', ...pkgs.map(p => PKG_TO_PIP[p] || p)]
                                                   : ['-m', 'pip', 'install', ...pkgs.map(p => PKG_TO_PIP[p] || p)];

        await new Promise((resolve, reject) => {
            const proc = spawn(pythonBin, pythonArgs, {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                windowsHide: false
            });
            proc.stdout.on('data', d => ch.append(d.toString()));
            proc.stderr.on('data', d => ch.append(d.toString()));
            proc.on('error', reject);
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`pip install 退出码 ${code}`));
            });
        });
        ch.appendLine('✅ 依赖安装完成');
    }

    // ============== 主流程：先看缓存，缓存不存在才检测 ==============
    const cached = loadEnvCache();
    let pythonCmd, missingPkgs;

    if (cached && cached.missing.length === 0) {
        // 缓存命中：依赖已就绪
        pythonCmd = cached.pythonCmd;
        missingPkgs = [];
        ensureChannel().appendLine(`✅ 检测缓存命中，Python 依赖已就绪（${pythonCmd}）`);
    } else {
        // 缓存失效：实际检测
        pythonCmd = findPythonCmd();
        if (!pythonCmd) {
            ensureChannel().appendLine('❌ 未找到 Python 解释器');
            const action = await vscode.window.showErrorMessage(
                '⚠️ 未检测到 Python。模型对比功能需要 Python 3.8+\n\n请安装后重启 VSCode。',
                { modal: true },
                '打开 Python 官网'
            );
            if (action === '打开 Python 官网') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
            }
            throw new Error('未检测到 Python，请先安装 Python 3.8+');
        }
        ensureChannel().appendLine(`✅ 检测到 Python: ${pythonCmd}`);

        missingPkgs = findMissingPkgs(pythonCmd);
        if (missingPkgs.length > 0) {
            ensureChannel().appendLine(`⚠️ 缺失依赖: ${missingPkgs.join(', ')}`);
            try {
                await autoPipInstall(pythonCmd, missingPkgs);
                vscode.window.showInformationMessage('✅ Python 依赖已自动安装');
                missingPkgs = []; // 安装后重置为空
            } catch (e) {
                ensureChannel().appendLine('❌ 自动安装失败: ' + e.message);
                const action = await vscode.window.showErrorMessage(
                    `依赖自动安装失败：${e.message}\n请手动执行: pip install ${missingPkgs.map(p => PKG_TO_PIP[p] || p).join(' ')}`,
                    { modal: true },
                    '复制命令'
                );
                if (action === '复制命令') {
                    await vscode.env.clipboard.writeText(`pip install ${missingPkgs.map(p => PKG_TO_PIP[p] || p).join(' ')}`);
                }
                throw new Error('依赖自动安装失败');
            }
        } else {
            ensureChannel().appendLine('✅ 所有 Python 依赖已就绪');
        }

        // 写缓存（仅在依赖已就绪时才缓存，避免缓存了"缺失"状态）
        if (missingPkgs.length === 0) {
            saveEnvCache(pythonCmd, []);
        }
    }

    const pythonBin = pythonCmd.split(' ')[0]; // 'py -3' 取 'py'
    const pythonArgs = pythonCmd.includes(' ') ? ['-3'] : [];
    // ========== Python 环境检测+自动安装结束 ==========

    // 构造输入数据
    const inputData = {
        history: history.map(h => ({ num: h.num, period: h.period, date: h.date })),
        testCount: testCount
    };

    // 写输入文件 + 输出文件路径
    const tmpIn = path.join(os.tmpdir(), 'pl3_ml_in.json');
    const tmpOut = path.join(os.tmpdir(), 'pl3_ml_out.json');
    fs.writeFileSync(tmpIn, JSON.stringify(inputData), 'utf-8');
    try { fs.unlinkSync(tmpOut); } catch (e) {}

    const scriptPath = path.join(__dirname, '..', 'scripts', 'ml_compare.py');

    return new Promise((resolve, reject) => {
        // PYTHONIOENCODING=utf-8 + unbuffered，确保输出是 UTF-8
        const proc = spawn(pythonBin, [
            ...pythonArgs,
            '-u',
            scriptPath,
            tmpIn,
            '--out', tmpOut
        ], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            windowsHide: true
        });

        let stderrBuf = '';
        proc.stderr.on('data', d => stderrBuf += d.toString('utf-8'));

        proc.on('error', err => {
            try { fs.unlinkSync(tmpIn); } catch (e) {}
            reject(new Error('Python 启动失败: ' + err.message));
        });

        proc.on('close', code => {
            try { fs.unlinkSync(tmpIn); } catch (e) {}
            if (code !== 0) {
                reject(new Error('Python 退出码 ' + code + ': ' + (stderrBuf || '未知错误')));
                return;
            }
            // 优先从输出文件读（更可靠）
            if (fs.existsSync(tmpOut)) {
                try {
                    const content = fs.readFileSync(tmpOut, 'utf-8');
                    fs.unlinkSync(tmpOut);
                    resolve(JSON.parse(content));
                } catch (e) {
                    reject(new Error('读取输出文件失败: ' + e.message));
                }
            } else {
                reject(new Error('Python 未生成输出文件: ' + stderrBuf.slice(0, 500)));
            }
        });
    });
}

/**
 * ML 对比 - 加载中页面
 */
function getMLCompareLoadingHtml(name) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>🧠 模型对比 - ${name}</title>
<style>
body { background:#1e1e1e;color:#ddd;font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;flex-direction:column; }
.spinner { width:60px;height:60px;border:4px solid rgba(255,255,255,0.1);border-top:4px solid #8ec5ff;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:24px; }
@keyframes spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
h2 { color:#8ec5ff;font-weight:500;margin-bottom:8px; }
.desc { color:#888;font-size:13px; }
</style>
</head>
<body>
<div class="spinner"></div>
<h2>正在运行多模型对比...</h2>
<div class="desc">4 个模型 × 3 位 × ${0} 次滚动预测，可能需要 30-90 秒</div>
</body>
</html>`;
}

/**
 * ML 对比 - 结果展示页面
 */
/**
 * 群鸟生命游戏 - Boids + Game of Life 融合
 * - Boids: 凝聚/对齐/分离三规则群飞
 * - Game of Life: 网格细胞按邻居数量生死
 * - 融合: 每个格子被 Boid 飞过的次数决定"激活"，激活后开始按生命游戏规则演化
 */
/**
 * 质合形态分析
 * 质数: 2,3,5,7  合数: 0,1,4,6,8,9（0和1归合数便于统计）
 * 每位统计质合频率 + 形态分布 + 预测
 */
function getZhiHeHtml(name, posLabels, allNumbers, periods) {
    const nPos = posLabels.length;
    const N = Math.min(300, allNumbers[0].length);
    const periodsSliced = periods.slice(-N);

    // 质合分类
    const ZHI = new Set([2, 3, 5, 7]);
    const classify = n => ZHI.has(n) ? '质' : '合';

    // 为每位统计
    const posData = allNumbers.map((nums, p) => {
        const data = nums.slice(-N);
        let zhiCnt = 0, heCnt = 0;
        for (const d of data) {
            if (ZHI.has(d)) zhiCnt++; else heCnt++;
        }
        return { data, zhiCnt, heCnt, zhiPct: zhiCnt / N * 100, hePct: heCnt / N * 100 };
    });

    // 形态统计（如"质质合"、"合合质"）
    const forms = {};
    for (let i = 0; i < N; i++) {
        const form = posData.map(pd => classify(pd.data[i])).join('');
        forms[form] = (forms[form] || 0) + 1;
    }
    const sortedForms = Object.entries(forms).sort((a, b) => b[1] - a[1]);

    // 转移矩阵（质→质, 质→合, 合→质, 合→合）每位
    const transData = posData.map(pd => {
        const t = { '质质': 0, '质合': 0, '合质': 0, '合合': 0 };
        for (let i = 0; i < N - 1; i++) {
            const k = classify(pd.data[i]) + classify(pd.data[i + 1]);
            t[k]++;
        }
        return t;
    });

    // 最近10期形态
    const recentForms = [];
    for (let i = N - 10; i < N; i++) {
        const form = posData.map(pd => classify(pd.data[i])).join('');
        recentForms.push({ period: periodsSliced[i], form, nums: posData.map(pd => pd.data[i]) });
    }

    // 预测：每位用转移矩阵预测下期质合
    const predForm = posData.map((pd, i) => {
        const last = classify(pd.data[N - 1]);
        const t = transData[i];
        const zhiNext = last === '质' ? t['质质'] : t['合质'];
        const heNext = last === '质' ? t['质合'] : t['合合'];
        return zhiNext >= heNext ? '质' : '合';
    }).join('');

    const dataJson = JSON.stringify({ posLabels, posData, forms: sortedForms, transData, recentForms, predForm, N, lastPeriod: periodsSliced[periodsSliced.length - 1] });

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>📐 质合形态分析 - ${name}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0e1a; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 4px; }
.meta { color: #888; font-size: 12px; margin-bottom: 16px; }
.pred-result { padding: 16px; background: rgba(46,204,113,0.08); border: 1px solid rgba(46,204,113,0.3); border-radius: 8px; margin: 16px 0; text-align: center; }
.pred-form { font-size: 32px; font-weight: bold; color: #2ecc71; letter-spacing: 8px; margin: 8px 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; max-width: 900px; }
.panel { background: rgba(20,30,50,0.5); border: 1px solid rgba(120,180,255,0.15); border-radius: 8px; padding: 14px; }
.panel h3 { color: #feca57; font-size: 14px; margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
.bar-label { width: 40px; text-align: center; font-weight: bold; }
.bar-track { flex: 1; height: 22px; background: rgba(0,0,0,0.3); border-radius: 4px; position: relative; }
.bar-fill { height: 100%; border-radius: 4px; }
.bar-val { width: 80px; font-size: 12px; color: #aaa; }
.legend { font-size: 11px; color: #666; margin-top: 6px; line-height: 1.5; }
.form-row { display: flex; justify-content: space-between; padding: 4px 8px; margin: 2px 0; border-radius: 4px; font-size: 13px; }
.form-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
.form-label { color: #8ec5ff; font-weight: bold; }
.form-count { color: #feca57; }
.form-pct { color: #888; font-size: 11px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 4px 8px; text-align: center; border: 1px solid rgba(255,255,255,0.08); }
th { background: rgba(0,0,0,0.3); color: #8ec5ff; }
.zhi { color: #5ad2ff; font-weight: bold; }
.he { color: #feca57; font-weight: bold; }
.recent-table th { font-size: 11px; }
</style>
</head>
<body>
<h2>📐 ${name} · 质合形态分析</h2>
<div class="meta">历史 ${N} 期 · 最新 ${periodsSliced[periodsSliced.length-1] || '?'} · 质数=2,3,5,7 · 合数=0,1,4,6,8,9</div>

<div class="pred-result">
    <div style="color:#888;font-size:12px">下期形态预测（基于转移矩阵）</div>
    <div class="pred-form" id="predForm">-</div>
    <div style="color:#888;font-size:11px">⚠️ 仅供娱乐参考</div>
    <button id="btnPred" style="margin-top:10px;padding:8px 20px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">🔮 重新预测</button>
</div>

<div class="grid">
    <div class="panel">
        <h3>📊 每位质合频率</h3>
        <div id="bars"></div>
        <div class="legend">蓝=质数(2,3,5,7) 黄=合数(0,1,4,6,8,9) · 理论: 质40% 合60%</div>
    </div>
    <div class="panel">
        <h3>📋 形态分布</h3>
        <div id="formList"></div>
        <div class="legend">所有历史形态按出现次数排序</div>
    </div>
    <div class="panel" style="grid-column: span 2;">
        <h3>🔢 每位转移矩阵</h3>
        <div id="transTables"></div>
        <div class="legend">行=上期质合 · 列=本期质合</div>
    </div>
    <div class="panel" style="grid-column: span 2;">
        <h3>📅 最近10期形态</h3>
        <table class="recent-table">
            <thead><tr><th>期号</th>${posLabels.map(l => '<th>' + l + '</th>').join('')}<th>形态</th></tr></thead>
            <tbody id="recentBody"></tbody>
        </table>
    </div>
</div>

<script>
(function() {
    const D = ${dataJson};

    // ============ 频率条形图 ============
    const barsEl = document.getElementById('bars');
    D.posLabels.forEach((label, p) => {
        const pd = D.posData[p];
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML =
            '<div class="bar-label" style="color:#feca57">' + label + '</div>' +
            '<div class="bar-track">' +
                '<div class="bar-fill" style="width:' + pd.zhiPct + '%; background:#5ad2ff; opacity:0.7;"></div>' +
                '<div style="position:absolute;top:0;left:' + pd.zhiPct + '%;right:0;height:100%;background:#feca57;opacity:0.6;border-radius:0 4px 4px 0;"></div>' +
            '</div>' +
            '<div class="bar-val">质' + pd.zhiCnt + '(' + pd.zhiPct.toFixed(1) + '%) 合' + pd.heCnt + '(' + pd.hePct.toFixed(1) + '%)</div>';
        barsEl.appendChild(row);
    });

    // ============ 形态列表 ============
    const formEl = document.getElementById('formList');
    D.forms.forEach(([form, cnt]) => {
        const pct = (cnt / D.N * 100).toFixed(1);
        const row = document.createElement('div');
        row.className = 'form-row';
        const colored = form.split('').map(c => '<span class="' + (c === '质' ? 'zhi' : 'he') + '">' + c + '</span>').join('');
        row.innerHTML = '<span class="form-label">' + colored + '</span><span class="form-count">' + cnt + '次</span><span class="form-pct">' + pct + '%</span>';
        formEl.appendChild(row);
    });

    // ============ 转移矩阵 ============
    const transEl = document.getElementById('transTables');
    D.posLabels.forEach((label, p) => {
        const t = D.transData[p];
        const total = t['质质'] + t['质合'] + t['合质'] + t['合合'] || 1;
        const div = document.createElement('div');
        div.style.cssText = 'display:inline-block;margin:8px;text-align:center;';
        div.innerHTML =
            '<div style="color:#feca57;font-size:13px;margin-bottom:6px">' + label + '</div>' +
            '<table style="font-size:11px;width:180px;">' +
                '<tr><th></th><th class="zhi">→质</th><th class="he">→合</th></tr>' +
                '<tr><td class="zhi">质→</td><td>' + t['质质'] + ' (' + (t['质质']/total*100).toFixed(1) + '%)</td><td>' + t['质合'] + ' (' + (t['质合']/total*100).toFixed(1) + '%)</td></tr>' +
                '<tr><td class="he">合→</td><td>' + t['合质'] + ' (' + (t['合质']/total*100).toFixed(1) + '%)</td><td>' + t['合合'] + ' (' + (t['合合']/total*100).toFixed(1) + '%)</td></tr>' +
            '</table>';
        transEl.appendChild(div);
    });

    // ============ 最近10期 ============
    const recentEl = document.getElementById('recentBody');
    D.recentForms.slice().reverse().forEach(r => {
        const colored = r.form.split('').map(c => '<span class="' + (c === '质' ? 'zhi' : 'he') + '">' + c + '</span>').join('');
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + r.period + '</td>' + r.nums.map(n => '<td>' + n + '</td>').join('') + '<td>' + colored + '</td>';
        recentEl.appendChild(tr);
    });

    // ============ 预测显示 ============
    function showPred() {
        const el = document.getElementById('predForm');
        const colored = D.predForm.split('').map(c => '<span class="' + (c === '质' ? 'zhi' : 'he') + '" style="color:' + (c === '质' ? '#5ad2ff' : '#feca57') + '">' + c + '</span>').join('');
        el.innerHTML = colored;
    }
    showPred();

    document.getElementById('btnPred').addEventListener('click', () => {
        // 重新预测：加随机扰动
        const noisy = D.predForm.split('').map(c => {
            return Math.random() < 0.3 ? (c === '质' ? '合' : '质') : c;
        }).join('');
        const el = document.getElementById('predForm');
        el.innerHTML = noisy.split('').map(c => '<span style="color:' + (c === '质' ? '#5ad2ff' : '#feca57') + '">' + c + '</span>').join('');
    });
})();
</script>
</body>
</html>`;
}


function getBoidsNumberHtml(name, posLabels, allNumbers, periods) {
    // allNumbers: [[位1号码序列], [位2号码序列], ...]
    // posLabels: ['百位','十位','个位'] 或 ['万位','千位','百位','十位','个位']
    const nPos = posLabels.length;
    const N = Math.min(300, allNumbers[0].length);
    const periodsSliced = periods.slice(-N);

    // 为每位计算统计
    const posData = allNumbers.map((nums, p) => {
        const data = nums.slice(-N);
        const counts = new Array(10).fill(0);
        for (const n of data) counts[n]++;
        const freqs = counts.map(c => c / N * 100);

        const cum = new Array(10).fill(0);
        const cumSeries = new Array(10).fill(null).map(() => []);
        for (let i = 0; i < N; i++) {
            cum[data[i]]++;
            for (let d = 0; d < 10; d++) {
                cumSeries[d].push(cum[d] / (i + 1) * 100);
            }
        }

        const trans = Array.from({length: 10}, () => new Array(10).fill(0));
        for (let i = 0; i < N - 1; i++) trans[data[i]][data[i+1]]++;
        const transMax = Math.max(...trans.map(r => Math.max(...r)));

        return { data, counts, freqs, cumSeries, trans, transMax, maxFreqIdx: counts.indexOf(Math.max(...counts)) };
    });

    const colors = ['#5ad2ff','#4cd9c0','#a78bfa','#feca57','#ff7675','#10b981','#f472b6','#facc15','#60a5fa','#34d399'];
    const dataJson = JSON.stringify({ posLabels, posData, N, periods: periodsSliced, colors, lastPeriod: periodsSliced[periodsSliced.length-1] });

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>🎲 号码分析 - ${name}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0e1a; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; padding: 16px; }
h2 { color: #8ec5ff; margin-bottom: 4px; }
.meta { color: #888; font-size: 12px; margin-bottom: 16px; }
.pred-btn { display: block; width: 100%; max-width: 600px; padding: 14px; margin: 0 auto 16px; background: #c0392b; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 18px; font-weight: bold; }
.pred-btn:hover { background: #e74c3c; }
.pred-result { padding: 16px; background: rgba(192,57,43,0.1); border: 1px solid rgba(192,57,43,0.3); border-radius: 8px; margin: 0 auto 20px; max-width: 600px; text-align: center; }
.pred-num { font-size: 48px; font-weight: bold; color: #2ecc71; letter-spacing: 12px; margin: 8px 0; }
.pred-top3 { color: #feca57; font-size: 14px; }
.pred-detail { color: #888; font-size: 11px; margin-top: 8px; line-height: 1.6; }
.pos-section { margin-bottom: 20px; }
.pos-title { color: #feca57; font-size: 16px; font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid rgba(254,202,87,0.2); padding-bottom: 4px; }
.pos-content { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.panel { background: rgba(20,30,50,0.5); border: 1px solid rgba(120,180,255,0.15); border-radius: 8px; padding: 10px; }
.panel h4 { color: #8ec5ff; font-size: 12px; margin-bottom: 6px; }
.panel canvas { width: 100%; display: block; background: rgba(0,0,0,0.3); border-radius: 4px; }
.bar-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 12px; }
.bar-label { width: 18px; text-align: center; font-weight: bold; }
.bar-track { flex: 1; height: 16px; background: rgba(0,0,0,0.3); border-radius: 3px; position: relative; }
.bar-fill { height: 100%; border-radius: 3px; }
.bar-val { width: 70px; font-size: 11px; color: #aaa; }
.legend { font-size: 10px; color: #666; margin-top: 4px; }
</style>
</head>
<body>
<h2>🎲 ${name} · 全位号码频率分析</h2>
<div class="meta">历史 ${N} 期 · 最新 ${periodsSliced[periodsSliced.length-1] || '?'} · 各位独立统计 · 理论均匀 10%</div>

<button class="pred-btn" id="btnPredict">🔮 一键预测下期号码</button>
<div id="predResult"></div>

${posLabels.map((label, p) => `
<div class="pos-section">
    <div class="pos-title">${label}</div>
    <div class="pos-content">
        <div class="panel">
            <h4>📊 频率分布</h4>
            <div id="bars_${p}"></div>
            <div class="legend">最高频率 ★</div>
        </div>
        <div class="panel">
            <h4>📈 累积占比</h4>
            <canvas id="cum_${p}" width="300" height="120"></canvas>
            <div class="legend">越接近10%越随机</div>
        </div>
        <div class="panel" style="grid-column: span 2;">
            <h4>🔀 转移矩阵</h4>
            <canvas id="trans_${p}" width="300" height="120"></canvas>
            <div class="legend">行=当前号 · 列=下一号 · 越亮=转移越频繁</div>
        </div>
    </div>
</div>
`).join('')}

<script>
(function() {
    const D = ${dataJson};

    // 为每位渲染统计图
    D.posLabels.forEach((label, p) => {
        const pd = D.posData[p];

        // 频率条形图
        const barsEl = document.getElementById('bars_' + p);
        for (let i = 0; i < 10; i++) {
            const pct = pd.freqs[i];
            const color = D.colors[i];
            const isMax = i === pd.maxFreqIdx;
            const row = document.createElement('div');
            row.className = 'bar-row';
            row.innerHTML =
                '<div class="bar-label" style="color:' + color + '">' + i + '</div>' +
                '<div class="bar-track">' +
                    '<div class="bar-fill" style="width:' + (pct * 5) + '%; background:' + color + '; opacity:' + (isMax ? 1 : 0.6) + ';"></div>' +
                    '<div style="position:absolute; top:0; left:50%; width:1px; height:100%; background:rgba(120,180,255,0.3);"></div>' +
                '</div>' +
                '<div class="bar-val">' + pd.counts[i] + '次 ' + pct.toFixed(1) + '%' + (isMax ? ' ★' : '') + '</div>';
            barsEl.appendChild(row);
        }

        // 累积占比折线
        const cumC = document.getElementById('cum_' + p);
        const cx = cumC.getContext('2d');
        cx.fillStyle = '#000';
        cx.fillRect(0, 0, cumC.width, cumC.height);
        const W = cumC.width, H = cumC.height - 8;
        for (let d = 0; d < 10; d++) {
            cx.strokeStyle = D.colors[d];
            cx.lineWidth = 1.2;
            cx.beginPath();
            const series = pd.cumSeries[d];
            for (let j = 0; j < series.length; j++) {
                const x = (j / (series.length - 1)) * W;
                const y = H - series[j] / 100 * H + 4;
                if (j === 0) cx.moveTo(x, y);
                else cx.lineTo(x, y);
            }
            cx.stroke();
        }
        cx.strokeStyle = 'rgba(255,255,255,0.3)';
        cx.setLineDash([3, 3]);
        cx.beginPath();
        cx.moveTo(0, H - 0.1 * H + 4);
        cx.lineTo(W, H - 0.1 * H + 4);
        cx.stroke();
        cx.setLineDash([]);

        // 转移矩阵热力图
        const tC = document.getElementById('trans_' + p);
        const tx = tC.getContext('2d');
        tx.fillStyle = '#000';
        tx.fillRect(0, 0, tC.width, tC.height);
        const cell = Math.min(tC.width / 12, (tC.height - 16) / 10);
        const ox = (tC.width - cell * 10) / 2;
        const oy = 14;
        for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 10; j++) {
                const v = pd.trans[i][j] / pd.transMax;
                tx.fillStyle = 'rgba(254,202,87,' + v.toFixed(3) + ')';
                tx.fillRect(ox + j * cell, oy + i * cell, cell - 1, cell - 1);
            }
        }
        tx.fillStyle = '#888';
        tx.font = '8px sans-serif';
        tx.textAlign = 'center';
        for (let i = 0; i < 10; i++) {
            tx.fillText(i, ox + i * cell + cell/2, 10);
            tx.fillText(i, ox - 6, oy + i * cell + cell/2 + 3);
        }
    });

    // ============ 一键预测 ============
    document.getElementById('btnPredict').addEventListener('click', () => {
        const el = document.getElementById('predResult');
        const preds = [];
        const details = [];

        // 对每位独立预测
        D.posLabels.forEach((label, p) => {
            const pd = D.posData[p];
            const last = pd.data[pd.data.length - 1];
            const recent5 = pd.data.slice(-5);
            const scores = new Array(10).fill(0);

            // 因子1：历史频率 30%
            for (let i = 0; i < 10; i++) scores[i] += pd.freqs[i] / 100 * 0.3;
            // 因子2：最近5期 30%
            for (const n of recent5) scores[n] += 0.3 / 5;
            // 因子3：转移概率 40%
            const transRow = pd.trans[last];
            const transSum = transRow.reduce((a, b) => a + b, 0) || 1;
            for (let i = 0; i < 10; i++) scores[i] += transRow[i] / transSum * 0.4;

            const top = scores.map((s, i) => ({s, i})).sort((a, b) => b.s - a.s);
            preds.push(top[0].i);
            details.push({ label, best: top[0].i, top5: top.slice(0, 5).map(t => t.i), scores });
        });

        const predStr = preds.join(' ');
        const top5Str = details.map(d => d.label + ': ' + d.top5.join(',')).join(' · ');
        const detailHtml = details.map(d => {
            return '<div style="text-align:left;margin:4px 0;font-size:12px;">' +
                '<b style="color:#feca57">' + d.label + '</b>: 预测 <b style="color:#2ecc71">' + d.best + '</b>' +
                ' · Top5: [' + d.top5.join(', ') + ']' +
                '</div>';
        }).join('');

        el.innerHTML =
            '<div class="pred-result">' +
                '<div style="color:#888;font-size:12px;margin-bottom:4px">下期预测号码</div>' +
                '<div class="pred-num">' + predStr + '</div>' +
                '<div class="pred-top3">Top5 候补: ' + top5Str + '</div>' +
                '<div style="margin-top:12px">' + detailHtml + '</div>' +
                '<div class="pred-detail">上期: ' + D.posData.map(pd => pd.data[pd.data.length-1]).join(' ') + ' · 历史' + D.N + '期 · 频率30%+近5期30%+转移40%</div>' +
                '<div class="pred-detail" style="color:#666">⚠️ 仅供娱乐参考</div>' +
            '</div>';
    });
})();
</script>
</body>
</html>`;
}



function getBoidsLifeHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>🐦 群鸟生命游戏</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0e1a; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; overflow: hidden; height: 100vh; }
#stage { display: block; width: 100vw; height: 100vh; cursor: crosshair; }
#hud { position: fixed; top: 16px; left: 16px; padding: 12px 16px; background: rgba(20,30,50,0.7); border: 1px solid rgba(120,180,255,0.3); border-radius: 8px; font-size: 12px; line-height: 1.7; backdrop-filter: blur(8px); pointer-events: none; }
#hud b { color: #8ec5ff; }
#hud .num { color: #feca57; font-weight: bold; }
#ctrl { position: fixed; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: rgba(20,30,50,0.7); border: 1px solid rgba(120,180,255,0.3); border-radius: 8px; backdrop-filter: blur(8px); }
#ctrl label { font-size: 12px; color: #aaa; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
#ctrl input[type="range"] { width: 120px; }
#ctrl button { padding: 6px 14px; background: #0e639c; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
#ctrl button:hover { background: #1177bb; }
#ctrl button.danger { background: #c0392b; }
#ctrl button.danger:hover { background: #e74c3c; }
#legend { position: fixed; bottom: 16px; left: 16px; padding: 10px 14px; background: rgba(20,30,50,0.7); border: 1px solid rgba(120,180,255,0.3); border-radius: 8px; font-size: 11px; line-height: 1.6; backdrop-filter: blur(8px); }
#legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 6px; }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="hud">
    <div>🐦 <b>Boids:</b> <span class="num" id="hudBoids">0</span></div>
    <div>🦠 <b>Live cells:</b> <span class="num" id="hudCells">0</span></div>
    <div>⚡ <b>FPS:</b> <span class="num" id="hudFps">0</span></div>
    <div>🔄 <b>Generation:</b> <span class="num" id="hudGen">0</span></div>
</div>
<div id="ctrl">
    <label>鸟数量 <span id="vBoids">150</span><input type="range" id="sBoids" min="20" max="400" value="150"></label>
    <label>凝聚力 <span id="vCoh">0.005</span><input type="range" id="sCoh" min="0" max="20" value="5"></label>
    <label>对齐力 <span id="vAli">0.05</span><input type="range" id="sAli" min="0" max="20" value="5"></label>
    <label>分离力 <span id="vSep">0.5</span><input type="range" id="sSep" min="0" max="20" value="5"></label>
    <label>生命演化速度 <span id="vLife">6</span><input type="range" id="sLife" min="1" max="20" value="6"></label>
    <label>网格大小 <span id="vGrid">10</span><input type="range" id="sGrid" min="6" max="24" value="10"></label>
    <button id="btnReset">重置</button>
    <button id="btnPause">暂停</button>
    <button id="btnSpark" class="danger">点燃中心</button>
</div>
<div id="legend">
    <div><span class="dot" style="background:#5ad2ff"></span>Boid 飞鸟</div>
    <div><span class="dot" style="background:#feca57"></span>激活态细胞（生命游戏进行中）</div>
    <div><span class="dot" style="background:#e74c3c"></span>活细胞</div>
    <div>💡 左键按住: 强吸引鸟群 · 右键按住: 吸引鸟群+激活生命</div>
</div>

<script>
(function() {
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    function resize() {
        W = canvas.width = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    // ============ 参数 ============
    const params = {
        boidCount: 150,
        cohesion: 0.005,
        alignment: 0.05,
        separation: 0.5,
        lifeSpeed: 6,       // 每N帧演化一次生命游戏
        gridSize: 10,       // 每格像素大小
        maxSpeed: 2.5,
        maxForce: 0.07,
        perception: 30
    };

    // ============ Boid 类 ============
    class Boid {
        constructor(x, y) {
            this.pos = { x: x || Math.random() * W, y: y || Math.random() * H };
            const a = Math.random() * Math.PI * 2;
            const s = 1 + Math.random() * 1.5;
            this.vel = { x: Math.cos(a) * s, y: Math.sin(a) * s };
            this.acc = { x: 0, y: 0 };
            this.trail = [];
        }

        edges() {
            if (this.pos.x < 0) this.pos.x = W;
            else if (this.pos.x > W) this.pos.x = 0;
            if (this.pos.y < 0) this.pos.y = H;
            else if (this.pos.y > H) this.pos.y = 0;
        }

        flock(boids) {
            let alignX = 0, alignY = 0, alignCount = 0;
            let cohX = 0, cohY = 0, cohCount = 0;
            let sepX = 0, sepY = 0, sepCount = 0;
            const per = params.perception;
            const perSq = per * per;

            for (const other of boids) {
                if (other === this) continue;
                const dx = other.pos.x - this.pos.x;
                const dy = other.pos.y - this.pos.y;
                const d2 = dx*dx + dy*dy;
                if (d2 > perSq || d2 === 0) continue;

                // 对齐
                alignX += other.vel.x; alignY += other.vel.y; alignCount++;
                // 凝聚
                cohX += other.pos.x; cohY += other.pos.y; cohCount++;

                // 分离（距离越近越强）
                const d = Math.sqrt(d2);
                if (d < per * 0.5) {
                    sepX -= (dx / d) / d;
                    sepY -= (dy / d) / d;
                    sepCount++;
                }
            }

            if (alignCount > 0) {
                alignX /= alignCount; alignY /= alignCount;
                this.acc.x += alignX * params.alignment * 0.01;
                this.acc.y += alignY * params.alignment * 0.01;
            }
            if (cohCount > 0) {
                cohX = cohX / cohCount - this.pos.x;
                cohY = cohY / cohCount - this.pos.y;
                this.acc.x += cohX * params.cohesion;
                this.acc.y += cohY * params.cohesion;
            }
            if (sepCount > 0) {
                this.acc.x += sepX * params.separation * 0.05;
                this.acc.y += sepY * params.separation * 0.05;
            }

            // 鼠标吸引（左键按住=强吸引，右键按住=强吸引+激活生命，鼠标移动=弱吸引）
            if (mouseActive || mouseRightActive) {
                const dx = mouseX - this.pos.x;
                const dy = mouseY - this.pos.y;
                const d2 = dx*dx + dy*dy;
                if (d2 < 300*300) {
                    // 引力强度：距离越近越强，左键比右键更强
                    const strength = mouseRightActive ? 0.0015 : 0.003;
                    this.acc.x += dx * strength;
                    this.acc.y += dy * strength;
                }
            }
        }

        update() {
            // 限力
            const mag = Math.sqrt(this.acc.x*this.acc.x + this.acc.y*this.acc.y);
            if (mag > params.maxForce) {
                this.acc.x = this.acc.x / mag * params.maxForce;
                this.acc.y = this.acc.y / mag * params.maxForce;
            }
            this.vel.x += this.acc.x;
            this.vel.y += this.acc.y;
            // 限速
            const sp = Math.sqrt(this.vel.x*this.vel.x + this.vel.y*this.vel.y);
            if (sp > params.maxSpeed) {
                this.vel.x = this.vel.x / sp * params.maxSpeed;
                this.vel.y = this.vel.y / sp * params.maxSpeed;
            }
            this.pos.x += this.vel.x;
            this.pos.y += this.vel.y;
            this.acc.x = 0; this.acc.y = 0;
            // 轨迹（短）
            this.trail.push({ x: this.pos.x, y: this.pos.y });
            if (this.trail.length > 8) this.trail.shift();
        }

        draw() {
            // 轨迹
            if (this.trail.length > 1) {
                ctx.strokeStyle = 'rgba(90,210,255,0.15)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(this.trail[0].x, this.trail[0].y);
                for (let i = 1; i < this.trail.length; i++) {
                    ctx.lineTo(this.trail[i].x, this.trail[i].y);
                }
                ctx.stroke();
            }
            // 鸟身（三角形指向运动方向）
            const angle = Math.atan2(this.vel.y, this.vel.x);
            ctx.save();
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(angle);
            ctx.fillStyle = '#5ad2ff';
            ctx.beginPath();
            ctx.moveTo(5, 0);
            ctx.lineTo(-4, 3);
            ctx.lineTo(-4, -3);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    // ============ 生命游戏网格 ============
    let cells = [];   // 当前生命状态
    let activated = []; // 激活度（被Boid飞过累积）
    let cols = 0, rows = 0;

    function initGrid() {
        cols = Math.floor(W / params.gridSize);
        rows = Math.floor(H / params.gridSize);
        cells = new Array(cols * rows).fill(0);
        activated = new Array(cols * rows).fill(0);
    }

    function gridIndex(x, y) {
        const cx = Math.floor(x / params.gridSize);
        const cy = Math.floor(y / params.gridSize);
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return -1;
        return cy * cols + cx;
    }

    // Boid 飞过激活格子
    function boidActivate(x, y) {
        const i = gridIndex(x, y);
        if (i >= 0) {
            activated[i] = Math.min(activated[i] + 0.3, 1.5);
            // 激活到阈值后转为活细胞
            if (activated[i] >= 1 && cells[i] === 0 && Math.random() < 0.3) {
                cells[i] = 1;
            }
        }
    }

    // 生命游戏一步演化
    function lifeStep() {
        const next = new Array(cols * rows).fill(0);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = (x + dx + cols) % cols;
                        const ny = (y + dy + rows) % rows;
                        n += cells[ny * cols + nx];
                    }
                }
                const idx = y * cols + x;
                if (cells[idx] === 1) {
                    next[idx] = (n === 2 || n === 3) ? 1 : 0;
                } else {
                    next[idx] = (n === 3) ? 1 : 0;
                }
                // 激活度衰减
                activated[idx] *= 0.95;
            }
        }
        cells = next;
    }

    function drawGrid() {
        // 激活态（黄色淡光）
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (cells[i] === 1) {
                    ctx.fillStyle = 'rgba(231,76,60,0.85)';
                    ctx.fillRect(x * params.gridSize, y * params.gridSize, params.gridSize - 1, params.gridSize - 1);
                } else if (activated[i] > 0.05) {
                    const a = Math.min(activated[i], 1) * 0.4;
                    ctx.fillStyle = 'rgba(254,202,87,' + a + ')';
                    ctx.fillRect(x * params.gridSize, y * params.gridSize, params.gridSize - 1, params.gridSize - 1);
                }
            }
        }
    }

    // ============ 主循环 ============
    let boids = [];
    function resetBoids() {
        boids = [];
        for (let i = 0; i < params.boidCount; i++) {
            boids.push(new Boid());
        }
    }

    let frame = 0;
    let lastTime = performance.now();
    let fpsTime = lastTime;
    let fpsFrames = 0;
    let gen = 0;
    let paused = false;

    function loop() {
        requestAnimationFrame(loop);
        if (paused) return;

        const now = performance.now();
        fpsFrames++;
        if (now - fpsTime > 500) {
            document.getElementById('hudFps').textContent = (fpsFrames * 1000 / (now - fpsTime)).toFixed(1);
            fpsTime = now;
            fpsFrames = 0;
        }

        // 背景（轻微拖尾）
        ctx.fillStyle = 'rgba(10,14,26,0.35)';
        ctx.fillRect(0, 0, W, H);

        // 生命演化
        frame++;
        if (frame % params.lifeSpeed === 0) {
            lifeStep();
            gen++;
            document.getElementById('hudGen').textContent = gen;
        }

        // 画生命网格
        drawGrid();

        // Boid 行为 + 绘制
        for (const b of boids) {
            b.flock(boids);
            b.update();
            b.edges();
            boidActivate(b.pos.x, b.pos.y);
            b.draw();
        }

        // 统计
        document.getElementById('hudBoids').textContent = boids.length;
        let liveCount = 0;
        for (const c of cells) if (c) liveCount++;
        document.getElementById('hudCells').textContent = liveCount;
    }

    // ============ 鼠标交互 ============
    let mouseX = 0, mouseY = 0, mouseActive = false, mouseRightActive = false;
    canvas.addEventListener('mousemove', e => {
        mouseX = e.clientX; mouseY = e.clientY;
    });
    canvas.addEventListener('mousedown', e => {
        if (e.button === 0) {
            mouseActive = true;
            mouseX = e.clientX; mouseY = e.clientY;
        } else if (e.button === 2) {
            // 右键: 强吸引鸟群 + 激活生命
            mouseRightActive = true;
            mouseX = e.clientX; mouseY = e.clientY;
            for (let dy = -3; dy <= 3; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    const i = gridIndex(e.clientX + dx * params.gridSize, e.clientY + dy * params.gridSize);
                    if (i >= 0 && Math.random() < 0.4) cells[i] = 1;
                }
            }
        }
    });
    canvas.addEventListener('mouseup', e => {
        if (e.button === 0) mouseActive = false;
        if (e.button === 2) mouseRightActive = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // ============ 控件 ============
    function bindRange(sliderId, valueId, key, scale, fmt) {
        const s = document.getElementById(sliderId);
        const v = document.getElementById(valueId);
        s.addEventListener('input', () => {
            params[key] = s.value * scale;
            v.textContent = fmt(params[key]);
            if (key === 'boidCount') resetBoids();
            if (key === 'gridSize') initGrid();
        });
        v.textContent = fmt(params[key]);
    }
    bindRange('sBoids', 'vBoids', 'boidCount', 1, v => v.toFixed(0));
    bindRange('sCoh', 'vCoh', 'cohesion', 0.001, v => v.toFixed(3));
    bindRange('sAli', 'vAli', 'alignment', 0.01, v => v.toFixed(2));
    bindRange('sSep', 'vSep', 'separation', 0.1, v => v.toFixed(1));
    bindRange('sLife', 'vLife', 'lifeSpeed', 1, v => v.toFixed(0));
    bindRange('sGrid', 'vGrid', 'gridSize', 1, v => v.toFixed(0));

    document.getElementById('btnReset').addEventListener('click', () => {
        resetBoids();
        initGrid();
        gen = 0;
    });
    document.getElementById('btnPause').addEventListener('click', e => {
        paused = !paused;
        e.target.textContent = paused ? '继续' : '暂停';
    });
    document.getElementById('btnSpark').addEventListener('click', () => {
        // 在中心点燃细胞
        const cx = Math.floor(cols / 2);
        const cy = Math.floor(rows / 2);
        for (let dy = -5; dy <= 5; dy++) {
            for (let dx = -5; dx <= 5; dx++) {
                const i = (cy + dy) * cols + (cx + dx);
                if (i >= 0 && i < cells.length && Math.random() < 0.35) cells[i] = 1;
            }
        }
    });

    // ============ 启动 ============
    initGrid();
    resetBoids();
    loop();
})();
</script>
</body>
</html>`;
}

function getMLCompareHtml(d, cfg, totalData, testCount) {
    const models = d.models;
    const summary = d.summary;
    const baseline = d.baseline;
    const perPos = d.perPos;
    const prediction = d.prediction || null;
    // 动态从 perPos 取位数顺序
    const posOrder = perPos.map(p => p.pos);

    // 模型英文名 → 中文名 + 算法说明
    const MODEL_CN = {
        'AR':            { name: '自回归',     desc: '用前5期值线性外推' },
        'Markov':        { name: '马尔可夫',   desc: '基于上期号预测下期概率' },
        'kNN':           { name: 'K近邻匹配',  desc: '找历史最相似片段投票' },
        'RandomForest':  { name: '随机森林',   desc: '多决策树集成（100棵）' }
    };
    const modelName = m => (MODEL_CN[m] || { name: m, desc: '' }).name;
    const modelDesc = m => (MODEL_CN[m] || { name: m, desc: '' }).desc;

    // 构造推荐号码展示
    let predictionHtml = '';
    if (prediction && prediction.ensemble) {
        const ensemble = prediction.ensemble;
        const modelPred = prediction.models || {};
        const nums = posOrder.map(p => ensemble[p] ? ensemble[p].value : '?');
        const mainPick = nums.join(' ');
        // 各模型预测明细
        const modelCells = models.map(m => {
            const parts = posOrder.map(p => {
                const mp = modelPred[p] && modelPred[p][m];
                return mp ? `${p}:<b>${mp.value}</b>` : `${p}:-`;
            });
            return `<tr><td class="model-name">${modelName(m)}<span class="model-desc">${modelDesc(m)}</span></td><td>${parts.join(' &nbsp; ')}</td></tr>`;
        }).join('');
        // Top3 集成
        const top3Html = posOrder.map(p => {
            const e = ensemble[p];
            if (!e) return `<div class="top3-pos"><b>${p}</b>: -</div>`;
            return `<div class="top3-pos"><b>${p}</b>: ${(e.top3 || []).join(' / ')}</div>`;
        }).join('');

        predictionHtml = `
<h3>🎯 下期推荐号码</h3>
<div class="ensemble-tip">
    <b>💡 集成投票说明：</b>右侧"加权投票"结果是<b>每个模型按回测命中率加权打分</b>后的最终号码。<br>
    若与某个模型的独立预测不一致，是因为该模型回测命中率低（权重小），它的预测被"打折"了。可信度高的模型贡献更大。
</div>
<div class="prediction-main">
    ${nums.map(n => `<div class="pred-num">${n}</div>`).join('')}
    <div class="pred-meta">
        基于 ${prediction.basedOn || '?'} 期数据 · 4 模型集成（按命中率加权投票）<br>
        <span style="color:#feca57;font-size:12px">🌟 好运相伴，必中一注！愿您财源滚滚来！</span><br>
        <button id="copyPickBtn" class="copy-btn">📋 一键复制号码</button>
        <div style="color:#888;font-size:11px;margin-top:6px;line-height:1.5">
            ⚠️ 由于集成投票对各模型预测值敏感，重新运行可能得到不同号码。<br>
            实际回测显示各模型命中率均接近随机基准（10%），结果仅供娱乐参考。
        </div>
    </div>
</div>
<div class="prediction-detail">
    <div class="detail-card">
        <div class="detail-title">各模型独立预测</div>
        <table>
            <tbody>${modelCells}</tbody>
        </table>
    </div>
    <div class="detail-card">
        <div class="detail-title">每位 Top3 候补（集成投票）</div>
        <div class="top3-list">${top3Html}</div>
    </div>
</div>
<div class="copy-tip">🍀 推荐号码：<code id="pickCode">${mainPick}</code><br><span style="color:#888;font-size:11px;margin-top:4px;display:inline-block">愿您一注必中，福运双至！</span></div>
`;
    }

    // 计算表格行
    const summaryRows = models.map(m => {
        const s = summary[m];
        const strictColor = s.strictPct > baseline.strict + 2 ? '#2ecc71' : (s.strictPct < baseline.strict - 2 ? '#e74c3c' : '#aaa');
        const top3Color = s.top3Pct > baseline.top3 + 3 ? '#2ecc71' : (s.top3Pct < baseline.top3 - 3 ? '#e74c3c' : '#aaa');
        return `<tr>
            <td class="model-name">${modelName(m)}</td>
            <td style="color:${strictColor};font-weight:600">${s.strictPct.toFixed(2)}%</td>
            <td>${s.strict} / ${s.total}</td>
            <td style="color:${top3Color};font-weight:600">${s.top3Pct.toFixed(2)}%</td>
            <td>${s.top3} / ${s.total}</td>
        </tr>`;
    }).join('');

    // 每位详情表
    const posTables = perPos.map(posRow => {
        const rows = models.map(m => {
            const r = posRow[m];
            const sCol = r.strictPct > 12 ? '#2ecc71' : (r.strictPct < 8 ? '#e74c3c' : '#aaa');
            const tCol = r.top3Pct > 33 ? '#2ecc71' : (r.top3Pct < 27 ? '#e74c3c' : '#aaa');
            return `<tr>
                <td class="model-name">${modelName(m)}</td>
                <td style="color:${sCol}">${r.strictPct.toFixed(2)}%</td>
                <td>${r.strict}/${r.total}</td>
                <td style="color:${tCol}">${r.top3Pct.toFixed(2)}%</td>
                <td>${r.top3}/${r.total}</td>
            </tr>`;
        }).join('');
        return `<div class="pos-section">
            <div class="pos-title">${posRow.pos}位</div>
            <table>
                <thead><tr><th>模型</th><th>严格命中</th><th>命中/总</th><th>Top3命中</th><th>命中/总</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }).join('');

    // 找最佳模型
    const bestStrict = models.reduce((a, b) => summary[a].strictPct > summary[b].strictPct ? a : b);
    const bestTop3 = models.reduce((a, b) => summary[a].top3Pct > summary[b].top3Pct ? a : b);
    const bestS = summary[bestStrict];
    const bestT = summary[bestTop3];

    // 结论
    let conclusion;
    if (bestS.strictPct > baseline.strict + 3) {
        conclusion = `<div class="conclusion good">
            ✅ 最佳模型 <b>${modelName(bestStrict)}</b>（${bestStrict}）严格命中率 ${bestS.strictPct.toFixed(2)}%，显著高于随机基准 ${baseline.strict}%。<br>
            <b>🌟 运势如虹，号码有灵！愿您把握良机，一举中奖！</b>
        </div>`;
    } else if (bestS.strictPct > baseline.strict + 1) {
        conclusion = `<div class="conclusion neutral">
            🟡 最佳模型 <b>${modelName(bestStrict)}</b>（${bestStrict}）严格命中率 ${bestS.strictPct.toFixed(2)}%，略高于随机（${baseline.strict}%），<br>
            Top3最佳：<b>${modelName(bestTop3)}</b>（${bestTop3}） ${bestT.top3Pct.toFixed(2)}%。<br>
            <b>🍀 福星高照，幸运将至！愿好运与您不期而遇！</b>
        </div>`;
    } else {
        conclusion = `<div class="conclusion bad">
            ❌ 所有模型严格命中率都在随机基准（${baseline.strict}%）附近或之下。<br>
            <b>🎉 心诚则灵，福至心灵！愿您福气满满，必中大奖！</b>
        </div>`;
    }

    const dataJson = JSON.stringify(d);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>🧠 模型对比 - ${cfg.name}</title>
<style>
* { box-sizing:border-box;margin:0;padding:0; }
body { background:#1e1e1e;color:#ddd;font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;padding:20px;line-height:1.6; }
h2 { color:#8ec5ff;margin-bottom:6px; }
h3 { color:#feca57;margin:18px 0 10px;font-size:15px; }
.desc { color:#888;margin-bottom:18px; }
table { width:100%;border-collapse:collapse;margin:8px 0 14px; }
th,td { padding:8px 12px;text-align:center;border:1px solid rgba(255,255,255,0.08); }
th { background:rgba(0,0,0,0.3);color:#8ec5ff;font-weight:600;font-size:12px; }
td.model-name { text-align:left;font-weight:600;color:#feca57; }
tbody tr:nth-child(odd) { background:rgba(255,255,255,0.02); }
.summary-card { padding:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:8px;margin-bottom:16px; }
.pos-section { padding:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:8px;margin-bottom:14px; }
.pos-title { color:#feca57;font-weight:600;margin-bottom:8px;font-size:14px; }
.conclusion { padding:16px;border-radius:8px;margin-top:20px;font-size:14px;line-height:1.8; }
.conclusion.good { background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.3);color:#2ecc71; }
.conclusion.neutral { background:rgba(254,202,87,0.08);border:1px solid rgba(254,202,87,0.3);color:#feca57; }
.conclusion.bad { background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.3);color:#ff6b6b; }
.prediction-main { display:flex;align-items:center;gap:24px;padding:20px;background:linear-gradient(135deg, rgba(142,197,255,0.1), rgba(254,202,87,0.1));border:1px solid rgba(254,202,87,0.3);border-radius:12px;margin-bottom:14px; }
.pred-num { width:80px;height:80px;display:flex;align-items:center;justify-content:center;background:#0e639c;color:#fff;font-size:42px;font-weight:bold;border-radius:50%;box-shadow:0 4px 16px rgba(14,99,156,0.4); }
.pred-meta { color:#feca57;font-size:13px;line-height:1.7; }
.prediction-detail { display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px; }
.detail-card { padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:8px; }
.detail-title { color:#8ec5ff;font-weight:600;margin-bottom:8px;font-size:13px; }
.top3-list { display:flex;gap:14px;flex-wrap:wrap; }
.top3-pos { color:#ddd;font-size:13px; }
.top3-pos b { color:#feca57;margin-right:6px; }
.copy-tip { padding:10px 14px;background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.2);border-radius:6px;color:#aaa;font-size:12px;margin-bottom:14px; }
.copy-tip code { background:#222;padding:3px 10px;border-radius:4px;color:#2ecc71;font-size:14px;font-weight:bold;letter-spacing:2px;margin-left:6px; }
.copy-btn { margin-top:8px;padding:6px 14px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s; }
.copy-btn:hover { background:#1177bb;transform:translateY(-1px); }
.copy-btn.copied { background:#2ecc71; }
.ensemble-tip { padding:12px 14px;background:rgba(142,197,255,0.06);border:1px solid rgba(142,197,255,0.25);border-radius:6px;color:#bbb;font-size:12px;line-height:1.7;margin-bottom:12px; }
.ensemble-tip b { color:#8ec5ff; }
.model-desc { color:#888;font-size:11px;font-weight:normal;display:block;margin-top:2px; }
.warn { color:#aaa;font-size:12px; }
.badge { display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;background:#0e639c;color:#fff;margin-left:8px; }
</style>
</head>
<body>
<h2>🧠 多模型对比预测 - ${cfg.name}</h2>
<div class="desc">
    总数据 ${totalData} 期，回测 ${testCount} 期（每位 ${testCount} 次预测）<span class="badge">4 模型对比</span>
</div>

<h3>📊 总览（3位合计）</h3>
<div class="summary-card">
    <table>
        <thead><tr><th>模型</th><th>严格命中率</th><th>命中/总</th><th>Top3命中率</th><th>命中/总</th></tr></thead>
        <tbody>${summaryRows}</tbody>
    </table>
    <div style="color:#888;font-size:12px;margin-top:6px">
        随机基准：严格 ${baseline.strict}% / Top3 ${baseline.top3}%
    </div>
</div>

<h3>📌 各位详情</h3>
${posTables}

${predictionHtml}
${conclusion}

<script>
(function() {
    const btn = document.getElementById('copyPickBtn');
    const pickCode = document.getElementById('pickCode');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const text = pickCode ? pickCode.innerText.trim() : '';
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            btn.innerText = '✅ 已复制：' + text;
            btn.classList.add('copied');
            setTimeout(() => {
                btn.innerText = '📋 一键复制号码';
                btn.classList.remove('copied');
            }, 2000);
        } catch (e) {
            // Fallback: 选中复制
            const range = document.createRange();
            range.selectNode(pickCode);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.execCommand('copy');
            btn.innerText = '✅ 已复制';
            setTimeout(() => { btn.innerText = '📋 一键复制号码'; }, 2000);
        }
    });
})();
</script>
</body>
</html>`;
}

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
(function(){
    try { window.vscodeApi = acquireVsCodeApi(); } catch(e) { console.error('vscode api error:', e); }
    
    window.runFilter = function() {
        try {
            var reds = document.getElementById('redInput').value.trim();
            var blues = document.getElementById('blueInput').value.trim();
            var count = document.getElementById('countSelect').value;
            if (!reds || !blues) { alert('请输入红球和蓝球号码'); return; }
            document.getElementById('resultArea').style.display = 'block';
            document.getElementById('resultsGrid').innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:10px">正在智能分析...</p></div>';
            if (window.vscodeApi) {
                window.vscodeApi.postMessage({command:'runFilter', reds:reds, blues:blues, count:+count});
            } else {
                alert('VSCode API 未就绪');
            }
        } catch(err) { console.error('error:', err); alert('出错: ' + err.message); }
    };
    
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || !msg.command) return;
        if (msg.command === 'filterResult') renderResult(msg.data);
        if (msg.command === 'error') document.getElementById('resultsGrid').innerHTML = '<p style="color:#f44;padding:20px;text-align:center">❌ ' + (msg.message||'未知错误') + '</p>';
        if (msg.command === 'copySuccess') showToast();
    });
    
    window.renderResult = function(data) {
        if (!data) return;
        document.getElementById('resultTitle').textContent = '🎯 精选 ' + (data.results||[]).length + ' 组单注';
        
        var rt = document.querySelector('#redScoresTable tbody');
        if (rt && data.redScores) rt.innerHTML = data.redScores.map(function(r){return '<tr><td style="color:#ce9178;font-weight:bold">'+r.num+'</td><td>'+r.score+'</td><td>'+r.miss+'</td><td>'+r.avgMiss+'</td><td>'+r.freq5+'</td><td style="color:#888;font-size:11px">'+(r.reasons||[]).join(',')+'</td></tr>';}).join('');
        
        var bt = document.querySelector('#blueScoresTable tbody');
        if (bt && data.blueScores) bt.innerHTML = data.blueScores.map(function(b){return '<tr><td style="color:#6a9fb5;font-weight:bold">'+b.num+'</td><td>'+b.score+'</td><td>'+b.miss+'</td><td>'+b.avgMiss+'</td><td>'+b.freq5+'</td><td style="color:#888;font-size:11px">'+(b.reasons||[]).join(',')+'</td></tr>';}).join('');
        
        var rfb = document.getElementById('redFreqBars');
        if (rfb && data.stats && data.stats.redFreq) rfb.innerHTML = data.stats.redFreq.map(function(f){return '<div class="freq-bar"><span class="freq-label">'+f.num+'</span><div class="freq-track"><div class="freq-fill" style="width:'+f.pct+'%"></div></div><span class="freq-pct">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
        
        var bfb = document.getElementById('blueFreqBars');
        if (bfb && data.stats && data.stats.blueFreq) bfb.innerHTML = data.stats.blueFreq.map(function(f){return '<div class="freq-bar"><span class="freq-label">'+f.num+'</span><div class="freq-track"><div class="freq-fill" style="width:'+f.pct+'%"></div></div><span class="freq-pct">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
        
        var rg = document.getElementById('resultsGrid');
        if (rg && data.results) rg.innerHTML = data.results.map(function(r){
            var redStr = r.reds.map(function(n){return String(n).padStart(2,'0');}).join(' ');
            var blueStr = r.blues.map(function(n){return String(n).padStart(2,'0');}).join(' ');
            var tags = [r.details.oddEven, r.details.bigSmall, r.details.sum, r.details.consecutive, r.details.zone];
            var tagHtml = tags.map(function(t){return t && t.indexOf('优') >= 0 ? '<span class="tag good">'+t+'</span>' : '<span class="tag">'+t+'</span>';}).join('');
            return '<div class="result-card"><div class="card-header"><span class="card-num">'+redStr+' + '+blueStr+'</span><span class="card-score">'+r.score+'分</span></div><div class="card-details">'+tagHtml+'</div><button onclick="copyOne(\''+redStr+' + '+blueStr+\')" style="margin-top:8px;padding:4px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer">复制</button></div>';
        }).join('');
        
        window.currentResults = data.results;
    };
    
    window.copyOne = function(text) { if(window.vscodeApi) window.vscodeApi.postMessage({command:'copy', text:text}); };
    
    window.copyAll = function() {
        if (!window.currentResults) return;
        var lines = window.currentResults.map(function(r, i){
            var redStr = r.reds.map(function(n){return String(n).padStart(2,'0');}).join(' ');
            var blueStr = r.blues.map(function(n){return String(n).padStart(2,'0');}).join(' ');
            return String(i+1).padStart(2,'0')+'. '+redStr+' + '+blueStr;
        });
        if (window.vscodeApi) window.vscodeApi.postMessage({command:'copy', text:lines.join(String.fromCharCode(10))});
    };
    
    window.showToast = function() {
        var t = document.getElementById('copyToast') || document.getElementById('toast');
        if (t) { t.classList.add('show'); t.style.display = 'block'; setTimeout(function(){ t.classList.remove('show'); t.style.display = 'none'; }, 2000); }
    };
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
 * 快乐8遗漏分层 + 走势图 Webview HTML
 * 对 1-80 号球的遗漏值进行分层统计展示：
 *  - 分层概览：按当前遗漏值分层（0 / 1-2 / 3-5 / 6-10 / 11-20 / 20+）
 *  - 明细表：每个号码的当前遗漏、各周期出现次数、平均遗漏、最大遗漏
 *  - 走势图（tab 切换）：
 *     · 号码分布走势：每期 20 个开出号码在 1-80 区间的散点分布
 *     · 遗漏曲线：当前遗漏 TOP10 号码的遗漏值随期数变化
 * @param {Array} history - 快乐8历史数据（最新在前），元素 {period, num:[20个号码]}
 */
function getKl8MissHtml(history) {
    const total = history.length;
    const latest = history[0];
    const latestPeriod = latest ? latest.period : '—';
    const latestNums = latest ? latest.num : [];
    const updateTime = latest ? (latest.date || '') : '';

    // 计算每个号码的遗漏统计
    // missStats[n] = { miss, count10, count30, count50, count100, count150, count200, avgMiss, maxMiss, lastPeriod }
    const missStats = {};
    for (let n = 1; n <= 80; n++) {
        // 当前遗漏：从最新往前找第一次出现的位置
        let miss = -1;
        let lastPeriod = '—';
        const positions = []; // 出现位置（index 越小越新）
        for (let i = 0; i < total; i++) {
            if (history[i].num.indexOf(n) >= 0) {
                if (miss < 0) {
                    miss = i;
                    lastPeriod = history[i].period;
                }
                positions.push(i);
            }
        }
        if (miss < 0) miss = total; // 从未出现
        const count10 = positions.filter(p => p < 10).length;
        const count30 = positions.filter(p => p < 30).length;
        const count50 = positions.filter(p => p < 50).length;
        const count100 = positions.filter(p => p < 100).length;
        const count150 = positions.filter(p => p < 150).length;
        const count200 = positions.filter(p => p < 200).length;
        // 平均遗漏：两次出现间隔的平均（含到第一期的距离）
        let avgMiss = 0;
        let maxMiss = 0;
        if (positions.length > 1) {
            const gaps = [];
            for (let i = 0; i < positions.length - 1; i++) {
                gaps.push(positions[i + 1] - positions[i] - 1);
            }
            gaps.push(positions[positions.length - 1]); // 最旧一期之前
            avgMiss = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            maxMiss = Math.max(...gaps);
        } else if (positions.length === 1) {
            avgMiss = positions[0];
            maxMiss = positions[0];
        }
        missStats[n] = {
            miss, count10, count30, count50, count100, count150, count200,
            avgMiss: Math.round(avgMiss * 10) / 10,
            maxMiss,
            lastPeriod
        };
    }

    // 分层定义
    const layers = [
        { name: '热号', range: [0, 0], cls: 'layer-hot', desc: '上期开出' },
        { name: '温热', range: [1, 2], cls: 'layer-warm', desc: '遗漏 1-2 期' },
        { name: '温冷', range: [3, 5], cls: 'layer-cool', desc: '遗漏 3-5 期' },
        { name: '冷号', range: [6, 10], cls: 'layer-cold', desc: '遗漏 6-10 期' },
        { name: '极冷', range: [11, 20], cls: 'layer-freeze', desc: '遗漏 11-20 期' },
        { name: '冰封', range: [21, 999], cls: 'layer-ice', desc: '遗漏 20+ 期' }
    ];

    // 分层概览表格 + 号码分类汇总
    let layerRows = '';
    let layerSummary = '';
    for (const layer of layers) {
        const nums = [];
        for (let n = 1; n <= 80; n++) {
            const m = missStats[n].miss;
            if (m >= layer.range[0] && m <= layer.range[1]) nums.push(n);
        }
        const ballHtml = nums.map(n => {
            const cls = n <= 10 ? 'kball-a' : n <= 20 ? 'kball-b' : n <= 30 ? 'kball-c' : n <= 40 ? 'kball-d' : n <= 50 ? 'kball-e' : n <= 60 ? 'kball-f' : n <= 70 ? 'kball-g' : 'kball-h';
            return '<span class="kball ' + cls + '" title="遗漏 ' + missStats[n].miss + ' 期">' + n + '</span>';
        }).join('');
        const avg = nums.length > 0
            ? (nums.reduce((a, n) => a + missStats[n].miss, 0) / nums.length).toFixed(1)
            : '—';
        layerRows += '<tr><td class="' + layer.cls + '">' + layer.name + '</td>' +
            '<td>' + layer.desc + '</td>' +
            '<td>' + nums.length + ' 个</td>' +
            '<td class="' + layer.cls + '">' + avg + '</td>' +
            '<td class="ball-cell">' + (ballHtml || '<span style="color:#555">无</span>') + '</td></tr>';

        // 号码分类汇总：每层一行，横向展示该层全部号码
        const dotCls = 'dot-' + layer.cls.replace('layer-', '');
        layerSummary += '<div class="summary-row">' +
            '<div class="summary-label"><span class="summary-dot ' + dotCls + '"></span>' + layer.name + ' <small>' + layer.desc + '</small></div>' +
            '<div class="summary-count ' + layer.cls + '">' + nums.length + ' 个</div>' +
            '<div class="summary-balls">' + (ballHtml || '<span style="color:#555">无</span>') + '</div>' +
            '</div>';
    }

    // ===== 智能推荐：选10 ~ 选1 =====
    // 综合评分：近期活跃度（count10 权重最高）＋中期活跃度 ＋ 遗漏回补
    // score = count10*3 + count30*1.5 + count50*0.8 - miss*0.3
    // 遗漏适中的活跃号码得分最高；选10 取前10名，选9 取前9名，依此类推
    const scored = [];
    for (let n = 1; n <= 80; n++) {
        const s = missStats[n];
        const score = s.count10 * 3 + s.count30 * 1.5 + s.count50 * 0.8 - s.miss * 0.3;
        scored.push({ n, score, miss: s.miss, count10: s.count10, count30: s.count30 });
    }
    scored.sort((a, b) => b.score - a.score);

    let pickRows = '';
    for (let pick = 10; pick >= 1; pick--) {
        const list = scored.slice(0, pick);
        list.sort((a, b) => a.n - b.n); // 显示按号码从小到大排序
        const balls = list.map(x => {
            const cls = x.n <= 10 ? 'kball-a' : x.n <= 20 ? 'kball-b' : x.n <= 30 ? 'kball-c' : x.n <= 40 ? 'kball-d' : x.n <= 50 ? 'kball-e' : x.n <= 60 ? 'kball-f' : x.n <= 70 ? 'kball-g' : 'kball-h';
            return '<span class="kball ' + cls + '" title="号码 ' + x.n + ' · 当前遗漏 ' + x.miss + ' 期 · 近10期出 ' + x.count10 + ' 次 · 近30期出 ' + x.count30 + ' 次">' + x.n + '</span>';
        }).join('');
        const hotInfo = list.length > 0
            ? '（近10期出现率 ' + (list.reduce((a, x) => a + x.count10, 0) / (pick * Math.min(total, 10)) * 100).toFixed(0) + '%）'
            : '';
        pickRows += '<div class="pick-row" data-pick="' + pick + '">' +
            '<div class="pick-label">选<span class="pick-num">' + pick + '</span></div>' +
            '<div class="pick-balls">' + (balls || '<span style="color:#555">无</span>') + '</div>' +
            '<div class="pick-info">' + hotInfo + '</div>' +
            '<button class="pick-copy-btn" data-pick-copy="' + pick + '" title="复制 选' + pick + ' 的号码">📋 复制</button>' +
            '</div>';
    }

    // 明细表（按当前遗漏排序）
    const detailRows = [];
    for (let n = 1; n <= 80; n++) {
        const s = missStats[n];
        const layerCls = s.miss === 0 ? 'layer-hot' : s.miss <= 2 ? 'layer-warm' : s.miss <= 5 ? 'layer-cool' : s.miss <= 10 ? 'layer-cold' : s.miss <= 20 ? 'layer-freeze' : 'layer-ice';
        detailRows.push({
            n,
            miss: s.miss,
            count10: s.count10,
            count30: s.count30,
            count50: s.count50,
            count100: s.count100,
            count150: s.count150,
            count200: s.count200,
            avgMiss: s.avgMiss,
            maxMiss: s.maxMiss,
            lastPeriod: s.lastPeriod,
            layerCls
        });
    }
    detailRows.sort((a, b) => b.miss - a.miss);

    // 明细数据（转为 JSON 传给前端，由前端按所选期数动态渲染表格）
    const detailData = detailRows.map(r => ({
        n: r.n,
        miss: r.miss,
        c10: r.count10, c30: r.count30, c50: r.count50,
        c100: r.count100, c150: r.count150, c200: r.count200,
        avg: r.avgMiss,
        max: r.maxMiss,
        last: r.lastPeriod,
        cls: r.layerCls
    }));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>快乐8 遗漏分层</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #e8a87c; margin-bottom: 8px; font-size: 20px; }
/* 遗漏明细期数选择与图例 */
.detail-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-bottom: 8px; font-size: 12px; }
.detail-label { color: #aaa; }
.span-chk-label { display: inline-flex; align-items: center; gap: 3px; color: #e8a87c; cursor: pointer; user-select: none; }
.span-chk-label input { accent-color: #e8a87c; cursor: pointer; }
.detail-legend { color: #999; font-size: 11px; margin-left: auto; }
.span-custom-box { display: inline-flex; align-items: center; gap: 4px; }
.span-custom-box input { width: 96px; background: #2d2d30; border: 1px solid #3c3c3f; color: #ddd; border-radius: 3px; padding: 3px 6px; font-size: 12px; }
.span-custom-box input:focus { outline: none; border-color: #e8a87c; }
.span-custom-box button { background: #0e639c; color: #fff; border: none; border-radius: 3px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.span-custom-box button:hover { background: #1177bb; }
.span-del { margin-left: 3px; color: #e74c3c; cursor: pointer; font-size: 10px; font-weight: 700; }
.span-del:hover { color: #ff6b5e; }
.detail-msg { color: #2ecc71; font-size: 11px; }
.sub { color: #888; margin-bottom: 16px; font-size: 12px; }
.latest-box { padding: 12px 16px; background: rgba(232,168,124,0.1); border: 1px solid rgba(232,168,124,0.3); border-radius: 8px; margin-bottom: 20px; }
.latest-box b { color: #e8a87c; }
.latest-nums { margin-top: 8px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: rgba(0,0,0,0.15); }
th, td { border: 1px solid #3a3a3d; padding: 6px 10px; text-align: center; font-size: 12px; }
th { background: #2d2d30; color: #e8a87c; font-size: 13px; position: sticky; top: 0; z-index: 1; }
.ball-cell { text-align: left; line-height: 1.9; }
.kball { display: inline-block; min-width: 26px; height: 26px; line-height: 26px; text-align: center; border-radius: 50%; font-size: 12px; margin: 1px 2px; color: #fff; font-weight: 600; }
/* 号码球配色（按区间 8 色） */
.kball-r1 { background: #e74c3c; }
.kball-a { background: #e67e22; }
.kball-b { background: #f1c40f; color: #222; }
.kball-c { background: #2ecc71; }
.kball-d { background: #1abc9c; }
.kball-e { background: #3498db; }
.kball-f { background: #9b59b6; }
.kball-g { background: #8e44ad; }
.kball-h { background: #34495e; }
/* 遗漏分层颜色 */
.layer-hot { color: #e74c3c; font-weight: 600; }
.layer-warm { color: #e67e22; font-weight: 600; }
.layer-cool { color: #f1c40f; font-weight: 600; }
.layer-cold { color: #2ecc71; font-weight: 600; }
.layer-freeze { color: #3498db; font-weight: 600; }
.layer-ice { color: #9b59b6; font-weight: 600; }
.section-title { color: #e8a87c; font-size: 15px; font-weight: 600; margin: 18px 0 8px; }
.scroll-wrap { max-height: 70vh; overflow-y: auto; border: 1px solid #3a3a3d; border-radius: 6px; }
/* 号码分层汇总 */
.layer-summary { background: rgba(0,0,0,0.15); border: 1px solid #3a3a3d; border-radius: 6px; padding: 12px; margin-bottom: 18px; }
.summary-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #2a2a2d; }
.summary-row:last-child { border-bottom: none; }
.summary-label { min-width: 110px; font-weight: 600; color: #ddd; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.summary-label small { color: #888; font-weight: 400; font-size: 11px; margin-left: 4px; }
.summary-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot-hot { background: #e74c3c; }
.dot-warm { background: #e67e22; }
.dot-cool { background: #f1c40f; }
.dot-cold { background: #2ecc71; }
.dot-freeze { background: #3498db; }
.dot-ice { background: #9b59b6; }
.summary-count { min-width: 50px; text-align: center; font-weight: 700; font-size: 13px; }
.summary-balls { flex: 1; line-height: 1.9; }
/* 智能推荐选号（选10~选1） */
.pick-box { background: rgba(232,168,124,0.07); border: 1px solid rgba(232,168,124,0.35); border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; }
.pick-box-title { color: #e8a87c; font-size: 15px; font-weight: 700; margin-bottom: 4px; }
.pick-box-desc { color: #999; font-size: 11px; margin-bottom: 10px; }
.pick-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid #2a2a2d; }
.pick-row:last-child { border-bottom: none; }
.pick-label { min-width: 42px; text-align: center; font-weight: 700; color: #e8a87c; font-size: 14px; background: rgba(232,168,124,0.12); border: 1px solid rgba(232,168,124,0.3); border-radius: 5px; padding: 3px 0; }
.pick-label .pick-num { font-size: 17px; }
.pick-balls { flex: 1; line-height: 1.9; }
.pick-info { min-width: 130px; text-align: right; color: #777; font-size: 11px; white-space: nowrap; }
.pick-copy-btn { float: right; background: #0e639c; color: #fff; border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all .2s; }
.pick-copy-btn:hover { background: #1177bb; }
.pick-copy-btn.copied { background: #2ecc71; }
.pick-multiplier { float: right; margin-right: 10px; color: #ccc; font-size: 12px; font-weight: 400; }
.pick-multiplier select { background: #2d2d30; color: #e8a87c; border: 1px solid #555; border-radius: 4px; padding: 3px 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.pick-multiplier select:focus { outline: none; border-color: #e8a87c; }
/* Tab 切换样式 */
.tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 2px solid #3a3a3d; }
.tab-btn { padding: 8px 22px; background: transparent; color: #aaa; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all .2s; }
.tab-btn:hover { color: #fff; background: rgba(255,255,255,0.04); }
.tab-btn.active { color: #e8a87c; border-bottom-color: #e8a87c; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.sub-tabs { display: flex; gap: 6px; margin: 6px 0 12px; }
.sub-tab-btn { padding: 5px 14px; background: #2d2d30; color: #aaa; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all .2s; }
.sub-tab-btn:hover { background: #3a3a3a; color: #fff; }
.sub-tab-btn.active { background: #0e639c; color: #fff; border-color: #0e639c; font-weight: 600; }
.canvas-wrap { overflow-x: auto; background: #151517; border: 1px solid #3a3a3d; border-radius: 6px; }
canvas { display: block; }
.hint { color: #777; font-size: 12px; margin: 4px 0 10px; line-height: 1.5; }
.legend { margin-top: 8px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.legend-item { display: inline-flex; align-items: center; gap: 5px; color: #ccc; }
.legend-item b { color: #fff; }
.legend-swatch { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
/* 走势图表格 */
.trend-wrap { overflow-x: auto; border: 1px solid #3a3a3d; border-radius: 6px; background: #151517; }
.trend-table { width: max-content; border-collapse: collapse; font-size: 11px; }
.trend-table thead { position: sticky; top: 0; z-index: 4; }
.trend-table th, .trend-table td { border: 1px solid #2a2a2d; padding: 2px 4px; text-align: center; min-width: 22px; height: 22px; }
.trend-table th { background: #2d2d30; color: #e8a87c; font-size: 10px; }
.trend-table .th-period { min-width: 48px; position: sticky; left: 0; z-index: 5; background: #2d2d30; }
.trend-table .td-period { background: #1e1e1e; color: #aaa; font-size: 10px; position: sticky; left: 0; z-index: 3; }
.trend-table .td-hit { background: #e74c3c !important; color: #fff; font-weight: 700; border-radius: 2px; box-shadow: inset 0 0 0 1px #ff8a80; }
.trend-table .td-miss { color: #777; font-size: 10px; }
.trend-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.trend-table tbody tr:hover { background: rgba(255,255,255,0.06); }
/* 分区背景（8 个区间不同色调，加强版） */
.trend-table td.g0 { background: rgba(231,76,60,0.18); color: #ff9d93; }
.trend-table td.g1 { background: rgba(230,126,34,0.18); color: #ffb066; }
.trend-table td.g2 { background: rgba(241,196,15,0.18); color: #f5d76e; }
.trend-table td.g3 { background: rgba(46,204,113,0.18); color: #7ee8a4; }
.trend-table td.g4 { background: rgba(26,188,156,0.18); color: #6ee8d2; }
.trend-table td.g5 { background: rgba(52,152,219,0.18); color: #7ab8ff; }
.trend-table td.g6 { background: rgba(155,89,182,0.18); color: #d0a8f0; }
.trend-table td.g7 { background: rgba(93,109,126,0.22); color: #c0c9d4; }
/* 表头号码按区间配色 */
.trend-table .th-num.g0 { color: #ff8a80; }
.trend-table .th-num.g1 { color: #ffab66; }
.trend-table .th-num.g2 { color: #f5d76e; }
.trend-table .th-num.g3 { color: #7ef0a8; }
.trend-table .th-num.g4 { color: #66e6cf; }
.trend-table .th-num.g5 { color: #82b1ff; }
.trend-table .th-num.g6 { color: #d1a3f0; }
.trend-table .th-num.g7 { color: #c0c9d4; }
.trend-table td.grp-end { border-right: 2px solid #777 !important; }
.trend-table th.grp-end { border-right: 2px solid #777 !important; }
/* 分组表头 */
.trend-table .grp { font-size: 11px; font-weight: 700; padding: 4px 2px; }
.trend-table .grp-0 { background: rgba(231,76,60,0.35); color: #ffb3a7; }
.trend-table .grp-1 { background: rgba(230,126,34,0.35); color: #ffd0a3; }
.trend-table .grp-2 { background: rgba(241,196,15,0.35); color: #fff0a3; }
.trend-table .grp-3 { background: rgba(46,204,113,0.35); color: #b3f5cd; }
.trend-table .grp-4 { background: rgba(26,188,156,0.35); color: #b0f3e6; }
.trend-table .grp-5 { background: rgba(52,152,219,0.35); color: #b5d9ff; }
.trend-table .grp-6 { background: rgba(155,89,182,0.35); color: #dfb8f5; }
.trend-table .grp-7 { background: rgba(93,109,126,0.4); color: #cfd6de; }
/* 表格内预测行（与表格一体，跟随横向滚动，可点击选号） */
.trend-table .trend-predict-row td { border-top: 2px solid #e8a87c; }
.trend-table .td-pick { cursor: pointer; font-weight: 700; font-size: 11px; user-select: none; }
.trend-table .td-pick:hover { box-shadow: inset 0 0 0 1px #e8a87c; }
.trend-table .trend-predict-row.active td:not(.td-period) { background: rgba(232,168,124,0.25) !important; }
.trend-table .trend-predict-row.active .td-period { color: #e8a87c; font-weight: 700; }
.trend-table .td-pick.picked { background: #e74c3c !important; color: #fff !important; box-shadow: inset 0 0 0 1px #ff8a80; }
/* 预测选号区 */
.predict-box { margin-top: 16px; border: 1px solid rgba(232,168,124,0.4); border-radius: 8px; background: rgba(232,168,124,0.06); padding: 14px; }
.predict-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.predict-title { color: #e8a87c; font-weight: 700; font-size: 15px; margin-right: auto; }
.predict-box button { padding: 6px 14px; background: #0e639c; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background .2s; }
.predict-box button:hover { background: #1177bb; }
.predict-box button.btn-danger { background: #7a2f2f; }
.predict-box button.btn-danger:hover { background: #a04040; }
.predict-picker { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; }
.pick-ball { width: 28px; height: 28px; line-height: 26px; text-align: center; border-radius: 50%; font-size: 12px; font-weight: 600; color: #fff; cursor: pointer; border: 2px solid transparent; user-select: none; transition: all .15s; }
.pick-ball:hover { border-color: #fff; transform: scale(1.08); }
.pick-ball.picked { border-color: #fff; box-shadow: 0 0 0 2px #e8a87c; transform: scale(1.1); }
.predict-rows { display: flex; flex-direction: column; gap: 8px; }
.predict-row { display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.25); border: 1px solid #3a3a3d; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
.predict-row.active { border-color: #e8a87c; box-shadow: 0 0 0 1px #e8a87c; }
.predict-row-label { min-width: 56px; color: #e8a87c; font-weight: 600; font-size: 12px; }
.predict-row-nums { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; }
.predict-row-actions { display: flex; gap: 4px; }
.predict-row-actions button { padding: 3px 8px; font-size: 11px; }
.predict-status { margin-top: 8px; color: #2ecc71; font-size: 12px; min-height: 16px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
</style>
</head>
<body>
<h2>🎱 快乐8 遗漏分层分析</h2>
<div class="sub">数据源：500.com · 共 ${total} 期（最新 ${latestPeriod} 期${updateTime ? ' · ' + updateTime : ''}）</div>
<div class="latest-box">
    <b>最新开奖 ${latestPeriod} 期：</b>
    <div class="latest-nums">${latestNums.map(n => {
        const cls = n <= 10 ? 'kball-a' : n <= 20 ? 'kball-b' : n <= 30 ? 'kball-c' : n <= 40 ? 'kball-d' : n <= 50 ? 'kball-e' : n <= 60 ? 'kball-f' : n <= 70 ? 'kball-g' : 'kball-h';
        return '<span class="kball ' + cls + '">' + n + '</span>';
    }).join('')}</div>
</div>

<div class="tabs">
    <button class="tab-btn active" data-tab="miss">📋 遗漏分层</button>
    <button class="tab-btn" data-tab="trend">📈 走势图</button>
</div>

<div id="panel-miss" class="tab-panel active">
<div class="pick-box">
    <div class="pick-box-title">🎯 智能推荐选号（选10 ~ 选1）
        <span class="pick-multiplier">倍数 <select id="pickMultiplier"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option></select> 倍</span>
        <button id="btnCopyPick" class="pick-copy-btn">📋 一键复制</button>
    </div>
    <div class="pick-box-desc">按近期活跃度综合评分排序：近10期出现次数(权重最高)＋近30期＋近50期，减去当前遗漏惩罚。选10 取前10名，选9 取前9名……选1 取第1名。悬停号码球可查看详细统计。</div>
    ${pickRows}
</div>
<div class="section-title">🌡️ 号码分层汇总</div>
<div class="layer-summary">${layerSummary}</div>
<div class="section-title">📋 遗漏分层概览（按当前遗漏值分层）</div>
<table>
<thead><tr><th>分层</th><th>说明</th><th>号码数</th><th>平均遗漏</th><th>号码列表</th></tr></thead>
<tbody>${layerRows}</tbody>
</table>
<div class="section-title">🔍 号码遗漏明细（按当前遗漏从大到小排序）</div>
<div class="detail-toolbar">
    <span class="detail-label">期数列：</span>
    <span id="spanChkBox"></span>
    <span class="span-custom-box">
        <input type="number" id="customSpanInput" min="1" max="5000" placeholder="自定义期数，如 2000">
        <button id="btnAddSpan">＋ 添加</button>
    </span>
    <span class="detail-msg" id="detailMsg"></span>
    <span class="detail-legend">🔥≥30% 热 · 😀≥23% 较热 · 😐≥17% 一般 · 😟≥10% 较冷 · 🥶&lt;10% 冷</span>
</div>
<div class="scroll-wrap">
<table>
<thead id="detailHead"></thead>
<tbody id="detailBody"></tbody>
</table>
</div>
</div>

<div id="panel-trend" class="tab-panel">
<div class="sub-tabs">
    <button class="sub-tab-btn active" data-subtab="zoushi">🎯 号码走势图</button>
    <button class="sub-tab-btn" data-subtab="missline">📉 遗漏曲线</button>
</div>
<div id="sub-zoushi">
    <div class="hint">横轴为开奖期数（旧 → 新，最新在右），纵轴为号码 1-80。开出号码红底白字显示，未开出号码显示当前遗漏值。表格最下方「🎯 预测」行可直接点击选号，与下方预测区联动。</div>
    <div class="trend-wrap" id="trendTableWrap"></div>
    <div class="predict-box" id="predictBox">
        <div class="predict-toolbar">
            <span class="predict-title">🎯 我的预测</span>
            <button id="btnAddRow">＋ 增加预测行</button>
            <button id="btnCopy">📋 一键复制</button>
            <button id="btnClear">🗑 清空</button>
        </div>
        <div class="predict-picker" id="predictPicker"></div>
        <div id="predictRows"></div>
        <div class="predict-status" id="predictStatus"></div>
    </div>
</div>
<div id="sub-missline" style="display:none;">
    <div class="hint">当前遗漏最大的 TOP10 号码的遗漏值随期数变化曲线（开出的当期遗漏为 0）。</div>
    <div class="canvas-wrap"><canvas id="missCanvas"></canvas></div>
    <div class="legend" id="missLegend"></div>
</div>
</div>

<script>
// ===== 快乐8 走势图绘制 =====
// 全局 vscode API：webview 中 acquireVsCodeApi 只能调用一次，此处缓存复用
let vscodeApi = null;
try { vscodeApi = acquireVsCodeApi(); } catch (e) { console.error('vscode api error:', e); }
const HISTORY = ${JSON.stringify(history)};
const dataOldNew = HISTORY.slice().reverse(); // 旧 → 新

// ===== 遗漏明细动态渲染（可勾选期数列 + 自定义期数） =====
const DETAIL_DATA = ${JSON.stringify(detailData)};
// 预设期数 → 数据字段 key（自定义期数在前端实时统计）
const spanDefs = {
    10: 'c10', 30: 'c30', 50: 'c50', 100: 'c100', 150: 'c150', 200: 'c200'
};
const presetSpans = [10, 30, 50, 100, 150, 200];
let detailSpans = [10, 30, 50, 100, 150, 200]; // 当前显示的期数列（升序）
let customSpans = []; // 用户自定义的期数
// 号码出现位置缓存（用于任意期数实时统计）
const posCache = {};
DETAIL_DATA.forEach(function(r) {
    const ps = [];
    for (let i = 0; i < HISTORY.length; i++) {
        if (HISTORY[i].num.indexOf(r.n) >= 0) ps.push(i);
    }
    posCache[r.n] = ps;
});
function countInSpan(num, span) {
    const ps = posCache[num] || [];
    const n = Math.min(span, HISTORY.length);
    let c = 0;
    for (let i = 0; i < ps.length && ps[i] < n; i++) c++;
    return c;
}
function hotEmoji(c, span) {
    const r = c / span;
    return r >= 0.30 ? '🔥' : r >= 0.233 ? '😀' : r >= 0.167 ? '😐' : r >= 0.10 ? '😟' : '🥶';
}
function showDetailMsg(msg, isError) {
    const el = document.getElementById('detailMsg');
    el.textContent = msg;
    el.style.color = isError ? '#e74c3c' : '#2ecc71';
    setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2500);
}
function renderSpanChks() {
    const box = document.getElementById('spanChkBox');
    let h = '';
    presetSpans.forEach(function(s) {
        h += '<label class="span-chk-label"><input type="checkbox" class="span-chk" value="' + s + '"' + (detailSpans.indexOf(s) >= 0 ? ' checked' : '') + '> 近' + s + '期</label>';
    });
    customSpans.forEach(function(s) {
        h += '<label class="span-chk-label"><input type="checkbox" class="span-chk" value="' + s + '" checked> 近' + s + '期 <span class="span-del" data-del="' + s + '" title="移除该列">✕</span></label>';
    });
    box.innerHTML = h;
}
function renderMissDetail() {
    const headEl = document.getElementById('detailHead');
    const bodyEl = document.getElementById('detailBody');
    if (!headEl || !bodyEl) return;
    let h = '<tr><th>号码</th><th>当前遗漏</th>';
    detailSpans.forEach(function(s) { h += '<th>近' + s + '期</th>'; });
    h += '<th>平均遗漏</th><th>最大遗漏</th><th>最近出现期</th></tr>';
    headEl.innerHTML = h;
    let b = '';
    DETAIL_DATA.forEach(function(r) {
        const cls = r.n <= 10 ? 'kball-a' : r.n <= 20 ? 'kball-b' : r.n <= 30 ? 'kball-c' : r.n <= 40 ? 'kball-d' : r.n <= 50 ? 'kball-e' : r.n <= 60 ? 'kball-f' : r.n <= 70 ? 'kball-g' : 'kball-h';
        b += '<tr><td><span class="kball ' + cls + '">' + r.n + '</span></td>';
        b += '<td class="' + r.cls + '" style="font-weight:bold;">' + r.miss + '</td>';
        detailSpans.forEach(function(s) {
            const v = (s <= 200 && spanDefs[s]) ? r[spanDefs[s]] : countInSpan(r.n, s);
            b += '<td>' + v + ' ' + hotEmoji(v, s) + '</td>';
        });
        b += '<td>' + r.avg + '</td><td>' + r.max + '</td><td style="color:#888;">' + r.last + '</td></tr>';
    });
    bodyEl.innerHTML = b;
}
// 勾选/取消期数列（事件委托，兼容动态生成的自定义勾选框）
document.getElementById('spanChkBox').addEventListener('change', function(e) {
    if (!e.target.classList.contains('span-chk')) return;
    const s = parseInt(e.target.value);
    const idx = detailSpans.indexOf(s);
    if (e.target.checked) { if (idx < 0) detailSpans.push(s); }
    else if (idx >= 0) detailSpans.splice(idx, 1);
    detailSpans.sort(function(a, b) { return a - b; });
    renderMissDetail();
});
// 移除自定义期数列
document.getElementById('spanChkBox').addEventListener('click', function(e) {
    if (!e.target.classList.contains('span-del')) return;
    const s = parseInt(e.target.getAttribute('data-del'));
    customSpans = customSpans.filter(function(x) { return x !== s; });
    const idx = detailSpans.indexOf(s);
    if (idx >= 0) detailSpans.splice(idx, 1);
    renderSpanChks();
    renderMissDetail();
});
// 添加自定义期数
document.getElementById('btnAddSpan').addEventListener('click', function() {
    const inp = document.getElementById('customSpanInput');
    const v = parseInt(inp.value);
    if (!v || v < 1) { showDetailMsg('请输入有效期数（≥1）', true); return; }
    if (v > 5000) { showDetailMsg('最多支持 5000 期', true); return; }
    if (detailSpans.indexOf(v) >= 0) { showDetailMsg('近' + v + '期已存在', true); return; }
    customSpans.push(v);
    detailSpans.push(v);
    detailSpans.sort(function(a, b) { return a - b; });
    inp.value = '';
    renderSpanChks();
    renderMissDetail();
    showDetailMsg('已添加 近' + v + '期');
});
renderSpanChks();
renderMissDetail();

function shortPeriod(p) {
    const s = String(p || '');
    return s.length > 6 ? s.slice(-5) : s;
}

// 计算每期的遗漏矩阵：missMatrix[j][num] = 该号码在该期的遗漏值（0 表示开出）
function buildMissMatrix() {
    const n = dataOldNew.length;
    const matrix = [];
    const lastSeen = {};
    for (let j = 0; j < n; j++) {
        const row = {};
        const nums = dataOldNew[j].num || [];
        for (let k = 0; k < nums.length; k++) lastSeen[nums[k]] = j;
        for (let num = 1; num <= 80; num++) {
            if (lastSeen[num] === undefined) row[num] = j;       // 从未出现
            else if (lastSeen[num] === j) row[num] = 0;          // 本期开出
            else row[num] = j - lastSeen[num];                    // 未开出
        }
        matrix.push(row);
    }
    return matrix;
}

// 号码走势图表格（标准彩票走势图样式，按 1-10 / 11-20 … 71-80 分区）
function drawTrendTable() {
    const wrap = document.getElementById('trendTableWrap');
    const n = dataOldNew.length;
    if (n === 0) return;
    const scrollLeft = wrap.scrollLeft;
    const matrix = buildMissMatrix();

    let html = '<table class="trend-table"><thead>';
    // 分组表头
    html += '<tr><th class="th-period"></th>';
    for (let g = 0; g < 8; g++) {
        const start = g * 10 + 1, end = start + 9;
        const label = String(start).padStart(2, '0') + '-' + String(end).padStart(2, '0');
        html += '<th colspan="10" class="grp grp-' + g + (g === 7 ? ' grp-end' : '') + '">' + label + '</th>';
    }
    html += '</tr>';
    // 号码表头
    html += '<tr><th class="th-period">期号</th>';
    for (let num = 1; num <= 80; num++) {
        const g = Math.floor((num - 1) / 10);
        html += '<th class="th-num g' + g + (num % 10 === 0 ? ' grp-end' : '') + '">' + num + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (let j = 0; j < n; j++) {
        const period = shortPeriod(dataOldNew[j].period);
        html += '<tr><td class="td-period">' + period + '</td>';
        const nums = dataOldNew[j].num || [];
        const numSet = {};
        for (let k = 0; k < nums.length; k++) numSet[nums[k]] = true;
        for (let num = 1; num <= 80; num++) {
            const g = Math.floor((num - 1) / 10);
            const endCls = (num % 10 === 0) ? ' grp-end' : '';
            if (numSet[num]) {
                html += '<td class="td-hit g' + g + endCls + '">' + num + '</td>';
            } else {
                html += '<td class="td-miss g' + g + endCls + '">' + matrix[j][num] + '</td>';
            }
        }
        html += '</tr>';
    }
    // 预测行：作为表格的一部分，紧贴数据行，跟随横向滚动，可点击选号（每行对应一个预测行）
    for (let r = 0; r < predictRows.length; r++) {
        const row = predictRows[r];
        const pickedSet = {};
        for (let k = 0; k < row.nums.length; k++) pickedSet[row.nums[k]] = true;
        html += '<tr class="trend-predict-row' + (r === activeRow ? ' active' : '') + '" data-prow="' + r + '">';
        html += '<td class="td-period">' + (r === activeRow ? '▶' : ' ') + ' 第' + (r + 1) + '行</td>';
        for (let num = 1; num <= 80; num++) {
            const g = Math.floor((num - 1) / 10);
            const endCls = (num % 10 === 0) ? ' grp-end' : '';
            html += '<td class="td-pick g' + g + endCls + (pickedSet[num] ? ' picked' : '') + '" data-num="' + num + '" title="点击选/取消 ' + num + '">' + num + '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.scrollLeft = scrollLeft;
}

// 当前遗漏 TOP10 号码
function topMissNums() {
    const latestSet = {};
    const l0 = HISTORY[0];
    if (l0 && l0.num) for (let k = 0; k < l0.num.length; k++) latestSet[l0.num[k]] = true;
    const list = [];
    for (let num = 1; num <= 80; num++) {
        if (latestSet[num]) continue;
        let miss = 0;
        for (let i = 0; i < HISTORY.length; i++) {
            if (HISTORY[i].num.indexOf(num) >= 0) break;
            miss++;
        }
        list.push({ num: num, miss: miss });
    }
    list.sort(function(a, b) { return b.miss - a.miss; });
    return list.slice(0, 10);
}

// 遗漏曲线图
function drawMissLines() {
    const wrap = document.getElementById('sub-missline');
    const canvas = document.getElementById('missCanvas');
    const n = dataOldNew.length;
    if (n === 0) return;
    const matrix = buildMissMatrix();
    const topNums = topMissNums();
    const colors = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#fd79a8','#00b894'];
    const axisW = 40, topH = 34, bottomH = 24;
    const w = Math.max(360, wrap.clientWidth - 8);
    const h = 280;
    const plotW = w - axisW - 14, plotH = h - topH - bottomH;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#151517';
    ctx.fillRect(0, 0, w, h);

    let maxMiss = 10;
    for (let t = 0; t < topNums.length; t++) {
        for (let j = 0; j < n; j++) {
            const v = matrix[j][topNums[t].num];
            if (v > maxMiss) maxMiss = v;
        }
    }
    maxMiss = Math.min(maxMiss, n);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 5; g++) {
        const y = topH + (plotH * g) / 5;
        ctx.beginPath(); ctx.moveTo(axisW, y); ctx.lineTo(axisW + plotW, y); ctx.stroke();
        ctx.fillStyle = '#9a9a9a';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.round(maxMiss * (5 - g) / 5)), axisW - 4, y);
    }

    ctx.fillStyle = '#e8a87c';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('遗漏值（期）', axisW, topH / 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const step = Math.max(1, Math.ceil(n / 8));
    for (let j = 0; j < n; j += step) {
        const x = axisW + (j / (n - 1)) * plotW;
        ctx.fillStyle = '#9a9a9a';
        ctx.fillText(shortPeriod(dataOldNew[j].period), x, h - 7);
    }

    ctx.lineWidth = 1.8;
    for (let t = 0; t < topNums.length; t++) {
        ctx.strokeStyle = colors[t % colors.length];
        ctx.beginPath();
        for (let j = 0; j < n; j++) {
            const x = axisW + (j / (n - 1)) * plotW;
            const y = topH + plotH - (Math.min(matrix[j][topNums[t].num], maxMiss) / maxMiss) * plotH;
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    let lg = '';
    for (let t = 0; t < topNums.length; t++) {
        lg += '<span class="legend-item"><span class="legend-swatch" style="background:' + colors[t % colors.length] + '"></span><b>' + topNums[t].num + '</b> 号（当前遗漏 ' + topNums[t].miss + '）</span>';
    }
    document.getElementById('missLegend').innerHTML = lg;
}

// Tab 切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        document.getElementById('panel-' + this.dataset.tab).classList.add('active');
        if (this.dataset.tab === 'trend') {
            const activeSub = document.querySelector('.sub-tab-btn.active');
            if (activeSub && activeSub.dataset.subtab === 'missline') drawMissLines();
            else drawTrendTable();
        }
    });
});

document.querySelectorAll('.sub-tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.sub-tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        const zoushi = document.getElementById('sub-zoushi');
        const miss = document.getElementById('sub-missline');
        if (this.dataset.subtab === 'zoushi') {
            zoushi.style.display = '';
            miss.style.display = 'none';
            drawTrendTable();
        } else {
            zoushi.style.display = 'none';
            miss.style.display = '';
            drawMissLines();
        }
    });
});

// ===== 预测选号 =====
const MAX_PICK = 20;
const MAX_ROWS = 10;
let predictRows = [{ nums: [] }];
let activeRow = 0;

function pickBallClass(num) {
    if (num <= 10) return 'kball-a';
    if (num <= 20) return 'kball-b';
    if (num <= 30) return 'kball-c';
    if (num <= 40) return 'kball-d';
    if (num <= 50) return 'kball-e';
    if (num <= 60) return 'kball-f';
    if (num <= 70) return 'kball-g';
    return 'kball-h';
}
function setStatus(msg, isError) {
    const el = document.getElementById('predictStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#e74c3c' : '#2ecc71';
    setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 3000);
}
function renderPicker() {
    const picker = document.getElementById('predictPicker');
    let html = '';
    for (let num = 1; num <= 80; num++) {
        const picked = predictRows[activeRow].nums.indexOf(num) >= 0;
        html += '<span class="pick-ball ' + pickBallClass(num) + (picked ? ' picked' : '') + '" data-num="' + num + '">' + num + '</span>';
    }
    picker.innerHTML = html;
    picker.querySelectorAll('.pick-ball').forEach(function(b) {
        b.addEventListener('click', function() { togglePick(parseInt(b.dataset.num)); });
    });
    renderTrendRow();
}
// 同步表格内预测行格子的选中态与活动行标记（与选号球联动）
function renderTrendRow() {
    const rowEls = document.querySelectorAll('.trend-predict-row');
    if (!rowEls.length) return;
    rowEls.forEach(function(rowEl) {
        const r = parseInt(rowEl.getAttribute('data-prow')) || 0;
        const row = predictRows[r];
        const pickedSet = {};
        if (row) for (let k = 0; k < row.nums.length; k++) pickedSet[row.nums[k]] = true;
        rowEl.classList.toggle('active', r === activeRow);
        const labelTd = rowEl.querySelector('.td-period');
        if (labelTd) labelTd.textContent = (r === activeRow ? '▶' : ' ') + ' 第' + (r + 1) + '行';
        rowEl.querySelectorAll('.td-pick').forEach(function(td) {
            td.classList.toggle('picked', !!pickedSet[parseInt(td.getAttribute('data-num'))]);
        });
    });
}
function togglePick(num) {
    const row = predictRows[activeRow];
    const idx = row.nums.indexOf(num);
    if (idx >= 0) {
        row.nums.splice(idx, 1);
    } else {
        if (row.nums.length >= MAX_PICK) { setStatus('每行最多选 ' + MAX_PICK + ' 个号码', true); return; }
        row.nums.push(num);
        row.nums.sort(function(a, b) { return a - b; });
    }
    renderPredictRows();
    renderPicker();
}
function renderPredictRows() {
    const wrap = document.getElementById('predictRows');
    let html = '';
    for (let r = 0; r < predictRows.length; r++) {
        const row = predictRows[r];
        html += '<div class="predict-row' + (r === activeRow ? ' active' : '') + '" data-row="' + r + '">';
        html += '<span class="predict-row-label">第 ' + (r + 1) + ' 行</span>';
        html += '<span class="predict-row-nums">';
        if (row.nums.length === 0) {
            html += '<span style="color:#888;font-size:11px;">点击上方号码球添加（0/' + MAX_PICK + '）</span>';
        } else {
            for (let k = 0; k < row.nums.length; k++) {
                const num = row.nums[k];
                html += '<span class="kball ' + pickBallClass(num) + '" style="min-width:22px;height:22px;line-height:22px;font-size:11px;cursor:pointer;" data-rm="' + num + '">' + num + '</span>';
            }
        }
        html += '</span><span class="predict-row-actions">';
        html += '<button data-copy="' + r + '">复制</button>';
        if (predictRows.length > 1) html += '<button class="btn-danger" data-del="' + r + '">删除</button>';
        html += '</span></div>';
    }
    wrap.innerHTML = html;

    // 点击行 → 设为活动行
    wrap.querySelectorAll('.predict-row').forEach(function(rowEl) {
        rowEl.addEventListener('click', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            activeRow = parseInt(rowEl.dataset.row);
            renderPredictRows();
            renderPicker();
        });
    });
    // 点击行内号码 → 移除
    wrap.querySelectorAll('[data-rm]').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            const r = parseInt(b.closest('.predict-row').dataset.row);
            const row = predictRows[r];
            const idx = row.nums.indexOf(parseInt(b.dataset.rm));
            if (idx >= 0) row.nums.splice(idx, 1);
            renderPredictRows();
            renderPicker();
        });
    });
    // 复制单行
    wrap.querySelectorAll('[data-copy]').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            copyRow(parseInt(b.dataset.copy));
        });
    });
    // 删除行
    wrap.querySelectorAll('[data-del]').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            predictRows.splice(parseInt(b.dataset.del), 1);
            if (activeRow >= predictRows.length) activeRow = predictRows.length - 1;
            renderPredictRows();
            renderPicker();
            drawTrendTable();
        });
    });
}
function copyText(text, okMsg) {
    // 优先通过扩展端剪贴板（webview 中 execCommand/clipboard API 不可靠）
    if (vscodeApi) {
        try {
            vscodeApi.postMessage({ command: 'copy', text: text });
            setStatus(okMsg);
            return;
        } catch (e) { console.error('copy postMessage error:', e); }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) { setStatus(okMsg); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() { setStatus(okMsg); }, function() { setStatus('复制失败，请手动选择', true); });
    } else {
        setStatus('复制失败，请手动选择', true);
    }
}
function formatRow(r) {
    const row = predictRows[r];
    return '快乐8 预测第' + (r + 1) + '行（' + row.nums.length + '个）: ' + row.nums.join(',');
}
function copyRow(r) {
    if (predictRows[r].nums.length === 0) { setStatus('第 ' + (r + 1) + ' 行还没有号码', true); return; }
    copyText(formatRow(r), '第 ' + (r + 1) + ' 行已复制 ✓');
}
function copyAll() {
    const lines = [];
    let total = 0, cnt = 0;
    predictRows.forEach(function(row, i) {
        if (row.nums.length > 0) { lines.push(formatRow(i)); total += row.nums.length; cnt++; }
    });
    if (cnt === 0) { setStatus('还没有预测号码，请先选号', true); return; }
    copyText(lines.join('\\n'), '已复制 ' + cnt + ' 行 / ' + total + ' 个号码 ✓');
}

// 预测区按钮
document.getElementById('btnAddRow').addEventListener('click', function() {
    if (predictRows.length >= MAX_ROWS) { setStatus('最多 ' + MAX_ROWS + ' 行', true); return; }
    predictRows.push({ nums: [] });
    activeRow = predictRows.length - 1;
    renderPredictRows();
    renderPicker();
    drawTrendTable();
});
document.getElementById('btnCopy').addEventListener('click', copyAll);
document.getElementById('btnClear').addEventListener('click', function() {
    predictRows = [{ nums: [] }];
    activeRow = 0;
    renderPredictRows();
    renderPicker();
    drawTrendTable();
    setStatus('已清空');
});

// 表格内预测行点击（事件委托，绑定一次，避免重复监听）
document.getElementById('sub-zoushi').addEventListener('click', function(e) {
    const td = e.target;
    if (td.classList && td.classList.contains('td-pick')) {
        const tr = td.closest('tr');
        if (tr && tr.hasAttribute('data-prow')) activeRow = parseInt(tr.getAttribute('data-prow'));
        togglePick(parseInt(td.dataset.num));
    }
});

// 初始化
renderPicker();
renderPredictRows();
if (document.getElementById('panel-trend').classList.contains('active')) {
    drawTrendTable();
}

// 复制工具：提取某行的 规格+号码
function pickRowText(rowEl) {
    const label = rowEl.querySelector('.pick-label').innerText.trim();
    const balls = Array.prototype.map.call(rowEl.querySelectorAll('.pick-balls .kball'), function(b) { return b.textContent; });
    return label + '：' + balls.join(' ');
}

// 一键复制智能推荐（选10 ~ 选1）全部
document.getElementById('btnCopyPick').addEventListener('click', function() {
    const multEl = document.getElementById('pickMultiplier');
    const mult = multEl ? multEl.value : '1';
    const lines = ['快乐8 智能推荐（全部' + mult + '倍）'];
    document.querySelectorAll('.pick-row').forEach(function(rowEl) {
        lines.push(pickRowText(rowEl));
    });
    copyText(lines.join('\\n'), '已复制 选10~选1 全部推荐（' + mult + '倍）✓');
    const btn = document.getElementById('btnCopyPick');
    btn.classList.add('copied');
    setTimeout(function() { btn.classList.remove('copied'); }, 2000);
});

// 每行独立复制按钮
document.querySelectorAll('[data-pick-copy]').forEach(function(btn) {
    btn.addEventListener('click', function() {
        const pick = btn.dataset.pickCopy;
        const rowEl = btn.closest('.pick-row');
        copyText(pickRowText(rowEl), '已复制 选' + pick + ' 号码 ✓');
        btn.classList.add('copied');
        setTimeout(function() { btn.classList.remove('copied'); }, 2000);
    });
});

// 监听扩展端复制成功反馈
if (vscodeApi) {
    vscodeApi.onDidReceiveMessage(function(msg) {
        if (msg && msg.command === 'copySuccess') {
            setStatus('已复制到剪贴板 ✓');
        }
    });
}
</script>
</body>
</html>`;
}

/**
 * 大乐透 遗漏分层 + 走势图 Webview HTML（照搬快乐8模式，适配前区 1-35 / 后区 1-12）
 */
function getDltMissHtml(history) {
    const total = history.length;
    const latest = history[0];
    const latestPeriod = latest ? latest.period : '—';
    const latestFront = latest ? (latest.front || []) : [];
    const latestBack = latest ? (latest.back || []) : [];

    // ===== 通用统计 =====
    function calcStats(list, nMax) {
        const stats = {};
        for (let n = 1; n <= nMax; n++) {
            let miss = -1;
            let lastPeriod = '—';
            const positions = [];
            for (let i = 0; i < total; i++) {
                if ((list[i] || []).indexOf(n) >= 0) {
                    if (miss < 0) {
                        miss = i;
                        lastPeriod = history[i].period;
                    }
                    positions.push(i);
                }
            }
            if (miss < 0) miss = total;
            const c10 = positions.filter(p => p < 10).length;
            const c30 = positions.filter(p => p < 30).length;
            const c50 = positions.filter(p => p < 50).length;
            const c100 = positions.filter(p => p < 100).length;
            const c150 = positions.filter(p => p < 150).length;
            const c200 = positions.filter(p => p < 200).length;
            let avgMiss = 0;
            let maxMiss = 0;
            if (positions.length > 1) {
                const gaps = [];
                for (let i = 0; i < positions.length - 1; i++) gaps.push(positions[i + 1] - positions[i] - 1);
                gaps.push(positions[positions.length - 1]);
                avgMiss = gaps.reduce((a, b) => a + b, 0) / gaps.length;
                maxMiss = Math.max(...gaps);
            } else if (positions.length === 1) {
                avgMiss = positions[0];
                maxMiss = positions[0];
            }
            stats[n] = {
                miss, c10, c30, c50, c100, c150, c200,
                avgMiss: Math.round(avgMiss * 10) / 10,
                maxMiss,
                lastPeriod
            };
        }
        return stats;
    }
    const frontStats = calcStats(history.map(h => h.front || []), 35);
    const backStats = calcStats(history.map(h => h.back || []), 12);

    function layerClsOf(miss) {
        return miss === 0 ? 'layer-hot' : miss <= 2 ? 'layer-warm' : miss <= 5 ? 'layer-cool' : miss <= 10 ? 'layer-cold' : miss <= 20 ? 'layer-freeze' : 'layer-ice';
    }
    function buildDetailData(stats, nMax) {
        const arr = [];
        for (let n = 1; n <= nMax; n++) {
            const s = stats[n];
            arr.push({
                n,
                miss: s.miss,
                c10: s.c10, c30: s.c30, c50: s.c50,
                c100: s.c100, c150: s.c150, c200: s.c200,
                avg: s.avgMiss,
                max: s.maxMiss,
                last: s.lastPeriod,
                cls: layerClsOf(s.miss)
            });
        }
        arr.sort((a, b) => b.miss - a.miss);
        return arr;
    }
    const detailF = buildDetailData(frontStats, 35);
    const detailB = buildDetailData(backStats, 12);

    // ===== 分层概览 =====
    const layers = [
        { name: '热号', range: [0, 0], cls: 'layer-hot', desc: '上期开出' },
        { name: '温热', range: [1, 2], cls: 'layer-warm', desc: '遗漏 1-2 期' },
        { name: '温冷', range: [3, 5], cls: 'layer-cool', desc: '遗漏 3-5 期' },
        { name: '冷号', range: [6, 10], cls: 'layer-cold', desc: '遗漏 6-10 期' },
        { name: '极冷', range: [11, 20], cls: 'layer-freeze', desc: '遗漏 11-20 期' },
        { name: '冰封', range: [21, 999], cls: 'layer-ice', desc: '遗漏 20+ 期' }
    ];
    function buildLayerRows(stats, nMax, ballFn) {
        let rows = '';
        for (const layer of layers) {
            const nums = [];
            let sumMiss = 0;
            for (let n = 1; n <= nMax; n++) {
                const m = stats[n].miss;
                if (m >= layer.range[0] && m <= layer.range[1]) {
                    nums.push(n);
                    sumMiss += m;
                }
            }
            if (nums.length === 0) continue;
            const avg = Math.round(sumMiss / nums.length * 10) / 10;
            const balls = nums.map(n => '<span class="kball ' + ballFn(n) + '">' + n + '</span>').join('');
            rows += '<tr><td class="' + layer.cls + '" style="font-weight:bold;">' + layer.name + '</td>' +
                '<td style="color:#aaa;">' + layer.desc + '</td>' +
                '<td>' + nums.length + '</td>' +
                '<td>' + avg + '</td>' +
                '<td>' + balls + '</td></tr>';
        }
        return rows;
    }
    const frontBallCls = n => 'kball-' + 'abcdefg'[Math.floor((n - 1) / 5)];
    const backBallCls = n => n <= 6 ? 'kball-h' : 'kball-i';
    const layerRowsF = buildLayerRows(frontStats, 35, frontBallCls);
    const layerRowsB = buildLayerRows(backStats, 12, backBallCls);
    const latestFrontBalls = latestFront.map(n => '<span class="kball ' + frontBallCls(n) + '">' + n + '</span>').join('');
    const latestBackBalls = latestBack.map(n => '<span class="kball ' + backBallCls(n) + '">' + n + '</span>').join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>大乐透遗漏分层 - ${latestPeriod}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1e1e1e; color: #ddd; font-family: "Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; padding: 16px; }
h2 { color: #e8a87c; margin-bottom: 8px; font-size: 20px; }
.sub { color: #aaa; margin-bottom: 12px; font-size: 12px; }
.latest-box { background: rgba(232,168,124,0.08); border: 1px solid rgba(232,168,124,0.3); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
.latest-nums { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
.zone-label { color: #8ec5ff; font-weight: 600; margin: 0 6px; font-size: 12px; }
.kball { display: inline-block; width: 28px; height: 28px; line-height: 26px; text-align: center; border-radius: 50%; font-size: 12px; font-weight: 600; color: #fff; }
.kball-a { background: linear-gradient(135deg,#e67e22,#f39c12); }
.kball-b { background: linear-gradient(135deg,#f1c40f,#f5d76e); color: #3a2c00; }
.kball-c { background: linear-gradient(135deg,#2ecc71,#27ae60); }
.kball-d { background: linear-gradient(135deg,#1abc9c,#16a085); }
.kball-e { background: linear-gradient(135deg,#3498db,#2980b9); }
.kball-f { background: linear-gradient(135deg,#9b59b6,#8e44ad); }
.kball-g { background: linear-gradient(135deg,#7f8c8d,#95a5a6); }
.kball-h { background: linear-gradient(135deg,#6c5ce7,#a29bfe); }
.kball-i { background: linear-gradient(135deg,#e84393,#fd79a8); }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #3a3a3d; padding: 4px 6px; text-align: center; font-size: 12px; }
th { background: #2d2d30; color: #aaa; position: sticky; top: 0; z-index: 2; }
.layer-hot { color: #e74c3c; font-weight: 600; }
.layer-warm { color: #e67e22; font-weight: 600; }
.layer-cool { color: #f1c40f; font-weight: 600; }
.layer-cold { color: #2ecc71; font-weight: 600; }
.layer-freeze { color: #3498db; font-weight: 600; }
.layer-ice { color: #9b59b6; font-weight: 600; }
.section-title { color: #e8a87c; font-size: 15px; font-weight: 600; margin: 18px 0 8px; }
.table-caption { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid #3a3a3d; border-left: 4px solid #e8a87c; border-radius: 6px; padding: 6px 12px; margin: 16px 0 6px; font-size: 13px; color: #e8a87c; font-weight: 600; }
.zone-badge-f { background: #e8a87c; color: #1e1e1e; border-radius: 10px; padding: 1px 12px; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.zone-badge-b { background: #8ec5ff; color: #10253b; border-radius: 10px; padding: 1px 12px; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.caption-desc { color: #999; font-size: 11px; font-weight: 400; margin-left: auto; }
.scroll-wrap { max-height: 70vh; overflow-y: auto; border: 1px solid #3a3a3d; border-radius: 6px; }
.tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 2px solid #3a3a3d; }
.tab-btn { padding: 8px 22px; background: transparent; color: #aaa; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all .2s; }
.tab-btn:hover { color: #fff; background: rgba(255,255,255,0.04); }
.tab-btn.active { color: #e8a87c; border-bottom-color: #e8a87c; }
.sub-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #3a3a3d; }
.sub-tab-btn { padding: 6px 14px; background: transparent; color: #aaa; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; font-size: 13px; transition: all .2s; }
.sub-tab-btn:hover { color: #fff; }
.sub-tab-btn.active { color: #8ec5ff; border-bottom-color: #8ec5ff; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.sub-panel { display: none; }
.sub-panel.active { display: block; }
.detail-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-bottom: 8px; font-size: 12px; }
.detail-label { color: #aaa; }
.span-chk-label { display: inline-flex; align-items: center; gap: 3px; color: #e8a87c; cursor: pointer; user-select: none; }
.span-chk-label input { accent-color: #e8a87c; cursor: pointer; }
.detail-legend { color: #999; font-size: 11px; margin-left: auto; }
.span-custom-box { display: inline-flex; align-items: center; gap: 4px; }
.span-custom-box input { width: 96px; background: #2d2d30; border: 1px solid #3c3c3f; color: #ddd; border-radius: 3px; padding: 3px 6px; font-size: 12px; }
.span-custom-box input:focus { outline: none; border-color: #e8a87c; }
.span-custom-box button { background: #0e639c; color: #fff; border: none; border-radius: 3px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.span-custom-box button:hover { background: #1177bb; }
.span-del { margin-left: 3px; color: #e74c3c; cursor: pointer; font-size: 10px; font-weight: 700; }
.span-del:hover { color: #ff6b5e; }
.detail-msg { color: #2ecc71; font-size: 11px; }
.trend-wrap { overflow-x: auto; overflow-y: auto; max-height: 70vh; border: 1px solid #3a3a3d; border-radius: 6px; }
.trend-table { border-collapse: collapse; }
.trend-table th, .trend-table td { border: 1px solid #3a3a3d; min-width: 24px; padding: 2px 1px; text-align: center; font-size: 10px; }
.trend-table .th-period, .trend-table .td-period { min-width: 54px; background: #1e1e1e; position: sticky; left: 0; z-index: 3; color: #bbb; font-weight: 600; }
.trend-table th { position: sticky; top: 0; z-index: 2; background: #2d2d30; }
.trend-table th.th-period { z-index: 4; }
.trend-table .td-hit { background: #e74c3c !important; color: #fff; box-shadow: inset 0 0 0 1px #ff8a80; font-weight: 700; }
.trend-table .td-miss { color: #888; }
.trend-table td.g0 { background: rgba(231,76,60,0.18); color: #ff9d93; }
.trend-table td.g1 { background: rgba(230,126,34,0.18); color: #ffb374; }
.trend-table td.g2 { background: rgba(241,196,15,0.18); color: #ffd97a; }
.trend-table td.g3 { background: rgba(46,204,113,0.18); color: #7be0a8; }
.trend-table td.g4 { background: rgba(26,188,156,0.18); color: #7ed9c8; }
.trend-table td.g5 { background: rgba(52,152,219,0.18); color: #7cc4ec; }
.trend-table td.g6 { background: rgba(155,89,182,0.18); color: #c39bdd; }
.trend-table td.g7 { background: rgba(108,122,137,0.18); color: #a9b6c2; }
.trend-table td.g8 { background: rgba(214,69,120,0.18); color: #f5a8c5; }
.trend-table th.grp-end, .trend-table td.grp-end { border-right: 2px solid #777 !important; }
.trend-table .trend-predict-row td { border-top: 2px solid #e8a87c; }
.trend-table .td-pick { cursor: pointer; font-weight: 700; font-size: 11px; user-select: none; }
.trend-table .td-pick:hover { box-shadow: inset 0 0 0 1px #e8a87c; }
.trend-table .trend-predict-row.active td:not(.td-period) { background: rgba(232,168,124,0.25) !important; }
.trend-table .trend-predict-row.active .td-period { color: #e8a87c; font-weight: 700; }
.trend-table .td-pick.picked { background: #e74c3c !important; color: #fff !important; box-shadow: inset 0 0 0 1px #ff8a80; }
.hint { color: #999; font-size: 11px; margin-bottom: 8px; line-height: 1.6; }
.canvas-wrap { background: #141414; border: 1px solid #3a3a3d; border-radius: 6px; padding: 8px; margin-bottom: 12px; }
canvas { width: 100%; display: block; }
.predict-box { margin-top: 16px; border: 1px solid rgba(232,168,124,0.4); border-radius: 8px; background: rgba(232,168,124,0.06); padding: 14px; }
.predict-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.predict-title { color: #e8a87c; font-weight: 700; font-size: 15px; margin-right: auto; }
.predict-box button { padding: 6px 14px; background: #0e639c; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background .2s; }
.predict-box button:hover { background: #1177bb; }
.predict-box button.btn-danger { background: #7a2f2f; }
.predict-box button.btn-danger:hover { background: #a04040; }
.predict-picker { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; align-items: center; }
.pick-zone-label { color: #8ec5ff; font-weight: 600; font-size: 12px; margin-right: 6px; min-width: 64px; }
.pick-ball { width: 28px; height: 28px; line-height: 26px; text-align: center; border-radius: 50%; font-size: 12px; font-weight: 600; color: #fff; cursor: pointer; border: 2px solid transparent; user-select: none; transition: all .15s; }
.pick-ball:hover { border-color: #fff; transform: scale(1.08); }
.pick-ball.picked { border-color: #fff; box-shadow: 0 0 0 2px #e8a87c; transform: scale(1.1); }
.predict-rows { display: flex; flex-direction: column; gap: 8px; }
.predict-row { display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.25); border: 1px solid #3a3a3d; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
.predict-row.active { border-color: #e8a87c; box-shadow: 0 0 0 1px #e8a87c; }
.predict-row-label { min-width: 56px; color: #e8a87c; font-weight: 600; font-size: 12px; }
.predict-row-nums { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; align-items: center; font-size: 12px; }
.predict-row-nums .zone-tag { color: #8ec5ff; margin: 0 2px; }
.predict-row-actions { display: flex; gap: 4px; }
.predict-row-actions button { padding: 3px 8px; font-size: 11px; }
.predict-status { margin-top: 8px; color: #2ecc71; font-size: 12px; min-height: 16px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
</style>
</head>
<body>
<h2>🎯 大乐透 遗漏分层分析</h2>
<div class="sub">数据源：500.com · 共 ${total} 期（最新 ${latestPeriod} 期）</div>
<div class="latest-box">
    <b>最新开奖 ${latestPeriod} 期：</b>
    <div class="latest-nums"><span class="zone-label">前区</span>${latestFrontBalls}<span class="zone-label">后区</span>${latestBackBalls}</div>
</div>

<div class="tabs">
    <button class="tab-btn active" data-tab="miss">📋 遗漏分层</button>
    <button class="tab-btn" data-tab="trend">📈 走势图</button>
</div>

<div id="panel-miss" class="tab-panel active">
<div class="table-caption"><span class="zone-badge-f">前区</span>遗漏分层概览（按当前遗漏值分层）<span class="caption-desc">号码范围 1-35，每期开出 5 个</span></div>
<table>
<thead><tr><th>分层</th><th>说明</th><th>号码数</th><th>平均遗漏</th><th>号码列表</th></tr></thead>
<tbody>${layerRowsF}</tbody>
</table>
<div class="table-caption"><span class="zone-badge-b">后区</span>遗漏分层概览（按当前遗漏值分层）<span class="caption-desc">号码范围 1-12，每期开出 2 个</span></div>
<table>
<thead><tr><th>分层</th><th>说明</th><th>号码数</th><th>平均遗漏</th><th>号码列表</th></tr></thead>
<tbody>${layerRowsB}</tbody>
</table>
<div class="section-title">🔍 号码遗漏明细（按当前遗漏从大到小排序，可勾选 / 自定义期数列）</div>
<div class="detail-toolbar">
    <span class="detail-label">期数列：</span>
    <span id="spanChkBox"></span>
    <span class="span-custom-box">
        <input type="number" id="customSpanInput" min="1" max="5000" placeholder="自定义期数，如 2000">
        <button id="btnAddSpan">＋ 添加</button>
    </span>
    <span class="detail-msg" id="detailMsg"></span>
    <span class="detail-legend">🔥≥30% 热 · 😀≥23% 较热 · 😐≥17% 一般 · 😟≥10% 较冷 · 🥶&lt;10% 冷</span>
</div>
<div class="table-caption"><span class="zone-badge-f">前区</span>号码遗漏明细<span class="caption-desc">号码 1-35，按当前遗漏从大到小排序</span></div>
<div class="scroll-wrap" style="margin-bottom:12px;">
<table>
<thead id="detailHeadF"></thead>
<tbody id="detailBodyF"></tbody>
</table>
</div>
<div class="table-caption"><span class="zone-badge-b">后区</span>号码遗漏明细<span class="caption-desc">号码 1-12，按当前遗漏从大到小排序</span></div>
<div class="scroll-wrap">
<table>
<thead id="detailHeadB"></thead>
<tbody id="detailBodyB"></tbody>
</table>
</div>
</div>

<div id="panel-trend" class="tab-panel">
<div class="sub-tabs">
    <button class="sub-tab-btn active" data-subtab="front">🎯 前区走势图</button>
    <button class="sub-tab-btn" data-subtab="back">🎯 后区走势图</button>
    <button class="sub-tab-btn" data-subtab="missline">📉 遗漏曲线</button>
</div>
<div id="sub-front" class="sub-panel active">
    <div class="hint">横轴为开奖期数（旧 → 新，最新在右），纵轴为号码 1-35。开出号码红底白字，未开出号码显示当前遗漏值。表格最下方「🎯 预测」行可直接点击选号（前区最多 5 个），与下方预测区联动。</div>
    <div class="trend-wrap" id="trendWrapF"></div>
</div>
<div id="sub-back" class="sub-panel">
    <div class="hint">横轴为开奖期数（旧 → 新，最新在右），纵轴为号码 1-12。开出号码红底白字，未开出号码显示当前遗漏值。表格最下方「🎯 预测」行可直接点击选号（后区最多 2 个），与下方预测区联动。</div>
    <div class="trend-wrap" id="trendWrapB"></div>
</div>
<div id="sub-missline" class="sub-panel">
    <div class="hint">最近 ${Math.min(60, total)} 期各号码遗漏值曲线（上方为前区，下方为后区）。</div>
    <div class="canvas-wrap"><canvas id="missCanvasF"></canvas></div>
    <div class="canvas-wrap"><canvas id="missCanvasB"></canvas></div>
</div>
<div class="predict-box">
    <div class="predict-toolbar">
        <span class="predict-title">🎯 预测选号</span>
        <button id="btnAddRow">＋ 增加预测行</button>
        <button id="btnCopyAll">📋 一键复制全部</button>
        <button id="btnClear" class="btn-danger">🗑 清空</button>
    </div>
    <div class="predict-picker" id="pickBoxF"></div>
    <div class="predict-picker" id="pickBoxB"></div>
    <div class="predict-rows" id="predictRowsWrap"></div>
    <div class="predict-status" id="predictStatus"></div>
</div>
</div>

<script>
// ===== 大乐透 遗漏分层 + 走势图 =====
const HISTORY = ${JSON.stringify(history)};
const dataOldNew = HISTORY.slice().reverse(); // 旧 → 新
const DETAIL_F = ${JSON.stringify(detailF)};
const DETAIL_B = ${JSON.stringify(detailB)};
const spanDefs = { 10: 'c10', 30: 'c30', 50: 'c50', 100: 'c100', 150: 'c150', 200: 'c200' };
const presetSpans = [10, 30, 50, 100, 150, 200];
let detailSpans = [10, 30, 50, 100, 150, 200];
let customSpans = [];
const posCache = {};
DETAIL_F.concat(DETAIL_B).forEach(function(r) {
    const ps = [];
    for (let i = 0; i < HISTORY.length; i++) {
        const hit = (r.n <= 35) ? ((HISTORY[i].front || []).indexOf(r.n) >= 0) : ((HISTORY[i].back || []).indexOf(r.n) >= 0);
        if (hit) ps.push(i);
    }
    posCache[r.n] = ps;
});
function countInSpan(num, span) {
    const ps = posCache[num] || [];
    const n = Math.min(span, HISTORY.length);
    let c = 0;
    for (let i = 0; i < ps.length && ps[i] < n; i++) c++;
    return c;
}
function hotEmoji(c, span) {
    const r = c / span;
    return r >= 0.30 ? '🔥' : r >= 0.233 ? '😀' : r >= 0.167 ? '😐' : r >= 0.10 ? '😟' : '🥶';
}
function showDetailMsg(msg, isError) {
    const el = document.getElementById('detailMsg');
    el.textContent = msg;
    el.style.color = isError ? '#e74c3c' : '#2ecc71';
    setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2500);
}
function renderSpanChks() {
    const box = document.getElementById('spanChkBox');
    let h = '';
    presetSpans.forEach(function(s) {
        h += '<label class="span-chk-label"><input type="checkbox" class="span-chk" value="' + s + '"' + (detailSpans.indexOf(s) >= 0 ? ' checked' : '') + '> 近' + s + '期</label>';
    });
    customSpans.forEach(function(s) {
        h += '<label class="span-chk-label"><input type="checkbox" class="span-chk" value="' + s + '" checked> 近' + s + '期 <span class="span-del" data-del="' + s + '" title="移除该列">✕</span></label>';
    });
    box.innerHTML = h;
}
function ballClsOf(num) {
    if (num <= 35) return 'kball-' + 'abcdefg'[Math.floor((num - 1) / 5)];
    return num <= 6 ? 'kball-h' : 'kball-i';
}
function renderMissDetail() {
    const headF = document.getElementById('detailHeadF');
    const bodyF = document.getElementById('detailBodyF');
    const headB = document.getElementById('detailHeadB');
    const bodyB = document.getElementById('detailBodyB');
    let h = '<tr><th>号码</th><th>当前遗漏</th>';
    detailSpans.forEach(function(s) { h += '<th>近' + s + '期</th>'; });
    h += '<th>平均遗漏</th><th>最大遗漏</th><th>最近出现期</th></tr>';
    headF.innerHTML = h;
    headB.innerHTML = h;
    function rowsHtml(data) {
        let b = '';
        data.forEach(function(r) {
            b += '<tr><td><span class="kball ' + ballClsOf(r.n) + '">' + r.n + '</span></td>';
            b += '<td class="' + r.cls + '" style="font-weight:bold;">' + r.miss + '</td>';
            detailSpans.forEach(function(s) {
                const v = (s <= 200 && spanDefs[s]) ? r[spanDefs[s]] : countInSpan(r.n, s);
                b += '<td>' + v + ' ' + hotEmoji(v, s) + '</td>';
            });
            b += '<td>' + r.avg + '</td><td>' + r.max + '</td><td style="color:#888;">' + r.last + '</td></tr>';
        });
        return b;
    }
    bodyF.innerHTML = rowsHtml(DETAIL_F);
    bodyB.innerHTML = rowsHtml(DETAIL_B);
}
document.getElementById('spanChkBox').addEventListener('change', function(e) {
    if (!e.target.classList.contains('span-chk')) return;
    const s = parseInt(e.target.value);
    const idx = detailSpans.indexOf(s);
    if (e.target.checked) { if (idx < 0) detailSpans.push(s); }
    else if (idx >= 0) detailSpans.splice(idx, 1);
    detailSpans.sort(function(a, b) { return a - b; });
    renderMissDetail();
});
document.getElementById('spanChkBox').addEventListener('click', function(e) {
    if (!e.target.classList.contains('span-del')) return;
    const s = parseInt(e.target.getAttribute('data-del'));
    customSpans = customSpans.filter(function(x) { return x !== s; });
    const idx = detailSpans.indexOf(s);
    if (idx >= 0) detailSpans.splice(idx, 1);
    renderSpanChks();
    renderMissDetail();
});
document.getElementById('btnAddSpan').addEventListener('click', function() {
    const inp = document.getElementById('customSpanInput');
    const v = parseInt(inp.value);
    if (!v || v < 1) { showDetailMsg('请输入有效期数（≥1）', true); return; }
    if (v > 5000) { showDetailMsg('最多支持 5000 期', true); return; }
    if (detailSpans.indexOf(v) >= 0) { showDetailMsg('近' + v + '期已存在', true); return; }
    customSpans.push(v);
    detailSpans.push(v);
    detailSpans.sort(function(a, b) { return a - b; });
    inp.value = '';
    renderSpanChks();
    renderMissDetail();
    showDetailMsg('已添加 近' + v + '期');
});

// ===== 走势图表格 =====
function shortPeriod(p) { return p ? String(p).slice(-4) : ''; }
function nMaxOf(zone) { return zone === 'f' ? 35 : 12; }
function gSizeOf(zone) { return zone === 'f' ? 5 : 6; }
function gCls(zone, num) { return zone === 'f' ? Math.floor((num - 1) / 5) : Math.floor((num - 1) / 6); }
function gCount(zone) { return zone === 'f' ? 7 : 2; }
function numsOf(zone, h) { return zone === 'f' ? (h.front || []) : (h.back || []); }
function trendTableHtml(zone) {
    const nMax = nMaxOf(zone);
    const gSize = gSizeOf(zone);
    const gN = gCount(zone);
    let html = '<table class="trend-table">';
    html += '<tr><th class="th-period">期数</th>';
    for (let g = 0; g < gN; g++) {
        const start = g * gSize + 1;
        const end = Math.min(start + gSize - 1, nMax);
        html += '<th colspan="' + gSize + '" class="grp grp-' + g + (g === gN - 1 ? ' grp-end' : '') + '">' + String(start).padStart(2, '0') + '-' + String(end).padStart(2, '0') + '</th>';
    }
    html += '</tr><tr><th class="th-period"></th>';
    for (let num = 1; num <= nMax; num++) {
        const g = gCls(zone, num);
        html += '<th class="th-num g' + g + (num % gSize === 0 ? ' grp-end' : '') + '">' + num + '</th>';
    }
    html += '</tr>';
    const last = {};
    for (let num = 1; num <= nMax; num++) last[num] = -1;
    for (let j = 0; j < dataOldNew.length; j++) {
        const period = shortPeriod(dataOldNew[j].period);
        const nums = numsOf(zone, dataOldNew[j]);
        const numSet = {};
        for (let k = 0; k < nums.length; k++) numSet[nums[k]] = true;
        html += '<tr><td class="td-period">' + period + '</td>';
        for (let num = 1; num <= nMax; num++) {
            const g = gCls(zone, num);
            const endCls = (num % gSize === 0) ? ' grp-end' : '';
            if (numSet[num]) {
                last[num] = 0;
                html += '<td class="td-hit g' + g + endCls + '">' + num + '</td>';
            } else {
                if (last[num] >= 0) last[num]++;
                html += '<td class="td-miss g' + g + endCls + '">' + (last[num] >= 0 ? last[num] : '') + '</td>';
            }
        }
        html += '</tr>';
    }
    for (let r = 0; r < predictRows.length; r++) {
        const row = predictRows[r];
        const arr = zone === 'f' ? row.front : row.back;
        const pickedSet = {};
        for (let k = 0; k < arr.length; k++) pickedSet[arr[k]] = true;
        html += '<tr class="trend-predict-row' + (r === activeRow ? ' active' : '') + '" data-prow="' + r + '" data-zone="' + zone + '">';
        html += '<td class="td-period">' + (r === activeRow ? '▶' : ' ') + ' 第' + (r + 1) + '行</td>';
        for (let num = 1; num <= nMax; num++) {
            const g = gCls(zone, num);
            const endCls = (num % gSize === 0) ? ' grp-end' : '';
            html += '<td class="td-pick g' + g + endCls + (pickedSet[num] ? ' picked' : '') + '" data-num="' + num + '" title="点击选/取消 ' + num + '">' + num + '</td>';
        }
        html += '</tr>';
    }
    html += '</table>';
    return html;
}
function drawTrendTable(zone) {
    const wrap = document.getElementById(zone === 'f' ? 'trendWrapF' : 'trendWrapB');
    const scrollLeft = wrap.scrollLeft;
    wrap.innerHTML = trendTableHtml(zone);
    wrap.scrollLeft = scrollLeft;
}

// ===== 遗漏曲线 =====
function drawMissLines(zone) {
    const canvas = document.getElementById(zone === 'f' ? 'missCanvasF' : 'missCanvasB');
    const nMax = nMaxOf(zone);
    const n = dataOldNew.length;
    if (n === 0) return;
    const show = Math.min(60, n);
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 800;
    const H = 260;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, W, H);
    const recent = dataOldNew.slice(-show);
    const series = {};
    const last = {};
    for (let num = 1; num <= nMax; num++) { series[num] = []; last[num] = -1; }
    for (let i = 0; i < recent.length; i++) {
        const nums = numsOf(zone, recent[i]);
        const numSet = {};
        for (let k = 0; k < nums.length; k++) numSet[nums[k]] = true;
        for (let num = 1; num <= nMax; num++) {
            if (numSet[num]) last[num] = 0; else if (last[num] >= 0) last[num]++;
            series[num].push(last[num]);
        }
    }
    const YMAX = 30;
    const X = function(i) { return 10 + (show > 1 ? i * (W - 20) / (show - 1) : 0); };
    const Y = function(v) { return H - 10 - Math.min(v, YMAX) / YMAX * (H - 30); };
    const colors = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#6c5ce7','#fd79a8','#00cec9','#fdcb6e'];
    for (let num = 1; num <= nMax; num++) {
        const arr = series[num];
        ctx.strokeStyle = colors[num % colors.length];
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
            const px = X(i);
            const py = Y(arr[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = 0; v <= YMAX; v += 5) {
        ctx.moveTo(10, Y(v));
        ctx.lineTo(W - 10, Y(v));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.fillText(zone === 'f' ? '前区 1-35 遗漏曲线（最近 ' + show + ' 期）' : '后区 1-12 遗漏曲线（最近 ' + show + ' 期）', 12, 14);
}

// ===== 预测选号 =====
const MAX_F = 5;
const MAX_B = 2;
const MAX_ROWS = 10;
let predictRows = [{ front: [], back: [] }];
let activeRow = 0;
function setStatus(msg, isError) {
    const el = document.getElementById('predictStatus');
    el.textContent = msg;
    el.style.color = isError ? '#e74c3c' : '#2ecc71';
}
function pickBallClsF(num) { return 'kball-' + 'abcdefg'[Math.floor((num - 1) / 5)]; }
function pickBallClsB(num) { return num <= 6 ? 'kball-h' : 'kball-i'; }
function togglePick(zone, num) {
    const row = predictRows[activeRow];
    const arr = zone === 'f' ? row.front : row.back;
    const max = zone === 'f' ? MAX_F : MAX_B;
    const idx = arr.indexOf(num);
    if (idx >= 0) {
        arr.splice(idx, 1);
    } else {
        if (arr.length >= max) {
            setStatus((zone === 'f' ? '前区' : '后区') + '最多选 ' + max + ' 个（当前已选 ' + arr.length + ' 个）', true);
            return;
        }
        arr.push(num);
        arr.sort(function(a, b) { return a - b; });
    }
    renderPicker();
    renderPredictRows();
    setStatus((zone === 'f' ? '前区' : '后区') + '已选：' + (zone === 'f' ? row.front.join(',') : row.back.join(',')));
}
function renderPicker() {
    const boxF = document.getElementById('pickBoxF');
    const boxB = document.getElementById('pickBoxB');
    let h = '<span class="pick-zone-label">前区(选5)</span>';
    for (let num = 1; num <= 35; num++) {
        const picked = predictRows[activeRow].front.indexOf(num) >= 0;
        h += '<span class="pick-ball ' + pickBallClsF(num) + (picked ? ' picked' : '') + '" data-zone="f" data-num="' + num + '">' + num + '</span>';
    }
    boxF.innerHTML = h;
    h = '<span class="pick-zone-label">后区(选2)</span>';
    for (let num = 1; num <= 12; num++) {
        const picked = predictRows[activeRow].back.indexOf(num) >= 0;
        h += '<span class="pick-ball ' + pickBallClsB(num) + (picked ? ' picked' : '') + '" data-zone="b" data-num="' + num + '">' + num + '</span>';
    }
    boxB.innerHTML = h;
    renderTrendRow();
}
function renderTrendRow() {
    const rowEls = document.querySelectorAll('.trend-predict-row');
    if (!rowEls.length) return;
    rowEls.forEach(function(rowEl) {
        const r = parseInt(rowEl.getAttribute('data-prow')) || 0;
        const zone = rowEl.getAttribute('data-zone');
        const row = predictRows[r];
        const pickedSet = {};
        if (row) {
            const arr = zone === 'f' ? row.front : row.back;
            for (let k = 0; k < arr.length; k++) pickedSet[arr[k]] = true;
        }
        rowEl.classList.toggle('active', r === activeRow);
        const labelTd = rowEl.querySelector('.td-period');
        if (labelTd) labelTd.textContent = (r === activeRow ? '▶' : ' ') + ' 第' + (r + 1) + '行';
        rowEl.querySelectorAll('.td-pick').forEach(function(td) {
            td.classList.toggle('picked', !!pickedSet[parseInt(td.getAttribute('data-num'))]);
        });
    });
}
function renderPredictRows() {
    const wrap = document.getElementById('predictRowsWrap');
    let h = '';
    predictRows.forEach(function(row, i) {
        const fBalls = row.front.map(function(n) {
            return '<span class="pick-ball ' + pickBallClsF(n) + '" style="width:22px;height:22px;line-height:20px;font-size:10px;cursor:default;">' + n + '</span>';
        }).join('');
        const bBalls = row.back.map(function(n) {
            return '<span class="pick-ball ' + pickBallClsB(n) + '" style="width:22px;height:22px;line-height:20px;font-size:10px;cursor:default;">' + n + '</span>';
        }).join('');
        h += '<div class="predict-row' + (i === activeRow ? ' active' : '') + '" data-prow="' + i + '">';
        h += '<span class="predict-row-label">第' + (i + 1) + '行</span>';
        h += '<div class="predict-row-nums"><span class="zone-tag">前区</span>' + (fBalls || '<span style="color:#666;">未选</span>') + '<span class="zone-tag">后区</span>' + (bBalls || '<span style="color:#666;">未选</span>') + '</div>';
        h += '<div class="predict-row-actions">';
        h += '<button data-copy="' + i + '" title="复制本行">📋</button>';
        h += '<button data-del="' + i + '" class="btn-danger" title="删除本行">✕</button>';
        h += '</div></div>';
    });
    wrap.innerHTML = h;
    wrap.querySelectorAll('[data-copy]').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            copyRow(parseInt(b.dataset.copy));
        });
    });
    wrap.querySelectorAll('[data-del]').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            predictRows.splice(parseInt(b.dataset.del), 1);
            if (predictRows.length === 0) predictRows = [{ front: [], back: [] }];
            if (activeRow >= predictRows.length) activeRow = predictRows.length - 1;
            renderPredictRows();
            renderPicker();
            drawTrendTable('f');
            drawTrendTable('b');
        });
    });
    wrap.querySelectorAll('.predict-row').forEach(function(rowEl) {
        rowEl.addEventListener('click', function() {
            activeRow = parseInt(rowEl.getAttribute('data-prow'));
            renderPredictRows();
            renderPicker();
        });
    });
}
function rowText(i) {
    const row = predictRows[i];
    return '大乐透 预测第' + (i + 1) + '行 前区(' + row.front.length + '个): ' + row.front.join(',') + ' 后区(' + row.back.length + '个): ' + row.back.join(',');
}
function copyRow(i) { copyText(rowText(i)); }
function copyAll() {
    const lines = [];
    predictRows.forEach(function(row, i) { lines.push(rowText(i)); });
    copyText(lines.join('\\n'));
}
function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() { setStatus('已复制：' + text); });
        return;
    }
    setStatus(ok ? '已复制：' + text : '复制失败');
}
document.getElementById('btnAddRow').addEventListener('click', function() {
    if (predictRows.length >= MAX_ROWS) { setStatus('最多 ' + MAX_ROWS + ' 行', true); return; }
    predictRows.push({ front: [], back: [] });
    activeRow = predictRows.length - 1;
    renderPredictRows();
    renderPicker();
    drawTrendTable('f');
    drawTrendTable('b');
});
document.getElementById('btnCopyAll').addEventListener('click', copyAll);
document.getElementById('btnClear').addEventListener('click', function() {
    predictRows = [{ front: [], back: [] }];
    activeRow = 0;
    renderPredictRows();
    renderPicker();
    drawTrendTable('f');
    drawTrendTable('b');
    setStatus('已清空');
});
document.getElementById('pickBoxF').addEventListener('click', function(e) {
    const b = e.target;
    if (b.classList && b.classList.contains('pick-ball')) togglePick('f', parseInt(b.dataset.num));
});
document.getElementById('pickBoxB').addEventListener('click', function(e) {
    const b = e.target;
    if (b.classList && b.classList.contains('pick-ball')) togglePick('b', parseInt(b.dataset.num));
});
document.getElementById('panel-trend').addEventListener('click', function(e) {
    const td = e.target;
    if (td.classList && td.classList.contains('td-pick')) {
        const tr = td.closest('tr');
        if (tr && tr.hasAttribute('data-prow')) activeRow = parseInt(tr.getAttribute('data-prow'));
        togglePick(tr.getAttribute('data-zone'), parseInt(td.dataset.num));
    }
});
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        const target = document.getElementById('panel-' + btn.dataset.tab);
        target.classList.add('active');
        if (btn.dataset.tab === 'trend') {
            const activeSub = document.querySelector('.sub-tab-btn.active');
            if (activeSub && activeSub.dataset.subtab === 'missline') {
                drawMissLines('f');
                drawMissLines('b');
            } else {
                drawTrendTable('f');
                drawTrendTable('b');
            }
        }
    });
});
document.querySelectorAll('.sub-tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.sub-tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.sub-panel').forEach(function(p) { p.classList.remove('active'); });
        const target = document.getElementById('sub-' + btn.dataset.subtab);
        target.classList.add('active');
        if (btn.dataset.subtab === 'missline') {
            drawMissLines('f');
            drawMissLines('b');
        } else {
            drawTrendTable(btn.dataset.subtab);
        }
    });
});
// 初始化
renderSpanChks();
renderMissDetail();
renderPicker();
renderPredictRows();
if (document.getElementById('panel-trend').classList.contains('active')) {
    drawTrendTable('f');
    drawTrendTable('b');
}
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

/* Toast 复制提示 */
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
.copy-btn-flash { animation: btnFlash 0.4s ease; }
@keyframes btnFlash { 0% { transform: scale(1); } 50% { transform: scale(1.1); box-shadow: 0 0 12px rgba(46,204,113,0.6); } 100% { transform: scale(1); } }

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
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
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

    // Toast 复制提示
    window.showCopyToast = function() {
        var toast = document.getElementById('copyToast');
        if (toast) {
            toast.classList.add('show');
            setTimeout(function() { toast.classList.remove('show'); }, 2000);
        }
    };

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
            navigator.clipboard.writeText(text).then(() => showCopyToast());
        } else {
            showCopyToast();
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
                navigator.clipboard.writeText(text).then(() => showCopyToast());
            } else {
                showCopyToast();
            }
        };
        // 复制精选单式
        window.copySuggestResult = function() {
            let text = DATA.name + '精选单式 TOP' + currentSuggest.length + '\\n';
            currentSuggest.forEach((s, i) => {
                text += '第' + (i + 1) + '注：' + s.combo.join(' ') + '\\n';
            });
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(() => showCopyToast());
            } else {
                showCopyToast();
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
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
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
function showCopyToast() {
    var toast = document.getElementById('copyToast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 2000); }
}
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
        const sizeLabels = { 2: '精简', 3: '标准', 4: '扩展', 5: '全覆盖' };
        const sizeLabel = sizeLabels[size] || (size + '码');
        // 生成多行格式的复制文本（带彩种、规格、注数标题）
        const copyLines = `${cfg.name} ${sizeLabel}复式（${size}×${size}${posCount > 3 ? '×' + posCount + '位' : ''}，${count}注）\n` +
            `基础期号：第${history[history.length - 1].period}期（${history[history.length - 1].date}）\n` +
            `样本量：${history.length}期\n` +
            nums.map((arr, idx) => `${posNames[idx]}位：${arr.join(' ')}`).join('\n');
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

// ==================== 大乐透智能精选功能 ====================

/**
 * 执行智能筛选算法
 */
async function runSmartFilter(redInput, blueInput, targetCount) {
    const path = require('path');
    const fs = require('fs');

    // 解析输入
    const reds = redInput.split(/[,，\s]+/).map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 35);
    const blues = blueInput.split(/[,，\s]+/).map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 12);

    if (reds.length < 5 || reds.length > 20) throw new Error('红球数量需在5-20个之间');
    if (blues.length < 2 || blues.length > 6) throw new Error('蓝球数量需在2-6个之间');
    if (targetCount < 1 || targetCount > 100) throw new Error('输出注数需在1-100之间');

    // 加载历史数据
    const dataPath = path.join(getDataDir(), 'latest.json');
    const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const history = rawData.history || [];
    const N = history.length;

    // 核心计算函数
    function calcMiss(num, isBlue = false) {
        let miss = 0;
        for (let i = 0; i < N; i++) {
            const nums = isBlue ? history[i].back : history[i].front;
            if (nums.includes(num)) break;
            miss++;
        }
        return miss;
    }

    function calcAvgMiss(num, isBlue = false) {
        let misses = [], currentMiss = 0;
        for (let i = 0; i < N; i++) {
            const nums = isBlue ? history[i].back : history[i].front;
            if (nums.includes(num)) { if (currentMiss > 0) misses.push(currentMiss); currentMiss = 0; }
            else currentMiss++;
        }
        misses.push(currentMiss);
        return misses.reduce((a, b) => a + b, 0) / misses.length;
    }

    function recentFreq(num, period, isBlue = false) {
        let count = 0;
        const len = Math.min(period, N);
        for (let i = 0; i < len; i++) {
            const nums = isBlue ? history[i].back : history[i].front;
            if (nums.includes(num)) count++;
        }
        return count / len;
    }

    // 红球评分
    function scoreRed(num) {
        const miss = calcMiss(num);
        const avgMiss = calcAvgMiss(num);
        const freq5 = recentFreq(num, 5);
        const freq15 = recentFreq(num, 15);
        let score = 0, reasons = [];
        const missRatio = miss / avgMiss;

        if (missRatio > 2) { score += 25; reasons.push(`超漏回归(${miss}期)`); }
        else if (missRatio > 1.5) { score += 18; reasons.push(`高漏(${miss}期)`); }
        else if (missRatio > 1.2) { score += 12; reasons.push(`中高漏(${miss}期)`); }
        else if (missRatio > 0.8) { score += 6; reasons.push('正常'); }
        else if (freq5 > 0) { score += 4; reasons.push('热号持续'); }
        else { score += 8; reasons.push('温号回补'); }

        if (freq5 >= 0.4) { score += 15; reasons.push('极热'); }
        else if (freq5 >= 0.2) { score += 10; reasons.push('热号'); }
        else if (freq15 <= 0.07 && miss > 10) { score += 12; reasons.push('冷号待开'); }

        const lastFront = history[0]?.front || [];
        for (const n of lastFront) { if (Math.abs(n - num) === 1) { score += 5; reasons.push('邻号'); break; } }
        if (lastFront.includes(num)) { score += 6; reasons.push('重号'); }

        return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
    }

    // 蓝球评分
    function scoreBlue(num) {
        const miss = calcMiss(num, true);
        const avgMiss = calcAvgMiss(num, true);
        const freq5 = recentFreq(num, 5, true);
        let score = 0, reasons = [];
        const missRatio = miss / avgMiss;

        if (missRatio > 2.5) { score += 28; reasons.push(`超漏回归(${miss}期)`); }
        else if (missRatio > 1.8) { score += 20; reasons.push(`高漏(${miss}期)`); }
        else if (missRatio > 1.2) { score += 14; reasons.push(`中漏(${miss}期)`); }
        else if (freq5 > 0) { score += 10; reasons.push('热蓝'); }
        else { score += 8; reasons.push('温蓝'); }

        const lastBack = history[0]?.back || [];
        if (lastBack.includes(num)) { score += 5; reasons.push('重号'); }

        return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
    }

    // 组合评分
    function scoreCombo(redArr, blueArr) {
        let comboScore = 0, details = {};

        const oddCount = redArr.filter(n => n % 2 === 1).length;
        const evenCount = 5 - oddCount;
        if (oddCount >= 2 && evenCount >= 2) { comboScore += 15; details.oddEven = `${oddCount}:${evenCount}(优)`; }
        else details.oddEven = `${oddCount}:${evenCount}`;

        const bigCount = redArr.filter(n => n > 18).length;
        const smallCount = 5 - bigCount;
        if (bigCount >= 2 && smallCount >= 2) { comboScore += 15; details.bigSmall = `${bigCount}:${smallCount}(优)`; }
        else details.bigSmall = `${bigCount}:${smallCount}`;

        const sum = redArr.reduce((a, b) => a + b, 0);
        if (sum >= 65 && sum <= 95) { comboScore += 20; details.sum = `${sum}(优)`; }
        else if (sum >= 55 && sum <= 105) { comboScore += 10; details.sum = `${sum}`; }
        else details.sum = `${sum}(偏)`;

        const sorted = [...redArr].sort((a, b) => a - b);
        let consecutive = 0;
        for (let i = 0; i < sorted.length - 1; i++) { if (sorted[i+1] - sorted[i] === 1) consecutive++; }
        if (consecutive === 1) { comboScore += 8; details.consecutive = `1对连号`; }
        else if (consecutive >= 2) { comboScore += 5; details.consecutive = `${consecutive}对`; }
        else details.consecutive = '无';

        const tails = redArr.map(n => n % 10);
        const uniqueTails = new Set(tails).size;
        if (uniqueTails <= 3) { comboScore -= 5; details.tail = `尾${uniqueTails}(密集)`; }
        else if (uniqueTails >= 4) { comboScore += 5; details.tail = `尾${uniqueTails}(散)`; }
        else details.tail = `尾${uniqueTails}`;

        const zones = [0, 0, 0];
        for (const n of redArr) { if (n <= 11) zones[0]++; else if (n <= 22) zones[1]++; else zones[2]++; }
        const zoneBalance = zones.filter(z => z >= 1).length;
        if (zoneBalance === 3) { comboScore += 12; details.zone = `三区有号(优)`; }
        else if (zoneBalance === 2) { comboScore += 5; details.zone = `两区`; }
        else details.zone = `单区`;

        const diffs = new Set();
        for (let i = 0; i < redArr.length; i++) for (let j = i+1; j < redArr.length; j++) diffs.add(Math.abs(redArr[i] - redArr[j]));
        const acValue = diffs.size;
        if (acValue >= 7) { comboScore += 8; details.ac = `AC=${acValue}(优)`; }
        else if (acValue >= 5) details.ac = `AC=${acValue}`;
        else details.ac = `AC=${acValue}(低)`;

        const blueOdd = blueArr.filter(b => b % 2 === 1).length;
        if (blueOdd === 1) { comboScore += 5; details.blueOE = `1奇1偶(优)`; }
        else details.blueOE = blueOdd === 2 ? '全奇' : '全偶';

        return { comboScore, details };
    }

    // 加权随机选择
    function weightedSelect(arr, count) {
        if (arr.length <= count) return arr.map(x => x.num);
        const weights = arr.map(x => x.score * x.score);
        const selected = [], remaining = arr.map((x, i) => ({ ...x, weight: weights[i] }));
        while (selected.length < count && remaining.length > 0) {
            const tw = remaining.reduce((a, b) => a + b.weight, 0);
            let r = Math.random() * tw;
            for (let i = 0; i < remaining.length; i++) { r -= remaining[i].weight; if (r <= 0) { selected.push(remaining[i].num); remaining.splice(i, 1); break; } }
        }
        return selected;
    }

    // 评分所有号码
    const redScores = reds.map(scoreRed).sort((a, b) => b.score - a.score);
    const blueScores = blues.map(scoreBlue).sort((a, b) => b.score - a.score);

    // 生成候选组合
    // 策略：后区全组合覆盖 —— 先枚举后区所有 C(blues.length, 2) 种组合，
    //       每种后区组合至少配 N/C 种前区组合，确保用户给的后区号码所有组合都被推荐到
    const candidates = [];

    // 1. 枚举后区所有组合
    const blueCombos = [];
    for (let i = 0; i < blues.length; i++) {
        for (let j = i + 1; j < blues.length; j++) {
            blueCombos.push([blues[i], blues[j]].sort((a, b) => a - b));
        }
    }
    const blueComboCount = blueCombos.length;

    // 2. 每种后区组合至少分配的注数
    const minPerBlueCombo = Math.max(1, Math.ceil(targetCount / blueComboCount));

    // 3. 为每种后区组合生成前区
    for (const blueCombo of blueCombos) {
        const blueTotal = blueCombo.reduce((sum, n) => sum + (blueScores.find(b => b.num === n)?.score || 0), 0);
        for (let iter = 0; iter < minPerBlueCombo * 3; iter++) { // 多生成一些再排序
            const redArr = weightedSelect(redScores, 5);
            const { comboScore, details } = scoreCombo(redArr, blueCombo);
            const redTotal = redArr.reduce((sum, n) => sum + (redScores.find(r => r.num === n)?.score || 0), 0);
            candidates.push({ reds: [...redArr].sort((a,b)=>a-b), blues: [...blueCombo], totalScore: redTotal + blueTotal*1.5 + comboScore, details });
        }
    }

    // 4. 如果还不够 targetCount，用随机后区补充
    while (candidates.length < targetCount * 3) {
        const blueArr = weightedSelect(blueScores, 2);
        const redArr = weightedSelect(redScores, 5);
        const { comboScore, details } = scoreCombo(redArr, blueArr);
        const redTotal = redArr.reduce((sum, n) => sum + (redScores.find(r => r.num === n)?.score || 0), 0);
        const blueTotal = blueArr.reduce((sum, n) => sum + (blueScores.find(b => b.num === n)?.score || 0), 0);
        candidates.push({ reds: [...redArr].sort((a,b)=>a-b), blues: [...blueArr].sort((a,b)=>a-b), totalScore: redTotal + blueTotal*1.5 + comboScore, details });
    }

    candidates.sort((a, b) => b.totalScore - a.totalScore);

    // 去重取前N组，同时确保每种后区组合至少出现一次
    const seen = new Set(), results = [];
    const blueComboUsed = {}; // 记录每种后区组合已选注数
    for (const c of candidates) {
        const key = c.reds.join(',') + '|' + c.blues.join(',');
        if (seen.has(key)) continue;
        const blueKey = c.blues.join(',');
        blueComboUsed[blueKey] = (blueComboUsed[blueKey] || 0) + 1;
        // 优先保留每种后区组合的前 minPerBlueCombo 注
        seen.add(key);
        results.push(c);
        if (results.length >= targetCount) break;
    }

    // 校验：如果某些后区组合未被覆盖，强制补充
    const coveredBlueCombos = new Set(results.map(r => r.blues.join(',')));
    for (const bc of blueCombos) {
        const bcKey = bc.join(',');
        if (!coveredBlueCombos.has(bcKey)) {
            // 找该后区组合的最高分候选
            const fallback = candidates.find(c => c.blues.join(',') === bcKey);
            if (fallback) {
                results.push(fallback);
                if (results.length >= targetCount + blueComboCount) break; // 允许超出一点
            }
        }
    }

    // 统计频率
    const allReds = results.flatMap(r => r.reds), allBlues = results.flatMap(r => r.blues);
    const redFreq = {}, blueFreq = {};
    for (const n of allReds) redFreq[n] = (redFreq[n]||0)+1;
    for (const n of allBlues) blueFreq[n] = (blueFreq[n]||0)+1;

    return {
        input: { reds, blues, targetCount },
        historyInfo: { totalPeriods: N, latest: history[0]?.period },
        redScores: redScores.map(r => ({ num: r.num, score: r.score, miss: r.miss, avgMiss: r.avgMiss, freq5: r.freq5, reasons: r.reasons })),
        blueScores: blueScores.map(b => ({ num: b.num, score: b.score, miss: b.miss, avgMiss: b.avgMiss, freq5: b.freq5, reasons: b.reasons })),
        results: results.map(r => ({
            reds: r.reds,
            blues: r.blues,
            score: Math.round(r.totalScore),
            details: r.details
        })),
        stats: {
            redFreq: Object.entries(redFreq).map(([n,c])=>({num:+n,count:c,pct:Math.round(c/targetCount*100)})).sort((a,b)=>b.count-a.count),
            blueFreq: Object.entries(blueFreq).map(([n,c])=>({num:+n,count:c,pct:Math.round(c/targetCount*100)})).sort((a,b)=>b.count-a.count)
        }
    };
}

/**
 * 生成智能精选界面 HTML
 */
function getSmartFilterHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>大乐透智能精选</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px}
.header{text-align:center;margin-bottom:24px}
.header h1{color:#4ec9b0;font-size:28px;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.form-section{background:#252526;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #333}
.form-section h3{color:#569cd6;font-size:15px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.form-group{margin-bottom:14px}
.form-group label{display:block;color:#9cdcfe;font-size:13px;margin-bottom:6px}
.form-group input,.form-group select{width:100%;padding:10px 14px;background:#1e1e1e;border:1px solid #444;border-radius:6px;color:#d4d4d4;font-size:14px;outline:none;transition:border .2s}
.form-group input:focus,.form-group select:focus{border-color:#007acc}
.form-group input::placeholder{color:#555}
.row{display:flex;gap:12px}
.row .form-group{flex:1}
.btn-run{width:100%;padding:13px;background:linear-gradient(135deg,#007acc,#005a9e);border:none;border-radius:8px;color:#fff;font-size:16px;font-weight:bold;cursor:pointer;transition:transform .2s,box-shadow .2s;margin-top:8px}
.btn-run:hover{transform:translateY(-1px);box-shadow:0 4px 15px rgba(0,122,204,.4)}
.btn-run:active{transform:translateY(0)}
.result-area{display:none}
.result-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.result-header h2{color:#4ec9b0;font-size:18px}
.btn-copy-all{padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer}
.btn-copy-all:hover{background:#1177bb}
.results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-bottom:20px}
.result-card{background:#252526;border-radius:8px;padding:14px;border:1px solid #333;transition:border-color .2s}
.result-card:hover{border-color:#007acc}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card-num{color:#ce9178;font-size:17px;font-weight:bold;letter-spacing:1px}
.card-score{color:#888;font-size:12px}
.card-details{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:#aaa}
.tag{background:#333;padding:2px 8px;border-radius:3px}
.tag.good{background:#1e4a1e;color:#9cdcfe}
.stats-section{background:#252526;border-radius:10px;padding:16px;margin-top:16px;border:1px solid #333}
.stats-section h3{color:#569cd6;font-size:14px;margin-bottom:12px}
.freq-bars{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.freq-bar{display:flex;align-items:center;gap:8px}
.freq-label{width:30px;text-align:right;color:#9cdcfe;font-size:12px}
.freq-track{flex:1;height:18px;background:#1e1e1e;border-radius:3px;overflow:hidden}
.freq-fill{height:100%;background:linear-gradient(90deg,#007acc,#4ec9b0);border-radius:3px;transition:width .5s}
.freq-pct{width:40px;font-size:11px;color:#888}
.scores-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
.scores-table th{background:#333;color:#569cd6;padding:6px 8px;text-align:left}
.scores-table td{padding:6px 8px;border-bottom:1px solid #333}
.loading{text-align:center;padding:40px;color:#888}
.spinner{display:inline-block;width:30px;height:30px;border:3px solid #333;border-top-color:#4ec9b0;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1e4a1e,#2ecc71);color:#fff;padding:12px 32px;border-radius:24px;z-index:999;display:none;animation:fadeIn .3s;box-shadow:0 4px 20px rgba(46,204,113,0.5);font-size:14px;font-weight:bold}
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@keyframes fadeIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.algo-section{background:#252526;border-radius:10px;padding:0;margin-bottom:16px;border:1px solid #333;overflow:hidden}
.algo-summary{padding:12px 20px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:#2d2d30}
.algo-summary h3{color:#4ec9b0;font-size:14px;margin:0}
.algo-toggle{color:#888;font-size:12px;transition:transform .2s}
.algo-toggle.open{transform:rotate(90deg)}
.algo-detail{display:none;padding:16px 20px;font-size:12px;line-height:1.8;color:#bbb;border-top:1px solid #333}
.algo-detail.open{display:block}
.algo-detail h4{color:#569cd6;font-size:13px;margin:12px 0 6px 0;padding-bottom:4px;border-bottom:1px solid #333}
.algo-detail h4:first-child{margin-top:0}
.algo-detail ul{margin:4px 0 8px 20px;padding:0}
.algo-detail li{margin:3px 0}
.algo-detail code{background:#1e1e1e;padding:1px 5px;border-radius:3px;color:#ce9178;font-family:Consolas,monospace}
.algo-detail .formula{background:#1a1a2e;padding:8px 12px;border-radius:5px;color:#9cdcfe;margin:6px 0;font-family:Consolas,monospace;border-left:3px solid #4ec9b0}
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
<div class="header"><h1>🎯 大乐透智能精选</h1><p>基于多维度历史数据分析，从复式中智能筛选最优单注</p></div>

<div class="algo-section">
<div class="algo-summary" onclick="var d=document.getElementById('algoDetail');var t=document.querySelector('.algo-toggle');if(d.classList.contains('open')){d.classList.remove('open');t.classList.remove('open')}else{d.classList.add('open');t.classList.add('open')}">
<h3>🧮 推荐算法说明（点击展开/收起）</h3><span class="algo-toggle">▶</span>
</div>
<div class="algo-detail" id="algoDetail">
<h4>一、单球评分模型（红球 / 蓝球）</h4>
<p>对用户输入的每个号码计算综合得分，含以下因子：</p>
<ul>
<li><b>遗漏回归分（主权重）</b>：计算号码当前遗漏期数 <code>miss</code> 与平均遗漏 <code>avgMiss</code> 的比值 <code>missRatio = miss / avgMiss</code>：
  <div class="formula">missRatio &gt; 2.0 → 超漏回归 +25 分（泊松回归思想：长期未出则回归概率增大）<br>missRatio &gt; 1.5 → 高漏 +18 分<br>missRatio &gt; 1.2 → 中高漏 +12 分<br>missRatio &gt; 0.8 → 正常 +6 分<br>近期出现 → 热号持续 +4 分<br>否则 → 温号回补 +8 分</div></li>
<li><b>热温冷判定</b>：基于近 5 期出现率 <code>freq5</code>：
  <div class="formula">freq5 ≥ 0.4 → 极热 +15 分（5期内出现≥2次）<br>freq5 ≥ 0.2 → 热号 +10 分<br>freq15 ≤ 0.07 且 miss &gt; 10 → 冷号待开 +12 分</div></li>
<li><b>邻号 +5 分</b>：与上一期开奖号码相差 ±1 的号码</li>
<li><b>重号 +6 分</b>：上一期已开出的同号</li>
</ul>

<h4>二、组合形态评分（6维加权）</h4>
<p>对每组 5红+2蓝 候选组合计算形态得分：</p>
<ul>
<li><b>奇偶比</b>：理想 2:3 或 3:2 → +15 分</li>
<li><b>大小比</b>：&gt;18 为大，理想 2:3 或 3:2 → +15 分</li>
<li><b>和值</b>：5 红理论均值 22.5×5=112.5，合理范围 65~95 → +20 分</li>
<li><b>连号</b>：1 对连号 +8 分，≥2 对 +5 分</li>
<li><b>尾数</b>：尾数种类 ≥4 散 +5 分，≤3 密集 -5 分</li>
<li><b>三区分布</b>：1-12/13-24/25-35 三区有号 +12 分</li>
<li><b>AC 值</b>：任意两号差值集合大小，≥7 为优 +8 分</li>
<li><b>蓝球奇偶</b>：1 奇 1 偶 +5 分</li>
</ul>

<h4>三、组合生成与筛选</h4>
<ul>
<li><b>加权随机采样</b>：权重 = 单球得分²，按权重随机抽取 5 红 + 2 蓝共 5 万次</li>
<li><b>总分 = 红球得分之和 + 蓝球得分×1.5 + 组合形态分</b></li>
<li><b>去重 + 排序</b>：按总分降序去重，取前 N 组</li>
</ul>

<h4>四、统计依据</h4>
<ul>
<li><b>遗漏回归</b>：泊松过程模型，号码出现率 λ ≈ 历史频次/N，遗漏 k 期未出概率 e^(-λk)，回归概率 1-e^(-λk)</li>
<li><b>形态约束</b>：基于历史开奖的奇偶/大小/和值/连号/AC 等形态分布规律</li>
<li><b>权重平方</b>：得分高的号码被选中概率指数级提升，但保留随机性避免过拟合</li>
</ul>
<p style="color:#888;margin-top:10px">⚠️ 彩票本质是独立随机事件，本算法基于历史统计模型，仅供娱乐参考，不构成投注建议。</p>
</div>
</div>

<div class="form-section" id="formSection">
<h3>📋 输入复式号码</h3>
<div class="form-group"><label>红球号码（5-20个，用空格或逗号分隔）</label><input type="text" id="redInput" placeholder="例如：5 10 11 12 13 16 18 19 20 23 24 25 26 27 28" value="5 10 11 12 13 16 18 19 20 23 24 25 26 27 28"></div>
<div class="form-group"><label>蓝球号码（2-6个，用空格或逗号分隔）</label><input type="text" id="blueInput" placeholder="例如：3 4 5 6 10" value="3 4 5 6 10"></div>
<div class="row"><div class="form-group"><label>输出注数</label><select id="countSelect"><option value="10">10 组</option><option value="20" selected>20 组</option><option value="30">30 组</option><option value="50">50 组</option><option value="100">100 组</option></select></div></div>
<button class="btn-run" id="runBtn">🚀 开始智能筛选</button>
</div>

<div class="result-area" id="resultArea">
<div class="result-header"><h2 id="resultTitle">筛选结果</h2><button class="btn-copy-all" id="copyAllBtn">📋 复制全部</button></div>

<div class="stats-section">
<h3>📊 号码评分分析</h3>
<div style="display:flex;gap:20px">
<div style="flex:1"><h4 style="color:#ce9178;font-size:13px;margin:8px 0">红球评分</h4><table class="scores-table" id="redScoresTable"><thead><tr><th>号码</th><th>得分</th><th>遗漏</th><th>均遗</th><th>近5期</th><th>特征</th></tr></thead><tbody></tbody></table></div>
<div style="flex:1"><h4 style="color:#6a9fb5;font-size:13px;margin:8px 0">蓝球评分</h4><table class="scores-table" id="blueScoresTable"><thead><tr><th>号码</th><th>得分</th><th>遗漏</th><th>均遗</th><th>近5期</th><th>特征</th></tr></thead><tbody></tbody></table></div>
</div>
</div>

<div class="stats-section">
<h3>🔥 号码出现频率</h3>
<div class="row"><div style="flex:1"><h4 style="color:#ce9178;font-size:13px;margin:8px 0">红球</h4><div class="freq-bars" id="redFreqBars"></div></div><div style="flex:1"><h4 style="color:#6a9fb5;font-size:13px;margin:8px 0">蓝球</h4><div class="freq-bars" id="blueFreqBars"></div></div></div>
</div>

<div class="results-grid" id="resultsGrid"></div>
</div>

<div class="toast" id="toast">✅ 已复制到剪贴板</div>

<script>
(function(){
var vscode;
try { vscode = acquireVsCodeApi(); } catch(e) { console.error('vscode api error:', e); }
var currentResults = [];
var runBtn = document.getElementById('runBtn');
if (runBtn) {
    runBtn.addEventListener('click', function() {
        try {
            var reds = document.getElementById('redInput').value.trim();
            var blues = document.getElementById('blueInput').value.trim();
            var count = document.getElementById('countSelect').value;
            if (!reds || !blues) { alert('请输入红球和蓝球号码'); return; }
            document.getElementById('resultArea').style.display = 'block';
            document.getElementById('resultsGrid').innerHTML = '<div class=\"loading\"><div class=\"spinner\"></div><p style=\"margin-top:10px\">正在智能分析...</p></div>';
            if (vscode) {
                vscode.postMessage({ command: 'runFilter', reds: reds, blues: blues, count: +count });
            } else { alert('VSCode API 未就绪'); }
        } catch(err) { console.error('error:', err); alert('出错: ' + err.message); }
    });
}
var copyAllBtn = document.getElementById('copyAllBtn');
if (copyAllBtn) {
    copyAllBtn.addEventListener('click', function() {
        if (!currentResults.length) return;
        var lines = currentResults.map(function(r, i) {
            var redStr = r.reds.map(function(n) { return String(n).padStart(2, '0'); }).join(' ');
            var blueStr = r.blues.map(function(n) { return String(n).padStart(2, '0'); }).join(' ');
            return String(i + 1).padStart(2, '0') + '. ' + redStr + ' + ' + blueStr;
        });
        if (vscode) vscode.postMessage({ command: 'copy', text: lines.join(String.fromCharCode(10)) });
    });
}
window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.command) return;
    if (msg.command === 'filterResult') renderResult(msg.data);
    if (msg.command === 'error') showError(msg.message || '未知错误');
    if (msg.command === 'copySuccess') showToast();
});
function showError(msg) {
    document.getElementById('resultsGrid').innerHTML = '<p style=\"color:#f44;padding:20px;text-align:center\">❌ ' + msg + '</p>';
}
function renderResult(data) {
    if (!data) return;
    document.getElementById('resultTitle').textContent = '🎯 精选 ' + (data.results || []).length + ' 组单注';
    currentResults = data.results || [];
    var rt = document.querySelector('#redScoresTable tbody');
    if (rt && data.redScores) rt.innerHTML = data.redScores.map(function(r){return '<tr><td style=\"color:#ce9178;font-weight:bold\">'+r.num+'</td><td>'+r.score+'</td><td>'+r.miss+'</td><td>'+r.avgMiss+'</td><td>'+r.freq5+'</td><td style=\"color:#888;font-size:11px\">'+(r.reasons||[]).join(',')+'</td></tr>';}).join('');
    var bt = document.querySelector('#blueScoresTable tbody');
    if (bt && data.blueScores) bt.innerHTML = data.blueScores.map(function(b){return '<tr><td style=\"color:#6a9fb5;font-weight:bold\">'+b.num+'</td><td>'+b.score+'</td><td>'+b.miss+'</td><td>'+b.avgMiss+'</td><td>'+b.freq5+'</td><td style=\"color:#888;font-size:11px\">'+(b.reasons||[]).join(',')+'</td></tr>';}).join('');
    var rfb = document.getElementById('redFreqBars');
    if (rfb && data.stats && data.stats.redFreq) rfb.innerHTML = data.stats.redFreq.map(function(f){return '<div class=\"freq-bar\"><span class=\"freq-label\">'+f.num+'</span><div class=\"freq-track\"><div class=\"freq-fill\" style=\"width:'+f.pct+'%\"></div></div><span class=\"freq-pct\">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
    var bfb = document.getElementById('blueFreqBars');
    if (bfb && data.stats && data.stats.blueFreq) bfb.innerHTML = data.stats.blueFreq.map(function(f){return '<div class=\"freq-bar\"><span class=\"freq-label\">'+f.num+'</span><div class=\"freq-track\"><div class=\"freq-fill\" style=\"width:'+f.pct+'%\"></div></div><span class=\"freq-pct\">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
    var rg = document.getElementById('resultsGrid');
    if (rg && data.results) rg.innerHTML = data.results.map(function(r){
        var redStr = r.reds.map(function(n){return String(n).padStart(2,'0');}).join(' ');
        var blueStr = r.blues.map(function(n){return String(n).padStart(2,'0');}).join(' ');
        var tags = [r.details.oddEven,r.details.bigSmall,r.details.sum,r.details.consecutive,r.details.zone];
        var tagHtml = tags.map(function(t){return t&&t.indexOf('优')>=0?'<span class=\"tag good\">'+t+'</span>':'<span class=\"tag\">'+t+'</span>';}).join('');
        var ct=redStr+' + '+blueStr;
        return '<div class=\"result-card\"><div class=\"card-header\"><span class=\"card-num\">'+redStr+' + '+blueStr+'</span><span class=\"card-score\">'+r.score+'分</span></div><div class=\"card-details\">'+tagHtml+'</div><button data-copy=\"'+ct+'\" class=\"cb\" style=\"margin-top:8px;padding:4px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer\">复制</button></div>';
    }).join('');
    var cbs = rg.querySelectorAll('.cb');
    for(var i=0;i<cbs.length;i++)(function(b){b.addEventListener('click',function(){if(vscode)vscode.postMessage({command:'copy',text:b.getAttribute('data-copy')});});})(cbs[i]);
}
function showToast() {
    var t = document.getElementById('copyToast') || document.getElementById('toast');
    if (t) { t.classList.add('show'); t.style.display = 'block'; setTimeout(function(){ t.classList.remove('show'); t.style.display = 'none'; }, 2000); }
}
})();
</script>
</body>
</html>`;
}

/**
 * 双色球智能精选（从红球复式+蓝球复式中智能筛选N组最优单注）
 * 双色球规则：6红(1-33) + 1蓝(1-16)
 */
async function runSsqFilter(redInput, blueInput, targetCount) {
    const path = require('path');
    const fs = require('fs');

    // 解析输入
    const reds = redInput.split(/[,，\s]+/).map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 33);
    const blues = blueInput.split(/[,，\s]+/).map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 16);

    if (reds.length < 6 || reds.length > 20) throw new Error('红球数量需在6-20个之间');
    if (blues.length < 2 || blues.length > 8) throw new Error('蓝球数量需在2-8个之间');
    if (targetCount < 1 || targetCount > 100) throw new Error('输出注数需在1-100之间');

    // 加载历史数据
    const dataPath = path.join(getDataDir(), 'ssq.json');
    const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const history = rawData.history || [];
    const N = history.length;

    // 核心计算函数（红球在 red 数组，蓝球在 blue 数组）
    function calcMiss(num, isBlue = false) {
        let miss = 0;
        for (let i = 0; i < N; i++) {
            const nums = isBlue ? history[i].blue : history[i].red;
            if (nums.includes(num)) break;
            miss++;
        }
        return miss;
    }

    function calcAvgMiss(num, isBlue = false) {
        let misses = [], currentMiss = 0;
        for (let i = 0; i < N; i++) {
            const nums = isBlue ? history[i].blue : history[i].red;
            if (nums.includes(num)) { if (currentMiss > 0) misses.push(currentMiss); currentMiss = 0; }
            else currentMiss++;
        }
        misses.push(currentMiss);
        return misses.reduce((a, b) => a + b, 0) / misses.length;
    }

    function recentFreq(num, period, isBlue = false) {
        let count = 0;
        const len = Math.min(period, N);
        for (let i = 0; i < len; i++) {
            const nums = isBlue ? history[i].blue : history[i].red;
            if (nums.includes(num)) count++;
        }
        return count / len;
    }

    // 红球评分（6个红球，1-33）
    function scoreRed(num) {
        const miss = calcMiss(num);
        const avgMiss = calcAvgMiss(num);
        const freq5 = recentFreq(num, 5);
        const freq15 = recentFreq(num, 15);
        let score = 0, reasons = [];
        const missRatio = miss / avgMiss;

        if (missRatio > 2) { score += 25; reasons.push('超漏回归(' + miss + '期)'); }
        else if (missRatio > 1.5) { score += 18; reasons.push('高漏(' + miss + '期)'); }
        else if (missRatio > 1.2) { score += 12; reasons.push('中高漏(' + miss + '期)'); }
        else if (missRatio > 0.8) { score += 6; reasons.push('正常'); }
        else if (freq5 > 0) { score += 4; reasons.push('热号持续'); }
        else { score += 8; reasons.push('温号回补'); }

        if (freq5 >= 0.4) { score += 15; reasons.push('极热'); }
        else if (freq5 >= 0.2) { score += 10; reasons.push('热号'); }
        else if (freq15 <= 0.07 && miss > 10) { score += 12; reasons.push('冷号待开'); }

        const lastRed = history[0] && history[0].red ? history[0].red : [];
        for (const n of lastRed) { if (Math.abs(n - num) === 1) { score += 5; reasons.push('邻号'); break; } }
        if (lastRed.includes(num)) { score += 6; reasons.push('重号'); }

        return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
    }

    // 蓝球评分（1个蓝球，1-16）
    function scoreBlue(num) {
        const miss = calcMiss(num, true);
        const avgMiss = calcAvgMiss(num, true);
        const freq5 = recentFreq(num, 5, true);
        let score = 0, reasons = [];
        const missRatio = miss / avgMiss;

        if (missRatio > 2.5) { score += 28; reasons.push('超漏回归(' + miss + '期)'); }
        else if (missRatio > 1.8) { score += 20; reasons.push('高漏(' + miss + '期)'); }
        else if (missRatio > 1.2) { score += 14; reasons.push('中漏(' + miss + '期)'); }
        else if (freq5 > 0) { score += 10; reasons.push('热蓝'); }
        else { score += 8; reasons.push('温蓝'); }

        const lastBlue = history[0] && history[0].blue ? history[0].blue : [];
        if (lastBlue.includes(num)) { score += 5; reasons.push('重号'); }

        return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
    }

    // 组合评分（双色球：6红1蓝）
    function scoreCombo(redArr, blueArr) {
        let comboScore = 0, details = {};

        // 奇偶比（6红，理想 3:3 或 2:4/4:2）
        const oddCount = redArr.filter(n => n % 2 === 1).length;
        const evenCount = 6 - oddCount;
        if (oddCount >= 2 && oddCount <= 4) { comboScore += 15; details.oddEven = oddCount + ':' + evenCount + '(优)'; }
        else details.oddEven = oddCount + ':' + evenCount;

        // 大小比（1-16为小，17-33为大，理想 3:3）
        const bigCount = redArr.filter(n => n > 16).length;
        const smallCount = 6 - bigCount;
        if (bigCount >= 2 && bigCount <= 4) { comboScore += 15; details.bigSmall = bigCount + ':' + smallCount + '(优)'; }
        else details.bigSmall = bigCount + ':' + smallCount;

        // 和值（6红理论均值 102，合理范围 80-130）
        const sum = redArr.reduce((a, b) => a + b, 0);
        if (sum >= 80 && sum <= 130) { comboScore += 20; details.sum = sum + '(优)'; }
        else if (sum >= 65 && sum <= 145) { comboScore += 10; details.sum = String(sum); }
        else details.sum = sum + '(偏)';

        // 连号
        const sorted = [...redArr].sort((a, b) => a - b);
        let consecutive = 0;
        for (let i = 0; i < sorted.length - 1; i++) { if (sorted[i+1] - sorted[i] === 1) consecutive++; }
        if (consecutive === 1) { comboScore += 8; details.consecutive = '1对连号'; }
        else if (consecutive >= 2) { comboScore += 5; details.consecutive = consecutive + '对'; }
        else details.consecutive = '无';

        // 尾数分布
        const tails = redArr.map(n => n % 10);
        const uniqueTails = new Set(tails).size;
        if (uniqueTails <= 3) { comboScore -= 5; details.tail = '尾' + uniqueTails + '(密集)'; }
        else if (uniqueTails >= 5) { comboScore += 5; details.tail = '尾' + uniqueTails + '(散)'; }
        else details.tail = '尾' + uniqueTails;

        // 三区分布（1-11, 12-22, 23-33）
        const zones = [0, 0, 0];
        for (const n of redArr) { if (n <= 11) zones[0]++; else if (n <= 22) zones[1]++; else zones[2]++; }
        const zoneBalance = zones.filter(z => z >= 1).length;
        if (zoneBalance === 3) { comboScore += 12; details.zone = '三区有号(优)'; }
        else if (zoneBalance === 2) { comboScore += 5; details.zone = '两区'; }
        else details.zone = '单区';

        // AC值
        const diffs = new Set();
        for (let i = 0; i < redArr.length; i++) for (let j = i+1; j < redArr.length; j++) diffs.add(Math.abs(redArr[i] - redArr[j]));
        const acValue = diffs.size;
        if (acValue >= 8) { comboScore += 8; details.ac = 'AC=' + acValue + '(优)'; }
        else if (acValue >= 6) details.ac = 'AC=' + acValue;
        else details.ac = 'AC=' + acValue + '(低)';

        // 蓝球奇偶
        if (blueArr.length > 0) {
            const blueOdd = blueArr[0] % 2 === 1;
            if (blueOdd && oddCount <= 3) { comboScore += 5; details.blueOE = '蓝奇红偶偏(优)'; }
            else if (!blueOdd && oddCount >= 3) { comboScore += 5; details.blueOE = '蓝偶红奇偏(优)'; }
            else details.blueOE = blueOdd ? '蓝奇' : '蓝偶';
        }

        return { comboScore, details };
    }

    // 加权随机选择
    function weightedSelect(arr, count) {
        if (arr.length <= count) return arr.map(x => x.num);
        const weights = arr.map(x => x.score * x.score);
        const selected = [], remaining = arr.map((x, i) => ({ ...x, weight: weights[i] }));
        while (selected.length < count && remaining.length > 0) {
            const tw = remaining.reduce((a, b) => a + b.weight, 0);
            let r = Math.random() * tw;
            for (let i = 0; i < remaining.length; i++) { r -= remaining[i].weight; if (r <= 0) { selected.push(remaining[i].num); remaining.splice(i, 1); break; } }
        }
        return selected;
    }

    // 评分所有号码
    const redScores = reds.map(scoreRed).sort((a, b) => b.score - a.score);
    const blueScores = blues.map(scoreBlue).sort((a, b) => b.score - a.score);

    // 生成候选组合（双色球：6红1蓝）
    // 策略：后区全覆盖 —— 每个蓝球号码至少分配 targetCount/blues.length 注
    const candidates = [];
    const minPerBlueSsq = Math.max(1, Math.ceil(targetCount / blues.length));

    for (const blueNum of blues) {
        const blueTotal = (blueScores.find(b => b.num === blueNum) ? blueScores.find(b => b.num === blueNum).score : 0);
        for (let iter = 0; iter < minPerBlueSsq * 3; iter++) {
            const redArr = weightedSelect(redScores, 6);
            const { comboScore, details } = scoreCombo(redArr, [blueNum]);
            const redTotal = redArr.reduce((sum, n) => sum + (redScores.find(r => r.num === n) ? redScores.find(r => r.num === n).score : 0), 0);
            candidates.push({ reds: [...redArr].sort((a,b)=>a-b), blues: [blueNum], totalScore: redTotal + blueTotal * 1.5 + comboScore, details });
        }
    }

    // 如果不够，随机补充
    while (candidates.length < targetCount * 3) {
        const redArr = weightedSelect(redScores, 6);
        const blueArr = weightedSelect(blueScores, 1);
        const { comboScore, details } = scoreCombo(redArr, blueArr);
        const redTotal = redArr.reduce((sum, n) => sum + (redScores.find(r => r.num === n) ? redScores.find(r => r.num === n).score : 0), 0);
        const blueTotal = blueArr.reduce((sum, n) => sum + (blueScores.find(b => b.num === n) ? blueScores.find(b => b.num === n).score : 0), 0);
        candidates.push({ reds: [...redArr].sort((a,b)=>a-b), blues: [...blueArr].sort((a,b)=>a-b), totalScore: redTotal + blueTotal * 1.5 + comboScore, details });
    }

    candidates.sort((a, b) => b.totalScore - a.totalScore);

    // 去重取前N组，确保每个蓝球至少出现一次
    const seen = new Set(), results = [];
    for (const c of candidates) {
        const key = c.reds.join(',') + '|' + c.blues.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(c);
        if (results.length >= targetCount) break;
    }

    // 校验：如果某些蓝球未被覆盖，强制补充
    const coveredBlues = new Set(results.map(r => r.blues[0]));
    for (const bn of blues) {
        if (!coveredBlues.has(bn)) {
            const fallback = candidates.find(c => c.blues[0] === bn);
            if (fallback) results.push(fallback);
        }
    }

    // 统计频率
    const allReds = results.flatMap(r => r.reds), allBlues = results.flatMap(r => r.blues);
    const redFreq = {}, blueFreq = {};
    for (const n of allReds) redFreq[n] = (redFreq[n]||0)+1;
    for (const n of allBlues) blueFreq[n] = (blueFreq[n]||0)+1;

    return {
        input: { reds, blues, targetCount },
        historyInfo: { totalPeriods: N, latest: history[0] ? history[0].period : '' },
        redScores: redScores.map(r => ({ num: r.num, score: r.score, miss: r.miss, avgMiss: r.avgMiss, freq5: r.freq5, reasons: r.reasons })),
        blueScores: blueScores.map(b => ({ num: b.num, score: b.score, miss: b.miss, avgMiss: b.avgMiss, freq5: b.freq5, reasons: b.reasons })),
        results: results.map(r => ({
            reds: r.reds,
            blues: r.blues,
            score: Math.round(r.totalScore),
            details: r.details
        })),
        stats: {
            redFreq: Object.entries(redFreq).map(([n,c])=>({num:+n,count:c,pct:Math.round(c/targetCount*100)})).sort((a,b)=>b.count-a.count),
            blueFreq: Object.entries(blueFreq).map(([n,c])=>({num:+n,count:c,pct:Math.round(c/targetCount*100)})).sort((a,b)=>b.count-a.count)
        }
    };
}

/**
 * 生成双色球智能精选界面 HTML
 */
function getSsqFilterHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>双色球智能精选</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px}
.header{text-align:center;margin-bottom:24px}
.header h1{color:#e94560;font-size:28px;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.form-section{background:#252526;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #333}
.form-section h3{color:#569cd6;font-size:15px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.form-group{margin-bottom:14px}
.form-group label{display:block;color:#9cdcfe;font-size:13px;margin-bottom:6px}
.form-group input,.form-group select{width:100%;padding:10px 14px;background:#1e1e1e;border:1px solid #444;border-radius:6px;color:#d4d4d4;font-size:14px;outline:none;transition:border .2s}
.form-group input:focus,.form-group select:focus{border-color:#007acc}
.form-group input::placeholder{color:#555}
.row{display:flex;gap:12px}
.row .form-group{flex:1}
.btn-run{width:100%;padding:13px;background:linear-gradient(135deg,#e94560,#c0392b);border:none;border-radius:8px;color:#fff;font-size:16px;font-weight:bold;cursor:pointer;transition:transform .2s,box-shadow .2s;margin-top:8px}
.btn-run:hover{transform:translateY(-1px);box-shadow:0 4px 15px rgba(233,69,96,.4)}
.btn-run:active{transform:translateY(0)}
.result-area{display:none}
.result-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.result-header h2{color:#e94560;font-size:18px}
.btn-copy-all{padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer}
.btn-copy-all:hover{background:#1177bb}
.results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-bottom:20px}
.result-card{background:#252526;border-radius:8px;padding:14px;border:1px solid #333;transition:border-color .2s}
.result-card:hover{border-color:#e94560}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card-num{color:#ce9178;font-size:17px;font-weight:bold;letter-spacing:1px}
.card-score{color:#888;font-size:12px}
.card-details{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:#aaa}
.tag{background:#333;padding:2px 8px;border-radius:3px}
.tag.good{background:#1e4a1e;color:#9cdcfe}
.stats-section{background:#252526;border-radius:10px;padding:16px;margin-top:16px;border:1px solid #333}
.stats-section h3{color:#569cd6;font-size:14px;margin-bottom:12px}
.freq-bars{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.freq-bar{display:flex;align-items:center;gap:8px}
.freq-label{width:30px;text-align:right;color:#9cdcfe;font-size:12px}
.freq-track{flex:1;height:18px;background:#1e1e1e;border-radius:3px;overflow:hidden}
.freq-fill{height:100%;background:linear-gradient(90deg,#e94560,#feca57);border-radius:3px;transition:width .5s}
.freq-pct{width:40px;font-size:11px;color:#888}
.scores-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
.scores-table th{background:#333;color:#569cd6;padding:6px 8px;text-align:left}
.scores-table td{padding:6px 8px;border-bottom:1px solid #333}
.loading{text-align:center;padding:40px;color:#888}
.spinner{display:inline-block;width:30px;height:30px;border:3px solid #333;border-top-color:#e94560;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1e4a1e,#2ecc71);color:#fff;padding:12px 32px;border-radius:24px;z-index:999;display:none;animation:fadeIn .3s;box-shadow:0 4px 20px rgba(46,204,113,0.5);font-size:14px;font-weight:bold}
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@keyframes fadeIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.algo-section{background:#252526;border-radius:10px;padding:0;margin-bottom:16px;border:1px solid #333;overflow:hidden}
.algo-summary{padding:12px 20px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:#2d2d30}
.algo-summary h3{color:#e94560;font-size:14px;margin:0}
.algo-toggle{color:#888;font-size:12px;transition:transform .2s}
.algo-toggle.open{transform:rotate(90deg)}
.algo-detail{display:none;padding:16px 20px;font-size:12px;line-height:1.8;color:#bbb;border-top:1px solid #333}
.algo-detail.open{display:block}
.algo-detail h4{color:#569cd6;font-size:13px;margin:12px 0 6px 0;padding-bottom:4px;border-bottom:1px solid #333}
.algo-detail h4:first-child{margin-top:0}
.algo-detail ul{margin:4px 0 8px 20px;padding:0}
.algo-detail li{margin:3px 0}
.algo-detail code{background:#1e1e1e;padding:1px 5px;border-radius:3px;color:#ce9178;font-family:Consolas,monospace}
.algo-detail .formula{background:#1a1a2e;padding:8px 12px;border-radius:5px;color:#9cdcfe;margin:6px 0;font-family:Consolas,monospace;border-left:3px solid #e94560}
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
<div class="header"><h1>🔴 双色球智能精选</h1><p>基于多维度历史数据分析，从红球+蓝球复式中智能筛选最优单注（6红+1蓝）</p></div>

<div class="algo-section">
<div class="algo-summary" onclick="var d=document.getElementById('algoDetail');var t=document.querySelector('.algo-toggle');if(d.classList.contains('open')){d.classList.remove('open');t.classList.remove('open')}else{d.classList.add('open');t.classList.add('open')}">
<h3>🧮 推荐算法说明（点击展开/收起）</h3><span class="algo-toggle">▶</span>
</div>
<div class="algo-detail" id="algoDetail">
<h4>一、单球评分模型（红球 1-33 / 蓝球 1-16）</h4>
<p>对用户输入的每个号码计算综合得分，含以下因子：</p>
<ul>
<li><b>遗漏回归分（主权重）</b>：计算号码当前遗漏期数 <code>miss</code> 与平均遗漏 <code>avgMiss</code> 的比值 <code>missRatio = miss / avgMiss</code>：
  <div class="formula">missRatio &gt; 2.0 → 超漏回归 +25 分（泊松回归思想：长期未出则回归概率增大）<br>missRatio &gt; 1.5 → 高漏 +18 分<br>missRatio &gt; 1.2 → 中高漏 +12 分<br>missRatio &gt; 0.8 → 正常 +6 分<br>近期出现 → 热号持续 +4 分<br>否则 → 温号回补 +8 分</div></li>
<li><b>热温冷判定</b>：基于近 5 期出现率 <code>freq5</code>：
  <div class="formula">freq5 ≥ 0.4 → 极热 +15 分（5期内出现≥2次）<br>freq5 ≥ 0.2 → 热号 +10 分<br>freq15 ≤ 0.07 且 miss &gt; 10 → 冷号待开 +12 分</div></li>
<li><b>邻号 +5 分</b>：与上一期红球开奖号码相差 ±1 的号码</li>
<li><b>重号 +6 分</b>：上一期已开出的同号（红球对红球，蓝球对蓝球）</li>
</ul>

<h4>二、组合形态评分（双色球：6红+1蓝）</h4>
<p>对每组 6红+1蓝 候选组合计算形态得分：</p>
<ul>
<li><b>奇偶比</b>：理想 2:4 / 3:3 / 4:2 → +15 分</li>
<li><b>大小比</b>：1-16 为小，17-33 为大，理想 2:4~4:2 → +15 分</li>
<li><b>和值</b>：6 红理论均值 17×6=102，合理范围 80~130 → +20 分</li>
<li><b>连号</b>：1 对连号 +8 分，≥2 对 +5 分</li>
<li><b>尾数</b>：尾数种类 ≥5 散 +5 分，≤3 密集 -5 分</li>
<li><b>三区分布</b>：1-11 / 12-22 / 23-33 三区有号 +12 分</li>
<li><b>AC 值</b>：任意两号差值集合大小，6 红共 C(6,2)=15 个差值，≥8 为优 +8 分</li>
<li><b>蓝球奇偶互补</b>：蓝奇+红偶偏 或 蓝偶+红奇偏 → +5 分</li>
</ul>

<h4>三、组合生成与筛选</h4>
<ul>
<li><b>加权随机采样</b>：权重 = 单球得分²，按权重随机抽取 6 红 + 1 蓝共 5 万次</li>
<li><b>总分 = 红球得分之和 + 蓝球得分×1.5 + 组合形态分</b></li>
<li><b>去重 + 排序</b>：按总分降序去重，取前 N 组</li>
</ul>

<h4>四、统计依据</h4>
<ul>
<li><b>遗漏回归</b>：泊松过程模型，号码出现率 λ ≈ 历史频次/N，遗漏 k 期未出概率 e^(-λk)，回归概率 1-e^(-λk)</li>
<li><b>形态约束</b>：基于历史开奖的奇偶/大小/和值/连号/AC/三区等形态分布规律</li>
<li><b>权重平方</b>：得分高的号码被选中概率指数级提升，但保留随机性避免过拟合</li>
</ul>
<p style="color:#888;margin-top:10px">⚠️ 彩票本质是独立随机事件，本算法基于历史统计模型，仅供娱乐参考，不构成投注建议。</p>
</div>
</div>

<div class="form-section" id="formSection">
<h3>📋 输入复式号码</h3>
<div class="form-group"><label>红球号码（6-20个，1-33，用空格或逗号分隔）</label><input type="text" id="redInput" placeholder="例如：1 5 8 12 15 18 20 23 25 27 28 30 31 33" value="1 5 8 12 15 18 20 23 25 27 28 30 31 33"></div>
<div class="form-group"><label>蓝球号码（2-8个，1-16，用空格或逗号分隔）</label><input type="text" id="blueInput" placeholder="例如：3 5 8 10 12" value="3 5 8 10 12"></div>
<div class="row"><div class="form-group"><label>输出注数</label><select id="countSelect"><option value="10">10 组</option><option value="20" selected>20 组</option><option value="30">30 组</option><option value="50">50 组</option><option value="100">100 组</option></select></div></div>
<button class="btn-run" id="runBtn">🚀 开始智能筛选</button>
</div>

<div class="result-area" id="resultArea">
<div class="result-header"><h2 id="resultTitle">筛选结果</h2><button class="btn-copy-all" id="copyAllBtn">📋 复制全部</button></div>

<div class="stats-section">
<h3>📊 号码评分分析</h3>
<div style="display:flex;gap:20px">
<div style="flex:1"><h4 style="color:#ce9178;font-size:13px;margin:8px 0">红球评分</h4><table class="scores-table" id="redScoresTable"><thead><tr><th>号码</th><th>得分</th><th>遗漏</th><th>均遗</th><th>近5期</th><th>特征</th></tr></thead><tbody></tbody></table></div>
<div style="flex:1"><h4 style="color:#6a9fb5;font-size:13px;margin:8px 0">蓝球评分</h4><table class="scores-table" id="blueScoresTable"><thead><tr><th>号码</th><th>得分</th><th>遗漏</th><th>均遗</th><th>近5期</th><th>特征</th></tr></thead><tbody></tbody></table></div>
</div>
</div>

<div class="stats-section">
<h3>🔥 号码出现频率</h3>
<div class="row"><div style="flex:1"><h4 style="color:#ce9178;font-size:13px;margin:8px 0">红球</h4><div class="freq-bars" id="redFreqBars"></div></div><div style="flex:1"><h4 style="color:#6a9fb5;font-size:13px;margin:8px 0">蓝球</h4><div class="freq-bars" id="blueFreqBars"></div></div></div>
</div>

<div class="results-grid" id="resultsGrid"></div>
</div>

<div class="toast" id="toast">✅ 已复制到剪贴板</div>

<script>
(function(){
var vscode;
try { vscode = acquireVsCodeApi(); } catch(e) { console.error('vscode api error:', e); }
var currentResults = [];
var runBtn = document.getElementById('runBtn');
if (runBtn) {
    runBtn.addEventListener('click', function() {
        try {
            var reds = document.getElementById('redInput').value.trim();
            var blues = document.getElementById('blueInput').value.trim();
            var count = document.getElementById('countSelect').value;
            if (!reds || !blues) { alert('请输入红球和蓝球号码'); return; }
            document.getElementById('resultArea').style.display = 'block';
            document.getElementById('resultsGrid').innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:10px">正在智能分析...</p></div>';
            if (vscode) {
                vscode.postMessage({ command: 'runFilter', reds: reds, blues: blues, count: +count });
            } else { alert('VSCode API 未就绪'); }
        } catch(err) { console.error('error:', err); alert('出错: ' + err.message); }
    });
}
var copyAllBtn = document.getElementById('copyAllBtn');
if (copyAllBtn) {
    copyAllBtn.addEventListener('click', function() {
        if (!currentResults.length) return;
        var lines = currentResults.map(function(r, i) {
            var redStr = r.reds.map(function(n) { return String(n).padStart(2, '0'); }).join(' ');
            var blueStr = r.blues.map(function(n) { return String(n).padStart(2, '0'); }).join(' ');
            return String(i + 1).padStart(2, '0') + '. ' + redStr + ' + ' + blueStr;
        });
        if (vscode) vscode.postMessage({ command: 'copy', text: lines.join(String.fromCharCode(10)) });
    });
}
window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.command) return;
    if (msg.command === 'filterResult') renderResult(msg.data);
    if (msg.command === 'error') showError(msg.message || '未知错误');
    if (msg.command === 'copySuccess') showToast();
});
function showError(msg) {
    document.getElementById('resultsGrid').innerHTML = '<p style="color:#f44;padding:20px;text-align:center">❌ ' + msg + '</p>';
}
function renderResult(data) {
    if (!data) return;
    document.getElementById('resultTitle').textContent = '🔴 精选 ' + (data.results || []).length + ' 组单注';
    currentResults = data.results || [];
    var rt = document.querySelector('#redScoresTable tbody');
    if (rt && data.redScores) rt.innerHTML = data.redScores.map(function(r){return '<tr><td style="color:#ce9178;font-weight:bold">'+r.num+'</td><td>'+r.score+'</td><td>'+r.miss+'</td><td>'+r.avgMiss+'</td><td>'+r.freq5+'</td><td style="color:#888;font-size:11px">'+(r.reasons||[]).join(',')+'</td></tr>';}).join('');
    var bt = document.querySelector('#blueScoresTable tbody');
    if (bt && data.blueScores) bt.innerHTML = data.blueScores.map(function(b){return '<tr><td style="color:#6a9fb5;font-weight:bold">'+b.num+'</td><td>'+b.score+'</td><td>'+b.miss+'</td><td>'+b.avgMiss+'</td><td>'+b.freq5+'</td><td style="color:#888;font-size:11px">'+(b.reasons||[]).join(',')+'</td></tr>';}).join('');
    var rfb = document.getElementById('redFreqBars');
    if (rfb && data.stats && data.stats.redFreq) rfb.innerHTML = data.stats.redFreq.map(function(f){return '<div class="freq-bar"><span class="freq-label">'+f.num+'</span><div class="freq-track"><div class="freq-fill" style="width:'+f.pct+'%"></div></div><span class="freq-pct">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
    var bfb = document.getElementById('blueFreqBars');
    if (bfb && data.stats && data.stats.blueFreq) bfb.innerHTML = data.stats.blueFreq.map(function(f){return '<div class="freq-bar"><span class="freq-label">'+f.num+'</span><div class="freq-track"><div class="freq-fill" style="width:'+f.pct+'%"></div></div><span class="freq-pct">'+f.count+'次('+f.pct+'%)</span></div>';}).join('');
    var rg = document.getElementById('resultsGrid');
    if (rg && data.results) rg.innerHTML = data.results.map(function(r){
        var redStr = r.reds.map(function(n){return String(n).padStart(2,'0');}).join(' ');
        var blueStr = r.blues.map(function(n){return String(n).padStart(2,'0');}).join(' ');
        var tags = [r.details.oddEven,r.details.bigSmall,r.details.sum,r.details.consecutive,r.details.zone];
        var tagHtml = tags.map(function(t){return t&&t.indexOf('优')>=0?'<span class="tag good">'+t+'</span>':'<span class="tag">'+t+'</span>';}).join('');
        var ct=redStr+' + '+blueStr;
        return '<div class="result-card"><div class="card-header"><span class="card-num">'+redStr+' + '+blueStr+'</span><span class="card-score">'+r.score+'分</span></div><div class="card-details">'+tagHtml+'</div><button data-copy="'+ct+'" class="cb" style="margin-top:8px;padding:4px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer">复制</button></div>';
    }).join('');
    var cbs = rg.querySelectorAll('.cb');
    for(var i=0;i<cbs.length;i++)(function(b){b.addEventListener('click',function(){if(vscode)vscode.postMessage({command:'copy',text:b.getAttribute('data-copy')});});})(cbs[i]);
}
function showToast() {
    var t = document.getElementById('copyToast') || document.getElementById('toast');
    if (t) { t.classList.add('show'); t.style.display = 'block'; setTimeout(function(){ t.classList.remove('show'); t.style.display = 'none'; }, 2000); }
}
})();
</script>
</body>
</html>`;
}

/**
 * 排三口诀实战工具 HTML
 * 基于彩民流传的 4 类口诀，结合最新一期开奖做实战推导
 */
function getPl3FormulaHtml(latest, history) {
    // 最新一期号码
    const latestNums = latest ? latest.num : [0, 0, 0];
    const latestPeriod = latest ? latest.period : '—';
    const latestDate = latest ? latest.date : '—';
    const [bai, shi, ge] = latestNums;

    // ===== 1. 十位杀号口诀表 =====
    const shiKillMap = {
        0: 0, 1: 8, 2: 6, 3: 4, 4: 7,
        5: 9, 6: 1, 7: 2, 8: 4, 9: 6
    };
    const shiKillNum = shiKillMap[shi] !== undefined ? shiKillMap[shi] : null;

    // ===== 2. 互补配对 =====
    const complementMap = { 0: 5, 1: 6, 2: 7, 3: 8, 4: 9, 5: 0, 6: 1, 7: 2, 8: 3, 9: 4 };
    const complementResult = latestNums.map(n => complementMap[n]);

    // 数字联动规则
    const linkageRules = [
        { name: '9追4、4恋9', test: (nums) => nums.includes(4) || nums.includes(9) ? '关注 4 或 9' : null },
        { name: '遇5填0', test: (nums) => nums.includes(5) ? '关注 0' : null },
        { name: '643金三角', test: (nums) => {
            const cnt = [6,4,3].filter(n => nums.includes(n)).length;
            return cnt >= 2 ? '关注 6/4/3 中缺失的号码' : null;
        }},
        { name: '7前后带1', test: (nums) => nums.includes(7) ? '关注 1' : null },
        { name: '24配8', test: (nums) => (nums.includes(2) || nums.includes(4)) ? '关注 8' : null }
    ];
    const linkageHits = linkageRules.map(r => ({ name: r.name, result: r.test(latestNums) })).filter(r => r.result);

    // ===== 3. 形态判断 =====
    const oddCount = latestNums.filter(n => n % 2 === 1).length;
    const evenCount = 3 - oddCount;
    const bigCount = latestNums.filter(n => n >= 5).length;
    const smallCount = 3 - bigCount;
    const span = Math.max.apply(null, latestNums) - Math.min.apply(null, latestNums);
    const sum = latestNums.reduce((a, b) => a + b, 0);
    const isRepeat = new Set(latestNums).size < 3; // 有对子或豹子
    const isLeopard = new Set(latestNums).size === 1; // 豹子

    // 和值反弹判断（看最近5期）
    let sumTrend = [];
    if (history.length >= 6) {
        for (let i = history.length - 5; i < history.length; i++) {
            sumTrend.push(history[i].num.reduce((a, b) => a + b, 0));
        }
    }
    const recentSmallCount = sumTrend.filter(s => s < 14).length; // 14以下算小和值
    const sumRebound = recentSmallCount >= 3 ? '连续小和值，防反弹（和值可能变大）' : (recentSmallCount <= 1 ? '和值正常，无明显反弹信号' : '和值波动中，需结合其他指标');

    // ===== 4. 试机号关联 =====
    // 试机号是排三特有的"试开号码"，用户输入后做关联推导
    // 页面上提供输入框，让用户输入试机号后实时推导

    // ===== 5. 基于口诀生成推荐号码 =====
    // 每位候选号码池：0-9，按口诀规则加减分
    function genRecommendation() {
        // 每位评分：基础0分，口诀命中加分
        const posScores = [
            new Array(10).fill(0), // 百位
            new Array(10).fill(0), // 十位
            new Array(10).fill(0)  // 个位
        ];
        const reasons = [[], [], []]; // 每位每个号码的命中理由

        // 规则1：十位杀号 → 全位排除（杀号在该位直接扣大分，其他位轻度扣分）
        if (shiKillNum !== null) {
            for (let p = 0; p < 3; p++) {
                posScores[p][shiKillNum] -= 30;
                reasons[p][shiKillNum] = (reasons[p][shiKillNum] || []) ;
                reasons[p][shiKillNum].push('十位杀号(口诀)');
            }
        }

        // 规则2：互补配对 → 每位的互补数加分
        for (let p = 0; p < 3; p++) {
            const comp = complementMap[latestNums[p]];
            posScores[p][comp] += 20;
            reasons[p][comp] = (reasons[p][comp] || []);
            reasons[p][comp].push('互补配对(' + latestNums[p] + '↔' + comp + ')');
        }

        // 规则3：数字联动 → 命中规则的号码在所有位加分
        linkageHits.forEach(h => {
            // 提取号码：从 result 字符串里提取数字
            const nums = h.result.match(/\d/g) || [];
            const uniqueNums = [...new Set(nums.map(Number))];
            uniqueNums.forEach(n => {
                for (let p = 0; p < 3; p++) {
                    posScores[p][n] += 12;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push(h.name);
                }
            });
        });

        // 规则4：形态约束
        // 奇偶比：推荐"一奇两偶"或"两奇一偶"
        // 不强制每位，但奇偶极端的号码降权
        // 大小比：推荐"一小两大"或"两大一小"
        // 跨度：推荐跨度1-8，避免豹子

        // 规则5：和值反弹
        // 若连续小和值，则大号码（5-9）加分
        if (recentSmallCount >= 3) {
            for (let p = 0; p < 3; p++) {
                for (let n = 5; n <= 9; n++) {
                    posScores[p][n] += 8;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值反弹(大号)');
                }
            }
        } else if (recentSmallCount <= 1 && sumTrend.length >= 3) {
            // 近期偏大，小号码略加分
            for (let p = 0; p < 3; p++) {
                for (let n = 0; n <= 4; n++) {
                    posScores[p][n] += 5;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值回落(小号)');
                }
            }
        }

        // 规则6：重号 +5（上期同位号码）
        for (let p = 0; p < 3; p++) {
            posScores[p][latestNums[p]] += 5;
            reasons[p][latestNums[p]] = (reasons[p][latestNums[p]] || []);
            reasons[p][latestNums[p]].push('重号');
        }

        // 规则7：邻号 +4（上期同位 ±1）
        for (let p = 0; p < 3; p++) {
            if (latestNums[p] > 0) {
                posScores[p][latestNums[p] - 1] += 4;
                reasons[p][latestNums[p] - 1] = (reasons[p][latestNums[p] - 1] || []);
                reasons[p][latestNums[p] - 1].push('邻号');
            }
            if (latestNums[p] < 9) {
                posScores[p][latestNums[p] + 1] += 4;
                reasons[p][latestNums[p] + 1] = (reasons[p][latestNums[p] + 1] || []);
                reasons[p][latestNums[p] + 1].push('邻号');
            }
        }

        // 每位按分数排序，取 TOP 候选
        const posRanked = posScores.map((scores, p) => {
            return scores.map((s, n) => ({
                num: n,
                score: s,
                reasons: reasons[p][n] || []
            })).sort((a, b) => b.score - a.score);
        });

        // 单注推荐：每位取 TOP1，但要校验形态（奇偶/大小/跨度/和值）
        // 生成多组候选（每位 TOP3 笛卡尔积），按形态得分排序
        const candidates = [];
        const topK = 3;
        function backtrack(depth, current) {
            if (depth === 3) {
                // 形态校验
                const cOdd = current.filter(n => n % 2 === 1).length;
                const cBig = current.filter(n => n >= 5).length;
                const cSpan = Math.max.apply(null, current) - Math.min.apply(null, current);
                const cSum = current.reduce((a, b) => a + b, 0);
                const isLeopard = new Set(current).size === 1;
                let shapeScore = 0;
                // 奇偶：1奇2偶 或 2奇1偶 加分
                if (cOdd === 1 || cOdd === 2) shapeScore += 15;
                // 大小：1大2小 或 2大1小 加分
                if (cBig === 1 || cBig === 2) shapeScore += 15;
                // 跨度 1-8 加分
                if (cSpan >= 1 && cSpan <= 8) shapeScore += 10;
                if (isLeopard) shapeScore -= 20; // 豹子降权
                // 和值合理范围 8-20
                if (cSum >= 8 && cSum <= 20) shapeScore += 10;
                // 总分 = 各位口诀分 + 形态分
                const formulaScore = current.reduce((sum, n, p) => sum + (posRanked[p].find(x => x.num === n) ? posRanked[p].find(x => x.num === n).score : 0), 0);
                candidates.push({ combo: [...current], formulaScore, shapeScore, total: formulaScore + shapeScore });
                return;
            }
            for (let i = 0; i < Math.min(topK, posRanked[depth].length); i++) {
                current.push(posRanked[depth][i].num);
                backtrack(depth + 1, current);
                current.pop();
            }
        }
        backtrack(0, []);
        candidates.sort((a, b) => b.total - a.total);

        // 去重取 TOP5 单注
        const seen = new Set();
        const topSingles = [];
        for (const c of candidates) {
            const key = c.combo.join('');
            if (!seen.has(key)) { seen.add(key); topSingles.push(c); if (topSingles.length >= 5) break; }
        }

        // 复式推荐：每位生成 4 种规格（2×2×2 / 3×3×3 / 4×4×4 / 5×5×5）
        // 规则：每位取评分前 k 个（排除负分太多的号码）
        const compoundList = [];
        for (let k = 2; k <= 5; k++) {
            const perPos = posRanked.map(ranked => {
                // 取评分前 k 个，过滤掉显著负分（< -10）的号码
                const filtered = ranked.filter(x => x.score > -10);
                return filtered.slice(0, k).map(x => x.num);
            });
            const totalCombos = perPos.reduce((a, b) => a * b.length, 1);
            compoundList.push({
                k: k,
                label: k + '×' + k + '×' + k,
                perPos: perPos,
                totalCombos: totalCombos
            });
        }

        return { topSingles, compoundList, posRanked };
    }

    const recommend = genRecommendation();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>排列三必背口诀</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px;line-height:1.6}
.header{text-align:center;margin-bottom:20px}
.header h1{color:#feca57;font-size:26px;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.latest-bar{display:flex;justify-content:center;align-items:center;gap:12px;background:#252526;padding:12px 20px;border-radius:10px;margin-bottom:20px;border:1px solid #333}
.latest-bar .label{color:#888;font-size:13px}
.latest-bar .balls{display:flex;gap:6px}
.ball{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;color:#fff}
.ball.bai{background:#e94560}
.ball.shi{background:#0984e3}
.ball.ge{background:#27ae60}
.section{background:#252526;border-radius:10px;padding:16px 20px;margin-bottom:16px;border:1px solid #333}
.section-title{color:#feca57;font-size:15px;font-weight:bold;margin-bottom:12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;padding-bottom:8px}
.formula-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.formula-card{background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid #feca57}
.formula-card.kill{border-left-color:#e94560}
.formula-card.ding{border-left-color:#27ae60}
.formula-card.shape{border-left-color:#0984e3}
.formula-card.try{border-left-color:#8e44ad}
.formula-card h4{font-size:13px;margin-bottom:8px}
.formula-card .desc{font-size:12px;color:#aaa;margin-bottom:8px}
.formula-card .result{background:#2d2d30;padding:8px 12px;border-radius:5px;font-size:13px;color:#9cdcfe;font-weight:bold}
.formula-card .result.hit{color:#2ecc71}
.formula-card .result.warn{color:#feca57}
.formula-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.formula-table th{background:#333;color:#569cd6;padding:6px;text-align:center}
.formula-table td{padding:6px;text-align:center;border-bottom:1px solid #333}
.formula-table td.highlight{background:rgba(254,202,87,0.15);color:#feca57;font-weight:bold}
.input-group{display:flex;gap:10px;align-items:center;margin-top:10px}
.input-group input{flex:1;padding:8px 12px;background:#1e1e1e;border:1px solid #444;border-radius:5px;color:#d4d4d4;font-size:14px;outline:none}
.input-group input:focus{border-color:#8e44ad}
.input-group button{padding:8px 16px;background:#8e44ad;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer}
.input-group button:hover{background:#6c3483}
.try-result{margin-top:12px;display:none}
.try-result.show{display:block}
.disclaimer{background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);padding:12px 16px;border-radius:8px;color:#e74c3c;font-size:12px;margin-top:16px}
.tag{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;margin:2px}
.tag.hot{background:rgba(233,69,96,0.2);color:#e94560}
.tag.cool{background:rgba(9,132,227,0.2);color:#0984e3}
.tag.warn{background:rgba(254,202,87,0.2);color:#feca57}
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
<div class="header">
<h1>📜 排列三必背口诀</h1>
<p>彩民总结的 4 类高频实用口诀（杀号 / 定胆 / 形态 / 试机号），结合最新一期自动推导</p>
</div>

<div class="latest-bar">
<span class="label">最新一期 第 ${latestPeriod} 期（${latestDate}）：</span>
<div class="balls">
<span class="ball bai">${bai}</span>
<span class="ball shi">${shi}</span>
<span class="ball ge">${ge}</span>
</div>
</div>

<!-- ===== 1. 十位杀号口诀 ===== -->
<div class="section">
<div class="section-title">🔪 一、十位杀号口诀</div>
<p style="color:#aaa;font-size:12px;margin-bottom:10px">规则：根据上期十位号码，杀掉（排除）对应的单个号码。</p>
<table class="formula-table">
<thead><tr><th>十位出</th><th>0</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th></tr></thead>
<tbody><tr><td>杀号</td><td>0</td><td>8</td><td>6</td><td>4</td><td>7</td><td>9</td><td>1</td><td>2</td><td>4</td><td>6</td></tr></tbody>
</table>
<div class="formula-card kill" style="margin-top:12px">
<h4>🎯 实战推导</h4>
<div class="desc">上期十位 = <b style="color:#0984e3">${shi}</b></div>
<div class="result ${shiKillNum !== null ? 'hit' : ''}">${shiKillNum !== null ? '本期杀号：' + shiKillNum + '（排除含此号码的组合）' : '无匹配口诀'}</div>
</div>
</div>

<!-- ===== 2. 数字配对与定胆 ===== -->
<div class="section">
<div class="section-title">💎 二、数字配对与定胆口诀</div>
<div class="formula-grid">
<div class="formula-card ding">
<h4>互补配对（0↔5, 1↔6, 2↔7, 3↔8, 4↔9）</h4>
<div class="desc">上期号码的互补数，下期易出。</div>
<div class="result hit">上期 [${bai},${shi},${ge}] → 互补关注 [${complementResult.join(',')}]</div>
</div>
<div class="formula-card ding">
<h4>数字联动</h4>
<div class="desc">9追4、4恋9、遇5填0、643金三角、7前后带1、24配8</div>
${linkageHits.length > 0 ? '<div class="result hit">' + linkageHits.map(h => '【' + h.name + '】' + h.result).join('<br>') + '</div>' : '<div class="result warn">上期号码未命中联动规则</div>'}
</div>
</div>
</div>

<!-- ===== 3. 形态判断 ===== -->
<div class="section">
<div class="section-title">📐 三、形态判断口诀</div>
<div class="formula-grid">
<div class="formula-card shape">
<h4>奇偶比</h4>
<div class="desc">"一奇两偶走，两小一大守"</div>
<div class="result">本期：${oddCount}奇${evenCount}偶 ${oddCount === 1 && evenCount === 2 ? '✓ 符合"一奇两偶"' : oddCount === 2 && evenCount === 1 ? '✓ 符合"两奇一偶"' : '⚠ 非常见形态'}</div>
</div>
<div class="formula-card shape">
<h4>大小比</h4>
<div class="desc">≥5 为大，&lt;5 为小</div>
<div class="result">本期：${bigCount}大${smallCount}小 ${bigCount === 1 && smallCount === 2 ? '✓ 符合"一小两大"' : bigCount === 2 && smallCount === 1 ? '✓ 符合"两大一小"' : '⚠ 非常见形态'}</div>
</div>
<div class="formula-card shape">
<h4>跨度</h4>
<div class="desc">"跨度不出9，豹子难长寿"</div>
<div class="result ${span <= 8 ? 'hit' : 'warn'}">本期跨度：${span} ${span <= 8 ? '✓ 在常见范围(0-8)' : '⚠ 跨度9较少见'} ${isLeopard ? '· 豹子号(罕见)' : isRepeat ? '· 有对子' : '· 六 different'}</div>
</div>
<div class="formula-card shape">
<h4>和值反弹</h4>
<div class="desc">"和值连续小后易变大"</div>
<div class="result">本期和值：${sum}（${sum < 14 ? '小' : sum > 18 ? '大' : '中'}）<br>${sumRebound}</div>
</div>
</div>
${sumTrend.length > 0 ? '<div style="margin-top:10px;font-size:12px;color:#888">最近5期和值：' + sumTrend.join(' → ') + '</div>' : ''}
</div>

<!-- ===== 4. 试机号关联 ===== -->
<div class="section">
<div class="section-title">🎲 四、试机号关联口诀</div>
<p style="color:#aaa;font-size:12px;margin-bottom:10px">输入排列三试机号（3位数字），根据口诀推导下期可能形态。</p>
<div class="input-group">
<input type="text" id="tryInput" placeholder="输入试机号，如 386" maxlength="3">
<button onclick="calcTry()">🔍 推导</button>
</div>
<div class="try-result" id="tryResult"></div>
<table class="formula-table" style="margin-top:14px">
<thead><tr><th>试机号</th><th>0</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th></tr></thead>
<tbody><tr><td>口诀</td><td>多半无0</td><td>大半无1</td><td>必用2</td><td>选4/6</td><td>出6/9</td><td>伴1或9</td><td>有47随</td><td>见8还有0</td><td>出偶数</td><td>出1或7</td></tr></tbody>
</table>
</div>

<!-- ===== 5. 口诀推荐号码 ===== -->
<div class="section" style="border:1px solid rgba(254,202,87,0.4)">
<div class="section-title" style="color:#feca57">🎯 五、口诀推荐号码</div>
<p style="color:#aaa;font-size:12px;margin-bottom:12px">基于上述 4 类口诀规则综合评分，每位取 TOP3 候选 → 笛卡尔积 → 形态校验排序 → 取 TOP5 单注 + 复式方案</p>

<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px" id="compoundDisplay"></div>
<button class="copy-btn" style="margin-bottom:14px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllCompound()">📋 复制全部 4 种复式方案</button>

<h4 style="color:#feca57;font-size:14px;margin-bottom:10px">🏆 精选单注 TOP5（口诀分+形态分）</h4>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px" id="singlesGrid"></div>
<button class="copy-btn" style="margin-top:12px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllSingles()">📋 复制全部单注</button>

<div style="margin-top:14px;background:#1e1e1e;border-radius:8px;padding:14px">
<h4 style="color:#569cd6;font-size:13px;margin-bottom:10px">📊 每位候选号码评分明细</h4>
<table class="formula-table">
<thead><tr><th>排名</th><th>百位</th><th>分数</th><th>命中口诀</th><th>十位</th><th>分数</th><th>命中口诀</th><th>个位</th><th>分数</th><th>命中口诀</th></tr></thead>
<tbody id="scoreTableBody"></tbody>
</table>
</div>
</div>

<div class="disclaimer">
⚠️ <b>免责声明：</b>以上口诀来源于彩民经验总结，无统计学严格证明。彩票为独立随机事件，口诀仅供娱乐参考，请理性购彩。
</div>

<script>
// ===== 渲染推荐号码 =====
var recommend = ${JSON.stringify(recommend)};
var posLabels = ['百位', '十位', '个位'];
var ballColors = ['#e94560', '#0984e3', '#27ae60'];

// 渲染复式方案（4 种规格）
(function() {
    var html = '';
    recommend.compoundList.forEach(function(comp, idx) {
        html += '<div style="flex:1;min-width:200px;background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid ' + (idx === 0 ? '#2ecc71' : idx === 1 ? '#feca57' : idx === 2 ? '#e94560' : '#8e44ad') + '">';
        html += '<h4 style="color:' + (idx === 0 ? '#2ecc71' : idx === 1 ? '#feca57' : idx === 2 ? '#e94560' : '#8e44ad') + ';font-size:13px;margin-bottom:6px">📋 ' + comp.label + '</h4>';
        html += '<div style="font-size:11px;color:#888;margin-bottom:8px">总注数：<b style="color:#feca57">' + comp.totalCombos + '</b> 注</div>';
        comp.perPos.forEach(function(picks, p) {
            html += '<div style="margin:5px 0;display:flex;align-items:center;gap:6px">';
            html += '<span style="color:' + ballColors[p] + ';font-weight:bold;font-size:12px;width:36px">' + posLabels[p] + '：</span>';
            picks.forEach(function(n) {
                html += '<span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;background:' + ballColors[p] + ';color:#fff;font-weight:bold;font-size:12px">' + n + '</span>';
            });
            html += '</div>';
        });
        html += '<button class="copy-btn" style="margin-top:8px;padding:5px 12px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer" onclick="copyOneCompound(' + idx + ', this)">📋 复制</button>';
        html += '</div>';
    });
    document.getElementById('compoundDisplay').innerHTML = html;
})();

// 渲染单注 TOP5
(function() {
    var html = '';
    recommend.topSingles.forEach(function(item, i) {
        var combo = item.combo;
        var isTop = i === 0;
        html += '<div style="background:#1e1e1e;border-radius:8px;padding:12px;text-align:center;border:1px solid ' + (isTop ? 'rgba(233,69,96,0.5)' : '#333') + (isTop ? ';background:rgba(233,69,96,0.08)' : '') + '">';
        html += '<div style="font-size:11px;color:#888;margin-bottom:6px">推荐 #' + (i + 1) + (isTop ? ' 🥇 最佳' : '') + '</div>';
        html += '<div style="font-size:22px;font-weight:bold;letter-spacing:4px;margin-bottom:6px">';
        combo.forEach(function(n, p) {
            html += '<span style="color:' + ballColors[p] + '">' + n + '</span>';
            if (p < 2) html += ' ';
        });
        html += '</div>';
        html += '<div style="font-size:11px;color:#aaa">口诀分:' + item.formulaScore + ' | 形态分:' + item.shapeScore + ' | 总分:' + item.total + '</div>';
        html += '<button class="copy-btn" style="margin-top:6px;padding:3px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer" onclick="copySingle(' + String.fromCharCode(39) + combo.join('') + String.fromCharCode(39) + ', this)">复制</button>';
        html += '</div>';
    });
    document.getElementById('singlesGrid').innerHTML = html;
})();

// 渲染评分明细表
(function() {
    var html = '';
    var maxRank = 5;
    for (var i = 0; i < maxRank; i++) {
        var bai = recommend.posRanked[0][i] || {num:'-',score:0,reasons:[]};
        var shi = recommend.posRanked[1][i] || {num:'-',score:0,reasons:[]};
        var ge = recommend.posRanked[2][i] || {num:'-',score:0,reasons:[]};
        html += '<tr>';
        html += '<td style="color:#feca57;font-weight:bold">' + (i + 1) + '</td>';
        html += '<td style="color:#e94560;font-weight:bold;font-size:14px">' + bai.num + '</td>';
        html += '<td>' + bai.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (bai.reasons || []).join(',') + '</td>';
        html += '<td style="color:#0984e3;font-weight:bold;font-size:14px">' + shi.num + '</td>';
        html += '<td>' + shi.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (shi.reasons || []).join(',') + '</td>';
        html += '<td style="color:#27ae60;font-weight:bold;font-size:14px">' + ge.num + '</td>';
        html += '<td>' + ge.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (ge.reasons || []).join(',') + '</td>';
        html += '</tr>';
    }
    document.getElementById('scoreTableBody').innerHTML = html;
})();

// 复制函数
function copySingle(combo, btn) {
    var text = '排三口诀推荐：' + combo.split('').join(' ');
    copyToClipboard(text);
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllSingles() {
    var lines = recommend.topSingles.map(function(item, i) {
        return String(i + 1).padStart(2, '0') + '. ' + item.combo.join(' ') + ' (总分' + item.total + ')';
    });
    copyToClipboard('排三口诀推荐单注TOP' + recommend.topSingles.length + '\\n' + lines.join('\\n'));
}
function copyOneCompound(idx, btn) {
    var comp = recommend.compoundList[idx];
    var parts = comp.perPos.map(function(picks, p) {
        return posLabels[p] + '：' + picks.join(' ');
    });
    var text = '排三口诀 ' + comp.label + ' 复式（' + comp.totalCombos + '注）\\n' + parts.join('\\n');
    copyToClipboard(text);
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllCompound() {
    var lines = ['排三口诀复式方案（4 种规格）'];
    recommend.compoundList.forEach(function(comp) {
        lines.push('\\n【' + comp.label + ' · ' + comp.totalCombos + '注】');
        comp.perPos.forEach(function(picks, p) {
            lines.push('  ' + posLabels[p] + '：' + picks.join(' '));
        });
    });
    copyToClipboard(lines.join('\\n'));
}
function copyToClipboard(text) {
    try { acquireVsCodeApi().postMessage({ command: 'copy', text: text }); } catch(e) {}
    // Toast 提示
    var toast = document.getElementById('copyToast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 2000); }
}

function calcTry() {
    var input = document.getElementById('tryInput').value.trim();
    var resultDiv = document.getElementById('tryResult');
    if (!input || input.length < 1 || !/^\\d+$/.test(input)) {
        resultDiv.className = 'try-result';
        resultDiv.innerHTML = '<p style="color:#f44;padding:8px">请输入有效的数字</p>';
        resultDiv.classList.add('show');
        return;
    }
    var rules = {
        '0': '多半没有0（下期可能不出0）',
        '1': '大半不见1（下期可能不出1）',
        '2': '一定要用2（下期关注2）',
        '3': '不如选4/6（下期关注4或6）',
        '4': '常会出6/9（下期关注6或9）',
        '5': '常伴1或9（下期关注1或9）',
        '6': '多有47随（下期关注4或7）',
        '7': '试8见还有0（下期关注8或0）',
        '8': '常出偶数字（下期关注偶数0/2/4/6/8）',
        '9': '能减出1或7（下期关注1或7）'
    };
    var html = '<div style="background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid #8e44ad">';
    html += '<h4 style="color:#8e44ad;margin-bottom:10px">试机号 ' + input + ' 推导结果</h4>';
    var digits = input.split('');
    var seen = {};
    digits.forEach(function(d) {
        if (!seen[d] && rules[d]) {
            html += '<div style="margin:6px 0;padding:6px 10px;background:#2d2d30;border-radius:4px">';
            html += '<span style="color:#feca57;font-weight:bold">试机号含 ' + d + '：</span>';
            html += '<span style="color:#9cdcfe">' + rules[d] + '</span>';
            html += '</div>';
            seen[d] = true;
        }
    });
    html += '</div>';
    resultDiv.innerHTML = html;
    resultDiv.classList.add('show');
}
</script>
</body>
</html>`;
}

/**
 * 排列五口诀实战工具 HTML
 * 排五规则：5 位数字（万千百十个），每位置 0-9
 */
function getPl5FormulaHtml(latest, history) {
    const latestNums = latest ? latest.num : [0, 0, 0, 0, 0];
    const latestPeriod = latest ? latest.period : '—';
    const latestDate = latest ? latest.date : '—';
    const [wan, qian, bai, shi, ge] = latestNums;

    // ===== 1. 趣味联想口诀 =====
    // 数字联动规则
    const linkageRules = [
        { name: '聚堆喜对配8', test: (nums) => {
            // 检测连号或对子
            const sorted = [...nums].sort();
            let consecutive = 0, pairs = 0;
            for (let i = 0; i < sorted.length - 1; i++) {
                if (sorted[i+1] - sorted[i] === 1) consecutive++;
                if (sorted[i+1] === sorted[i]) pairs++;
            }
            if (consecutive > 0 || pairs > 0) return '有聚堆/对子，关注配8';
            return null;
        }},
        { name: '9449好朋友', test: (nums) => {
            const has9 = nums.includes(9), has4 = nums.includes(4);
            if (has9 && has4) return '9和4已联动，竖连99后易出7';
            if (has9) return '有9，关注4';
            if (has4) return '有4，关注9';
            return null;
        }},
        { name: '50中间有座桥', test: (nums) => {
            if (nums.includes(5)) return '有5，关注0';
            if (nums.includes(0)) return '有0，关注5';
            return null;
        }},
        { name: '643金三角', test: (nums) => {
            const cnt = [6,4,3].filter(n => nums.includes(n)).length;
            if (cnt >= 2) return '643金三角命中' + cnt + '个，关注缺失号码';
            return null;
        }},
        { name: '7前7后常有1', test: (nums) => nums.includes(7) ? '有7，关注1' : null },
        { name: '8998似双碟', test: (nums) => {
            if (nums.includes(8) && nums.includes(9)) return '8和9对称出现，关注延续';
            return null;
        }}
    ];
    const linkageHits = linkageRules.map(r => ({ name: r.name, result: r.test(latestNums) })).filter(r => r.result);

    // ===== 2. 杀号技巧口诀 =====
    // 基础杀尾
    const periodTail = parseInt(String(latestPeriod).slice(-1));
    const sumTail = latestNums.reduce((a, b) => a + b, 0) % 10;
    const squareSumTail = latestNums.reduce((a, b) => a + b * b, 0) % 10;
    // 计算杀尾
    const calcKill1 = (bai * 7 + ge * 5) % 10;
    const prevShi = history.length >= 2 ? (history[history.length - 2].num[3] || 0) : 0;
    const currShi = shi;
    const calcKill2 = (prevShi + currShi) % 10;
    const span = Math.max.apply(null, latestNums) - Math.min.apply(null, latestNums);
    const sum = latestNums.reduce((a, b) => a + b, 0);
    const calcKill3 = Math.floor((sum + span) / 3) % 10;
    const calcKill4 = Math.floor((sum + span) / 4) % 10;
    const calcKill5 = Math.floor((sum + span) / 5) % 10;
    // 对应杀号 0-9 → 8527419630
    const correspondMap = [8,5,2,7,4,1,9,6,3,0];
    const killByCorrespond = latestNums.map(n => correspondMap[n]);
    // 位置杀号：上期第4位（index 3）
    const killPos4 = shi;
    // 跨质号（跨度是否质数 2,3,5,7）
    const isSpanPrime = [2,3,5,7].includes(span);

    // ===== 3. 组合选号口诀 =====
    const oddCount = latestNums.filter(n => n % 2 === 1).length;
    const evenCount = 5 - oddCount;
    const bigCount = latestNums.filter(n => n >= 5).length;
    const smallCount = 5 - bigCount;
    const isRepeat = new Set(latestNums).size < 5;
    const isLeopard = new Set(latestNums).size === 1;

    // 最近5期和值
    let sumTrend = [];
    if (history.length >= 6) {
        for (let i = history.length - 5; i < history.length; i++) {
            sumTrend.push(history[i].num.reduce((a, b) => a + b, 0));
        }
    }
    // 排五和值合理范围 9-16，避开 5-7 和 17-20
    const sumStatus = sum < 8 ? '偏低(避开5-7区)' : sum > 16 ? '偏高(避开17-20区)' : '在重点区(9-16)';

    // ===== 4. 推荐号码生成 =====
    function genRecommendation() {
        const posScores = [
            new Array(10).fill(0),
            new Array(10).fill(0),
            new Array(10).fill(0),
            new Array(10).fill(0),
            new Array(10).fill(0)
        ];
        const reasons = [[], [], [], [], []];
        const posLabels5 = ['万位', '千位', '百位', '十位', '个位'];

        // 规则1：杀号 → 对应号码在所有位降权
        const allKillNums = [periodTail, sumTail, squareSumTail, calcKill1, calcKill2, calcKill3, calcKill4, calcKill5, killPos4];
        const killCount = {};
        allKillNums.forEach(n => { killCount[n] = (killCount[n] || 0) + 1; });
        Object.entries(killCount).forEach(([n, cnt]) => {
            const num = +n;
            for (let p = 0; p < 5; p++) {
                posScores[p][num] -= cnt * 8;
                reasons[p][num] = (reasons[p][num] || []);
                reasons[p][num].push('杀尾×' + cnt);
            }
        });
        // 对应杀号
        killByCorrespond.forEach(n => {
            for (let p = 0; p < 5; p++) {
                posScores[p][n] -= 5;
                reasons[p][n] = (reasons[p][n] || []);
                reasons[p][n].push('对应杀号');
            }
        });

        // 规则2：数字联动 → 命中规则的号码在所有位加分
        linkageHits.forEach(h => {
            const nums = h.result.match(/\d/g) || [];
            const uniqueNums = [...new Set(nums.map(Number))];
            uniqueNums.forEach(n => {
                for (let p = 0; p < 5; p++) {
                    posScores[p][n] += 10;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push(h.name);
                }
            });
        });

        // 规则3：50 桥（互补）→ 5 和 0 互相加分
        if (latestNums.includes(5)) {
            for (let p = 0; p < 5; p++) {
                posScores[p][0] += 15;
                reasons[p][0] = (reasons[p][0] || []);
                reasons[p][0].push('50桥(5→0)');
            }
        }
        if (latestNums.includes(0)) {
            for (let p = 0; p < 5; p++) {
                posScores[p][5] += 15;
                reasons[p][5] = (reasons[p][5] || []);
                reasons[p][5].push('50桥(0→5)');
            }
        }

        // 规则4：奇偶大小形态约束
        // 推荐 2奇1偶 + 2大1小 的变体（5位：2-3奇，2-3大）
        // 偏好"中和"形态，极端形态降权
        // 不强制每位，整体约束

        // 规则5：和值范围约束
        // 排五和值重点 9-16，避开 5-7 和 17-20
        // 若当前和值偏低，大号码（5-9）加分
        if (sum < 9) {
            for (let p = 0; p < 5; p++) {
                for (let n = 5; n <= 9; n++) {
                    posScores[p][n] += 6;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值回升');
                }
            }
        } else if (sum > 16) {
            for (let p = 0; p < 5; p++) {
                for (let n = 0; n <= 4; n++) {
                    posScores[p][n] += 6;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值回落');
                }
            }
        }

        // 规则6：重号 +5（上期同位）
        for (let p = 0; p < 5; p++) {
            posScores[p][latestNums[p]] += 5;
            reasons[p][latestNums[p]] = (reasons[p][latestNums[p]] || []);
            reasons[p][latestNums[p]].push('重号');
        }

        // 规则7：邻号 +4（上期同位 ±1）
        for (let p = 0; p < 5; p++) {
            if (latestNums[p] > 0) {
                posScores[p][latestNums[p] - 1] += 4;
                reasons[p][latestNums[p] - 1] = (reasons[p][latestNums[p] - 1] || []);
                reasons[p][latestNums[p] - 1].push('邻号');
            }
            if (latestNums[p] < 9) {
                posScores[p][latestNums[p] + 1] += 4;
                reasons[p][latestNums[p] + 1] = (reasons[p][latestNums[p] + 1] || []);
                reasons[p][latestNums[p] + 1].push('邻号');
            }
        }

        // 每位排序
        const posRanked = posScores.map((scores, p) => {
            return scores.map((s, n) => ({
                num: n,
                score: s,
                reasons: reasons[p][n] || []
            })).sort((a, b) => b.score - a.score);
        });

        // 单注推荐：每位取 TOP3，笛卡尔积（5^5=3125 太多，取 TOP2 = 32 组合理）
        const candidates = [];
        const topK = 2;
        function backtrack(depth, current) {
            if (depth === 5) {
                const cOdd = current.filter(n => n % 2 === 1).length;
                const cBig = current.filter(n => n >= 5).length;
                const cSpan = Math.max.apply(null, current) - Math.min.apply(null, current);
                const cSum = current.reduce((a, b) => a + b, 0);
                const isLeopard = new Set(current).size === 1;
                let shapeScore = 0;
                // 奇偶：2-3奇 加分
                if (cOdd >= 2 && cOdd <= 3) shapeScore += 12;
                // 大小：2-3大 加分
                if (cBig >= 2 && cBig <= 3) shapeScore += 12;
                // 跨度合理范围
                if (cSpan >= 2 && cSpan <= 8) shapeScore += 8;
                if (isLeopard) shapeScore -= 25;
                // 和值重点区 9-16
                if (cSum >= 9 && cSum <= 16) shapeScore += 15;
                else if (cSum >= 5 && cSum <= 7) shapeScore -= 8;
                else if (cSum >= 17 && cSum <= 20) shapeScore -= 8;
                const formulaScore = current.reduce((sum, n, p) => sum + (posRanked[p].find(x => x.num === n) ? posRanked[p].find(x => x.num === n).score : 0), 0);
                candidates.push({ combo: [...current], formulaScore, shapeScore, total: formulaScore + shapeScore });
                return;
            }
            for (let i = 0; i < Math.min(topK, posRanked[depth].length); i++) {
                current.push(posRanked[depth][i].num);
                backtrack(depth + 1, current);
                current.pop();
            }
        }
        backtrack(0, []);
        candidates.sort((a, b) => b.total - a.total);

        // 去重取 TOP5
        const seen = new Set();
        const topSingles = [];
        for (const c of candidates) {
            const key = c.combo.join('');
            if (!seen.has(key)) { seen.add(key); topSingles.push(c); if (topSingles.length >= 5) break; }
        }

        // 复式：每位 TOP k（k=2,3,4,5）
        const compoundList = [];
        for (let k = 2; k <= 5; k++) {
            const perPos = posRanked.map(ranked => {
                const filtered = ranked.filter(x => x.score > -15);
                return filtered.slice(0, k).map(x => x.num);
            });
            const totalCombos = perPos.reduce((a, b) => a * b.length, 1);
            compoundList.push({
                k: k,
                label: posLabels5.map(() => k).join('×'),
                perPos: perPos,
                totalCombos: totalCombos
            });
        }

        return { topSingles, compoundList, posRanked };
    }

    const recommend = genRecommendation();
    const posLabels5 = ['万位', '千位', '百位', '十位', '个位'];
    const ballColors5 = ['#e94560', '#0984e3', '#27ae60', '#8e44ad', '#f39c12'];

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>排列五口诀</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px;line-height:1.6}
.header{text-align:center;margin-bottom:20px}
.header h1{color:#0984e3;font-size:26px;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.latest-bar{display:flex;justify-content:center;align-items:center;gap:12px;background:#252526;padding:12px 20px;border-radius:10px;margin-bottom:20px;border:1px solid #333}
.latest-bar .label{color:#888;font-size:13px}
.latest-bar .balls{display:flex;gap:5px}
.ball{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:15px;color:#fff}
.ball.wan{background:#e94560}
.ball.qian{background:#0984e3}
.ball.bai{background:#27ae60}
.ball.shi{background:#8e44ad}
.ball.ge{background:#f39c12}
.section{background:#252526;border-radius:10px;padding:16px 20px;margin-bottom:16px;border:1px solid #333}
.section-title{color:#0984e3;font-size:15px;font-weight:bold;margin-bottom:12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;padding-bottom:8px}
.formula-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.formula-card{background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid #0984e3}
.formula-card h4{font-size:13px;margin-bottom:8px}
.formula-card .desc{font-size:12px;color:#aaa;margin-bottom:8px}
.formula-card .result{background:#2d2d30;padding:8px 12px;border-radius:5px;font-size:13px;color:#9cdcfe;font-weight:bold}
.formula-card .result.hit{color:#2ecc71}
.formula-card .result.warn{color:#feca57}
.formula-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.formula-table th{background:#333;color:#569cd6;padding:6px;text-align:center}
.formula-table td{padding:6px;text-align:center;border-bottom:1px solid #333}
.disclaimer{background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);padding:12px 16px;border-radius:8px;color:#e74c3c;font-size:12px;margin-top:16px}
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
<div class="header">
<h1>🎲 排列五口诀</h1>
<p>彩民总结的 3 类高频实用口诀（数字关联 / 杀号 / 组合选号），结合最新一期自动推导</p>
</div>

<div class="latest-bar">
<span class="label">最新一期 第 ${latestPeriod} 期（${latestDate}）：</span>
<div class="balls">
<span class="ball wan">${wan}</span>
<span class="ball qian">${qian}</span>
<span class="ball bai">${bai}</span>
<span class="ball shi">${shi}</span>
<span class="ball ge">${ge}</span>
</div>
</div>

<!-- ===== 1. 趣味联想口诀 ===== -->
<div class="section">
<div class="section-title">🎯 一、趣味联想口诀（数字关联）</div>
<div class="formula-grid">
${linkageRules.map(r => {
    const result = r.test(latestNums);
    return '<div class="formula-card"><h4>' + r.name + '</h4><div class="desc">' + (
        r.name === '聚堆喜对配8' ? '号码易聚堆(连号)、出对子，遇3配8' :
        r.name === '9449好朋友' ? '9和4常联动，竖连99后易出7' :
        r.name === '50中间有座桥' ? '遇5填0，遇0填5' :
        r.name === '643金三角' ? '6、4、3易组合' :
        r.name === '7前7后常有1' ? '7前后或斜连易带1' :
        '8和9常对称出现'
    ) + '</div><div class="result ' + (result ? 'hit' : 'warn') + '">' + (result || '未命中') + '</div></div>';
}).join('')}
</div>
</div>

<!-- ===== 2. 杀号技巧口诀 ===== -->
<div class="section">
<div class="section-title">🔪 二、杀号技巧口诀</div>
<h4 style="color:#e94560;font-size:13px;margin-bottom:8px">基础杀尾</h4>
<table class="formula-table">
<thead><tr><th>杀尾类型</th><th>计算方法</th><th>结果</th></tr></thead>
<tbody>
<tr><td>期号尾</td><td>当期期号 ${latestPeriod} 的尾数</td><td style="color:#e94560;font-weight:bold">${periodTail}</td></tr>
<tr><td>和值尾</td><td>上期和值 ${sum} 的尾数</td><td style="color:#e94560;font-weight:bold">${sumTail}</td></tr>
<tr><td>平方和尾</td><td>各位平方和 ${latestNums.map(n => n + '²').join('+')} = ${latestNums.reduce((a, b) => a + b * b, 0)} 的尾数</td><td style="color:#e94560;font-weight:bold">${squareSumTail}</td></tr>
</tbody>
</table>

<h4 style="color:#e94560;font-size:13px;margin:12px 0 8px">计算杀尾</h4>
<table class="formula-table">
<thead><tr><th>杀尾类型</th><th>计算方法</th><th>结果</th></tr></thead>
<tbody>
<tr><td>百×7+个×5</td><td>${bai}×7+${ge}×5 = ${bai * 7 + ge * 5} 取尾</td><td style="color:#e94560;font-weight:bold">${calcKill1}</td></tr>
<tr><td>上两期十位和</td><td>上期十${prevShi}+本期十${currShi} = ${prevShi + currShi} 取尾</td><td style="color:#e94560;font-weight:bold">${calcKill2}</td></tr>
<tr><td>(和值+跨度)÷3</td><td>(${sum}+${span})÷3 = ${Math.floor((sum + span) / 3)} 取尾</td><td style="color:#e94560;font-weight:bold">${calcKill3}</td></tr>
<tr><td>(和值+跨度)÷4</td><td>(${sum}+${span})÷4 = ${Math.floor((sum + span) / 4)} 取尾</td><td style="color:#e94560;font-weight:bold">${calcKill4}</td></tr>
<tr><td>(和值+跨度)÷5</td><td>(${sum}+${span})÷5 = ${Math.floor((sum + span) / 5)} 取尾</td><td style="color:#e94560;font-weight:bold">${calcKill5}</td></tr>
</tbody>
</table>

<h4 style="color:#e94560;font-size:13px;margin:12px 0 8px">对应杀号（0-9 → 8527419630）</h4>
<table class="formula-table">
<thead><tr><th>上期号码</th><th>${wan}</th><th>${qian}</th><th>${bai}</th><th>${shi}</th><th>${ge}</th></tr></thead>
<tbody><tr><td>对应杀号</td><td style="color:#e94560;font-weight:bold">${killByCorrespond[0]}</td><td style="color:#e94560;font-weight:bold">${killByCorrespond[1]}</td><td style="color:#e94560;font-weight:bold">${killByCorrespond[2]}</td><td style="color:#e94560;font-weight:bold">${killByCorrespond[3]}</td><td style="color:#e94560;font-weight:bold">${killByCorrespond[4]}</td></tr></tbody>
</table>

<h4 style="color:#e94560;font-size:13px;margin:12px 0 8px">位置杀号</h4>
<div style="font-size:13px;color:#aaa">杀上期第4位（十位）：<b style="color:#e94560">${killPos4}</b> | 跨度 ${span} ${isSpanPrime ? '是质数' : '非质数'} ${isSpanPrime ? '→ 可杀跨质号' : ''}</div>
</div>

<!-- ===== 3. 组合选号口诀 ===== -->
<div class="section">
<div class="section-title">📐 三、组合选号口诀</div>
<div class="formula-grid">
<div class="formula-card">
<h4>奇偶大小</h4>
<div class="desc">常见 2奇1偶 + 2大1小（如 005、227）</div>
<div class="result">本期：${oddCount}奇${evenCount}偶 / ${bigCount}大${smallCount}小 ${oddCount >= 2 && oddCount <= 3 && bigCount >= 2 && bigCount <= 3 ? '✓ 符合常见形态' : '⚠ 非常见形态'}</div>
</div>
<div class="formula-card">
<h4>和值范围</h4>
<div class="desc">重点 9-16，避开 5-7 和 17-20</div>
<div class="result ${sum >= 9 && sum <= 16 ? 'hit' : 'warn'}">本期和值：${sum}（${sumStatus}）</div>
</div>
<div class="formula-card">
<h4>聚堆/对子</h4>
<div class="desc">连号或对子频繁</div>
<div class="result">${isLeopard ? '⚠ 豹子号(罕见)' : isRepeat ? '有对子' : '无重复'}</div>
</div>
<div class="formula-card">
<h4>跨度</h4>
<div class="desc">常见 2-8</div>
<div class="result ${span >= 2 && span <= 8 ? 'hit' : 'warn'}">本期跨度：${span} ${span >= 2 && span <= 8 ? '✓ 常见范围' : '⚠ 偏极端'}</div>
</div>
</div>
${sumTrend.length > 0 ? '<div style="margin-top:10px;font-size:12px;color:#888">最近5期和值：' + sumTrend.join(' → ') + '</div>' : ''}
</div>

<!-- ===== 4. 口诀推荐号码 ===== -->
<div class="section" style="border:1px solid rgba(9,132,227,0.4)">
<div class="section-title" style="color:#0984e3">🎯 四、口诀推荐号码</div>
<p style="color:#aaa;font-size:12px;margin-bottom:12px">基于上述 3 类口诀规则综合评分，每位取 TOP2 候选 → 笛卡尔积 → 形态校验排序 → 取 TOP5 单注 + 4 种复式方案</p>

<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px" id="compoundDisplay"></div>
<button class="copy-btn" style="margin-bottom:14px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllCompound()">📋 复制全部 4 种复式方案</button>

<h4 style="color:#0984e3;font-size:14px;margin-bottom:10px">🏆 精选单注 TOP5（口诀分+形态分）</h4>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px" id="singlesGrid"></div>
<button class="copy-btn" style="margin-top:12px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllSingles()">📋 复制全部单注</button>

<div style="margin-top:14px;background:#1e1e1e;border-radius:8px;padding:14px">
<h4 style="color:#569cd6;font-size:13px;margin-bottom:10px">📊 每位候选号码评分明细（TOP5）</h4>
<table class="formula-table">
<thead><tr><th>排名</th><th>万位</th><th>分数</th><th>口诀</th><th>千位</th><th>分数</th><th>口诀</th><th>百位</th><th>分数</th><th>口诀</th><th>十位</th><th>分数</th><th>口诀</th><th>个位</th><th>分数</th><th>口诀</th></tr></thead>
<tbody id="scoreTableBody"></tbody>
</table>
</div>
</div>

<div class="disclaimer">
⚠️ <b>免责声明：</b>以上口诀来源于彩民经验总结，无统计学严格证明。彩票为独立随机事件，口诀仅供娱乐参考，请理性购彩。
</div>

<script>
var recommend = ${JSON.stringify(recommend)};
var posLabels = ${JSON.stringify(posLabels5)};
var ballColors = ${JSON.stringify(ballColors5)};

// 渲染复式方案
(function() {
    var html = '';
    recommend.compoundList.forEach(function(comp, idx) {
        var color = idx === 0 ? '#2ecc71' : idx === 1 ? '#feca57' : idx === 2 ? '#0984e3' : '#8e44ad';
        html += '<div style="flex:1;min-width:200px;background:#1e1e1e;border-radius:8px;padding:12px;border-left:3px solid ' + color + '">';
        html += '<h4 style="color:' + color + ';font-size:12px;margin-bottom:6px">📋 ' + comp.label + '</h4>';
        html += '<div style="font-size:11px;color:#888;margin-bottom:6px">总注数：<b style="color:#feca57">' + comp.totalCombos + '</b> 注</div>';
        comp.perPos.forEach(function(picks, p) {
            html += '<div style="margin:3px 0;display:flex;align-items:center;gap:4px">';
            html += '<span style="color:' + ballColors[p] + ';font-weight:bold;font-size:11px;width:32px">' + posLabels[p] + '：</span>';
            picks.forEach(function(n) {
                html += '<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:' + ballColors[p] + ';color:#fff;font-weight:bold;font-size:11px;margin:0 1px">' + n + '</span>';
            });
            html += '</div>';
        });
        html += '<button class="copy-btn" style="margin-top:6px;padding:4px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:10px;cursor:pointer" onclick="copyOneCompound(' + idx + ', this)">📋 复制</button>';
        html += '</div>';
    });
    document.getElementById('compoundDisplay').innerHTML = html;
})();

// 渲染单注 TOP5
(function() {
    var html = '';
    recommend.topSingles.forEach(function(item, i) {
        var isTop = i === 0;
        html += '<div style="background:#1e1e1e;border-radius:8px;padding:10px;text-align:center;border:1px solid ' + (isTop ? 'rgba(9,132,227,0.5)' : '#333') + (isTop ? ';background:rgba(9,132,227,0.08)' : '') + '">';
        html += '<div style="font-size:11px;color:#888;margin-bottom:4px">推荐 #' + (i + 1) + (isTop ? ' 🥇 最佳' : '') + '</div>';
        html += '<div style="font-size:20px;font-weight:bold;letter-spacing:3px;margin-bottom:4px">';
        item.combo.forEach(function(n, p) {
            html += '<span style="color:' + ballColors[p] + '">' + n + '</span>';
            if (p < 4) html += ' ';
        });
        html += '</div>';
        html += '<div style="font-size:11px;color:#aaa">口诀:' + item.formulaScore + ' | 形态:' + item.shapeScore + ' | 总:' + item.total + '</div>';
        html += '<button class="copy-btn" style="margin-top:4px;padding:3px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer" onclick="copySingle(' + String.fromCharCode(39) + item.combo.join('') + String.fromCharCode(39) + ', this)">复制</button>';
        html += '</div>';
    });
    document.getElementById('singlesGrid').innerHTML = html;
})();

// 渲染评分明细表
(function() {
    var html = '';
    for (var i = 0; i < 5; i++) {
        html += '<tr><td style="color:#feca57;font-weight:bold">' + (i + 1) + '</td>';
        for (var p = 0; p < 5; p++) {
            var item = recommend.posRanked[p][i] || { num: '-', score: 0, reasons: [] };
            html += '<td style="color:' + ballColors[p] + ';font-weight:bold;font-size:13px">' + item.num + '</td>';
            html += '<td>' + item.score + '</td>';
            html += '<td style="font-size:10px;color:#888">' + (item.reasons || []).join(',') + '</td>';
        }
        html += '</tr>';
    }
    document.getElementById('scoreTableBody').innerHTML = html;
})();

function copySingle(combo, btn) {
    copyToClipboard('排五口诀推荐：' + combo.split('').join(' '));
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllSingles() {
    var lines = recommend.topSingles.map(function(item, i) {
        return String(i + 1).padStart(2, '0') + '. ' + item.combo.join(' ') + ' (总分' + item.total + ')';
    });
    copyToClipboard('排五口诀推荐单注TOP' + recommend.topSingles.length + '\\n' + lines.join('\\n'));
}
function copyOneCompound(idx, btn) {
    var comp = recommend.compoundList[idx];
    var parts = comp.perPos.map(function(picks, p) {
        return posLabels[p] + '：' + picks.join(' ');
    });
    copyToClipboard('排五口诀 ' + comp.label + ' 复式（' + comp.totalCombos + '注）\\n' + parts.join('\\n'));
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllCompound() {
    var lines = ['排五口诀复式方案（4 种规格）'];
    recommend.compoundList.forEach(function(comp) {
        lines.push('\\n【' + comp.label + ' · ' + comp.totalCombos + '注】');
        comp.perPos.forEach(function(picks, p) {
            lines.push('  ' + posLabels[p] + '：' + picks.join(' '));
        });
    });
    copyToClipboard(lines.join('\\n'));
}
function copyToClipboard(text) {
    try { acquireVsCodeApi().postMessage({ command: 'copy', text: text }); } catch(e) {}
    // Toast 提示
    var toast = document.getElementById('copyToast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 2000); }
}
</script>
</body>
</html>`;
}

/**
 * 福彩3D口诀实战工具 HTML
 * 福彩3D规则：3 位数字（百十个），每位 0-9
 */
function getFc3dFormulaHtml(latest, history) {
    const latestNums = latest ? latest.num : [0, 0, 0];
    const latestPeriod = latest ? latest.period : '—';
    const latestDate = latest ? latest.date : '—';
    const [bai, shi, ge] = latestNums;

    // ===== 1. 数字关联口诀 =====
    // 每个数字的口诀对应
    const digitRules = {
        0: { rule: '见0多半没有0', action: '下期可能不出0', focus: [] },
        1: { rule: '有1大半不见1', action: '下期可能不出1', focus: [] },
        2: { rule: '有2一定要用2', action: '下期关注2', focus: [2] },
        3: { rule: '有3不如选46', action: '下期关注4或6', focus: [4, 6] },
        4: { rule: '有4常会出69', action: '下期关注6或9', focus: [6, 9] },
        5: { rule: '见5常伴1或9', action: '下期关注1或9', focus: [1, 9] },
        6: { rule: '现6多有47随', action: '下期关注4或7', focus: [4, 7] },
        7: { rule: '7遇8时自带0', action: '7和8出现时关注0', focus: [0] },
        8: { rule: '有8偏爱偶数出', action: '下期关注偶数0/2/4/6/8', focus: [0, 2, 4, 6, 8] },
        9: { rule: '现9回落1跟7', action: '下期关注1或7', focus: [1, 7] }
    };
    // 组合规则
    const comboRules = [
        { name: '369经常有', test: (nums) => { const c = [3,6,9].filter(n => nums.includes(n)).length; return c >= 2 ? '369组合高频命中' + c + '个' : null; } },
        { name: '478多同在', test: (nums) => { const c = [4,7,8].filter(n => nums.includes(n)).length; return c >= 2 ? '478组合同在命中' + c + '个' : null; } },
        { name: '25同出小和小跨', test: (nums) => nums.includes(2) && nums.includes(5) ? '2和5同出，留意小和值小跨度' : null },
        { name: '01出现组三多看', test: (nums) => nums.includes(0) && nums.includes(1) ? '0和1出现，关注组选三（有对子）' : null }
    ];
    const digitHits = [];
    const focusSet = new Set();
    [...new Set(latestNums)].forEach(n => {
        const rule = digitRules[n];
        if (rule) {
            digitHits.push({ digit: n, ...rule });
            rule.focus.forEach(f => focusSet.add(f));
        }
    });
    const comboHits = comboRules.map(r => ({ name: r.name, result: r.test(latestNums) })).filter(r => r.result);

    // ===== 2. 和值/跨度/形态 =====
    const sum = latestNums.reduce((a, b) => a + b, 0);
    const span = Math.max.apply(null, latestNums) - Math.min.apply(null, latestNums);
    const oddCount = latestNums.filter(n => n % 2 === 1).length;
    const evenCount = 3 - oddCount;
    const bigCount = latestNums.filter(n => n >= 5).length;
    const smallCount = 3 - bigCount;
    const isRepeat = new Set(latestNums).size < 3;
    const isLeopard = new Set(latestNums).size === 1;

    // 和值评价
    const sumStatus = sum >= 10 && sum <= 18 ? '主道区(10-18)' : sum >= 8 && sum <= 20 ? '稳抓区(8-20)' : sum < 8 ? '偏低' : '偏高';
    // 跨度评价
    const spanStatus = span >= 3 && span <= 7 ? '靠谱区(3-7)' : span === 9 ? '豹子跨度9少碰' : span < 3 ? '偏小' : '偏大';
    // 奇偶
    const oddEvenStatus = (oddCount === 2 && evenCount === 1) || (oddCount === 1 && evenCount === 2) ? '二比一最香' : (oddCount === 3 || evenCount === 3 ? '全奇全偶别当庄' : '其他');
    // 大小
    const bigSmallStatus = (bigCount === 2 && smallCount === 1) || (bigCount === 1 && smallCount === 2) ? '2:1或1:2 不偏差' : '偏差';

    // 最近5期和值
    let sumTrend = [];
    if (history.length >= 6) {
        for (let i = history.length - 5; i < history.length; i++) {
            sumTrend.push(history[i].num.reduce((a, b) => a + b, 0));
        }
    }
    // 最近5期重号统计
    let repeatCount = 0;
    if (history.length >= 5) {
        for (let i = history.length - 5; i < history.length; i++) {
            const prev = history[i - 1] ? history[i - 1].num : [];
            const curr = history[i].num;
            if (curr.some(n => prev.includes(n))) repeatCount++;
        }
    }

    // ===== 3. 推荐号码生成 =====
    function genRecommendation() {
        const posScores = [new Array(10).fill(0), new Array(10).fill(0), new Array(10).fill(0)];
        const reasons = [[], [], []];

        // 规则1：数字关联口诀 → focus 里的号码加分
        focusSet.forEach(n => {
            for (let p = 0; p < 3; p++) {
                posScores[p][n] += 15;
                reasons[p][n] = (reasons[p][n] || []);
                reasons[p][n].push('数字关联');
            }
        });
        // 见0/1 → 杀0/1
        if (latestNums.includes(0)) {
            for (let p = 0; p < 3; p++) {
                posScores[p][0] -= 12;
                reasons[p][0] = (reasons[p][0] || []);
                reasons[p][0].push('见0多半无0');
            }
        }
        if (latestNums.includes(1)) {
            for (let p = 0; p < 3; p++) {
                posScores[p][1] -= 12;
                reasons[p][1] = (reasons[p][1] || []);
                reasons[p][1].push('有1大半无1');
            }
        }
        // 有2一定要用2
        if (latestNums.includes(2)) {
            for (let p = 0; p < 3; p++) {
                posScores[p][2] += 18;
                reasons[p][2] = (reasons[p][2] || []);
                reasons[p][2].push('有2必用2');
            }
        }
        // 有8偏爱偶数
        if (latestNums.includes(8)) {
            for (let p = 0; p < 3; p++) {
                for (let n = 0; n <= 8; n += 2) {
                    posScores[p][n] += 8;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('有8偏爱偶');
                }
            }
        }

        // 规则2：组合规则
        comboHits.forEach(h => {
            const nums = h.result.match(/\d/g) || [];
            const uniqueNums = [...new Set(nums.map(Number))];
            uniqueNums.forEach(n => {
                for (let p = 0; p < 3; p++) {
                    posScores[p][n] += 10;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push(h.name);
                }
            });
        });

        // 规则3：和值范围 8-20，主道 10-18
        if (sum < 10) {
            for (let p = 0; p < 3; p++) {
                for (let n = 4; n <= 9; n++) {
                    posScores[p][n] += 6;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值回升');
                }
            }
        } else if (sum > 18) {
            for (let p = 0; p < 3; p++) {
                for (let n = 0; n <= 5; n++) {
                    posScores[p][n] += 6;
                    reasons[p][n] = (reasons[p][n] || []);
                    reasons[p][n].push('和值回落');
                }
            }
        }

        // 规则4：重号 +5
        for (let p = 0; p < 3; p++) {
            posScores[p][latestNums[p]] += 5;
            reasons[p][latestNums[p]] = (reasons[p][latestNums[p]] || []);
            reasons[p][latestNums[p]].push('重号');
        }

        // 规则5：邻号 +4
        for (let p = 0; p < 3; p++) {
            if (latestNums[p] > 0) {
                posScores[p][latestNums[p] - 1] += 4;
                reasons[p][latestNums[p] - 1] = (reasons[p][latestNums[p] - 1] || []);
                reasons[p][latestNums[p] - 1].push('邻号');
            }
            if (latestNums[p] < 9) {
                posScores[p][latestNums[p] + 1] += 4;
                reasons[p][latestNums[p] + 1] = (reasons[p][latestNums[p] + 1] || []);
                reasons[p][latestNums[p] + 1].push('邻号');
            }
        }

        // 每位排序
        const posRanked = posScores.map((scores, p) => {
            return scores.map((s, n) => ({
                num: n, score: s, reasons: reasons[p][n] || []
            })).sort((a, b) => b.score - a.score);
        });

        // 单注推荐：每位 TOP3 笛卡尔积 + 形态校验
        const candidates = [];
        const topK = 3;
        function backtrack(depth, current) {
            if (depth === 3) {
                const cOdd = current.filter(n => n % 2 === 1).length;
                const cBig = current.filter(n => n >= 5).length;
                const cSpan = Math.max.apply(null, current) - Math.min.apply(null, current);
                const cSum = current.reduce((a, b) => a + b, 0);
                const isLeopard = new Set(current).size === 1;
                let shapeScore = 0;
                if (cOdd === 2 || cOdd === 1) shapeScore += 15; // 二比一
                if (cOdd === 3 || cOdd === 0) shapeScore -= 10; // 全奇全偶
                if (cBig === 2 || cBig === 1) shapeScore += 15; // 2:1或1:2
                if (cSpan >= 3 && cSpan <= 7) shapeScore += 12; // 跨度3-7
                if (cSpan === 9 || isLeopard) shapeScore -= 15; // 豹子
                if (cSum >= 10 && cSum <= 18) shapeScore += 15; // 主道
                else if (cSum >= 8 && cSum <= 20) shapeScore += 8; // 稳抓
                const formulaScore = current.reduce((sum, n, p) => sum + (posRanked[p].find(x => x.num === n) ? posRanked[p].find(x => x.num === n).score : 0), 0);
                candidates.push({ combo: [...current], formulaScore, shapeScore, total: formulaScore + shapeScore });
                return;
            }
            for (let i = 0; i < Math.min(topK, posRanked[depth].length); i++) {
                current.push(posRanked[depth][i].num);
                backtrack(depth + 1, current);
                current.pop();
            }
        }
        backtrack(0, []);
        candidates.sort((a, b) => b.total - a.total);

        const seen = new Set();
        const topSingles = [];
        for (const c of candidates) {
            const key = c.combo.join('');
            if (!seen.has(key)) { seen.add(key); topSingles.push(c); if (topSingles.length >= 5) break; }
        }

        // 复式：2×2×2 ~ 5×5×5
        const compoundList = [];
        for (let k = 2; k <= 5; k++) {
            const perPos = posRanked.map(ranked => {
                const filtered = ranked.filter(x => x.score > -10);
                return filtered.slice(0, k).map(x => x.num);
            });
            const totalCombos = perPos.reduce((a, b) => a * b.length, 1);
            compoundList.push({ k, label: k + '×' + k + '×' + k, perPos, totalCombos });
        }

        return { topSingles, compoundList, posRanked };
    }

    const recommend = genRecommendation();
    const posLabels3 = ['百位', '十位', '个位'];
    const ballColors3 = ['#e94560', '#0984e3', '#27ae60'];

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>福彩3D口诀</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px;line-height:1.6}
.header{text-align:center;margin-bottom:20px}
.header h1{color:#27ae60;font-size:26px;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.latest-bar{display:flex;justify-content:center;align-items:center;gap:12px;background:#252526;padding:12px 20px;border-radius:10px;margin-bottom:20px;border:1px solid #333}
.latest-bar .label{color:#888;font-size:13px}
.latest-bar .balls{display:flex;gap:6px}
.ball{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;color:#fff}
.ball.bai{background:#e94560}
.ball.shi{background:#0984e3}
.ball.ge{background:#27ae60}
.section{background:#252526;border-radius:10px;padding:16px 20px;margin-bottom:16px;border:1px solid #333}
.section-title{color:#27ae60;font-size:15px;font-weight:bold;margin-bottom:12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;padding-bottom:8px}
.formula-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.formula-card{background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid #27ae60}
.formula-card h4{font-size:13px;margin-bottom:8px}
.formula-card .desc{font-size:12px;color:#aaa;margin-bottom:8px}
.formula-card .result{background:#2d2d30;padding:8px 12px;border-radius:5px;font-size:13px;color:#9cdcfe;font-weight:bold}
.formula-card .result.hit{color:#2ecc71}
.formula-card .result.warn{color:#feca57}
.formula-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.formula-table th{background:#333;color:#569cd6;padding:6px;text-align:center}
.formula-table td{padding:6px;text-align:center;border-bottom:1px solid #333}
.formula-table td.highlight{background:rgba(39,174,96,0.15);color:#27ae60;font-weight:bold}
.disclaimer{background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);padding:12px 16px;border-radius:8px;color:#e74c3c;font-size:12px;margin-top:16px}
.mind-section{background:rgba(39,174,96,0.05);border:1px solid rgba(39,174,96,0.2);border-radius:8px;padding:14px;margin-bottom:8px}
.mind-section h4{color:#27ae60;font-size:13px;margin-bottom:8px}
.mind-section ul{margin:0 0 0 20px;font-size:12px;color:#bbb}
.mind-section li{margin:4px 0}
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
<div class="header">
<h1>🎁 福彩3D口诀</h1>
<p>彩民总结的 3 类高频实用口诀（数字关联 / 和值跨度形态 / 购彩心态），结合最新一期自动推导</p>
</div>

<div class="latest-bar">
<span class="label">最新一期 第 ${latestPeriod} 期（${latestDate}）：</span>
<div class="balls">
<span class="ball bai">${bai}</span>
<span class="ball shi">${shi}</span>
<span class="ball ge">${ge}</span>
</div>
</div>

<!-- ===== 1. 数字关联口诀 ===== -->
<div class="section">
<div class="section-title">🔢 一、数字关联口诀（上期定下期）</div>
<h4 style="color:#27ae60;font-size:13px;margin-bottom:10px">单数字规则</h4>
<table class="formula-table">
<thead><tr><th>上期含</th><th>0</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th></tr></thead>
<tbody>
<tr><td>口诀</td><td>多半无0</td><td>大半无1</td><td>必用2</td><td>选4/6</td><td>出6/9</td><td>伴1或9</td><td>有4/7随</td><td>遇8带0</td><td>偏爱偶数</td><td>回落1/7</td></tr>
</tbody>
</table>

<h4 style="color:#27ae60;font-size:13px;margin:12px 0 8px">🎯 实战推导</h4>
${digitHits.length > 0 ? digitHits.map(h => '<div class="formula-card" style="margin-bottom:8px"><h4>上期含 ' + h.digit + '</h4><div class="desc">' + h.rule + '</div><div class="result hit">' + h.action + (h.focus.length > 0 ? '（关注：' + h.focus.join(',') + '）' : '') + '</div></div>').join('') : '<div class="result warn">无匹配</div>'}

<h4 style="color:#27ae60;font-size:13px;margin:12px 0 8px">组合规则</h4>
<div class="formula-grid">
${comboRules.map(r => {
    const result = r.test(latestNums);
    return '<div class="formula-card"><h4>' + r.name + '</h4><div class="result ' + (result ? 'hit' : 'warn') + '">' + (result || '未命中') + '</div></div>';
}).join('')}
</div>
</div>

<!-- ===== 2. 和值/跨度/形态口诀 ===== -->
<div class="section">
<div class="section-title">📐 二、和值/跨度/形态口诀</div>
<div class="formula-grid">
<div class="formula-card">
<h4>和值</h4>
<div class="desc">8-20 稳抓牢，10-18 是主道</div>
<div class="result ${sum >= 10 && sum <= 18 ? 'hit' : sum >= 8 && sum <= 20 ? 'warn' : 'warn'}">本期和值：${sum}（${sumStatus}）</div>
</div>
<div class="formula-card">
<h4>跨度</h4>
<div class="desc">3-7 最靠谱，豹子跨度9少碰</div>
<div class="result ${span >= 3 && span <= 7 ? 'hit' : 'warn'}">本期跨度：${span}（${spanStatus}）</div>
</div>
<div class="formula-card">
<h4>奇偶比</h4>
<div class="desc">二比一最香，全奇全偶别当庄</div>
<div class="result ${(oddCount === 2 && evenCount === 1) || (oddCount === 1 && evenCount === 2) ? 'hit' : 'warn'}">本期：${oddCount}奇${evenCount}偶（${oddEvenStatus}）</div>
</div>
<div class="formula-card">
<h4>大小比</h4>
<div class="desc">2:1 或 1:2，有大有小不偏差</div>
<div class="result ${(bigCount === 2 && smallCount === 1) || (bigCount === 1 && smallCount === 2) ? 'hit' : 'warn'}">本期：${bigCount}大${smallCount}小（${bigSmallStatus}）</div>
</div>
<div class="formula-card">
<h4>重号/连号</h4>
<div class="desc">期期有重号，连号看走势</div>
<div class="result">${isLeopard ? '豹子(罕见)' : isRepeat ? '有对子' : '无重复'} | 近5期有重号${repeatCount}期</div>
</div>
</div>
${sumTrend.length > 0 ? '<div style="margin-top:10px;font-size:12px;color:#888">最近5期和值：' + sumTrend.join(' → ') + '</div>' : ''}
</div>

<!-- ===== 3. 购彩心态口诀 ===== -->
<div class="section">
<div class="section-title">🧠 三、购彩心态口诀（避坑提醒）</div>
<div class="mind-section">
<h4>📌 选号策略</h4>
<ul>
<li>新手先学买组选，安全绑组选；研究号位做单选，定胆买组选</li>
<li>买热号防出错，买冷号等冷返；倍投反算总额，别盲目</li>
</ul>
</div>
<div class="mind-section">
<h4>📊 数据参考</h4>
<ul>
<li>找规律看五十期，找号码看十五期</li>
<li>试机号参考趋势，非开奖号</li>
</ul>
</div>
<div class="mind-section">
<h4>⚠️ 心态提醒</h4>
<ul>
<li>会不买才不赔钱，天天买熬人</li>
<li>跟着高手学方法，跟着笨蛋杀号码</li>
</ul>
</div>
</div>

<!-- ===== 4. 口诀推荐号码 ===== -->
<div class="section" style="border:1px solid rgba(39,174,96,0.4)">
<div class="section-title" style="color:#27ae60">🎯 四、口诀推荐号码</div>
<p style="color:#aaa;font-size:12px;margin-bottom:12px">基于上述 3 类口诀规则综合评分，每位取 TOP3 候选 → 笛卡尔积 → 形态校验排序 → 取 TOP5 单注 + 4 种复式方案</p>

<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px" id="compoundDisplay"></div>
<button class="copy-btn" style="margin-bottom:14px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllCompound()">📋 复制全部 4 种复式方案</button>

<h4 style="color:#27ae60;font-size:14px;margin-bottom:10px">🏆 精选单注 TOP5（口诀分+形态分）</h4>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px" id="singlesGrid"></div>
<button class="copy-btn" style="margin-top:12px;padding:7px 16px;background:#0e639c;border:none;border-radius:5px;color:#fff;font-size:13px;cursor:pointer" onclick="copyAllSingles()">📋 复制全部单注</button>

<div style="margin-top:14px;background:#1e1e1e;border-radius:8px;padding:14px">
<h4 style="color:#569cd6;font-size:13px;margin-bottom:10px">📊 每位候选号码评分明细（TOP5）</h4>
<table class="formula-table">
<thead><tr><th>排名</th><th>百位</th><th>分数</th><th>口诀</th><th>十位</th><th>分数</th><th>口诀</th><th>个位</th><th>分数</th><th>口诀</th></tr></thead>
<tbody id="scoreTableBody"></tbody>
</table>
</div>
</div>

<div class="disclaimer">
⚠️ <b>免责声明：</b>以上口诀来源于彩民经验总结，无统计学严格证明。彩票为独立随机事件，口诀仅供娱乐参考，请理性购彩。
</div>

<script>
var recommend = ${JSON.stringify(recommend)};
var posLabels = ${JSON.stringify(posLabels3)};
var ballColors = ${JSON.stringify(ballColors3)};

// 渲染复式方案
(function() {
    var html = '';
    recommend.compoundList.forEach(function(comp, idx) {
        var color = idx === 0 ? '#2ecc71' : idx === 1 ? '#feca57' : idx === 2 ? '#27ae60' : '#8e44ad';
        html += '<div style="flex:1;min-width:200px;background:#1e1e1e;border-radius:8px;padding:14px;border-left:3px solid ' + color + '">';
        html += '<h4 style="color:' + color + ';font-size:13px;margin-bottom:6px">📋 ' + comp.label + '</h4>';
        html += '<div style="font-size:11px;color:#888;margin-bottom:8px">总注数：<b style="color:#feca57">' + comp.totalCombos + '</b> 注</div>';
        comp.perPos.forEach(function(picks, p) {
            html += '<div style="margin:5px 0;display:flex;align-items:center;gap:6px">';
            html += '<span style="color:' + ballColors[p] + ';font-weight:bold;font-size:12px;width:36px">' + posLabels[p] + '：</span>';
            picks.forEach(function(n) {
                html += '<span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;background:' + ballColors[p] + ';color:#fff;font-weight:bold;font-size:12px;margin:0 2px">' + n + '</span>';
            });
            html += '</div>';
        });
        html += '<button class="copy-btn" style="margin-top:8px;padding:5px 12px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer" onclick="copyOneCompound(' + idx + ', this)">📋 复制</button>';
        html += '</div>';
    });
    document.getElementById('compoundDisplay').innerHTML = html;
})();

// 渲染单注 TOP5
(function() {
    var html = '';
    recommend.topSingles.forEach(function(item, i) {
        var isTop = i === 0;
        html += '<div style="background:#1e1e1e;border-radius:8px;padding:12px;text-align:center;border:1px solid ' + (isTop ? 'rgba(39,174,96,0.5)' : '#333') + (isTop ? ';background:rgba(39,174,96,0.08)' : '') + '">';
        html += '<div style="font-size:11px;color:#888;margin-bottom:6px">推荐 #' + (i + 1) + (isTop ? ' 🥇 最佳' : '') + '</div>';
        html += '<div style="font-size:22px;font-weight:bold;letter-spacing:4px;margin-bottom:6px">';
        item.combo.forEach(function(n, p) {
            html += '<span style="color:' + ballColors[p] + '">' + n + '</span>';
            if (p < 2) html += ' ';
        });
        html += '</div>';
        html += '<div style="font-size:11px;color:#aaa">口诀分:' + item.formulaScore + ' | 形态分:' + item.shapeScore + ' | 总分:' + item.total + '</div>';
        html += '<button class="copy-btn" style="margin-top:6px;padding:3px 10px;background:#0e639c;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer" onclick="copySingle(' + String.fromCharCode(39) + item.combo.join('') + String.fromCharCode(39) + ', this)">复制</button>';
        html += '</div>';
    });
    document.getElementById('singlesGrid').innerHTML = html;
})();

// 渲染评分明细表
(function() {
    var html = '';
    for (var i = 0; i < 5; i++) {
        var bai = recommend.posRanked[0][i] || {num:'-',score:0,reasons:[]};
        var shi = recommend.posRanked[1][i] || {num:'-',score:0,reasons:[]};
        var ge = recommend.posRanked[2][i] || {num:'-',score:0,reasons:[]};
        html += '<tr><td style="color:#feca57;font-weight:bold">' + (i + 1) + '</td>';
        html += '<td style="color:#e94560;font-weight:bold;font-size:14px">' + bai.num + '</td>';
        html += '<td>' + bai.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (bai.reasons || []).join(',') + '</td>';
        html += '<td style="color:#0984e3;font-weight:bold;font-size:14px">' + shi.num + '</td>';
        html += '<td>' + shi.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (shi.reasons || []).join(',') + '</td>';
        html += '<td style="color:#27ae60;font-weight:bold;font-size:14px">' + ge.num + '</td>';
        html += '<td>' + ge.score + '</td>';
        html += '<td style="font-size:11px;color:#888">' + (ge.reasons || []).join(',') + '</td>';
        html += '</tr>';
    }
    document.getElementById('scoreTableBody').innerHTML = html;
})();

function copySingle(combo, btn) {
    copyToClipboard('福彩3D口诀推荐：' + combo.split('').join(' '));
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllSingles() {
    var lines = recommend.topSingles.map(function(item, i) {
        return String(i + 1).padStart(2, '0') + '. ' + item.combo.join(' ') + ' (总分' + item.total + ')';
    });
    copyToClipboard('福彩3D口诀推荐单注TOP' + recommend.topSingles.length + '\\n' + lines.join('\\n'));
}
function copyOneCompound(idx, btn) {
    var comp = recommend.compoundList[idx];
    var parts = comp.perPos.map(function(picks, p) {
        return posLabels[p] + '：' + picks.join(' ');
    });
    copyToClipboard('福彩3D口诀 ' + comp.label + ' 复式（' + comp.totalCombos + '注）\\n' + parts.join('\\n'));
    if (btn) { var old = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(function(){ btn.innerHTML = old; }, 1500); }
}
function copyAllCompound() {
    var lines = ['福彩3D口诀复式方案（4 种规格）'];
    recommend.compoundList.forEach(function(comp) {
        lines.push('\\n【' + comp.label + ' · ' + comp.totalCombos + '注】');
        comp.perPos.forEach(function(picks, p) {
            lines.push('  ' + posLabels[p] + '：' + picks.join(' '));
        });
    });
    copyToClipboard(lines.join('\\n'));
}
function copyToClipboard(text) {
    try { acquireVsCodeApi().postMessage({ command: 'copy', text: text }); } catch(e) {}
    // Toast 提示
    var toast = document.getElementById('copyToast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 2000); }
}
</script>
</body>
</html>`;
}
function getRoadAnalysisHtml(result, cfg, N) {
    const R = result;
    const posCount = R.posCount || 3;
    const posNames = R.posNames || [];
    const posColors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6'];
    const roadColors = { 0: '#06b6d4', 1: '#8b5cf6', 2: '#f59e0b' };
    const roadNums = { 0: '0,3,6,9', 1: '1,4,7', 2: '2,5,8' };

    function getRoad(n) { return n % 3; }
    function isOdd(n) { return n % 2 === 1; }

    let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>012路趋势分析</title>
<style>body{font-family:'Microsoft YaHei',sans-serif;background:#0f172a;color:#e2e8f0;padding:16px}
.card{background:#1e293b;border-radius:10px;padding:16px;margin:14px 0}
h1{text-align:center;font-size:20px;color:#38bdf8;margin-bottom:18px}
h2{font-size:16px;color:#818cf8;margin:22px 0 12px;padding-left:10px;border-left:4px solid #6366f1}
table{width:100%;border-collapse:collapse;font-size:12px}th{background:#334155;padding:8px}td{padding:6px;text-align:center}
.road-cell{display:inline-block;width:24px;height:24px;line-height:24px;border-radius:50%;color:white;font-size:11px;font-weight:bold}
.r0{background:#06b6d4}.r1{background:#8b5cf6}.r2{background:#f59e0b}
.copy-btn{background:#6366f1;color:white;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:11px}.copy-btn:hover{transform:scale(1.05)}.copy-btn.copied{background:#10b981}
.copy-all-btn{background:#f59e0b;color:white;border:none;padding:8px 18px;border-radius:8px;font-size:13px;cursor:pointer;margin:10px 0}.copy-all-btn.copied{background:#10b981}
.tag-hot{background:#ef4444;color:white;padding:2px 8px;border-radius:4px;font-size:11px}.tag-warm{background:#f59e0b;color:white;padding:2px 8px;border-radius:4px;font-size:11px}
.insight-box{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:14px;margin:12px}
</style></head><body>
<h1>🛤️ ${cfg.name} 012路趋势分析 (${N}期)</h1>

<h2>一、各位012路基础分布</h2>
<div style="display:grid;grid-template-columns:repeat(${posCount},1fr);gap:14px">`;

    for (let p = 0; p < posCount; p++) {
        html += `<div class="card"><h3 style="color:${posColors[p]};margin-bottom:12px">${posNames[p]}位 012路分布</h3><table><tr><th>路别</th><th>号码</th><th>出现次数</th><th>占比</th></tr>`;
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            const pct = ((s.total / N) * 100).toFixed(1);
            html += `<tr><td>${r}路</td><td>${roadNums[r]}</td><td>${s.total}</td><td>${pct}%</td></tr>`;
        }
        html += `</table></div>`;
    }
    html += `</div>`;

    // 分段趋势
    html += `<h2>二、分段趋势演变</h2><div class="card"><table><tr><th rowspan="2">位置</th>`;
    R.segData.forEach(seg => { html += `<th colspan="3">${seg.name}<br/><small>${seg.count}期</small></th>`; });
    html += `</tr><tr>`; R.segData.forEach(() => { html += '<th>0路</th><th>1路</th><th>2路</th>'; });
    html += `</tr>`;
    for (let p = 0; p < posCount; p++) {
        html += `<tr style="color:${posColors[p]};font-weight:bold"><td>${posNames[p]}位</td>`;
        R.segData.forEach(seg => { for (let r = 0; r <= 2; r++) html += `<td>${seg.roads[p][r]}%</td>`; });
        html += `</tr>`;
    }
    html += `</table></div>`;

    // 奇偶比
    html += `<h2>三、012路内奇偶比分析</h2><div style="display:grid;grid-template-columns:repeat(${posCount},1fr);gap:14px">`;
    for (let p = 0; p < posCount; p++) {
        html += `<div class="card"><h3 style="color:${posColors[p]}">${posNames[p]}位 奇偶详情</h3><table><tr><th>路别</th><th>总次</th><th>奇数</th><th>偶数</th></tr>`;
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            html += `<tr><td>${r}路</td><td>${s.total}</td><td>${s.odd}</td><td>${s.even}</td></tr>`;
        }
        html += `</table></div>`;
    }
    html += `</div>`;

    // 遗漏
    html += `<h2>四、遗漏与连出分析</h2><div style="display:grid;grid-template-columns:repeat(${posCount},1fr);gap:14px">`;
    for (let p = 0; p < posCount; p++) {
        html += `<div class="card"><h3 style="color:${posColors[p]}">${posNames[p]}位 遗漏状态</h3><table><tr><th>路别</th><th>当前遗漏</th><th>平均遗漏</th><th>最大遗漏</th></tr>`;
        for (let r = 0; r <= 2; r++) {
            const m = R.missData[p][r];
            let status = m.current >= m.max * 0.9 ? '⚠极值' : m.current > parseFloat(m.avg) * 2 ? '超漏' : m.current === 0 ? '刚出' : '正常';
            html += `<tr><td>${r}路</td><td>${m.current}</td><td>${m.avg}</td><td>${m.max}</td><td>${status}</td></tr>`;
        }
        html += `</table></div>`;
    }
    html += `</div>`;

    // 组合形态
    html += `<h2>五、012路组合形态统计</h2><div class="card"><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">`;
    R.combos.slice(0, 15).forEach(([combo, count]) => {
        const pct = ((count / N) * 100).toFixed(2);
        html += `<span style="background:#334155;padding:10px 16px;border-radius:8px;text-align:center;border:1px solid #475569">
<span style="font-family:monospace;font-size:16px;font-weight:bold">${combo}</span><br/>
<span style="font-size:11px;color:#94a3b8">${count}次(${pct}%)</span></span>`;
    });
    html += `</div></div>`;

    // 走势图
    html += `<h2>六、最近30期走势</h2><div class="card" style="overflow-x:auto"><table><tr><th>期号</th>`;
    for (let p = 0; p < posCount; p++) html += `<th>${posNames[p]}位</th>`;
    html += `<th>路组合</th></tr>`;
    R.recentTrend.slice(0, 30).forEach(item => {
        html += `<tr><td>${item.period}</td>`;
        item.nums.forEach(n => { html += `<td>${n.val}|<span class="road-cell r${n.road}">${n.road}</span></td>`; });
        html += `<td>`; item.roadCombo.split('').forEach(r => html += `<span class="road-cell r${r}">${r}</span>`); html += `</td></tr>`;
    });
    html += `</table></div>`;

    // 预测推荐
    html += `<h2>七、下期预测参考</h2><div style="display:grid;grid-template-columns:repeat(${posCount},1fr);gap:14px">`;
    for (let p = 0; p < posCount; p++) {
        html += `<div class="card" style="border-left:4px solid ${posColors[p]}"><h3 style="color:${posColors[p]};margin-bottom:12px">${posNames[p]}位推荐</h3>`;
        const advice = R.trendAdvice[p];
        const recs = [];
        for (let r = 0; r <= 2; r++) recs.push({ road: r, ...advice[r] });
        recs.sort((a, b) => a.miss - b.miss);
        recs.slice(0, 2).forEach((rec, i) => {
            html += `<div style="padding:8px;background:#334155;border-radius:6px;margin:4px 0">
<strong style="color:${roadColors[rec.road]}">${i===0?'首选':'次选'}: ${rec.road}路</strong> 遗漏${rec.miss}(均${rec.avgMiss})</div>`;
        });
        html += `</div>`;
    }
    html += `</div>`;

    // ========== 第八部分：智能号码推荐 + 复制功能 ==========
    if (R.complexRec && R.singleRec) {
        // 合并所有复式规格的复制文本，用于一键复制全部
        const allComplexText = R.complexRec.map(rec => rec.copyText).join('\n\n');
        const allComplexB64 = Buffer.from(allComplexText).toString('base64');

        html += `<h2>八、🎲 智能号码推荐</h2>

<div class="card" style="border-left:4px solid #f59e0b">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
<h3 style="color:#f59e0b;font-size:15px;margin:0">📋 复式推荐（多规格可选）</h3>
<button class="copy-all-btn" id="copyAllComplexBtn" onclick="copyAllComplex()">📋 一键复制全部复式</button>
<span id="allComplexData" data-copy="${allComplexB64}" style="display:none"></span>
</div>
<div style="display:grid;grid-template-columns:repeat(${Math.min(R.complexRec.length,4)},1fr);gap:14px">`;

        const sizeLabels = { 2: '精简', 3: '标准', 4: '扩展', 5: '全覆盖' };
        const sizeColorsMap = { 2: '#38bdf8', 3: '#a78bfa', 4: '#f59e0b', 5: '#ef4444' };

        R.complexRec.forEach((rec) => {
            const label = sizeLabels[rec.size] || rec.size + '码';
            const color = sizeColorsMap[rec.size] || '#94a3b8';
            const copyBase64 = Buffer.from(rec.copyText).toString('base64');

            html += `<div style="background:#334155;border-radius:8px;padding:14px;border-top:3px solid ${color}">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
<span style="font-weight:bold;color:${color}">${label}复式 (${rec.size}*${rec.size}${posCount===3?'':'×'+posCount+'位'})</span>
<div style="display:flex;align-items:center;gap:8px">
<span class="tag-hot">${rec.count}注</span>
<button class="copy-btn" data-copy="${copyBase64}" onclick="copyFromData(this)">📋 复制</button>
</div></div>
<div style="text-align:center;font-family:monospace;font-size:${posCount>3?16:20}px;font-weight:bold;padding:12px;background:#1e293b;border-radius:6px;letter-spacing:${posCount>3?'2':'4'}px">${rec.formula}</div>
<div style="font-size:11px;color:#94a3b8;line-height:1.8;margin-top:10px">`;
            for (let p = 0; p < posCount; p++) {
                html += `<div>${posNames[p]}位: <span style="color:${posColors[p]}">${rec.nums[p].join(', ')}</span></div>`;
            }
            html += '</div></div>';
        });

        html += `</div></div>`;

        // 精选单注
        html += `
<div class="card" style="border-left:4px solid #ef4444;margin-top:14px">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
<h3 style="color:#ef4444;font-size:15px;margin:0">🏆 精选单注推荐</h3>
<span style="font-size:11px;color:#94a3b8">基于五维评分+形态匹配+和值优化</span>
</div>
<div style="text-align:right;margin-bottom:10px">
<button class="copy-all-btn" id="copyAllSingleBtn" onclick="copyAllSingles()">📋 复制全部单注</button>
<span id="singlesData" data-singles="${R.singleRec.map(item => item.combo.join('')).join('\\n')}"></span>
</div>
<table style="font-size:13px">
<tr style="background:#334155"><th width="50">排名</th><th width="100">号码</th><th width="80">012路</th><th width="70">和值</th><th width="80">综合分</th></tr>`;

        R.singleRec.forEach((item, idx) => {
            const comboStr = item.combo.join('');
            const roadStr = item.combo.map(n => getRoad(n)).join('');
            const sumVal = item.combo.reduce((a, b) => a + b, 0);
            const rankTag = idx === 0 ? '<span class="tag-hot">TOP1</span>' : idx < 3 ? '<span class="tag-warm">TOP'+(idx+1)+'</span>' : ''+(idx+1);
            const rowBg = idx % 2 === 0 ? '' : 'style="background:rgba(51,65,85,.3)"';
            const comboB64 = Buffer.from(comboStr).toString('base64');

            html += `<tr ${rowBg}>
<td style="text-align:center;font-weight:bold">${rankTag}</td>
<td style="text-align:center;font-family:monospace;font-size:16px;font-weight:bold;color:#38bdf8;letter-spacing:3px">
${comboStr}<button class="copy-btn" style="margin-left:6px;padding:2px 8px;font-size:10px" data-copy="${comboB64}" onclick="copySingle(this)">复制</button>
</td>
<td style="text-align:center">`;
            roadStr.split('').forEach(r => html += `<span class="road-cell r${r}" style="width:22px;height:22px;font-size:10px;line-height:22px">${r}</span>`);
            html += `</td>
<td style="text-align:center;font-weight:bold;color:#f59e0b">${sumVal}</td>
<td style="text-align:center;color:#10b981;font-weight:bold">${item.finalScore.toFixed(3)}</td>
</tr>`;
        });

        html += `</table></div>`;
    }

    html += `
<small style="color:#94a3b8;display:block;margin-top:15px;text-align:center">数据范围：${R.firstPeriod} ~ ${R.latestPeriod} | 分析期数：${N}期</small>
<div style="text-align:center;margin:20px 0 15px;padding:15px;color:#64748b;font-size:11px;border-top:1px solid #334155">
🛤️ 012路趋势分析 | ${cfg.name} | 数据驱动 · 智能分析
</div>

<script>
function decodeBase64(s){try{var b=atob(s);return decodeURIComponent(Array.from(b,function(c){return'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)}).join(''))}catch(e){return s}}
function copyFromData(btn){var t=decodeBase64(btn.getAttribute('data-copy'));try{acquireVsCodeApi().postMessage({command:'copy',text:t})}catch(e){}btn.innerHTML='✅ 已复制';btn.classList.add('copied');setTimeout(function(){btn.innerHTML='📋 复制';btn.classList.remove('copied')},1500)}
function copySingle(btn){var t=decodeBase64(btn.getAttribute('data-copy'));try{acquireVsCodeApi().postMessage({command:'copy',text:t})}catch(e){}btn.innerHTML='✅ 已复制';btn.classList.add('copied');setTimeout(function(){btn.innerHTML='复制';btn.classList.remove('copied')},1500)}
function copyAllSingles(){var btn=document.getElementById('copyAllSingleBtn');var el=document.getElementById('singlesData');if(el){try{acquireVsCodeApi().postMessage({command:'copy',text:el.getAttribute('data-singles')})}catch(e){}}if(btn){btn.innerHTML='✅ 已复制';btn.classList.add('copied');setTimeout(function(){btn.innerHTML='📋 复制全部单注';btn.classList.remove('copied')},1500)}}
function copyAllComplex(){var btn=document.getElementById('copyAllComplexBtn');var el=document.getElementById('allComplexData');if(el){try{acquireVsCodeApi().postMessage({command:'copy',text:decodeBase64(el.getAttribute('data-copy'))})}catch(e){}}if(btn){btn.innerHTML='✅ 已复制';btn.classList.add('copied');setTimeout(function(){btn.innerHTML='📋 一键复制全部复式';btn.classList.remove('copied')},1500)}}
</script>
</body></html>`;

    return html;
}


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
.copy-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff; padding: 12px 32px; border-radius: 24px; z-index: 9999; display: none; box-shadow: 0 4px 20px rgba(46,204,113,0.5); font-size: 14px; font-weight: bold; }
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="copy-toast" id="copyToast">✅ 已复制到剪贴板</div>
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
function showCopyToast() {
    var toast = document.getElementById('copyToast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 2000); }
}
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
            showCopyToast();
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
                showCopyToast();
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
            showCopyToast();
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
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
    background: linear-gradient(135deg,#1e4a1e,#2ecc71); color: #fff;
    padding: 12px 32px; border-radius: 24px;
    font-size: 14px; font-weight: bold; z-index: 10000; max-width: 80vw;
    box-shadow: 0 4px 20px rgba(46,204,113,0.5);
}
.copy-toast.show { display: block; animation: copySlideUp .3s ease; }
@keyframes copySlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

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
