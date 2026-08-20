/**
 * 排三傅里叶变换 - 人为注入周期规律验证
 *
 * 思路：在真实200期号码基础上，叠加一个固定周期正弦波，再clip到0-9
 * 然后看傅里叶能否：
 *   1. 检测到注入的周期频率
 *   2. 利用它预测下一期（预测命中率是否高于纯随机）
 */

const fs = require('fs');

// ============ DFT ============
function dft(signal) {
    const N = signal.length;
    const result = [];
    for (let k = 0; k < N; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
            const angle = -2 * Math.PI * k * n / N;
            re += signal[n] * Math.cos(angle);
            im += signal[n] * Math.sin(angle);
        }
        const magnitude = Math.sqrt(re * re + im * im) / N;
        const phase = Math.atan2(im, re);
        result.push({ k, re, im, magnitude, phase, freq: k / N });
    }
    return result;
}

// ============ 加载数据 ============
const raw = JSON.parse(fs.readFileSync('d:/0.Y003H/Plugin/data/pl3.json', 'utf-8'));
const history = (raw.history || []).slice().reverse();

console.log('数据期数:', history.length);
console.log('最新期:', history[history.length - 1].period);

const N = 200;
const recent = history.slice(-N);
console.log('分析样本量:', N, '期\n');

// ============ 注入参数 ============
// 注入周期 T（比如每7期一个周期），幅度A
const INJECT_T = 7;      // 周期=7期
const INJECT_A = 2.0;    // 幅度=2（叠加±2的范围）
const INJECT_K = N / INJECT_T;  // 对应DFT的k = N/T

console.log('===== 注入参数 =====');
console.log('注入周期 T =', INJECT_T, '期');
console.log('注入幅度 A =', INJECT_A);
console.log('期望DFT峰值 k =', INJECT_K.toFixed(2), '（如果落在整数上最理想）');
console.log('注：N=200, T=7 时 k≈28.57，DFT最近桶是 k=29 (T≈6.9) 或 k=28 (T≈7.14)');
console.log();

// ============ 对每个位注入并分析 ============
const posLabels = ['百位', '十位', '个位'];

// 记录用于回测
const injectedHistory = []; // 每元素 {orig:[a,b,c], injected:[a,b,c]}

for (let p = 0; p < 3; p++) {
    const origSignal = recent.map(h => h.num[p]);

    // 注入：signal[n] = orig[n] + A*sin(2π*n/T)
    const injectedSignal = origSignal.map((v, n) => {
        const s = v + INJECT_A * Math.sin(2 * Math.PI * n / INJECT_T);
        return Math.max(0, Math.min(9, Math.round(s)));
    });

    // 保存用于回测
    injectedHistory.push(injectedSignal.slice());

    console.log('========== ' + posLabels[p] + '位 ==========');

    // 基本统计
    const meanO = origSignal.reduce((a, b) => a + b, 0) / N;
    const meanI = injectedSignal.reduce((a, b) => a + b, 0) / N;
    console.log('原始均值:', meanO.toFixed(3), '注入后均值:', meanI.toFixed(3));
    console.log('原始样本(前15):', origSignal.slice(0, 15).join(','));
    console.log('注入样本(前15):', injectedSignal.slice(0, 15).join(','));

    // 差异
    const diffs = origSignal.map((v, i) => injectedSignal[i] - v);
    const diffMean = diffs.reduce((a, b) => a + b, 0) / N;
    const diffVar = diffs.reduce((a, b) => a + (b - diffMean) ** 2, 0) / N;
    console.log('注入扰动均值:', diffMean.toFixed(3), '标准差:', Math.sqrt(diffVar).toFixed(3));

    // DFT
    const spectrum = dft(injectedSignal);
    const dc = spectrum[0];
    const ac = spectrum.slice(1);

    // 期望峰值桶
    const kTarget = Math.round(INJECT_K);
    const expectedBins = [kTarget, kTarget + 1, N - kTarget, N - kTarget - 1].filter((v, i, a) => a.indexOf(v) === i);

    console.log('\n期望峰值桶:', expectedBins.join(', '));
    console.log('这些桶的幅度:');
    for (const k of expectedBins) {
        if (k > 0 && k < N) {
            const c = spectrum[k];
            console.log('  k=' + k + ' (T=' + (N / k).toFixed(2) + '期): magnitude=' + c.magnitude.toFixed(4) + ', phase=' + (c.phase * 180 / Math.PI).toFixed(1) + '°');
        }
    }

    // TOP10
    const sorted = ac.slice().sort((a, b) => b.magnitude - a.magnitude);
    console.log('\nTOP10 主频:');
    console.log('排名 | k  | T(期)  | 幅度     | 相位(度) | 能量%');
    const totalEnergy = ac.reduce((s, c) => s + c.magnitude ** 2, 0);
    sorted.slice(0, 10).forEach((c, i) => {
        const T = (N / c.k).toFixed(2);
        const pct = (c.magnitude ** 2 / totalEnergy * 100);
        console.log(
            String(i + 1).padStart(4) + ' | ' +
            String(c.k).padStart(2) + ' | ' +
            T.padStart(7) + ' | ' +
            c.magnitude.toFixed(4) + ' | ' +
            String((c.phase * 180 / Math.PI).toFixed(1)).padStart(8) + ' | ' +
            pct.toFixed(2) + '%'
        );
    });

    // 注入周期是否在TOP？
    const topK = new Set(sorted.slice(0, 5).map(c => c.k));
    const hit = expectedBins.some(k => topK.has(k));
    console.log('\n注入周期是否进入TOP5:', hit ? '是 ✓' : '否 ✗');

    if (hit) {
        console.log('→ 傅里叶成功检测到注入的周期');
    } else {
        console.log('→ 傅里叶未能将注入周期排进TOP5（可能被噪声淹没）');
    }
    console.log();
}

// ============ 回测预测对比 ============
console.log('\n\n========== 回测预测对比 ==========');

// 纯傅里叶预测函数：用最近N期信号预测下一期
function fourierPredict(signal) {
    const n = signal.length;
    const spectrum = dft(signal);
    const dc = spectrum[0];
    const ac = spectrum.slice(1);
    const sorted = ac.slice().sort((a, b) => b.magnitude - a.magnitude);
    const topK = sorted.slice(0, 5);

    let pred = dc.magnitude;
    for (const c of topK) {
        pred += 2 * c.magnitude * Math.cos(2 * Math.PI * c.k * n / n + c.phase);
    }
    return Math.max(0, Math.min(9, Math.round(pred)));
}

// 注入函数
function injectPeriod(signal, T, A) {
    return signal.map((v, i) => {
        const s = v + A * Math.sin(2 * Math.PI * i / T);
        return Math.max(0, Math.min(9, Math.round(s)));
    });
}

const testCount = 50;
let correctOrig = 0, correctInjected = 0, total = 0;
const perPosCorrectOrig = [0, 0, 0];
const perPosCorrectInj = [0, 0, 0];

console.log('回测期数:', testCount, '每位独立，共', testCount * 3, '次');

for (let t = history.length - testCount; t < history.length; t++) {
    if (t - N < 0) continue;
    const train = history.slice(t - N, t);
    const target = history[t].num;

    for (let p = 0; p < 3; p++) {
        const origSignal = train.map(h => h.num[p]);
        const injectedSignal = injectPeriod(origSignal, INJECT_T, INJECT_A);

        const predOrig = fourierPredict(origSignal);
        const predInjected = fourierPredict(injectedSignal);

        if (predOrig === target[p]) { correctOrig++; perPosCorrectOrig[p]++; }
        if (predInjected === target[p]) { correctInjected++; perPosCorrectInj[p]++; }
        total++;
    }
}

console.log('\n--- 结果对比 ---');
console.log('原始数据    命中:', correctOrig, '/', total, '=', (correctOrig / total * 100).toFixed(2) + '%');
console.log('注入后      命中:', correctInjected, '/', total, '=', (correctInjected / total * 100).toFixed(2) + '%');
console.log('随机基准       :                              10.00%');
console.log();
console.log('分位对比:');
posLabels.forEach((label, p) => {
    console.log('  ' + label + ': 原始=' + perPosCorrectOrig[p] + '/' + testCount + '=' +
        (perPosCorrectOrig[p] / testCount * 100).toFixed(1) + '%  注入=' +
        perPosCorrectInj[p] + '/' + testCount + '=' + (perPosCorrectInj[p] / testCount * 100).toFixed(1) + '%');
});

console.log('\n--- 结论 ---');
const origPct = correctOrig / total * 100;
const injPct = correctInjected / total * 100;
if (injPct > origPct + 2) {
    console.log('注入后命中率提升', (injPct - origPct).toFixed(2), '个百分点');
    console.log('→ 在存在人造周期的情况下，傅里叶预测能力增强');
    console.log('→ 但注意：真实排三没有这种周期，注入只是人为构造');
} else if (injPct > origPct) {
    console.log('注入后命中率略升', (injPct - origPct).toFixed(2), '个百分点（不显著）');
} else {
    console.log('注入后命中率未提升甚至下降');
    console.log('→ 即使人为注入周期，傅里叶对离散0-9信号预测仍有限');
}

// ============ 理想情况验证：纯合成数据 ============
console.log('\n\n========== 理想验证：纯合成数据 ==========');
console.log('完全用数学函数生成0-9序列，验证傅里叶抓规律能力');
const T_ideal = 13;
const synthSignal = [];
for (let n = 0; n < N; n++) {
    // 信号 = 直流4.5 + 幅度3.5的T=13周期 + 小噪声
    const v = 4.5 + 3.5 * Math.sin(2 * Math.PI * n / T_ideal) + (Math.random() - 0.5) * 0.5;
    synthSignal.push(Math.max(0, Math.min(9, Math.round(v))));
}
console.log('合成周期 T =', T_ideal, '幅度=3.5');
console.log('合成样本(前20):', synthSignal.slice(0, 20).join(','));

const synthSpectrum = dft(synthSignal);
const synthAC = synthSpectrum.slice(1);
const synthSorted = synthAC.slice().sort((a, b) => b.magnitude - a.magnitude);
console.log('\nTOP5主频（应能抓到 T=' + T_ideal + '）:');
console.log('排名 | k  | T(期)  | 幅度     | 能量%');
const synthTotalE = synthAC.reduce((s, c) => s + c.magnitude ** 2, 0);
synthSorted.slice(0, 5).forEach((c, i) => {
    console.log(
        String(i + 1).padStart(4) + ' | ' +
        String(c.k).padStart(2) + ' | ' +
        (N / c.k).toFixed(2).padStart(7) + ' | ' +
        c.magnitude.toFixed(4) + ' | ' +
        (c.magnitude ** 2 / synthTotalE * 100).toFixed(2) + '%'
    );
});

// 理想预测：纯合成 + 注入周期已知
let synthCorrect = 0, synthTotal = 0;
for (let t = 50; t < N; t++) {
    const train = synthSignal.slice(0, t);
    const target = synthSignal[t];
    // 简单外推
    const sp = dft(train);
    const dc = sp[0];
    const ac = sp.slice(1);
    const sorted = ac.slice().sort((a, b) => b.magnitude - a.magnitude);
    const topK = sorted.slice(0, 5);
    let pred = dc.magnitude;
    for (const c of topK) {
        pred += 2 * c.magnitude * Math.cos(2 * Math.PI * c.k * t / train.length + c.phase);
    }
    pred = Math.max(0, Math.min(9, Math.round(pred)));
    if (pred === target) synthCorrect++;
    synthTotal++;
}
console.log('\n理想合成数据预测:', synthCorrect, '/', synthTotal, '=', (synthCorrect / synthTotal * 100).toFixed(2) + '%');
console.log('→ 在纯周期信号下傅里叶预测能力');
