const fs = require('fs');
let code = fs.readFileSync('src/extension.js', 'utf8');

// 找到诊断版函数
const fnStart = code.indexOf('function getRoadAnalysisHtml(');
let fnEnd = code.indexOf('\nfunction ', fnStart + 10);
if (fnEnd === -1) fnEnd = code.length;

console.log('替换函数位置:', fnStart, '-', fnEnd);

// 完整的新函数
const newFn = `/**
 * 生成012路分析 HTML 报告（完整版）
 */
function getRoadAnalysisHtml(result, cfg, N) {
    const R = result;
    const posCount = R.posCount || 3;
    const posNames = R.posNames || [];
    const posColors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6'];
    const roadColors = { 0: '#06b6d4', 1: '#8b5cf6', 2: '#f59e0b' };
    const roadNums = { 0: '0,3,6,9', 1: '1,4,7', 2: '2,5,8' };

    function getRoad(n) { return n % 3; }
    function isOdd(n) { return n % 2 === 1; }

    let html = \`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>012路趋势分析</title>
<style>
body{font-family:'Microsoft YaHei',sans-serif;background:#0f172a;color:#e2e8f0;padding:16px}
.card{background:#1e293b;border-radius:10px;padding:16px;margin:14px 0}
h1{text-align:center;font-size:20px;color:#38bdf8;margin-bottom:18px}
h2{font-size:16px;color:#818cf8;margin:22px 0 12px;padding-left:10px;border-left:4px solid #6366f1}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#334155;padding:8px 6px;color:#cbd5e1}
td{padding:7px 6px;text-align:center;border-bottom:1px solid #1e293b}
.road-cell{display:inline-block;width:24px;height:24px;line-height:24px;border-radius:50%;color:white;font-size:11px;font-weight:bold}
.r0{background:#06b6d4}.r1{background:#8b5cf6}.r2{background:#f59e0b}
.copy-btn{background:#6366f1;color:white;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:11px;transition:all .2s}
.copy-btn:hover{transform:scale(1.05)}.copy-btn.copied{background:#10b981}
.copy-all-btn{background:#f59e0b;color:white;border:none;padding:8px 18px;border-radius:8px;font-size:13px;cursor:pointer;margin:10px 0}
.copy-all-btn.copied{background:#10b981}
.tag-hot{background:#ef4444;color:white;padding:2px 8px;border-radius:4px;font-size:11px}
.tag-warm{background:#f59e0b;color:white;padding:2px 8px;border-radius:4px;font-size:11px}
.insight-box{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:14px;margin:12px}
</style></head><body>
<h1>🛤️ \${cfg.name} 012路趋势分析 (\${N}期)</h1>

<h2>一、各位012路基础分布</h2>
<div style="display:grid;grid-template-columns:repeat(\${posCount},1fr);gap:14px">
`;

    // 第一部分：基础分布
    for (let p = 0; p < posCount; p++) {
        html += \`<div class="card"><h3 style="color:\${posColors[p]};margin-bottom:12px">\${posNames[p]}位 012路分布</h3>
<table><tr><th>路别</th><th>号码</th><th>出现次数</th><th>占比</th></tr>\`;
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            const pct = ((s.total / N) * 100).toFixed(1);
            html += \`<tr><td>\${r}路</td><td>\${roadNums[r]}</td><td>\${s.total}</td><td>\${pct}%</td></tr>\`;
        }
        html += \`</table></div>\`;
    }

    html += \`</div>

<h2>二、分段趋势演变</h2>
<div class="card"><table>
<tr><th rowspan="2">位置</th>\`;

    R.segData.forEach(seg => {
        html += \`<th colspan="3">\${seg.name}<br/><small>\${seg.count}期</small></th>\`;
    });
    
    html += \`</tr><tr>\`;
    R.segData.forEach(() => { html += '<th>0路</th><th>1路</th><th>2路</th>'; });
    html += '</tr>';

    for (let p = 0; p < posCount; p++) {
        html += \`<tr style="color:\${posColors[p]};font-weight:bold"><td>\${posNames[p]}位</td>\`;
        R.segData.forEach(seg => {
            for (let r = 0; r <= 2; r++) html += \`<td>\${seg.roads[p][r]}%</td>\`;
        });
        html += '</tr>';
    }
    html += '</table></div>';

    // 第三部分：奇偶比
    html += \`<h2>三、012路内奇偶比分析</h2>
<div style="display:grid;grid-template-columns:repeat(\${posCount},1fr);gap:14px">\`;
    
    for (let p = 0; p < posCount; p++) {
        html += \`<div class="card"><h3 style="color:\${posColors[p]}">\${posNames[p]}位 奇偶详情</h3>
<table><tr><th>路别</th><th>总次</th><th>奇数</th><th>偶数</th><th>奇占比</th></tr>\`;
        for (let r = 0; r <= 2; r++) {
            const s = R.roadStats[p][r];
            const oddPct = s.total > 0 ? ((s.odd / s.total) * 100).toFixed(1) : '0.0';
            html += \`<tr><td>\${r}路</td><td>\${s.total}</td><td>\${s.odd}</td><td>\${s.even}</td><td>\${oddPct}%</td></tr>\`;
        }
        html += '</table></div>';
    }
    html += '</div>';

    // 第四部分：遗漏
    html += \`<h2>四、遗漏与连出分析</h2>
<div style="display:grid;grid-template-columns:repeat(\${posCount},1fr);gap:14px">\`;
    
    for (let p = 0; p < posCount; p++) {
        html += \`<div class="card"><h3 style="color:\${posColors[p]}">\${posNames[p]}位 遗漏状态</h3>
<table><tr><th>路别</th><th>当前遗漏</th><th>平均遗漏</th><th>最大遗漏</th><th>状态</th></tr>\`;
        for (let r = 0; r <= 2; r++) {
            const m = R.missData[p][r];
            let statusTag = '正常';
            if (m.current >= m.max * 0.9) statusTag = '⚠极值';
            else if (m.current > parseFloat(m.avg) * 2) statusTag = '超漏';
            else if (m.current === 0) statusTag = '刚出';
            
            const tagClass = statusTag === '⚠极值' || statusTag === '超漏' ? 'tag-warm' : '';
            html += \`<tr><td>\${r}路</td><td>\${m.current}</td><td>\${m.avg}</td><td>\${m.max}</td><td class="\${tagClass}">\${statusTag}</td></tr>\`;
        }
        html += '</table></div>';
    }
    html += '</div>';

    // 第五部分：组合形态
    html += \`<h2>五、012路组合形态统计（TOP热/冷）</h2>
<div class="card"><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">\`;
    
    const maxComboCount = R.combos.length > 0 ? R.combos[0][1] : 1;
    R.combos.slice(0, 15).forEach(([combo, count]) => {
        const pct = ((count / N) * 100).toFixed(2);
        const ratio = count / maxComboCount;
        let itemClass = ratio >= 0.7 ? 'hot' : ratio <= 0.25 ? '' : '';
        const tag = ratio >= 0.7 ? '★热' : ratio <= 0.25 ? '☆冷' : '';
        
        html += \`<span style="background:\${itemClass ? '#334155' : '#1e293b'};padding:10px 16px;border-radius:8px;text-align:center;\${itemClass ? 'border:1px solid #ef4444' : 'border:1px solid #475569'}">
<span style="font-family:monospace;font-size:16px;font-weight:bold">\${combo}</span><br/>
<span style="font-size:11px;color:#94a3b8">\${count}次(\${pct}%) \${tag}</span>
</span>\`;
    });

    html += '</div></div>';

    // 第六部分：走势图
    html += \`<h2>六、最近30期详细走势</h2>
<div class="card" style="overflow-x:auto"><table>
<tr><th>期号</th>\`;
    for (let p = 0; p < posCount; p++) html += \`<th>\${posNames[p]}位<br/>(号|路|奇偶)</th>\`;
    html += '<th>路组合</th></tr>';

    R.recentTrend.slice(0, 30).forEach(item => {
        html += \`<tr><td>\${item.period}</td>\`;
        item.nums.forEach(n => {
            html += \`<td>\${n.val}|<span class="road-cell r\${n.road}">\${n.road}</span>|\${n.odd?'奇':'偶'}</td>\`;
        });
        html += '<td>';
        item.roadCombo.split('').forEach(r => html += \`<span class="road-cell r\${r}">\${r}</span>\`);
        html += '</td></tr>';
    });
    html += '</table></div>';

    // 第七部分：预测推荐
    html += \`<h2>七、下期预测参考</h2>
<div style="display:grid;grid-template-columns:repeat(\${posCount},1fr);gap:14px">\`;
    
    for (let p = 0; p < posCount; p++) {
        html += \`<div class="card" style="border-left:4px solid \${posColors[p]}">
<h3 style="color:\${posColors[p]};margin-bottom:12px">\${posNames[p]}位推荐</h3>
<div style="display:flex;gap:10px;flex-wrap:wrap">\`;

        const advice = R.trendAdvice[p];
        const recommendations = [];
        for (let r = 0; r <= 2; r++) recommendations.push({ road: r, ...advice[r] });
        recommendations.sort((a, b) => a.miss - b.miss);
        
        for (let i = 0; i < Math.min(2, recommendations.length); i++) {
            const rec = recommendations[i];
            const label = i === 0 ? '首选' : '次选';
            html += \`<div style="flex:1;min-width:120px;background:#334155;padding:12px;border-radius:8px;text-align:center">
<div style="font-size:11px;color:#94a3b8">\${label}路</div>
<div style="font-size:22px;font-weight:bold;color:\${roadColors[rec.road]}">\${rec.road}路</div>
<div style="font-size:10px;color:#94a3b8">遗漏\${rec.miss}(均\${rec.avgMiss})</div>
</div>\`;
        }

        html += '</div></div>';
    }

    html += '</div>';

    // 综合推荐形态
    html += \`<div class="insight-box" style="margin-top:16px">
<strong style="color:#a78bfa">🎯 综合推荐 - 012路组合形态：</strong> \`;
    R.combos.slice(0, 3).forEach(([combo, count], idx) => {
        const stars = idx === 0 ? '⭐' : idx === 1 ? '🌟' : '✨';
        html += \`\${stars} <strong>\${combo}</strong>(\${count}次,\${((count/N)*100).toFixed(1)}%) &nbsp;&nbsp;\`;
    });
    html += '</div>';

    // ========== 第八部分：智能号码推荐 + 复制功能 ==========
    if (R.complexRec && R.singleRec) {
        html += \`
<h2>八、🎲 智能号码推荐</h2>

<!-- 复式推荐 -->
<div class="card" style="border-left:4px solid #f59e0b">
<h3 style="color:#f59e0b;font-size:15px;margin-bottom:14px">📋 复式推荐（多规格可选）</h3>
<div style="display:grid;grid-template-columns:repeat(\${Math.min(R.complexRec.length,4)},1fr);gap:14px">
\`;

        const sizeLabels = { 2: '精简', 3: '标准', 4: '扩展', 5: '全覆盖' };
        const sizeColors = { 2: '#38bdf8', 3: '#a78bfa', 4: '#f59e0b', 5: '#ef4444' };

        R.complexRec.forEach((rec) => {
            const label = sizeLabels[rec.size] || rec.size + '码';
            const color = sizeColors[rec.size] || '#94a3b8';
            const copyBase64 = Buffer.from(rec.copyText).toString('base64');

            html += \`
<div style="background:#334155;border-radius:8px;padding:14px;border-top:3px solid \${color}">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
<span style="font-weight:bold;color:\${color}">\${label}复式 (\${size}*\\${size}\${posCount===3?'':'×'+posCount+'位'})</span>
<div style="display:flex;align-items:center;gap:8px">
<span class="tag-hot">\${rec.count}注</span>
<button class="copy-btn" data-copy="\${copyBase64}" onclick="copyFromData(this)">📋 复制</button>
</div></div>
<div style="text-align:center;font-family:monospace;font-size:\${posCount>3?16:20}px;font-weight:bold;padding:12px;background:#1e293b;border-radius:6px;letter-spacing:\${posCount>3?'2':'4'}px">\${rec.formula}</div>
<div style="font-size:11px;color:#94a3b8;line-height:1.8;margin-top:10px">
\`;
            for (let p = 0; p < posCount; p++) {
                html += \`<div>\${posNames[p]}位: <span style="color:\${posColors[p]}">\${rec.nums[p].join(', ')}</span></div>\`;
            }
            html += '</div></div>';
        });

        html += '</div></div>';

        // 精选单注
        html += \`
<div class="card" style="border-left:4px solid #ef4444;margin-top:14px">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
<h3 style="color:#ef4444;font-size:15px;margin:0">🏆 精选单注推荐</h3>
<span style="font-size:11px;color:#94a3b8">基于五维评分+形态匹配+和值优化</span>
</div>
<div style="text-align:right;margin-bottom:10px">
<button class="copy-all-btn" id="copyAllSingleBtn" onclick="copyAllSingles()">📋 复制全部单注</button>
<span id="singlesData" data-singles="\${R.singleRec.map(item => item.combo.join('')).join('\\n')}"></span>
</div>
<table style="font-size:13px">
<tr style="background:#334155"><th width="50">排名</th><th width="100">号码</th><th width="80">012路</th><th width="70">和值</th><th width="80">综合分</th></tr>
\`;

        R.singleRec.forEach((item, idx) => {
            const comboStr = item.combo.join('');
            const roadStr = item.combo.map(n => getRoad(n)).join('');
            const sumVal = item.combo.reduce((a, b) => a + b, 0);
            const rankTag = idx === 0 ? '<span class="tag-hot">TOP1</span>' : idx < 3 ? '<span class="tag-warm">TOP' + (idx+1) + '</span>' : (idx+1);
            const rowBg = idx % 2 === 0 ? '' : 'style="background:rgba(51,65,85,.3)"';
            const comboB64 = Buffer.from(comboStr).toString('base64');

            html += \`<tr \${rowBg}>
<td style="text-align:center;font-weight:bold">\${rankTag}</td>
<td style="text-align:center;font-family:monospace;font-size:16px;font-weight:bold;color:#38bdf8;letter-spacing:3px">
\${comboStr}
<button class="copy-btn" style="margin-left:6px;padding:2px 8px;font-size:10px" data-copy="\${comboB64}" onclick="copySingle(this)">复制</button>
</td>
<td style="text-align:center">\`;
            roadStr.split('').forEach(r => html += \`<span class="road-cell r\${r}" style="width:22px;height:22px;font-size:10px;line-height:22px">\${r}</span>\`);
            html += \`</td>
<td style="text-align:center;font-weight:bold;color:#f59e0b">\${sumVal}</td>
<td style="text-align:center;color:#10b981;font-weight:bold">\${item.finalScore.toFixed(3)}</td>
</tr>\`;
        });

        html += '</table></div>';
    }

    html += \`
<small style="color:#94a3b8;display:block;margin-top:15px;text-align:center">数据范围：\${R.firstPeriod} ~ \${R.latestPeriod} | 分析期数：\${N}期</small>
<div style="text-align:center;margin:20px 0 15px;padding:15px;color:#64748b;font-size:11px;border-top:1px solid #334155">
🛤️ 012路趋势分析 | \${cfg.name} | 数据驱动 · 智能分析
</div>

<script>
function decodeBase64(s){try{return atob(s)}catch(e){return s}}
function copyFromData(btn){
    var t=decodeBase64(btn.getAttribute('data-copy'));
    try{acquireVsCodeApi().postMessage({command:'copy',text:t})}catch(e){}
    btn.innerHTML='✅ 已复制';btn.classList.add('copied');
    setTimeout(function(){btn.innerHTML='📋 复制';btn.classList.remove('copied')},1500)
}
function copySingle(btn){
    var t=decodeBase64(btn.getAttribute('data-copy'));
    try{acquireVsCodeApi().postMessage({command:'copy',text:t})}catch(e){}
    btn.innerHTML='✅ 已复制';btn.classList.add('copied');
    setTimeout(function(){btn.innerHTML='复制';btn.classList.remove('copied')},1500)
}
function copyAllSingles(){
    var btn=document.getElementById('copyAllSingleBtn');
    var el=document.getElementById('singlesData');
    if(el){try{acquireVsCodeApi().postMessage({command:'copy',text:el.getAttribute('data-singles')})}catch(e){}}
    if(btn){btn.innerHTML='✅ 已复制';btn.classList.add('copied');setTimeout(function(){btn.innerHTML='📋 复制全部单注';btn.classList.remove('copied')},1500)}
}
</script>
</body></html>\`;

    return html;
}

`;

code = code.substring(0, fnStart) + newFn + code.substring(fnEnd);
fs.writeFileSync('src/extension.js', code, 'utf8');
console.log('✅ 完整版 HTML 函数已恢复！');
