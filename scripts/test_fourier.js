/**
 * 排列三傅里叶变换验证
 * 对每位号码序列做DFT，看频谱是否有显著成分
 */
const fs = require('fs');

// DFT 实现
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

// 加载排三数据
const raw = JSON.parse(fs.readFileSync('d:/0.Y003H/Plugin/data/pl3.json', 'utf-8'));
const history = (raw.history || []).slice().reverse(); // 升序

console.log('数据期数:', history.length);
console.log('最新期:', history[history.length - 1].period, history[history.length - 1].date);
console.log('最早期:', history[0].period, history[0].date);

// 取最近N期做分析
const N = 200; // 用200期
const recent = history.slice(-N);
console.log('\n分析样本量:', N, '期');

// 每位号码序列
const posLabels = ['百位', '十位', '个位'];
for (let p = 0; p < 3; p++) {
    const signal = recent.map(h => h.num[p]);
    console.log('\n========== ' + posLabels[p] + '位 ==========');
    console.log('原始序列(前20):', signal.slice(0, 20).join(','));
    console.log('原始序列(后20):', signal.slice(-20).join(','));

    // 基本统计
    const mean = signal.reduce((a, b) => a + b, 0) / N;
    const variance = signal.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
    const std = Math.sqrt(variance);
    console.log('均值:', mean.toFixed(3), '标准差:', std.toFixed(3));

    // DFT
    const spectrum = dft(signal);

    // 去除直流分量(k=0)，分析交流频谱
    const dc = spectrum[0];
    const ac = spectrum.slice(1); // k=1..N-1
    console.log('\n直流分量(k=0): magnitude =', dc.magnitude.toFixed(4), '(=均值', dc.re.toFixed(3) + ')');

    // 按幅度排序，找TOP10主频
    const sorted = ac.slice().sort((a, b) => b.magnitude - a.magnitude);
    console.log('\nTOP10 主频成分:');
    console.log('排名 | k  | 频率    | 幅度     | 相位(度) | 占总能量%');
    let totalEnergy = ac.reduce((s, c) => s + c.magnitude ** 2, 0);
    sorted.slice(0, 10).forEach((c, i) => {
        const energyPct = (c.magnitude ** 2 / totalEnergy * 100);
        const phaseDeg = (c.phase * 180 / Math.PI).toFixed(1);
        console.log(
            String(i + 1).padStart(4) + ' | ' +
            String(c.k).padStart(2) + ' | ' +
            c.freq.toFixed(4) + ' | ' +
            c.magnitude.toFixed(4) + ' | ' +
            String(phaseDeg).padStart(8) + ' | ' +
            energyPct.toFixed(2) + '%'
        );
    });

    // 检验：如果最大幅度成分的能量占比 > 15%，说明有周期性
    const maxEnergyPct = (sorted[0].magnitude ** 2 / totalEnergy * 100);
    console.log('\n最大单一频率能量占比:', maxEnergyPct.toFixed(2) + '%');
    if (maxEnergyPct > 15) {
        console.log('→ 存在显著周期成分（>15%），可能有周期性规律');
    } else if (maxEnergyPct > 8) {
        console.log('→ 弱周期成分（8-15%），可能是噪声波动');
    } else {
        console.log('→ 能量分散（<8%），接近白噪声，无明显周期');
    }

    // 重建信号：只用TOP5主频重建，看与原始序列的差异
    const top5 = sorted.slice(0, 5);
    const reconstructed = [];
    for (let n = 0; n < N; n++) {
        let val = dc.magnitude; // 直流分量（已除以N，=均值）
        for (const c of top5) {
            val += 2 * c.magnitude * Math.cos(2 * Math.PI * c.k * n / N + c.phase);
        }
        reconstructed.push(val);
    }
    // 计算重建误差
    const errors = signal.map((s, i) => s - reconstructed[i]);
    const mse = errors.reduce((a, b) => a + b * b, 0) / N;
    const rmse = Math.sqrt(mse);
    console.log('\nTOP5频率重建:');
    console.log('  重建RMSE:', rmse.toFixed(3), '(原始标准差', std.toFixed(3) + ')');
    console.log('  解释方差比:', (((std * std - mse) / (std * std)) * 100).toFixed(2) + '%');
    console.log('  原始序列样本(后10):', signal.slice(-10).join(','));
    console.log('  重建序列样本(后10):', reconstructed.slice(-10).map(v => v.toFixed(1)).join(','));
}

// 关键验证：用傅里叶预测下一期
console.log('\n\n========== 傅里叶预测验证 ==========');
let correct = 0, total = 0;
const testCount = 50; // 回测50期
for (let t = history.length - testCount; t < history.length; t++) {
    const train = history.slice(t - N, t).map(h => h.num);
    const target = history[t].num;

    for (let p = 0; p < 3; p++) {
        const signal = train.map(row => row[p]);
        const spectrum = dft(signal);
        const dc = spectrum[0];

        // 用TOP5主频外推一期
        const ac = spectrum.slice(1);
        const sorted = ac.slice().sort((a, b) => b.magnitude - a.magnitude);
        const top5 = sorted.slice(0, 5);

        let pred = dc.magnitude; // 直流分量=均值
        const n = N; // 下一期是第N期
        for (const c of top5) {
            pred += 2 * c.magnitude * Math.cos(2 * Math.PI * c.k * n / N + c.phase);
        }
        const predRounded = Math.max(0, Math.min(9, Math.round(pred)));

        if (predRounded === target[p]) correct++;
        total++;
    }
}
console.log('回测期数:', testCount, '(每位独立预测，共', total, '次)');
console.log('严格命中:', correct, '/', total, '=', (correct / total * 100).toFixed(2) + '%');
console.log('随机基准: 10.00%');
console.log('结论:', correct / total > 0.12 ? '略高于随机（可能偶然）' : '接近随机，傅里叶无显著预测能力');