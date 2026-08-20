// 生成排五合成数据测试
const fs = require('fs');
const data = {
    history: Array.from({length: 200}, (_, i) => ({
        num: [i%10, (i*3)%10, (i*7)%10, (i*2)%10, (i*5)%10]
    })),
    testCount: 20
};
fs.writeFileSync('d:/0.Y003H/Plugin/scripts/_in5.json', JSON.stringify(data));
console.log('done');