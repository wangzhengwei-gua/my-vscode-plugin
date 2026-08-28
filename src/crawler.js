const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 彩种配置（移植自 dlt-simulator/scripts/crawler.py）
const LOTTERY_SOURCES = {
    dlt: {
        name: '大乐透',
        url: 'https://datachart.500.com/dlt/history/newinc/history.php?limit={limit}&sort=0',
        referer: 'https://datachart.500.com/dlt/',
        encoding: 'utf-8',
        areas: [['front', 'cfont2', 5], ['back', 'cfont4', 2]],
        output: 'latest.json',
        limit: 500
    },
    ssq: {
        name: '双色球',
        url: 'https://datachart.500.com/ssq/history/newinc/history.php?limit={limit}&sort=0',
        referer: 'https://datachart.500.com/ssq/',
        encoding: 'utf-8',
        areas: [['red', 'cfont2', 6], ['blue', 'cfont4', 1]],
        output: 'ssq.json',
        limit: 500
    },
    pl3: {
        name: '排列三',
        url: 'https://datachart.500.com/pls/history/inc/history.php?limit={limit}&sort=0',
        referer: 'https://datachart.500.com/pls/',
        encoding: 'gb2312',
        areas: [['num', 'cfont2', 3]],
        output: 'pl3.json',
        limit: 500
    },
    pl5: {
        name: '排列五',
        url: 'https://datachart.500.com/plw/history/inc/history.php?limit={limit}&sort=0',
        referer: 'https://datachart.500.com/plw/',
        encoding: 'gb2312',
        areas: [['num', 'cfont2', 5]],
        output: 'pl5.json',
        limit: 500
    },
    fc3d: {
        name: '福彩3D',
        url: 'https://datachart.500.com/sd/history/inc/history.php?limit={limit}&sort=0',
        referer: 'https://datachart.500.com/sd/',
        encoding: 'gb2312',
        areas: [['num', 'cfont2', 3]],
        output: 'fc3d.json',
        limit: 500
    },
    kl8: {
        name: '快乐8',
        url: 'https://datachart.500.com/kl8/zoushi/newinc/jbzs_redblue.php?expect={limit}',
        referer: 'https://datachart.500.com/kl8/',
        encoding: 'gbk',
        // 快乐8走势图是"遗漏值表"：每行 = 期号 + 80 列（chartBall01 表示该期开出，其余显示遗漏值）
        rowPattern: /<tr[^>]*>[\s\S]*?<\/tr>/g,
        kl8Mode: true, // 使用快乐8专用解析
        output: 'kl8.json',
        limit: 100 // 500.com 快乐8接口 expect 参数最大支持 100 期
    }
};

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

/**
 * HTTP GET 请求，返回 Buffer
 */
function fetchBuffer(url, referer) {
    return new Promise((resolve, reject) => {
        const headers = Object.assign({}, HEADERS, { Referer: referer });
        const req = https.get(url, { headers, timeout: 15000 }, (resp) => {
            if (resp.statusCode !== 200) {
                reject(new Error('HTTP ' + resp.statusCode));
                return;
            }
            const chunks = [];
            resp.on('data', c => chunks.push(c));
            resp.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });
}

/**
 * 解码 Buffer 到字符串
 * gb2312 编码用 iconv-lite（如果没装则 fallback 到 latin1）
 */
function decodeBuffer(buf, encoding) {
    if (encoding === 'utf-8' || encoding === 'utf8') {
        return buf.toString('utf-8');
    }
    // gb2312：尝试用 iconv-lite，没有则用 latin1（号码都是数字，影响不大）
    try {
        const iconv = require('iconv-lite');
        return iconv.decode(buf, encoding);
    } catch (e) {
        // iconv-lite 不可用，用 latin1（数字和 ASCII 不受影响）
        return buf.toString('latin1');
    }
}

/**
 * 从行 HTML 中提取指定 css class 的号码
 */
function extractBalls(rowHtml, cssClass, expectedCount) {
    const cellPattern = new RegExp('<td[^>]*' + cssClass + '[^>]*>(.*?)</td>', 'g');
    const cells = [];
    let m;
    while ((m = cellPattern.exec(rowHtml)) !== null) {
        cells.push(m[1]);
    }
    let numbers = [];
    for (const cell of cells) {
        const nums = cell.match(/\d+/g);
        if (nums) {
            numbers = numbers.concat(nums.map(n => parseInt(n)));
        }
    }
    return numbers.slice(0, expectedCount);
}

/**
 * 提取期号和日期
 */
function extractPeriodAndDate(rowHtml) {
    // 去掉 HTML 注释
    const clean = rowHtml.replace(/<!--.*?-->/g, '');
    const allTds = [];
    const tdPattern = /<td[^>]*>([^<]+)<\/td>/g;
    let m;
    while ((m = tdPattern.exec(clean)) !== null) {
        allTds.push(m[1]);
    }

    let period = '';
    let date = '';
    for (let v of allTds) {
        v = v.trim();
        if (!v || v === '&nbsp;') continue;
        const dateMatch = v.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && !date) {
            date = dateMatch[1];
        } else if (/^\d{5,}$/.test(v) && !period) {
            period = v;
        }
    }
    return { period, date };
}

/**
 * 爬取一个彩种
 * @param {string} type - 彩种 key
 * @param {string} dataDir - 数据保存目录
 * @param {number} limit - 抓取期数
 * @returns {Promise<Object>} 爬取结果
 */
async function crawlOne(type, dataDir, limit) {
    const config = LOTTERY_SOURCES[type];
    if (!config) throw new Error('未知彩种: ' + type);

    const name = config.name;
    const effLimit = limit || config.limit;
    console.log(`[${name}] 开始爬取 (limit=${effLimit})...`);

    // 请求（带重试，最多3次，指数退避）
    const url = config.url.replace('{limit}', effLimit);
    let buf;
    const maxRetries = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            buf = await fetchBuffer(url, config.referer);
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
            console.warn(`[${name}] 第 ${attempt}/${maxRetries} 次请求失败: ${e.message}`);
            if (attempt < maxRetries) {
                // 指数退避：1s, 2s, 4s
                const delay = 1000 * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
                console.log(`[${name}] 等待 ${delay}ms 后重试...`);
            }
        }
    }
    if (lastErr) {
        // 友好错误提示
        let hint = '';
        if (/timeout|超时/i.test(lastErr.message)) hint = '（服务器响应慢，可稍后再试）';
        else if (/HTTP 4\d\d/.test(lastErr.message)) hint = '（请求被限制，请稍后再试）';
        else if (/HTTP 5\d\d/.test(lastErr.message)) hint = '（服务器异常，请稍后再试）';
        else if (/ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(lastErr.message)) hint = '（网络连接问题，请检查网络）';
        throw new Error(`${name} 请求失败: ${lastErr.message}${hint}`);
    }

    const html = decodeBuffer(buf, config.encoding);

    // 提取数据行
    const rowPattern = config.rowPattern || /<tr class="t_tr1">.*?<\/tr>/g;
    const rows = [];
    let m;
    while ((m = rowPattern.exec(html)) !== null) {
        rows.push(m[0]);
    }

    if (rows.length === 0) {
        throw new Error(`${name} 网页结构变化或无数据（未匹配到任何数据行，可能网站改版）`);
    }

    // 快乐8专用解析：每行 = 期号 + 80 列遗漏值表，chartBall01 表示开出号码
    const parseKl8Row = (rowHtml) => {
        const clean = rowHtml.replace(/<!--.*?-->/g, '');
        const tds = clean.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
        if (tds.length < 81) return null;
        // 期号在第一个 td
        const period = tds[0].replace(/<[^>]+>/g, '').trim();
        if (!/^\d{6,}$/.test(period)) return null;
        // 提取开出号码（class 含 chartBall01 的 td）
        const nums = [];
        for (let i = 1; i < tds.length; i++) {
            if (/class="[^"]*chartBall01/.test(tds[i])) {
                const n = parseInt(tds[i].replace(/<[^>]+>/g, '').trim());
                if (!isNaN(n)) nums.push(n);
            }
        }
        if (nums.length !== 20) return null;
        nums.sort((a, b) => a - b);
        return { period, date: '', num: nums };
    };

    const history = [];
    for (const rowHtml of rows) {
        if (config.kl8Mode) {
            const entry = parseKl8Row(rowHtml);
            if (entry) history.push(entry);
            continue;
        }
        const { period, date } = extractPeriodAndDate(rowHtml);
        if (!period || !date) continue;

        const entry = { period, date };
        let valid = true;
        for (const [field, cssClass, expected] of config.areas) {
            const nums = extractBalls(rowHtml, cssClass, expected);
            if (nums.length !== expected) {
                valid = false;
                break;
            }
            entry[field] = nums;
        }
        if (valid) history.push(entry);
    }

    if (history.length === 0) {
        throw new Error(`${name} 匹配到 ${rows.length} 行但未能解析出有效号码（CSS 类名可能变更）`);
    }

    // 快乐8接口返回正序（旧→新），统一为最新在前（与其他彩种一致）
    if (config.kl8Mode && history.length > 1 &&
        parseInt(history[0].period) < parseInt(history[history.length - 1].period)) {
        history.reverse();
    }

    // 写入文件
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const outputFile = path.join(dataDir, config.output);
    const now = new Date();
    const updateTime = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
    const result = {
        latest: history[0],
        history: history,
        updateTime: updateTime
    };
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

    console.log(`[${name}] 爬取成功! 最新: 第${history[0].period}期${history[0].date ? ' (' + history[0].date + ')' : ''}，共 ${history.length} 期`);
    return result;
}

/**
 * 爬取所有彩种
 * @param {string} dataDir - 数据保存目录
 * @param {number} limit - 抓取期数（可选）
 * @returns {Promise<Object>} 各彩种结果
 */
async function crawlAll(dataDir, limit) {
    const results = {};
    const types = Object.keys(LOTTERY_SOURCES);
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        // 彩种间间隔 500ms，降低被限流概率
        if (i > 0) await new Promise(r => setTimeout(r, 500));
        try {
            results[type] = await crawlOne(type, dataDir, limit);
        } catch (e) {
            console.error(`[${LOTTERY_SOURCES[type].name}] 爬取失败: ${e.message}`);
            results[type] = { error: e.message };
        }
    }
    return results;
}

module.exports = {
    LOTTERY_SOURCES,
    crawlOne,
    crawlAll
};
