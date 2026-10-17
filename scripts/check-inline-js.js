/**
 * 内联 JS 语法检查
 *
 * 背景：本项目的页面 HTML/CSS/JS 全部内联在 extension.js 的模板字符串中。
 * 若在模板字符串里误写单反斜杠转义（例如 `\n` 而非 `\\n`），
 * 模板字符串求值后会变成**真实换行**，使生成的 HTML 中 JS 字符串被截断，
 * 导致整个 <script> 块语法错误、页面所有交互失效（走势图/统计工具打不开）。
 * `node --check src/extension.js` 检查不到这类问题，故有此脚本。
 *
 * 用法：node scripts/check-inline-js.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'src', 'extension.js');
const src = fs.readFileSync(file, 'utf8');

// 记录模板字符串中"单反斜杠转义"出现的位置（这些会被求值成真实控制字符）
const suspicious = [];
function markSuspicious(offset, seq) {
    const line = src.slice(0, offset).split('\n').length;
    suspicious.push({ line: line, seq: seq });
}

/**
 * 模拟 JS 模板字符串的转义求值：
 *   \\  -> \      \n -> 真实换行      \t -> 真实制表符
 *   ${...} -> 0   （插值内容用占位符代替）
 * 这样得到的字符串就等价于"浏览器实际收到的内联 JS 代码"。
 */
function toGenerated(tpl, baseOffset) {
    let out = '';
    for (let i = 0; i < tpl.length; i++) {
        const ch = tpl[i];
        if (ch === '\\') {
            const nx = tpl[i + 1];
            if (nx === '\\') { out += '\\'; i++; continue; }
            if (nx === 'n') { markSuspicious(baseOffset + i, '\\n'); out += '\n'; i++; continue; }
            if (nx === 't') { markSuspicious(baseOffset + i, '\\t'); out += '\t'; i++; continue; }
            if (nx === 'r') { markSuspicious(baseOffset + i, '\\r'); out += '\r'; i++; continue; }
            if (nx === "'") { out += "'"; i++; continue; }
            if (nx === '"') { out += '"'; i++; continue; }
            if (nx === '`') { out += '`'; i++; continue; }
            if (nx === '$') { out += '$'; i++; continue; }
            if (nx === 'u' || nx === 'x') { out += '\\' + nx; i++; continue; } // 保留原样，语义等价
            out += nx === undefined ? '' : nx;
            i++;
            continue;
        }
        if (ch === '$' && tpl[i + 1] === '{') {
            let depth = 1;
            i += 2;
            while (i < tpl.length && depth > 0) {
                if (tpl[i] === '{') depth++;
                else if (tpl[i] === '}') depth--;
                i++;
            }
            i--;
            out += '0';
            continue;
        }
        out += ch;
    }
    return out;
}

const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
let m;
let blockNo = 0;
let failCount = 0;
const checked = [];

while ((m = re.exec(src)) !== null) {
    const inner = m[1];
    const innerStart = m.index + m[0].indexOf(inner);
    const startLine = src.slice(0, innerStart).split('\n').length;
    blockNo++;
    const code = toGenerated(inner, innerStart);
    checked.push({ no: blockNo, startLine: startLine, len: code.length });
    try {
        new vm.Script(code, { filename: 'inline-script-' + blockNo + '.js' });
    } catch (e) {
        failCount++;
        console.log('');
        console.log('❌ 第 ' + blockNo + ' 个 <script> 块语法错误（extension.js 第 ' + startLine + ' 行起）');
        console.log('   ' + e.message);
        const dumpFile = path.join(__dirname, '..', 'inline-bad-' + blockNo + '.js');
        fs.writeFileSync(dumpFile, code, 'utf8');
        console.log('   已导出生成代码：' + dumpFile);
        const stack = String(e.stack || '');
        const loc = stack.match(/inline-script-\d+\.js:(\d+)/);
        if (loc) {
            const badLine = parseInt(loc[1], 10);
            const lines = code.split('\n');
            const from = Math.max(0, badLine - 3);
            const to = Math.min(lines.length, badLine + 2);
            console.log('   ---- 生成代码第 ' + badLine + ' 行附近 ----');
            for (let i = from; i < to; i++) {
                console.log('   ' + (i + 1 === badLine ? '>> ' : '   ') + String(i + 1).padStart(5) + ' | ' + lines[i].slice(0, 200));
            }
        }
    }
}

console.log('');
console.log('扫描 extension.js：共 ' + blockNo + ' 个内联 <script> 块');
checked.forEach(function(c) {
    console.log('   #' + c.no + '  起始行 ' + c.startLine + '  生成代码 ' + c.len + ' 字符');
});

if (suspicious.length) {
    console.log('');
    console.log('⚠️ 检测到 ' + suspicious.length + ' 处模板字符串内的单反斜杠转义（会变成真实控制字符，请确认是否为笔误）：');
    const uniq = {};
    suspicious.forEach(function(s) {
        const k = s.line + ':' + s.seq;
        if (uniq[k]) return;
        uniq[k] = 1;
        console.log('   extension.js 第 ' + s.line + ' 行：' + s.seq + '  -> 建议写成 \\' + s.seq + ' 以输出字面转义序列');
    });
}

console.log('');
if (failCount) {
    console.log('❌ 检查未通过：' + failCount + ' 个 <script> 块存在语法错误，页面交互会整体失效。');
    process.exit(1);
} else {
    console.log('✅ 全部内联 JS 语法检查通过。');
}
