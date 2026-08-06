/**
 * 大乐透智能精选 - 多维度筛选算法
 * 
 * 输入: 15+5复式 → 输出: 20组精选5+2单注
 * 
 * 维度:
 *   1. 遗漏值分析 (当前遗漏 vs 平均遗漏)
 *   2. 热态/冷态识别 (近期出现频率)
 *   3. 回归概率 (超漏后回归)
 *   4. 趋势走向 (上升/下降趋势)
 *   5. 奇偶比/大小比平衡
 *   6. 和值区间控制
 *   7. 连号/同尾号分布
 */

const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const RED_POOL = [5, 10, 11, 12, 13, 16, 18, 19, 20, 23, 24, 25, 26, 27, 28];
const BLUE_POOL = [3, 4, 5, 6, 10];
const TARGET_COUNT = 20; // 目标输出注数

// 加载历史数据
const dataPath = path.join(__dirname, '..', 'data', 'latest.json');
const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
const history = rawData.history || [];
const N = history.length;

console.log(`\n========================================`);
console.log(`  大乐透智能精选 v2.0`);
console.log(`  历史数据: ${N}期 (最新: ${history[0]?.period})`);
console.log(`  复式: 红${RED_POOL.length}+蓝${BLUE_POOL.length}`);
console.log(`========================================\n`);

// ========== 核心计算函数 ==========

/**
 * 计算单个号码的遗漏值
 */
function calcMiss(num, isBlue = false) {
    let miss = 0;
    for (let i = 0; i < N; i++) {
        const nums = isBlue ? history[i].back : history[i].front;
        if (nums.includes(num)) break;
        miss++;
    }
    return miss;
}

/**
 * 计算平均遗漏
 */
function calcAvgMiss(num, isBlue = false) {
    let misses = [];
    let currentMiss = 0;
    
    for (let i = 0; i < N; i++) {
        const nums = isBlue ? history[i].back : history[i].front;
        if (nums.includes(num)) {
            if (currentMiss > 0) misses.push(currentMiss);
            currentMiss = 0;
        } else {
            currentMiss++;
        }
    }
    // 当前遗漏也计入
    misses.push(currentMiss);
    
    return misses.reduce((a, b) => a + b, 0) / misses.length;
}

/**
 * 近N期出现频率
 */
function recentFreq(num, period, isBlue = false) {
    let count = 0;
    const len = Math.min(period, N);
    for (let i = 0; i < len; i++) {
        const nums = isBlue ? history[i].back : history[i].front;
        if (nums.includes(num)) count++;
    }
    return count / len;
}

/**
 * 遗漏趋势: 正=越来越冷, 负=越来越热
 */
function missTrend(num, window = 30, isBlue = false) {
    // 比较前window期的遗漏变化
    let pos1 = -1, pos2 = -1;
    for (let i = 0; i < N && (pos1 === -1 || pos2 === -1); i++) {
        const nums = isBlue ? history[i].back : history[i].front;
        if (nums.includes(num)) {
            if (i < window) pos2 = i;
            else if (pos1 === -1) pos1 = i;
        }
    }
    // 简化: 用近10期vs再前10期的频率差
    const freq1 = recentFreq(num, 10, isBlue);
    const freq2 = (() => {
        let c = 0;
        for (let i = 10; i < Math.min(20, N); i++) {
            const nums = isBlue ? history[i].back : history[i].front;
            if (nums.includes(num)) c++;
        }
        return c / Math.max(1, Math.min(10, N - 10));
    })();
    return freq1 - freq2;
}

// ========== 号码评分系统 ==========

function scoreRedNumber(num) {
    const miss = calcMiss(num, false);
    const avgMiss = calcAvgMiss(num, false);
    const freq5 = recentFreq(num, 5, false);  // 近5期
    const freq15 = recentFreq(num, 15, false); // 近15期
    const freq50 = recentFreq(num, 50, false); // 近50期
    const trend = missTrend(num, 30, false);
    
    let score = 0;
    let reasons = [];
    
    // 因子1: 回归分 (遗漏超过平均越多,回归概率越高)
    const missRatio = miss / avgMiss;
    if (missRatio > 2) { score += 25; reasons.push(`超漏回归(${miss}期)`); }
    else if (missRatio > 1.5) { score += 18; reasons.push(`高漏(${miss}期)`); }
    else if (missRatio > 1.2) { score += 12; reasons.push(`中高漏(${miss}期)`); }
    else if (missRatio > 0.8) { score += 6; reasons.push(`正常`); }
    else if (freq5 > 0) { score += 4; reasons.push(`热号持续`); }
    else { score += 8; reasons.push(`温号回补`); }
    
    // 因子2: 热态分 (近期活跃)
    if (freq5 >= 0.4) { score += 15; reasons.push('极热'); }
    else if (freq5 >= 0.2) { score += 10; reasons.push('热号'); }
    else if (freq15 <= 0.07 && miss > 10) { score += 12; reasons.push('冷号待开'); }
    
    // 因子3: 趋势分
    if (trend > 0.08) score -= 5;  // 变冷,降分
    else if (trend < -0.05) score += 8; // 变热,加分
    
    // 因子4: 上期邻号加分 (上期开出相邻号码)
    const lastFront = history[0]?.front || [];
    for (const n of lastFront) {
        if (Math.abs(n - num) === 1) { score += 5; reasons.push('邻号'); break; }
    }
    
    // 因子5: 重号加分 (上期开出)
    if (lastFront.includes(num)) { score += 6; reasons.push('重号'); }
    
    return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
}

function scoreBlueNumber(num) {
    const miss = calcMiss(num, true);
    const avgMiss = calcAvgMiss(num, true);
    const freq5 = recentFreq(num, 5, true);
    const freq15 = recentFreq(num, 15, true);
    
    let score = 0;
    let reasons = [];
    
    const missRatio = miss / avgMiss;
    if (missRatio > 2.5) { score += 28; reasons.push(`超漏回归(${miss}期)`); }
    else if (missRatio > 1.8) { score += 20; reasons.push(`高漏(${miss}期)`); }
    else if (missRatio > 1.2) { score += 14; reasons.push(`中漏(${miss}期)`); }
    else if (freq5 > 0) { score += 10; reasons.push('热蓝'); }
    else { score += 8; reasons.push('温蓝'); }
    
    // 上期篮球
    const lastBack = history[0]?.back || [];
    if (lastBack.includes(num)) { score += 5; reasons.push('重号'); }
    
    return { num, score, miss, avgMiss: +avgMiss.toFixed(1), freq5: +freq5.toFixed(2), reasons };
}

// ========== 组合评分 ==========

function scoreCombination(reds, blues) {
    let comboScore = 0;
    let details = {};
    
    // 1. 奇偶比 (理想: 2:3 或 3:2)
    const oddCount = reds.filter(n => n % 2 === 1).length;
    const evenCount = 5 - oddCount;
    if (oddCount >= 2 && evenCount >= 2) { comboScore += 15; details.oddEven = `${oddCount}:${evenCount}(优)`; }
    else { details.oddEven = `${oddCount}:${evenCount}`; }
    
    // 2. 大小比 (理想: 2:3 或 3:2, 以18为界)
    const bigCount = reds.filter(n => n > 18).length;
    const smallCount = 5 - bigCount;
    if (bigCount >= 2 && smallCount >= 2) { comboScore += 15; details.bigSmall = `${bigCount}:${smallCount}(优)`; }
    else { details.bigSmall = `${bigCount}:${smallCount}`; }
    
    // 3. 和值区间 (理想: 65-95)
    const sum = reds.reduce((a, b) => a + b, 0);
    if (sum >= 65 && sum <= 95) { comboScore += 20; details.sum = `${sum}(优)`; }
    else if (sum >= 55 && sum <= 105) { comboScore += 10; details.sum = `${sum}`; }
    else { details.sum = `${sum}(偏)`; }
    
    // 4. 连号奖励
    const sorted = [...reds].sort((a, b) => a - b);
    let consecutive = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i + 1] - sorted[i] === 1) consecutive++;
    }
    if (consecutive === 1) { comboScore += 8; details.consecutive = `1对连号`; }
    else if (consecutive >= 2) { comboScore += 5; details.consecutive = `${consecutive}对连号`; }
    else { details.consecutive = '无连号'; }
    
    // 5. 同尾号
    const tails = reds.map(n => n % 10);
    const uniqueTails = new Set(tails).size;
    if (uniqueTails <= 3) { comboScore -= 5; details.tail = `尾${uniqueTails}(密集)`; }
    else if (uniqueTails >= 4) { comboScore += 5; details.tail = `尾${uniqueTails}(散)`; }
    else { details.tail = `尾${uniqueTails}`; }
    
    // 6. 区间分布 (01-11, 12-22, 23-35)
    const zones = [0, 0, 0];
    for (const n of reds) {
        if (n <= 11) zones[0]++;
        else if (n <= 22) zones[1]++;
        else zones[2]++;
    }
    const zoneBalance = zones.filter(z => z >= 1).length;
    if (zoneBalance === 3) { comboScore += 12; details.zone = `三区有号(优)`; }
    else if (zoneBalance === 2) { comboScore += 5; details.zone = `两区`; }
    else { details.zone = `单区`; }
    
    // 7. AC值 (任意两数差值的去重数)
    const diffs = new Set();
    for (let i = 0; i < reds.length; i++) {
        for (let j = i + 1; j < reds.length; j++) {
            diffs.add(Math.abs(reds[i] - reds[j]));
        }
    }
    const acValue = diffs.size;
    if (acValue >= 7) { comboScore += 8; details.ac = `AC=${acValue}(优)`; }
    else if (acValue >= 5) { details.ac = `AC=${acValue}`; }
    else { details.ac = `AC=${acValue}(低)`; }
    
    // 8. 蓝球奇偶
    const blueOdd = blues.filter(b => b % 2 === 1).length;
    if (blueOdd === 1) { comboScore += 5; details.blueOE = `1奇1偶(优)`; }
    else { details.blueOE = blueOdd === 2 ? '全奇' : '全偶'; }
    
    return { comboScore, details };
}

// ========== 主逻辑 ==========

// 1. 评分所有红球
console.log('【红球评分】');
const redScores = RED_POOL.map(scoreRedNumber).sort((a, b) => b.score - a.score);
redScores.forEach(r => {
    console.log(`  ${String(r.num).padStart(2)}: ${r.score.toString().padStart(3)}分 | 遗漏:${r.miss}期(均${r.avgMiss}) | 近5期:${r.freq5} | ${r.reasons.join(',')}`);
});

// 2. 评分所有蓝球
console.log('\n【蓝球评分】');
const blueScores = BLUE_POOL.map(scoreBlueNumber).sort((a, b) => b.score - a.score);
blueScores.forEach(b => {
    console.log(`  ${b.num}: ${b.score.toString().padStart(3)}分 | 遗漏:${b.miss}期(均${b.avgMiss}) | 近5期:${b.freq5} | ${b.reasons.join(',')}`);
});

// 3. 生成候选组合并评分
console.log('\n' + '='.repeat(60));
console.log('开始生成精选组合...\n');

// 使用加权随机选择 + 组合优化
function weightedSelect(arr, count, exclude = []) {
    const available = arr.filter(x => !exclude.includes(x.num));
    if (available.length <= count) return available.map(x => x.num);
    
    // 权重 = score^2 (拉开差距)
    const weights = available.map(x => x.score * x.score);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    
    const selected = [];
    const remaining = available.map((x, i) => ({ ...x, weight: weights[i], index: i }));
    
    while (selected.length < count && remaining.length > 0) {
        const tw = remaining.reduce((a, b) => a + b.weight, 0);
        let r = Math.random() * tw;
        
        for (let i = 0; i < remaining.length; i++) {
            r -= remaining[i].weight;
            if (r <= 0) {
                selected.push(remaining[i].num);
                remaining.splice(i, 1);
                break;
            }
        }
    }
    
    return selected;
}

// 生成大量候选组合，取最优的20组
const candidates = [];
const MAX_CANDIDATES = 50000;

for (let iter = 0; iter < MAX_CANDIDATES; iter++) {
    // 选择红球 (带权重随机)
    const reds = weightedSelect(redScores, 5);
    // 选择蓝球
    const blues = weightedSelect(blueScores, 2);
    
    // 评分组合
    const { comboScore, details } = scoreCombination(reds, blues);
    
    // 单号得分之和
    const redTotalScore = reds.reduce((sum, n) => {
        const found = redScores.find(r => r.num === n);
        return sum + (found ? found.score : 0);
    }, 0);
    const blueTotalScore = blues.reduce((sum, n) => {
        const found = blueScores.find(b => b.num === n);
        return sum + (found ? found.score : 0);
    }, 0);
    
    const totalScore = redTotalScore + blueTotalScore * 1.5 + comboScore;
    
    candidates.push({
        reds: [...reds].sort((a, b) => a - b),
        blues: [...blues].sort((a, b) => a - b),
        totalScore,
        redTotalScore,
        blueTotalScore,
        comboScore,
        details
    });
}

// 排序并去重
candidates.sort((a, b) => b.totalScore - a.totalScore);

const seen = new Set();
const results = [];

for (const c of candidates) {
    const key = c.reds.join(',') + '|' + c.blues.join(',');
    if (!seen.has(key)) {
        seen.add(key);
        results.push(c);
        if (results.length >= TARGET_COUNT) break;
    }
}

// ========== 输出结果 ==========

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║                    🎯 精选20组单注                          ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  注号 |          红球           | 蓝球 | 总分 | 特征         ║');
console.log('╠══════════════════════════════════════════════════════════════╣');

results.forEach((r, idx) => {
    const redStr = r.reds.map(n => String(n).padStart(2)).join(' ');
    const blueStr = r.blues.map(n => String(n).padStart(2)).join(' ');
    const features = [
        r.details.oddEven,
        r.details.bigSmall,
        r.details.sum,
        r.details.consecutive,
        r.details.zone
    ].filter(Boolean).slice(0, 2).join(',');
    
    console.log(
        `║  ${String(idx + 1).padStart(2)}   | ${redStr} | ${blueStr}  | ${String(Math.round(r.totalScore)).padStart(4)} | ${features.padEnd(12)} ║`
    );
});

console.log('╚══════════════════════════════════════════════════════════════╝');

// 详细信息
console.log('\n【详细分析】');
results.slice(0, 5).forEach((r, idx) => {
    console.log(`\n--- 第${idx + 1}注 ---`);
    console.log(`红球: ${r.reds.join(',')} | 蓝球: ${r.blues.join(',')}`);
    console.log(`  单号分:红${Math.round(r.redTotalScore)} 蓝${Math.round(r.blueTotalScore)} | 组合分:${Math.round(r.comboScore)} | 总分:${Math.round(r.totalScore)}`);
    console.log(`  ${JSON.stringify(r.details)}`);
});

// 统计摘要
console.log('\n【统计摘要】');
const allReds = results.flatMap(r => r.reds);
const allBlues = results.flatMap(r => r.blues);
const redFreq = {};
const blueFreq = {};

for (const n of allReds) redFreq[n] = (redFreq[n] || 0) + 1;
for (const n of allBlues) blueFreq[n] = (blueFreq[n] || 0) + 1;

console.log('红球出现频率:');
Object.entries(redFreq)
    .sort((a, b) => b[1] - a[1])
    .forEach(([num, cnt]) => {
        const pct = ((cnt / TARGET_COUNT) * 100).toFixed(0);
        console.log(`  ${num}: ${cnt}次 (${pct}%) ${pct >= 40 ? '★核心' : pct >= 25 ? '☆热门' : ''}`);
    });

console.log('蓝球出现频率:');
Object.entries(blueFreq)
    .sort((a, b) => b[1] - a[1])
    .forEach(([num, cnt]) => {
        const pct = ((cnt / TARGET_COUNT) * 100).toFixed(0);
        console.log(`  ${num}: ${cnt}次 (${pct}%) ${pct >= 35 ? '★核心' : ''}`);
    });

// 输出可复制格式
console.log('\n' + '='.repeat(60));
console.log('【复制格式】');
results.forEach((r, idx) => {
    console.log(`${idx + 1}. ${r.reds.map(n => String(n).padStart(2, '0')).join(' ')} + ${r.blues.map(n => String(n).padStart(2, '0')).join(' ')}`);
});
