/**
 * 梅花易数 · 生辰八字 核心算法（纯计算，不依赖 DOM / vscode）
 *
 * 本文件被两处复用，请保持「纯 ES5、无 DOM、无 require」的写法：
 *   1) Node 端：extension.js 通过 require('./bazi') 调用（八字起卦推号面板在扩展侧计算）
 *   2) Webview 端：extension.js 读取本文件源码文本，注入到页面的 <script> 中执行
 */

// ===== 梅花易数 · 生辰八字起卦选号 =====
// 农历数据表 1900-2100：低4位=闰月月份(0无闰)，0x10000=闰月大小，0x8000~0x8 依次表示正~腊月大小(1为30天)
var BZ_LUNAR = [0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
0x0d520];
var BZ_TERM = [0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758];
var BZ_TERM_BASE = Date.UTC(1900, 0, 6, 2, 5, 0);
var BZ_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
var BZ_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
var BZ_GAN_WX = ['木', '木', '火', '火', '土', '土', '金', '金', '水', '水'];
var BZ_ZHI_WX = ['水', '土', '木', '木', '土', '火', '火', '土', '金', '金', '土', '水'];
var BZ_JIE_ZHI = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0]; // 小寒→丑、立春→寅 …… 大雪→子（对应 sTermInfo 偶数下标）
var BZ_JIE_NAME = ['小寒', '立春', '惊蛰', '清明', '立夏', '芒种', '小暑', '立秋', '白露', '寒露', '立冬', '大雪'];
// 先天卦数 1乾 2兑 3离 4震 5巽 6坎 7艮 8坤
var BZ_GUA_NAME = ['', '乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
var BZ_GUA_SYM = ['', '☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷'];
var BZ_GUA_YAO = ['', '111', '110', '101', '100', '011', '010', '001', '000']; // 爻序：初→上
var BZ_GUA_WX = ['', '金', '金', '火', '木', '木', '水', '土', '土'];
var BZ_GUA_HOUTIAN = ['', 6, 7, 9, 3, 4, 1, 8, 2];
var BZ_WX_ORDER = ['金', '水', '木', '火', '土'];
var BZ_WX_TAIL = { '金': [4, 9], '水': [1, 6], '木': [3, 8], '火': [2, 7], '土': [5, 0] };
var BZ_GUA64 = ['乾为天', '天泽履', '天火同人', '天雷无妄', '天风姤', '天水讼', '天山遁', '天地否',
'泽天夬', '兑为泽', '泽火革', '泽雷随', '泽风大过', '泽水困', '泽山咸', '泽地萃',
'火天大有', '火泽睽', '离为火', '火雷噬嗑', '火风鼎', '火水未济', '火山旅', '火地晋',
'雷天大壮', '雷泽归妹', '雷火丰', '震为雷', '雷风恒', '雷水解', '雷山小过', '雷地豫',
'风天小畜', '风泽中孚', '风火家人', '风雷益', '巽为风', '风水涣', '风山渐', '风地观',
'水天需', '水泽节', '水火既济', '水雷屯', '水风井', '坎为水', '水山蹇', '水地比',
'山天大畜', '山泽损', '山火贲', '山雷颐', '山风蛊', '山水蒙', '艮为山', '山地剥',
'地天泰', '地泽临', '地火明夷', '地雷复', '地风升', '地水师', '地山谦', '坤为地'];
function bzLeapMonth(y) { return BZ_LUNAR[y - 1900] & 0xf; }
function bzLeapDays(y) { return bzLeapMonth(y) ? ((BZ_LUNAR[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function bzMonthDays(y, m) { return (BZ_LUNAR[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function bzYearDays(y) {
    var sum = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) sum += (BZ_LUNAR[y - 1900] & i) ? 1 : 0;
    return sum + bzLeapDays(y);
}
// 农历 → 公历（1900-2100）
function bzLunar2Solar(y, m, d, isLeap) {
    var offset = 0, i;
    for (i = 1900; i < y; i++) offset += bzYearDays(i);
    var leap = bzLeapMonth(y);
    for (i = 1; i < m; i++) {
        offset += bzMonthDays(y, i);
        if (leap > 0 && i === leap) offset += bzLeapDays(y);
    }
    if (isLeap && leap === m) offset += bzMonthDays(y, m);
    offset += d - 1;
    var dt = new Date(Date.UTC(1900, 0, 31) + offset * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
// 儒略日 → 用于日柱（干支序号：0=甲子）
function bzJdn(y, m, d) {
    var a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
function bzTermDate(y, n) {
    var off = 525948.76 * (y - 1900) + BZ_TERM[n];
    var dt = new Date(BZ_TERM_BASE + off * 60000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function bzCmpDate(a, b) { return (a.y - b.y) || (a.m - b.m) || (a.d - b.d); }
// 求某公历日的月令：返回 { jieIdx, zhi }（jieIdx 为 12 节顺序，0=小寒/丑月）
function bzMonthOrder(solar) {
    var cands = [{ t: bzTermDate(solar.y - 1, 22), jie: 11 }], k; // 上一年大雪 → 子月
    for (k = 0; k < 12; k++) cands.push({ t: bzTermDate(solar.y, k * 2), jie: k });
    cands.push({ t: bzTermDate(solar.y + 1, 0), jie: 0 }); // 次年小寒 → 丑月
    var best = null;
    for (k = 0; k < cands.length; k++) {
        if (bzCmpDate(cands[k].t, solar) <= 0) {
            if (!best || bzCmpDate(cands[k].t, best.t) >= 0) best = cands[k];
        }
    }
    return best;
}
// 四柱排盘：公历日期 + 时辰地支序号(0=子) → 干支
function bzFourPillars(solar, hourZhi) {
    var term2 = bzTermDate(solar.y, 2); // 立春
    var yearY = bzCmpDate(solar, term2) >= 0 ? solar.y : solar.y - 1;
    var yIdx = ((yearY - 4) % 60 + 60) % 60;
    var mo = bzMonthOrder(solar);
    var mZhi = BZ_JIE_ZHI[mo.jie];
    var yStem = yIdx % 10;
    var yinStem = (yStem % 5) * 2 + 2;
    var mStem = (yinStem + ((mZhi - 2 + 12) % 12)) % 10;
    var dIdx = (bzJdn(solar.y, solar.m, solar.d) + 49) % 60;
    var dStem = dIdx % 10;
    var subStem = (dStem % 5) * 2;
    var hStem = (subStem + hourZhi) % 10;
    return {
        solar: solar, yearY: yearY, jieIdx: mo.jie,
        year: BZ_GAN[yIdx % 10] + BZ_ZHI[yIdx % 12],
        month: BZ_GAN[mStem] + BZ_ZHI[mZhi],
        day: BZ_GAN[dStem] + BZ_ZHI[dIdx % 12],
        hour: BZ_GAN[hStem] + BZ_ZHI[hourZhi],
        yIdx: yIdx, mStem: mStem, mZhi: mZhi, dIdx: dIdx, dStem: dStem, hStem: hStem,
        yStem: yStem, hourZhi: hourZhi
    };
}
// 五行统计（天干 + 地支，各计 1）
function bzWxCount(fp) {
    var c = { '金': 0, '水': 0, '木': 0, '火': 0, '土': 0 };
    c[BZ_GAN_WX[fp.yIdx % 10]]++;
    c[BZ_GAN_WX[fp.mStem]]++;
    c[BZ_GAN_WX[fp.dStem]]++;
    c[BZ_GAN_WX[fp.hStem]]++;
    c[BZ_ZHI_WX[fp.yIdx % 12]]++;
    c[BZ_ZHI_WX[fp.mZhi]]++;
    c[BZ_ZHI_WX[fp.dIdx % 12]]++;
    c[BZ_ZHI_WX[fp.hourZhi]]++;
    return c;
}
// 梅花易数起卦：农历年支数 + 月 + 日 + 时支数
function bzGua(lunarY, lunarM, lunarD, hourZhi) {
    var nian = ((lunarY - 4) % 12 + 12) % 12 + 1; // 子=1 …… 亥=12
    var shi = hourZhi + 1;
    var s1 = nian + lunarM + lunarD;
    var s2 = s1 + shi;
    var up = s1 % 8; if (up === 0) up = 8;
    var dn = s2 % 8; if (dn === 0) dn = 8;
    var mv = s2 % 6; if (mv === 0) mv = 6;
    var yao = (BZ_GUA_YAO[dn] + BZ_GUA_YAO[up]).split(''); // 初 → 上
    var bian = yao.slice();
    bian[mv - 1] = bian[mv - 1] === '1' ? '0' : '1';
    function pat2gua(p) { for (var i = 1; i <= 8; i++) if (BZ_GUA_YAO[i] === p) return i; return 8; }
    var huUp = pat2gua(yao.slice(2, 5).join('')), huDn = pat2gua(yao.slice(1, 4).join(''));
    var biUp = pat2gua(bian.slice(3, 6).join('')), biDn = pat2gua(bian.slice(0, 3).join(''));
    return {
        nian: nian, shi: shi, s1: s1, s2: s2, up: up, dn: dn, mv: mv,
        yao: yao, bian: bian,
        ben: BZ_GUA64[(up - 1) * 8 + (dn - 1)],
        huUp: huUp, huDn: huDn, hu: BZ_GUA64[(huUp - 1) * 8 + (huDn - 1)],
        biUp: biUp, biDn: biDn, bianName: BZ_GUA64[(biUp - 1) * 8 + (biDn - 1)]
    };
}
// 确定性伪随机（Park-Miller），保证同一八字每次结果一致
function bzSeedSeq(seed, count) {
    var s = Math.floor(Math.abs(seed)) % 2147483647;
    if (s <= 0) s += 2147483646;
    var out = [];
    for (var i = 0; i < count; i++) { s = (s * 16807) % 2147483647; out.push(s / 2147483647); }
    return out;
}
// 五行生克
var BZ_SHENG = { '木': '火', '火': '土', '土': '金', '金': '水', '水': '木' };
var BZ_KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };
var BZ_WX_CLS = { '金': 'jin', '水': 'shui', '木': 'mu', '火': 'huo', '土': 'tu' };
function bzRelation(ti, yong) {
    if (ti === yong) return { t: '体用比和', d: '同气相求，谋事顺遂', cls: 'sim-ok' };
    if (BZ_SHENG[yong] === ti) return { t: '用生体', d: '外力相助，最为有利', cls: 'sim-ok' };
    if (BZ_SHENG[ti] === yong) return { t: '体生用', d: '我方付出，略耗心神', cls: '' };
    if (BZ_KE[ti] === yong) return { t: '体克用', d: '事可为，须主动争取', cls: '' };
    return { t: '用克体', d: '受制于外，宜守不宜进', cls: 'sim-bad' };
}

// Node 端导出（浏览器中 module 未定义，自动跳过）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        BZ_LUNAR: BZ_LUNAR, BZ_TERM: BZ_TERM, BZ_TERM_BASE: BZ_TERM_BASE,
        BZ_GAN: BZ_GAN, BZ_ZHI: BZ_ZHI, BZ_GAN_WX: BZ_GAN_WX, BZ_ZHI_WX: BZ_ZHI_WX,
        BZ_JIE_ZHI: BZ_JIE_ZHI, BZ_JIE_NAME: BZ_JIE_NAME,
        BZ_GUA_NAME: BZ_GUA_NAME, BZ_GUA_SYM: BZ_GUA_SYM, BZ_GUA_YAO: BZ_GUA_YAO,
        BZ_GUA_WX: BZ_GUA_WX, BZ_GUA_HOUTIAN: BZ_GUA_HOUTIAN,
        BZ_WX_ORDER: BZ_WX_ORDER, BZ_WX_TAIL: BZ_WX_TAIL, BZ_GUA64: BZ_GUA64,
        BZ_SHENG: BZ_SHENG, BZ_KE: BZ_KE, BZ_WX_CLS: BZ_WX_CLS,
        bzLeapMonth: bzLeapMonth, bzLeapDays: bzLeapDays, bzMonthDays: bzMonthDays, bzYearDays: bzYearDays,
        bzLunar2Solar: bzLunar2Solar, bzJdn: bzJdn, bzTermDate: bzTermDate, bzCmpDate: bzCmpDate,
        bzMonthOrder: bzMonthOrder, bzFourPillars: bzFourPillars, bzWxCount: bzWxCount,
        bzGua: bzGua, bzSeedSeq: bzSeedSeq, bzRelation: bzRelation
    };
}
