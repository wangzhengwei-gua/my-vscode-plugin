const fs = require('fs');
let code = fs.readFileSync('src/extension.js', 'utf8');

// 找到 getRoadAnalysisHtml 函数的开始和结束
const fnStart = code.indexOf('function getRoadAnalysisHtml(');
let fnEnd = code.indexOf('\nfunction ', fnStart + 10);
if (fnEnd === -1) fnEnd = code.indexOf('/**', fnStart + 10);

console.log('函数位置:', fnStart, '-', fnEnd);

// 最简诊断版本
const newFn = `/**
 * 生成012路分析 HTML 报告（诊断版）
 */
function getRoadAnalysisHtml(result, cfg, N) {
    let html = \`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>测试</title></head>
<body>
<h1>012路趋势分析 - \${cfg.name}</h1>
<p>数据范围：\${result.firstPeriod} ~ \${result.latestPeriod}</p>
<p>分析期数：\${N}期</p>
</body></html>\`;
    return html;
}

`;

code = code.substring(0, fnStart) + newFn + code.substring(fnEnd);
fs.writeFileSync('src/extension.js', code, 'utf8');
console.log('已替换为最简诊断版本');
