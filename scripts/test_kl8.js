const crawler = require('../src/crawler');
(async () => {
    try {
        const result = await crawler.crawlOne('kl8', 'd:/0.Y003H/Plugin/data', 100);
        console.log('最新期:', result.latest.period, '号码:', result.latest.num.join(','));
        console.log('总期数:', result.history.length);
        console.log('首期:', result.history[result.history.length - 1].period);
        // 验证每期号码数
        const bad = result.history.filter(h => h.num.length !== 20);
        console.log('号码数异常期:', bad.length);
    } catch (e) {
        console.log('ERR:', e.message);
    }
})();
