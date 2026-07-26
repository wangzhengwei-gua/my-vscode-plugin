#!/usr/bin/env node
/**
 * 均线形态识别回测脚本
 *
 * 思路：假装"不知道"第 i+1 期的开奖号码，只用第 0..i 期的数据
 *      运行 detectMAPatterns，看识别出的"优选号码"和"避开号码"
 *      对第 i+1 期实际开奖号码的命中情况。
 *
 * 用法: node scripts/backtest.js [彩种] [回测期数]
 *   彩种: pl3(默认) / pl5 / dlt / ssq
 *   回测期数: 默认 50
 */
const path = require('path');
const fs = require('fs');
const crawler = require('../src/crawler');

// 复用 extension.js 里的函数（直接 require 会触发 vscode 模块，所以单独摘出来）
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

const toNum = (v) => Math.max(0, Math.min(9, Math.round(v)));

function detectMAPatterns(series) {
    const N = 20;
    const recent = series.slice(-N);
    if (recent.length < 20) {
        return { patterns: [], maData: null, error: '数据不足' };
    }

    const ma5 = calcMA(recent, 5);
    const ma10 = calcMA(recent, 10);
    const ma20 = calcMA(recent, 20);

    const patterns = [];
    const i = recent.length - 1;
    const i1 = recent.length - 2;
    const i2 = recent.length - 3;

    const cur = { ma5: ma5[i], ma10: ma10[i], ma20: ma20[i] };
    const prev = { ma5: ma5[i1], ma10: ma10[i1], ma20: ma20[i1] };

    const latestNum = recent[i];
    const prevNum = recent[i1];

    // ① 多头排列
    if (cur.ma5 > cur.ma10 && cur.ma10 > cur.ma20) {
        const upCount = (cur.ma5 > prev.ma5 ? 1 : 0) + (cur.ma10 > prev.ma10 ? 1 : 0) + (cur.ma20 > prev.ma20 ? 1 : 0);
        if (upCount >= 2) {
            patterns.push({ name: '多头排列', signal: 'bull', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
    }
    // ② 空头排列
    if (cur.ma5 < cur.ma10 && cur.ma10 < cur.ma20) {
        const downCount = (cur.ma5 < prev.ma5 ? 1 : 0) + (cur.ma10 < prev.ma10 ? 1 : 0) + (cur.ma20 < prev.ma20 ? 1 : 0);
        if (downCount >= 2) {
            patterns.push({ name: '空头排列', signal: 'bear', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
    }
    // ③ 黄金交叉
    if (prev.ma5 < prev.ma10 && cur.ma5 > cur.ma10) {
        patterns.push({ name: '黄金交叉', signal: 'bull', numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma10)] });
    } else if (prev.ma5 < prev.ma20 && cur.ma5 > cur.ma20) {
        patterns.push({ name: '黄金交叉', signal: 'bull', numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma20)] });
    }
    // ④ 死亡交叉
    if (prev.ma5 > prev.ma10 && cur.ma5 < cur.ma10) {
        patterns.push({ name: '死亡交叉', signal: 'bear', numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma10)] });
    } else if (prev.ma5 > prev.ma20 && cur.ma5 < cur.ma20) {
        patterns.push({ name: '死亡交叉', signal: 'bear', numbers: [prevNum, latestNum, toNum(cur.ma5), toNum(cur.ma20)] });
    }
    // ⑤ 银山谷
    let silverCross1 = false, silverCross2 = false;
    for (let k = i2; k < i; k++) {
        if (!silverCross1 && ma5[k - 1] < ma20[k - 1] && ma5[k] > ma20[k]) silverCross1 = true;
        if (silverCross1 && !silverCross2 && ma10[k - 1] < ma20[k - 1] && ma10[k] > ma20[k]) silverCross2 = true;
    }
    if (silverCross1 && silverCross2 && cur.ma5 > cur.ma20 && cur.ma10 > cur.ma20) {
        patterns.push({ name: '银山谷', signal: 'bull', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
    }
    // ⑥ 死亡谷
    let deathCross1 = false, deathCross2 = false;
    for (let k = i2; k < i; k++) {
        if (!deathCross1 && ma5[k - 1] > ma20[k - 1] && ma5[k] < ma20[k]) deathCross1 = true;
        if (deathCross1 && !deathCross2 && ma10[k - 1] > ma20[k - 1] && ma10[k] < ma20[k]) deathCross2 = true;
    }
    if (deathCross1 && deathCross2 && cur.ma5 < cur.ma20 && cur.ma10 < cur.ma20) {
        patterns.push({ name: '死亡谷', signal: 'bear', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
    }
    // ⑦ 粘合向上发散
    const convergeWindow = ma5.slice(0, 15).map((v, idx) => ({ ma5: ma5[idx + 5], ma10: ma10[idx + 5], ma20: ma20[idx + 5] })).filter(x => x.ma5 !== null && x.ma10 !== null && x.ma20 !== null);
    const divergeWindow = ma5.slice(15).map((v, idx) => ({ ma5: ma5[idx + 15], ma10: ma10[idx + 15], ma20: ma20[idx + 15] })).filter(x => x.ma5 !== null);
    if (convergeWindow.length >= 5 && divergeWindow.length >= 3) {
        const convSpread = Math.max(...convergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const divSpread = Math.max(...divergeWindow.map(x => Math.max(x.ma5, x.ma10, x.ma20) - Math.min(x.ma5, x.ma10, x.ma20)));
        const recentUp = divergeWindow.slice(-3).every((x, idx, arr) => idx === 0 || (x.ma5 > arr[idx - 1].ma5));
        if (convSpread < 1.0 && divSpread > convSpread * 1.5 && recentUp && cur.ma5 > cur.ma10 && cur.ma10 > cur.ma20) {
            patterns.push({ name: '粘合向上发散', signal: 'bull', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
        const recentDown = divergeWindow.slice(-3).every((x, idx, arr) => idx === 0 || (x.ma5 < arr[idx - 1].ma5));
        if (convSpread < 1.0 && divSpread > convSpread * 1.5 && recentDown && cur.ma5 < cur.ma10 && cur.ma10 < cur.ma20) {
            patterns.push({ name: '粘合向下发散', signal: 'bear', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
    }
    // ⑨ 上山爬坡形
    const climbWindow = ma5.slice(10).map((v, idx) => ({ ma5: ma5[idx + 10], ma10: ma10[idx + 10], ma20: ma20[idx + 10] })).filter(x => x.ma5 !== null && x.ma10 !== null && x.ma20 !== null);
    if (climbWindow.length >= 8) {
        const allUp = climbWindow.every((x, idx, arr) => idx === 0 || (x.ma5 > arr[idx - 1].ma5 && x.ma10 > arr[idx - 1].ma10 && x.ma20 > arr[idx - 1].ma20));
        if (allUp) {
            patterns.push({ name: '上山爬坡形', signal: 'bull', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
        const allDown = climbWindow.every((x, idx, arr) => idx === 0 || (x.ma5 < arr[idx - 1].ma5 && x.ma10 < arr[idx - 1].ma10 && x.ma20 < arr[idx - 1].ma20));
        if (allDown) {
            patterns.push({ name: '下山滑坡形', signal: 'bear', numbers: [toNum(cur.ma5), toNum(cur.ma10), toNum(cur.ma20), latestNum] });
        }
    }
    return { patterns, maData: { series: recent, ma5, ma10, ma20, currentValues: cur } };
}

// 彩种配置（与 extension.js 一致）
const LOTTERY_TYPES = {
    pl3: {
        name: '排列三', file: 'pl3.json',
        positions: [
            { label: '百', pick: (h) => h.num[0] },
            { label: '十', pick: (h) => h.num[1] },
            { label: '个', pick: (h) => h.num[2] }
        ]
    },
    pl5: {
        name: '排列五', file: 'pl5.json',
        positions: [
            { label: '万', pick: (h) => h.num[0] },
            { label: '千', pick: (h) => h.num[1] },
            { label: '百', pick: (h) => h.num[2] },
            { label: '十', pick: (h) => h.num[3] },
            { label: '个', pick: (h) => h.num[4] }
        ]
    },
    dlt: {
        name: '大乐透', file: 'latest.json',
        positions: [
            { label: '前1', pick: (h) => h.front[0] },
            { label: '前2', pick: (h) => h.front[1] },
            { label: '前3', pick: (h) => h.front[2] },
            { label: '前4', pick: (h) => h.front[3] },
            { label: '前5', pick: (h) => h.front[4] },
            { label: '后1', pick: (h) => h.back[0] },
            { label: '后2', pick: (h) => h.back[1] }
        ]
    },
    ssq: {
        name: '双色球', file: 'ssq.json',
        positions: [
            { label: '红1', pick: (h) => h.red[0] },
            { label: '红2', pick: (h) => h.red[1] },
            { label: '红3', pick: (h) => h.red[2] },
            { label: '红4', pick: (h) => h.red[3] },
            { label: '红5', pick: (h) => h.red[4] },
            { label: '红6', pick: (h) => h.red[5] },
            { label: '蓝', pick: (h) => h.blue[0] }
        ]
    }
};

async function main() {
    const type = process.argv[2] || 'pl3';
    const backtestCount = parseInt(process.argv[3] || '50');
    const cfg = LOTTERY_TYPES[type];
    if (!cfg) {
        console.error('未知彩种:', type);
        process.exit(1);
    }

    const DATA_DIR = path.join(__dirname, '..', 'data');
    const filePath = path.join(DATA_DIR, cfg.file);

    // 如果数据文件不存在，先爬取
    if (!fs.existsSync(filePath)) {
        console.log('数据文件不存在，开始爬取 ' + cfg.name + ' ...');
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        await crawler.crawlOne(type, DATA_DIR, 500);
        console.log('爬取完成');
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    const history = (json.history || []).slice().reverse(); // 旧→新

    if (history.length < 22) {
        console.error('数据不足（需要 ≥22 期，当前 ' + history.length + '）');
        process.exit(1);
    }

    console.log('');
    console.log('========================================');
    console.log('  均线形态识别回测 - ' + cfg.name);
    console.log('========================================');
    console.log('总历史期数:', history.length);
    console.log('回测期数:', Math.min(backtestCount, history.length - 21));
    console.log('');

    // 回测：对最近 backtestCount 期逐期回测
    // 对于第 t 期（目标期），用 history[0 .. t-1] 作为"已知数据"
    // detectMAPatterns 会自动取最后 20 期，即 history[t-20 .. t-1]
    // 然后对比第 t 期的实际开奖号码
    const startPos = 21; // 至少需要 21 期才能开始回测（20期数据 + 1期目标）
    const endPos = history.length;
    const actualBacktest = Math.min(backtestCount, endPos - startPos);

    // 统计汇总
    let totalPosTests = 0;       // 总位号测试次数
    let bullHitCount = 0;        // 看涨号码命中次数
    let bullTotalCount = 0;      // 看涨号码总个数（去重后）
    let bearHitCount = 0;        // 看跌号码命中次数（应该越少越好）
    let bearTotalCount = 0;      // 看跌号码总个数
    let posWithSignal = 0;       // 有信号的位数
    let posBullOnly = 0;         // 纯看涨的位数
    let posBearOnly = 0;         // 纯看跌的位数
    let posMixed = 0;            // 多空交织的位数
    let bullOnlyHitByLatest = 0; // 纯看涨位：下期号码 == 最新号码（趋势延续）
    let bullOnlyTrendUp = 0;     // 纯看涨位：下期号码 > 上期号码（确实涨了）
    let bullOnlyTotal = 0;       // 纯看涨位总数
    let bearOnlyTrendDown = 0;   // 纯看跌位：下期号码 < 上期号码（确实跌了）
    let bearOnlyTotal = 0;       // 纯看跌位总数

    // 最近 10 期详细记录
    const recentDetails = [];

    for (let t = endPos - actualBacktest; t < endPos; t++) {
        const targetPeriod = history[t];
        const knownHistory = history.slice(0, t); // 不含目标期
        const prevPeriod = history[t - 1];

        // 对每位识别形态
        const posResults = [];
        for (let pos = 0; pos < cfg.positions.length; pos++) {
            const series = knownHistory.map(h => cfg.positions[pos].pick(h));
            const result = detectMAPatterns(series);
            posResults.push({
                label: cfg.positions[pos].label,
                patterns: result.patterns,
                latestNum: series[series.length - 1], // "当前最新"（其实是目标期的上一期）
                targetNum: cfg.positions[pos].pick(targetPeriod) // 目标期实际号码
            });
        }

        // 统计这一期
        const periodDetail = {
            period: targetPeriod.period,
            drawNums: cfg.positions.map((p, i) => posResults[i].targetNum),
            positions: []
        };

        posResults.forEach(pr => {
            totalPosTests++;
            const bullNums = [];
            const bearNums = [];
            pr.patterns.forEach(p => {
                if (p.numbers && p.numbers.length > 0) {
                    p.numbers.forEach(n => {
                        if (p.signal === 'bull') { if (bullNums.indexOf(n) === -1) bullNums.push(n); }
                        else { if (bearNums.indexOf(n) === -1) bearNums.push(n); }
                    });
                }
            });

            const hasBull = bullNums.length > 0;
            const hasBear = bearNums.length > 0;
            const hasSignal = hasBull || hasBear;

            if (hasSignal) posWithSignal++;
            if (hasBull && !hasBear) posBullOnly++;
            if (hasBear && !hasBull) posBearOnly++;
            if (hasBull && hasBear) posMixed++;

            // 看涨号码命中统计
            bullNums.forEach(n => {
                bullTotalCount++;
                if (n === pr.targetNum) bullHitCount++;
            });
            // 看跌号码命中统计
            bearNums.forEach(n => {
                bearTotalCount++;
                if (n === pr.targetNum) bearHitCount++;
            });

            // 趋势判断准确性
            if (hasBull && !hasBear) {
                bullOnlyTotal++;
                if (pr.targetNum === pr.latestNum) bullOnlyHitByLatest++;
                if (pr.targetNum > pr.latestNum) bullOnlyTrendUp++;
            }
            if (hasBear && !hasBull) {
                bearOnlyTotal++;
                if (pr.targetNum < pr.latestNum) bearOnlyTrendDown++;
            }

            periodDetail.positions.push({
                label: pr.label,
                targetNum: pr.targetNum,
                latestNum: pr.latestNum,
                bullNums: bullNums,
                bearNums: bearNums,
                bullHit: bullNums.indexOf(pr.targetNum) !== -1,
                bearHit: bearNums.indexOf(pr.targetNum) !== -1
            });
        });

        if (t >= endPos - 10) {
            recentDetails.push(periodDetail);
        }
    }

    // 输出结果
    console.log('========== 回测结果 ==========');
    console.log('');
    console.log('【整体统计】');
    console.log('  回测期数: ' + actualBacktest);
    console.log('  位号测试总数: ' + totalPosTests + ' (=' + actualBacktest + '期 × ' + cfg.positions.length + '位)');
    console.log('  有信号的位数: ' + posWithSignal + ' (' + (posWithSignal / totalPosTests * 100).toFixed(1) + '%)');
    console.log('    其中 纯看涨: ' + posBullOnly + ' 位');
    console.log('    其中 纯看跌: ' + posBearOnly + ' 位');
    console.log('    其中 多空交织: ' + posMixed + ' 位');
    console.log('');
    console.log('【看涨号码命中（优选号码是否包含开奖号）】');
    console.log('  看涨号码总数(含重复): ' + bullTotalCount);
    console.log('  命中次数: ' + bullHitCount);
    console.log('  命中率: ' + (bullTotalCount > 0 ? (bullHitCount / bullTotalCount * 100).toFixed(1) : '0') + '%');
    console.log('  说明: 每位平均给 ' + (bullTotalCount / Math.max(posWithSignal, 1)).toFixed(1) + ' 个优选号码，10 个号中选 ' + (bullTotalCount / Math.max(posWithSignal, 1)).toFixed(1) + ' 个，随机命中率应约 ' + (bullTotalCount / Math.max(posWithSignal, 1) / 10 * 100).toFixed(1) + '%');
    console.log('');
    console.log('【看跌号码命中（避开号码是否误包含开奖号）】');
    console.log('  看跌号码总数(含重复): ' + bearTotalCount);
    console.log('  误中次数: ' + bearHitCount);
    console.log('  误中率: ' + (bearTotalCount > 0 ? (bearHitCount / bearTotalCount * 100).toFixed(1) : '0') + '%');
    console.log('  说明: 误中率越低越好，说明避开的号码确实没开出');
    console.log('');
    console.log('【趋势方向准确性】');
    console.log('  纯看涨位 总数: ' + bullOnlyTotal);
    console.log('    其中 下期号码>上期(确实涨): ' + bullOnlyTrendUp + ' (' + (bullOnlyTotal > 0 ? (bullOnlyTrendUp / bullOnlyTotal * 100).toFixed(1) : 0) + '%)');
    console.log('    其中 下期号码=上期(持平): ' + bullOnlyHitByLatest + ' (' + (bullOnlyTotal > 0 ? (bullOnlyHitByLatest / bullOnlyTotal * 100).toFixed(1) : 0) + '%)');
    console.log('    涨或持平占比: ' + (bullOnlyTotal > 0 ? ((bullOnlyTrendUp + bullOnlyHitByLatest) / bullOnlyTotal * 100).toFixed(1) : 0) + '%');
    console.log('  纯看跌位 总数: ' + bearOnlyTotal);
    console.log('    其中 下期号码<上期(确实跌): ' + bearOnlyTrendDown + ' (' + (bearOnlyTotal > 0 ? (bearOnlyTrendDown / bearOnlyTotal * 100).toFixed(1) : 0) + '%)');
    console.log('');

    console.log('========== 最近 10 期详细 ==========');
    recentDetails.forEach(d => {
        console.log('');
        console.log('期号 ' + d.period + ' 开奖: ' + d.drawNums.join(' '));
        d.positions.forEach(p => {
            let line = '  ' + p.label + '位 开=' + p.targetNum + ' (上期=' + p.latestNum + ')';
            if (p.bullNums.length === 0 && p.bearNums.length === 0) {
                line += ' | 无信号';
            } else {
                if (p.bullNums.length > 0) {
                    line += ' | 优选[' + p.bullNums.join(',') + ']' + (p.bullHit ? ' ✅命中' : ' ❌未中');
                }
                if (p.bearNums.length > 0) {
                    line += ' | 避开[' + p.bearNums.join(',') + ']' + (p.bearHit ? ' ⚠️误中' : ' ✓正确避开');
                }
            }
            console.log(line);
        });
    });
    console.log('');
}

main().catch(e => {
    console.error('回测失败:', e);
    process.exit(1);
});
