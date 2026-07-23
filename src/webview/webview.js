// 走势图表格渲染逻辑（外部 JS 文件）
// 数据通过 ALL_DATA 全局变量传入（由 extension.js 通过 inline script 注入）
(function () {
    'use strict';

    const POS_COLORS = ['#e74c3c','#f39c12','#f1c40f','#1abc9c','#3498db','#9b59b6','#e84393','#00b894','#fd79a8','#6c5ce7'];
    const SELECT_LIMIT = { dlt_front: 7, dlt_back: 3, ssq_red: 8, ssq_blue: 2 };

    // 标记 JS 启动
    document.title = 'JS-EXT-RUNNING';

    function switchTab(key) {
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(t => t.classList.toggle('active', t.dataset.key === key));
        const panels = document.querySelectorAll('.panel');
        panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + key));
        setTimeout(() => drawAllLines(key), 50);
    }

    function buildPanel(d) {
        const panel = document.createElement('div');
        panel.dataset.key = d.key;

        const legend = document.createElement('div');
        legend.className = 'legend';
        legend.innerHTML =
            '<span>' + d.name + ' · 共 ' + d.total + ' 期</span>' +
            '<span>显示期数：<select class="limit-select" data-key="' + d.key + '">' +
                '<option value="50">最近 50 期</option>' +
                '<option value="100">最近 100 期</option>' +
                '<option value="150">最近 150 期</option>' +
                '<option value="200">最近 200 期</option>' +
                '<option value="300">最近 300 期</option>' +
                '<option value="500">最近 500 期</option>' +
            '</select></span>' +
            d.positionLabels.map((l, i) => '<span><i class="dot" style="background:' + POS_COLORS[i % POS_COLORS.length] + '"></i>' + l + '</span>').join('');
        panel.appendChild(legend);

        // 预选区配置（每个位号一段 + 段名标签 + 段内数字按钮）
        const groups = [];
        // 统一：每个位号一个 group（大乐透 7 段，双色球 7 段，排列三 3 段，排列五 5 段）
        d.positionLabels.forEach((lbl, pi) => {
            groups.push({ label: lbl, pi: pi, max: d.positionMax[pi] });
        });

        const wrap = document.createElement('div');
        wrap.className = 'trend-wrap';
        wrap.id = 'wrap-' + d.key;

        const tbl = document.createElement('table');
        tbl.className = 'trend';

        const thead = document.createElement('thead');
        let headHtml = '<tr><th class="period">期号</th>';
        d.positionLabels.forEach((l, pi) => {
            const sep = pi > 0 ? ' pos-sep' : '';
            const max = d.positionMax[pi];
            headHtml += '<th class="pos-group' + sep + '" colspan="' + (max + 1) + '" style="text-align:center;">' + l + '</th>';
        });
        headHtml += '<th class="stat" style="text-align:center;">和尾</th>';
        headHtml += '<th class="stat" style="text-align:center;">跨度</th>';
        headHtml += '<th class="stat" style="text-align:center;">奇偶比</th>';
        headHtml += '<th class="stat" style="text-align:center;">012路</th>';
        headHtml += '</tr>';
        headHtml += '<tr><th class="period"></th>';
        d.positionLabels.forEach((l, pi) => {
            for (let n = 0; n <= d.positionMax[pi]; n++) {
                const sep = (pi > 0 && n === 0) ? ' pos-sep' : '';
                headHtml += '<th' + sep + ' style="text-align:center;">' + n + '</th>';
            }
        });
        headHtml += '<th class="stat"></th><th class="stat"></th><th class="stat"></th><th class="stat"></th></tr>';
        thead.innerHTML = headHtml;
        tbl.appendChild(thead);

        const tbody = document.createElement('tbody');
        // 默认显示 50 期
        const limit = 50;
        const recentRows = d.rows.slice(-limit);
        tbody.dataset.limit = limit;
        let tbodyHtml = '';
        recentRows.forEach((row, ri) => {
            let trHtml = '<tr><td class="period">' + row.period + '</td>';
            d.positionLabels.forEach((l, pi) => {
                const val = row.positions[pi];
                const segClass = 'seg-' + (pi % 7);
                for (let n = 0; n <= d.positionMax[pi]; n++) {
                    const hit = (n === val) ? ' hit' : '';
                    const sep = (pi > 0 && n === 0) ? ' pos-sep' : '';
                    trHtml += '<td class="num-cell ' + segClass + sep + hit + '" data-pos="' + pi + '" data-row="' + ri + '" data-n="' + n + '" data-val="' + val + '"><span class="n">' + n + '</span></td>';
                }
            });
            trHtml += '<td class="stat">' + row.sumTail + '</td>';
            trHtml += '<td class="stat">' + row.span + '</td>';
            trHtml += '<td class="stat">' + row.oddEven + '</td>';
            trHtml += '<td class="stat">' + row.road012 + '</td>';
            trHtml += '</tr>';
            tbodyHtml += trHtml;
        });
        tbody.innerHTML = tbodyHtml;

        // 预选行：作为表格最后一行（默认 1 行）
        addPredictRow(d, tbody, groups, 0);

        tbl.appendChild(tbody);

        wrap.appendChild(tbl);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'svg-layer');
        svg.id = 'svg-' + d.key;
        svg.style.overflow = 'visible';
        wrap.appendChild(svg);

        panel.appendChild(wrap);

        // 摘要 + 操作按钮放在表格外（紧贴表格下方）
        const footer = document.createElement('div');
        footer.className = 'predict-footer';
        footer.innerHTML =
            '<div class="predict-summary" id="summary-' + d.key + '">已选：<b>-</b></div>' +
            '<div class="predict-actions">' +
            '<button data-act="addrow" data-key="' + d.key + '">➕ 增加预选行</button>' +
            '<button class="secondary" data-act="clear" data-key="' + d.key + '">🗑️ 清空</button>' +
            '<button class="secondary" data-act="copy" data-key="' + d.key + '">📋 一键复制</button>' +
            '</div>';
        panel.appendChild(footer);

        // 绑定预选行内的号码点击（动态添加的行通过事件委托）
        panel.addEventListener('click', (ev) => {
            const el = ev.target.closest('.predict-num');
            if (el) {
                el.classList.toggle('selected');
                updatePredictSummary(d.key);
            }
        });

        panel.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                const key = btn.dataset.key;
                if (act === 'clear') clearPredict(key);
                else if (act === 'addrow') addPredictRowByKey(key);
                else if (act === 'copy') copyPredict(key);
            });
        });

        // 期数选择器：切换时重新渲染 tbody（保留预选行）
        const limitSelect = panel.querySelector('.limit-select');
        if (limitSelect) {
            limitSelect.addEventListener('change', () => {
                const newLimit = parseInt(limitSelect.value);
                console.log('limit changed:', d.key, '->', newLimit);
                // 显示加载提示，让 UI 先响应
                const tbl = panel.querySelector('table.trend');
                if (tbl) {
                    const tbody = tbl.querySelector('tbody');
                    if (tbody) {
                        tbody.style.opacity = '0.4';
                    }
                }
                // 用 requestAnimationFrame + setTimeout 让浏览器有机会渲染加载状态
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        rebuildTbody(d.key, newLimit);
                        const tbody2 = panel.querySelector('table.trend tbody');
                        if (tbody2) tbody2.style.opacity = '1';
                        console.log('rebuild done:', d.key);
                    }, 50);
                });
            });
        } else {
            console.log('WARNING: limitSelect not found for', d.key);
        }

        return panel;
    }

    // 按 newLimit 重新构建 tbody（数据行 + 1 个预选行）
    function rebuildTbody(key, newLimit) {
        const d = ALL_DATA.find(x => x.key === key);
        if (!d) { console.log('rebuildTbody: no data for', key); return; }
        const panel = document.getElementById('panel-' + key);
        if (!panel) { console.log('rebuildTbody: no panel for', key); return; }
        const tbl = panel.querySelector('table.trend');
        if (!tbl) { console.log('rebuildTbody: no table for', key); return; }
        const tbody = tbl.querySelector('tbody');
        if (!tbody) { console.log('rebuildTbody: no tbody for', key); return; }
        console.log('rebuildTbody:', key, 'limit=', newLimit, 'rows=', d.rows.length, 'will render', Math.min(newLimit, d.rows.length));

        // 保存当前预选行（已选中的号码）
        const savedPredict = [];
        tbody.querySelectorAll('tr.predict-row').forEach((tr, idx) => {
            const selected = {};
            tr.querySelectorAll('.predict-num.selected').forEach(el => {
                const gi = el.dataset.gi;
                if (!selected[gi]) selected[gi] = [];
                selected[gi].push(parseInt(el.dataset.n));
            });
            savedPredict.push(selected);
        });

        // 重建 groups
        const groups = [];
        // 统一：每个位号一个 group（大乐透 7 段，双色球 7 段，排列三 3 段，排列五 5 段）
        d.positionLabels.forEach((lbl, pi) => {
            groups.push({ label: lbl, pi: pi, max: d.positionMax[pi] });
        });

        // 清空 tbody
        tbody.innerHTML = '';
        // 重新构建数据行（用字符串拼接，一次性 innerHTML，提升性能）
        const recentRows = d.rows.slice(-newLimit);
        let tbodyHtml = '';
        recentRows.forEach((row, ri) => {
            let trHtml = '<tr><td class="period">' + row.period + '</td>';
            d.positionLabels.forEach((l, pi) => {
                const val = row.positions[pi];
                const segClass = 'seg-' + (pi % 7);
                for (let n = 0; n <= d.positionMax[pi]; n++) {
                    const hit = (n === val) ? ' hit' : '';
                    const sep = (pi > 0 && n === 0) ? ' pos-sep' : '';
                    trHtml += '<td class="num-cell ' + segClass + sep + hit + '" data-pos="' + pi + '" data-row="' + ri + '" data-n="' + n + '" data-val="' + val + '"><span class="n">' + n + '</span></td>';
                }
            });
            trHtml += '<td class="stat">' + row.sumTail + '</td>';
            trHtml += '<td class="stat">' + row.span + '</td>';
            trHtml += '<td class="stat">' + row.oddEven + '</td>';
            trHtml += '<td class="stat">' + row.road012 + '</td>';
            trHtml += '</tr>';
            tbodyHtml += trHtml;
        });
        tbody.innerHTML = tbodyHtml;
        // 重新构建预选行（按保存的状态恢复）
        for (let i = 0; i < Math.max(1, savedPredict.length); i++) {
            const trs = addPredictRow(d, tbody, groups, i);
            // 恢复选中状态（在所有 trs 里找）
            if (savedPredict[i]) {
                Object.keys(savedPredict[i]).forEach(gi => {
                    savedPredict[i][gi].forEach(n => {
                        for (const tr of trs) {
                            const el = tr.querySelector('.predict-num[data-gi="' + gi + '"][data-n="' + n + '"]');
                            if (el) { el.classList.add('selected'); break; }
                        }
                    });
                });
            }
        }
        updatePredictSummary(key);
        drawAllLines(key);
    }

    function buildPredictBar(d) {
        // 保留空函数（旧代码可能引用，兼容）
        return document.createElement('div');
    }

    // 保留 cnNum 以备后用
    function cnNum(n) {
        const map = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        return map[n] || String(n);
    }

    // 预选行生成：返回 tr 元素数组
    // 所有彩种统一：1 行 = 1 套预选
    // 每个位号段一组号码按钮（与表格列结构对齐）
    function addPredictRow(d, tbody, groups, rowIdx) {
        const tr = document.createElement('tr');
        tr.className = 'predict-row';
        tr.dataset.predictRow = rowIdx;
        let html = '<td class="period predict-cell">🎯 预选' + cnNum(rowIdx + 1) + '</td>';
        groups.forEach((g, gi) => {
            for (let n = 0; n <= g.max; n++) {
                const sep = (gi > 0 && n === 0) ? ' pos-sep' : '';
                html += '<td class="predict-cell-inner' + sep + '"><span class="predict-num" data-gi="' + gi + '" data-n="' + n + '" data-prow="' + rowIdx + '">' + n + '</span></td>';
            }
        });
        html += '<td class="stat"></td><td class="stat"></td><td class="stat"></td><td class="stat"></td>';
        tr.innerHTML = html;
        tbody.appendChild(tr);
        return [tr];
    }

    // 通过 key 找到 panel 并追加预选行
    function addPredictRowByKey(key) {
        const d = ALL_DATA.find(x => x.key === key);
        if (!d) return;
        const panel = document.getElementById('panel-' + key);
        if (!panel) return;
        const tbody = panel.querySelector('table.trend tbody');
        if (!tbody) return;
        // 现有预选行数
        // 用 data-predictRow 计数（每个预选单元 = 1 个 rowIdx；大乐透/双色球会占 2 个 tr）
        const existing = tbody.querySelectorAll('tr.predict-row[data-predictRow]').length;
        const lastRowIdx = existing > 0 ? Math.max(...Array.from(tbody.querySelectorAll('tr.predict-row[data-predictRow]')).map(t => parseInt(t.dataset.predictRow))) : -1;
        const nextIdx = lastRowIdx + 1;
        // 重新构建 groups
        const groups = [];
        // 统一：每个位号一个 group（大乐透 7 段，双色球 7 段，排列三 3 段，排列五 5 段）
        d.positionLabels.forEach((lbl, pi) => {
            groups.push({ label: lbl, pi: pi, max: d.positionMax[pi] });
        });
        addPredictRow(d, tbody, groups, nextIdx);
        updatePredictSummary(key);
    }

    // 复制所有预选行的选中号码到剪贴板
    function copyPredict(key) {
        const panel = document.getElementById('panel-' + key);
        if (!panel) return;
        const d = ALL_DATA.find(x => x.key === key);
        if (!d) return;
        const groupLabels = d.positionLabels;
        // 按行收集
        const rows = {};
        panel.querySelectorAll('.predict-num.selected').forEach(el => {
            const prow = el.dataset.prow || '0';
            const gi = el.dataset.gi;
            if (!rows[prow]) rows[prow] = {};
            if (!rows[prow][gi]) rows[prow][gi] = [];
            rows[prow][gi].push(parseInt(el.dataset.n));
        });
        // 取最近一期作为"下一期预测对象"
        const lastPeriod = d.rows.length > 0 ? d.rows[d.rows.length - 1].period : '';
        const nextPeriod = lastPeriod ? (parseInt(lastPeriod) + 1).toString() : '?';

        // 按彩种区分格式
        // 大乐透/双色球：前区所有位号合并 + 后区所有位号合并，用 + 连接
        //   例：05 06 07 08 09 10 + 02 05
        // 排列三/五：每位独立一行，带位名
        //   例：百位：0 1 2 3 4
        //       十位：1 2 3 4 5
        //       个位：2 3 4 5 6
        const lines = [];
        const isMergeType = (key === 'dlt' || key === 'ssq');

        Object.keys(rows).sort((a, b) => parseInt(a) - parseInt(b)).forEach(prow => {
            if (isMergeType) {
                // 大乐透/双色球：前 5/6 段合并成前区，后 2/1 段合并成后区
                const frontCount = (key === 'dlt') ? 5 : 6; // 前区段数
                let frontNums = [];
                let backNums = [];
                for (let gi = 0; gi < groupLabels.length; gi++) {
                    const nums = rows[prow][gi] || [];
                    if (gi < frontCount) {
                        frontNums = frontNums.concat(nums);
                    } else {
                        backNums = backNums.concat(nums);
                    }
                }
                // 去重 + 排序 + 补零
                frontNums = Array.from(new Set(frontNums)).sort((a, b) => a - b)
                    .map(n => String(n).padStart(2, '0'));
                backNums = Array.from(new Set(backNums)).sort((a, b) => a - b)
                    .map(n => String(n).padStart(2, '0'));
                lines.push(frontNums.join(' ') + ' + ' + backNums.join(' '));
            } else {
                // 排列三/五：每位独立一行，带位名
                for (let gi = 0; gi < groupLabels.length; gi++) {
                    const lbl = groupLabels[gi];
                    const nums = (rows[prow][gi] || []).sort((a, b) => a - b);
                    lines.push(lbl + '位：' + nums.join(' '));
                }
                // 多套预选之间空一行分隔
                lines.push('');
            }
        });

        // 加上彩种名称 + 格式说明
        const header = '【' + d.name + '】下一期 ' + nextPeriod + ' 预选';
        const formatHint = (key === 'dlt')
            ? '格式：前区 1-35 选 5+ 个  +  后区 1-12 选 2+ 个'
            : (key === 'ssq')
            ? '格式：红球 1-33 选 6+ 个  +  蓝球 1-16 选 1+ 个'
            : (key === 'pl3')
            ? '格式：百位 / 十位 / 个位  每位 0-9'
            : '格式：万位 / 千位 / 百位 / 十位 / 个位  每位 0-9';
        const text = [header, formatHint, '---', lines.join('\n').trim() || '(空)'].join('\n');

        // 复制到剪贴板
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showCopyToast('已复制：\n' + text);
            }).catch(() => {
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showCopyToast('已复制：\n' + text);
        } catch (e) {
            showCopyToast('复制失败，请手动复制：\n' + text);
        }
        document.body.removeChild(ta);
    }

    function showCopyToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'copy-toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
    }

    function updatePredictSummary(key) {
        const panel = document.getElementById('panel-' + key);
        if (!panel) return;
        const summary = document.getElementById('summary-' + key);
        if (!summary) return;
        const d = ALL_DATA.find(x => x.key === key);
        if (!d) return;
        const groupLabels = d.positionLabels;

        // 按 prow (预选行) → gi (段) 分组
        const byRow = {};
        panel.querySelectorAll('.predict-num.selected').forEach(el => {
            const prow = el.dataset.prow || '0';
            const gi = el.dataset.gi;
            if (!byRow[prow]) byRow[prow] = {};
            if (!byRow[prow][gi]) byRow[prow][gi] = [];
            byRow[prow][gi].push(parseInt(el.dataset.n));
        });

        const rowKeys = Object.keys(byRow).sort((a, b) => parseInt(a) - parseInt(b));
        const out = [];
        rowKeys.forEach(prow => {
            const segs = [];
            groupLabels.forEach((lbl, gi) => {
                const nums = (byRow[prow][gi] || []).sort((a, b) => a - b);
                segs.push(lbl + ': ' + (nums.length ? nums.join(' ') : '-'));
            });
            out.push('[' + cnNum(parseInt(prow) + 1) + '] ' + segs.join(' | '));
        });
        summary.innerHTML = '已选 → <b>' + (out.length ? out.join('<br>') : '-') + '</b>';
    }

    function clearPredict(key) {
        const panel = document.getElementById('panel-' + key);
        if (!panel) return;
        // 清空所有选中状态
        panel.querySelectorAll('.predict-num.selected').forEach(el => el.classList.remove('selected'));
        // 删除多余预选行，只保留第 1 行（data-prow="0"）
        const rows = panel.querySelectorAll('tr.predict-row');
        rows.forEach(tr => {
            if (tr.dataset.predictRow !== '0') tr.remove();
        });
        updatePredictSummary(key);
    }

    function drawAllLines(key) {
        const panel = document.getElementById('panel-' + key);
        if (!panel) return;
        const svg = document.getElementById('svg-' + key);
        if (!svg) return;
        const data = ALL_DATA.find(d => d.key === key);
        if (!data) return;

        const wrap = panel.querySelector('.trend-wrap');
        const tbl = panel.querySelector('.trend');
        if (!wrap || !tbl) return;
        const wrapRect = wrap.getBoundingClientRect();

        let svgContent = '';
        const posCount = data.positionLabels.length;
        // 红圈半径 11px
        const R = 11;

        for (let pi = 0; pi < posCount; pi++) {
            const hits = panel.querySelectorAll('.num-cell.hit[data-pos="' + pi + '"]');
            if (hits.length < 2) continue;
            const color = POS_COLORS[pi % POS_COLORS.length];

            // 收集每个 hit 圆心坐标
            const pts = [];
            hits.forEach(c => {
                const r = c.getBoundingClientRect();
                pts.push({
                    x: r.left - wrapRect.left + r.width / 2,
                    y: r.top - wrapRect.top + r.height / 2
                });
            });

            // 每两个圆之间画一条线段，起点终点都在圆的边缘（外切线）
            for (let k = 0; k < pts.length - 1; k++) {
                const a = pts[k], b = pts[k + 1];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 2 * R + 2) continue; // 两圆重叠或太近，跳过

                // 圆 a 的右侧外切点（沿 a→b 方向）
                const ratioA = R / dist;
                const ax = a.x + dx * ratioA;
                const ay = a.y + dy * ratioA;
                // 圆 b 的左侧外切点
                const ratioB = R / dist;
                const bx = b.x - dx * ratioB;
                const by = b.y - dy * ratioB;

                const pathD = 'M ' + ax + ' ' + ay + ' L ' + bx + ' ' + by;
                // 双层描边：背景色宽边 + 彩色窄边
                svgContent += '<path d="' + pathD + '" stroke="#1e1e1e" stroke-width="2.5" fill="none" opacity="0.95"/>';
                svgContent += '<path d="' + pathD + '" stroke="' + color + '" stroke-width="1.2" fill="none" opacity="0.95"/>';
            }
        }

        svg.innerHTML = svgContent;
        // SVG 尺寸要等于整个表格（包含横向滚动出去的部分）
        svg.setAttribute('width', tbl.scrollWidth || tbl.offsetWidth);
        svg.setAttribute('height', tbl.scrollHeight || tbl.offsetHeight);
        // SVG 跟随 wrap 定位，position 已经在 CSS 里设了
    }

    function init() {
        if (typeof ALL_DATA === 'undefined' || !ALL_DATA) {
            document.title = 'NO-DATA';
            return;
        }
        const tabsEl = document.getElementById('tabs');
        const contentEl = document.getElementById('content');
        if (!tabsEl || !contentEl) {
            document.title = 'NO-DOM';
            return;
        }

        ALL_DATA.forEach((d, i) => {
            const tab = document.createElement('div');
            tab.className = 'tab' + (i === 0 ? ' active' : '');
            tab.textContent = d.emoji + ' ' + d.name;
            tab.dataset.key = d.key;
            tab.onclick = () => switchTab(d.key);
            tabsEl.appendChild(tab);

            const panel = buildPanel(d);
            panel.id = 'panel-' + d.key;
            panel.className = 'panel' + (i === 0 ? ' active' : '');
            contentEl.appendChild(panel);
        });

        const lm = document.getElementById('loadingMark');
        if (lm) lm.remove();

        drawAllLines(ALL_DATA[0].key);
        document.title = 'DONE';
    }

    // 等待 DOM 完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const active = document.querySelector('.panel.active');
            if (active) drawAllLines(active.id.replace('panel-', ''));
        }, 200);
    });
})();
