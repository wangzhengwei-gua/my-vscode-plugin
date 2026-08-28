/**
 * 快乐8号码合理性分析脚本
 * 用法：node scripts/analyze_kl8.js [号码列表，空格或逗号分隔]
 * 示例：node scripts/analyze_kl8.js 4 6 11 12 14 15 17 18 19 20 21 22 27 29 32 33 41 42 45 46 66 67 69 70 71 76 79
 * 如果不传号码，默认使用 data/kl8.json 做整体统计分析
 */
const fs = require('fs');
const path = require('path');

// ===== 读取数据 =====
const DATA_FILE = path.join(__dirname, '..', 'data', 'kl8.json');
if (!fs.existsSync(DATA_FILE)) {
    console.error('❌ 未找到数据文件: ' + DATA_FILE);
    console.error('   请先在插件中执行"刷新彩票数据"爬取快乐8数据');
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
const history = data.history || []; // 最新在前
const TOTAL = history.length;
const latestPeriod = history[0] ? history[0].period : '—';

// ===== 解析用户号码 =====
const args = process.argv.slice(2);
let userNums = [];
if (args.length > 0) {
    userNums = args.join(' ').split(/[\s,，、]+/).map(s => parseInt(s)).filter(n => !isNaN(n) && n >= 1 && n <= 80);
    userNums = [...new Set(userNums)].sort((a, b) => a - b);
}
const hasUserNums = userNums.length > 0;

// ===== 号码统计 =====
// 每个号码：出现次数、当前遗漏、平均遗漏、最大遗漏、近N期次数
const stats = {};
for (let n = 1; n <= 80; n++) {
    const positions = []; // 出现位置（0=最新）
    for (let i = 0; i < TOTAL; i++) {
        if (history[i].num.indexOf(n) >= 0) positions.push(i);
    }
    let miss = TOTAL;
    if (positions.length > 0) miss = positions[0];
    // 平均遗漏 / 最大遗漏
    let avgMiss = 0, maxMiss = 0;
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
        count: positions.length,
        freq: TOTAL > 0 ? positions.length / TOTAL : 0,
        miss,
        avgMiss: Math.round(avgMiss * 10) / 10,
        maxMiss,
        count10: positions.filter(p => p < 10).length,
        count30: positions.filter(p => p < 30).length,
        count50: positions.filter(p => p < 50).length,
        lastPeriod: positions.length > 0 ? history[positions[0]].period : '从未出现'
    };
}

// ===== 工具函数 =====
function pad(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }
function layerName(miss, avg) {
    if (miss === 0) return '热(上期开出)';
    if (miss <= 2) return '温热';
    if (miss <= 5) return '温冷';
    if (miss <= avg * 1.5) return '正常';
    if (miss <= avg * 2) return '偏冷';
    return '极冷';
}

console.log('========================================');
console.log('  快乐8 号码合理性分析');
console.log('========================================');
console.log('数据来源: 500.com');
console.log('总期数  : ' + TOTAL + ' 期（最新 ' + latestPeriod + ' 期）');
console.log('');

if (hasUserNums) {
    // ===== 用户号码分析 =====
    console.log('用户号码（' + userNums.length + '个）:');
    console.log('  ' + userNums.join(', '));
    console.log('');

    // 1. 基础统计
    console.log('【1. 每个号码的基础统计】');
    console.log('------------------------------------------------');
    console.log(pad('号码', 6) + pad('出现', 6) + pad('频率%', 7) + pad('当前遗漏', 9) + pad('平均遗漏', 9) + pad('最大遗漏', 9) + '  近10/30/50期  最近出现');
    console.log('------------------------------------------------');
    for (const n of userNums) {
        const s = stats[n];
        console.log(pad(n, 6) + pad(s.count, 6) + pad((s.freq * 100).toFixed(1), 7) + pad(s.miss, 9) + pad(s.avgMiss, 9) + pad(s.maxMiss, 9) +
            '  ' + pad(s.count10, 2) + '/' + pad(s.count30, 2) + '/' + pad(s.count50, 2) + '    ' + s.lastPeriod);
    }
    console.log('');

    // 2. 合理性评分
    console.log('【2. 合理性评分】');
    console.log('------------------------------------------------');
    let totalScore = 0;
    const problems = [];
    const goodPoints = [];
    for (const n of userNums) {
        const s = stats[n];
        let score = 50; // 基础分
        const notes = [];
        // 频率合理性：期望频率 = 20/80 = 25%
        const expected = 0.25;
        if (s.freq >= expected * 1.2) { score += 15; notes.push('出现频率高于均值'); }
        else if (s.freq >= expected * 0.9) { score += 8; notes.push('频率接近均值'); }
        else if (s.freq >= expected * 0.6) { score -= 5; notes.push('出现偏少'); }
        else { score -= 15; notes.push('出现频率过低'); }
        // 当前遗漏合理性
        if (s.miss === 0) { score += 10; notes.push('上期刚开出(热号)'); }
        else if (s.miss <= s.avgMiss * 0.5) { score += 10; notes.push('遗漏低于平均(偏热)'); }
        else if (s.miss <= s.avgMiss * 1.2) { score += 5; notes.push('遗漏接近平均'); }
        else if (s.miss <= s.avgMiss * 2) { score -= 5; notes.push('遗漏偏高'); }
        else { score -= 15; notes.push('严重遗漏(冷号)'); }
        // 近30期活跃度
        if (s.count30 >= 9) { score += 5; notes.push('近30期活跃'); }
        else if (s.count30 <= 3) { score -= 5; notes.push('近30期低迷'); }
        // 记录
        if (score >= 65) goodPoints.push(n + ':' + score + '分');
        if (score <= 40) problems.push(n + ':' + score + '分');
        totalScore += score;
        console.log(pad(n, 5) + ' → ' + pad(score, 3) + '分  (' + notes.join('；') + ')');
    }
    console.log('------------------------------------------------');
    const avgScore = Math.round(totalScore / userNums.length);
    console.log('平均评分: ' + avgScore + ' 分（0-100）');
    console.log('');
    console.log('【3. 汇总判断】');
    console.log('  表现好的号码(' + (goodPoints.length) + '): ' + (goodPoints.join(', ') || '无'));
    console.log('  风险较高的号码(' + (problems.length) + '): ' + (problems.join(', ') || '无'));
    console.log('');

    // 4. 分布分析
    console.log('【4. 分布分析】');
    const ranges = [[1,20],[21,40],[41,60],[61,80]];
    console.log('  区间分布:');
    for (const [lo, hi] of ranges) {
        const cnt = userNums.filter(n => n >= lo && n <= hi).length;
        const bar = '█'.repeat(cnt);
        console.log('    ' + pad(lo + '-' + hi, 8) + ': ' + cnt + ' 个  ' + bar);
    }
    // 奇偶
    const odd = userNums.filter(n => n % 2 === 1).length;
    const even = userNums.length - odd;
    console.log('  奇偶比  : ' + odd + ' : ' + even);
    // 大小（1-40小，41-80大）
    const big = userNums.filter(n => n > 40).length;
    const small = userNums.length - big;
    console.log('  大小比  : ' + small + ' : ' + big + '（1-40小 / 41-80大）');
    // 连号
    const sorted = userNums.slice().sort((a, b) => a - b);
    const links = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1] + 1) cur.push(sorted[i]);
        else {
            if (cur.length >= 2) links.push(cur.join('-'));
            cur = [sorted[i]];
        }
    }
    if (cur.length >= 2) links.push(cur.join('-'));
    console.log('  连号组  : ' + (links.join('、') || '无'));
    console.log('');

    // 5. 建议
    console.log('【5. 选号建议】');
    const recNums = userNums.filter(n => {
        const s = stats[n];
        const score = 50 +
            (s.freq >= 0.25 * 1.2 ? 15 : s.freq >= 0.25 * 0.9 ? 8 : s.freq >= 0.25 * 0.6 ? -5 : -15) +
            (s.miss === 0 ? 10 : s.miss <= s.avgMiss * 0.5 ? 10 : s.miss <= s.avgMiss * 1.2 ? 5 : s.miss <= s.avgMiss * 2 ? -5 : -15) +
            (s.count30 >= 9 ? 5 : s.count30 <= 3 ? -5 : 0);
        return score >= 60;
    }).sort((a, b) => {
        // 按得分排序
        const sa = stats[a], sb = stats[b];
        const sc = n => 50 +
            (stats[n].freq >= 0.25 * 1.2 ? 15 : stats[n].freq >= 0.25 * 0.9 ? 8 : stats[n].freq >= 0.25 * 0.6 ? -5 : -15) +
            (stats[n].miss === 0 ? 10 : stats[n].miss <= stats[n].avgMiss * 0.5 ? 10 : stats[n].miss <= stats[n].avgMiss * 1.2 ? 5 : stats[n].miss <= stats[n].avgMiss * 2 ? -5 : -15) +
            (stats[n].count30 >= 9 ? 5 : stats[n].count30 <= 3 ? -5 : 0);
        return sc(b) - sc(a);
    });
    console.log('  推荐优先保留（评分≥60）: ' + (recNums.join(', ') || '无'));
    console.log('  建议剔除或谨慎（评分≤40）: ' + (problems.join(', ') || '无'));
    console.log('  说明: 遗漏极高的冷号虽有"回补"预期，但快乐8每期20/80=25%开出率，冷号中奖概率并未提高。');
    console.log('');
} else {
    // ===== 整体统计分析 =====
    console.log('【整体统计】未传入号码，以下为 80 个号码的整体分析');
    console.log('------------------------------------------------');
    const sortedByMiss = Object.keys(stats).map(Number).sort((a, b) => stats[b].miss - stats[a].miss);
    console.log('当前遗漏最大的 10 个号码（冷号）:');
    for (const n of sortedByMiss.slice(0, 10)) {
        const s = stats[n];
        console.log('   ' + pad(n, 4) + ' 遗漏 ' + pad(s.miss, 4) + ' 期 | 平均 ' + s.avgMiss + ' | 最大 ' + s.maxMiss + ' | 近30期 ' + s.count30);
    }
    console.log('');
    const sortedByFreq = Object.keys(stats).map(Number).sort((a, b) => stats[b].freq - stats[a].freq);
    console.log('出现频率最高的 10 个号码（热号）:');
    for (const n of sortedByFreq.slice(0, 10)) {
        const s = stats[n];
        console.log('   ' + pad(n, 4) + ' 出现 ' + s.count + ' 次 (' + (s.freq * 100).toFixed(1) + '%) | 当前遗漏 ' + s.miss + ' | 近30期 ' + s.count30);
    }
    console.log('');
    // 分层统计
    console.log('【遗漏分层】');
    const layers = [[0,0,'热号'],[1,2,'温热'],[3,5,'温冷'],[6,10,'冷号'],[11,20,'极冷'],[21,999,'冰封']];
    for (const [lo, hi, name] of layers) {
        const nums = [];
        for (let n = 1; n <= 80; n++) {
            if (stats[n].miss >= lo && stats[n].miss <= hi) nums.push(n);
        }
        console.log('   ' + name + '（遗漏 ' + lo + '-' + (hi === 999 ? '∞' : hi) + '）: ' + nums.length + ' 个  ' + (nums.length > 0 ? nums.join(', ') : ''));
    }
    console.log('');
    console.log('用法提示: node scripts/analyze_kl8.js 4 6 11 12 ... 可分析指定号码');
}
