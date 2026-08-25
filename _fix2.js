#!/usr/bin/env node
// 删除旧的乱码版本 getDailyQuotes（保留第一个好的版本）
const fs = require('fs');
const f = 'd:/0.Y003H/Plugin/src/extension.js';
let c = fs.readFileSync(f, 'utf-8');

// 找第二个 getDailyQuotes（旧的乱码版本）
const first = c.indexOf('function getDailyQuotes()');
const second = c.indexOf('function getDailyQuotes()', first + 1);
if (second === -1) { console.log('只找到一个，无需修复'); process.exit(0); }

// 找第二个函数结束位置（下一个空行后的}）
const endMarker = '\n}\n';
const end = c.indexOf(endMarker, second) + endMarker.length;

c = c.substring(0, second) + c.substring(end);
fs.writeFileSync(f, c, 'utf-8');
console.log('Done. Removed second getDailyQuotes. New size:', c.length);
