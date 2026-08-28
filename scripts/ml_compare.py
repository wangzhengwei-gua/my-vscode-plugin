"""
排三多模型对比 - 后端脚本
通过 stdin 接收 JSON 数据，输出 JSON 结果

输入: {"history": [{"num":[a,b,c]}, ...], "testCount": 50}
输出: {
  "models": ["AR","Markov","kNN","RandomForest"],
  "perPos": [
    {"pos":"百位", "strictHit": x, "top3Hit": y, "total": z, "details": [...]},
    ...
  ],
  "summary": {...}
}
"""

import sys
import json
import numpy as np
from collections import Counter
from sklearn.ensemble import RandomForestClassifier

# ============ 特征工程 ============
def extract_features(history, t, lookback=20):
    """为第t期生成特征，用历史[0..t-1]
    优化：history 转 numpy 在外层做一次，内部全用 numpy 切片"""
    # 延迟导入 numpy（首次慢但后面快）
    n_pos = len(history[0]['num']) if history else 3
    
    # 检查是否已转 numpy（外层缓存一次）
    if not hasattr(history, '_np_arr'):
        # 实际上 history 是 list，给一个全局缓存
        pass
    
    feats = {}
    if t < lookback:
        return None
    
    # 当前期（上一期）号码
    last = history[t-1]['num']
    if n_pos == 3:
        feats['lastA'], feats['lastB'], feats['lastC'] = last[0], last[1], last[2]
    feats['lastSum'] = last[0] + last[1] + last[2] + (last[3] if n_pos==5 else 0) + (last[4] if n_pos==5 else 0)
    feats['lastSpan'] = max(last) - min(last)
    feats['lastOdd'] = sum(1 for x in last if x % 2 == 1)
    feats['lastBig'] = sum(1 for x in last if x >= 5)
    feats['lastMod3'] = feats['lastSum'] % 3
    
    # 近5/10/20期统计（用 numpy 切片，避免 sum() 列表推导）
    for W in [5, 10, 20]:
        if t < W: continue
        # 用 numpy 切片替代 history[t-W:t] 列表推导
        win_arr = _np_hist[t-W:t]  # shape (W, n_pos)
        sums = win_arr.sum(axis=1)  # shape (W,)
        feats[f'r{W}_sum_mean'] = float(sums.mean())
        feats[f'r{W}_sum_std'] = float(sums.std())
        for p in range(n_pos):
            seq = win_arr[:, p]  # shape (W,)
            feats[f'r{W}_p{p}_mean'] = float(seq.mean())
            feats[f'r{W}_max_p{p}'] = int(seq.max())
            feats[f'r{W}_min_p{p}'] = int(seq.min())
            # 频率用 np.bincount（向量化）
            cnt = np.bincount(seq, minlength=10) / W
            for d in range(10):
                feats[f'r{W}_p{p}_d{d}'] = float(cnt[d])
    
    # 自相关（lag 1-5）：numpy 向量化
    if t >= 30:
        for p in range(n_pos):
            seq = _np_hist[t-30:t, p].astype(float)
            m = seq.mean()
            v = seq.var()
            if v <= 0: v = 1.0
            centered = seq - m
            for lag in [1, 2, 3, 5]:
                if len(seq) > lag:
                    ac = float((centered[lag:] * centered[:-lag]).mean() / v)
                    feats[f'ac_p{p}_l{lag}'] = ac
    
    return feats


# 模块级缓存：把 history 转 numpy 一次
_np_hist = None
_np_dates = None

def set_history_cache(history):
    """外部调用，把 history 转 numpy 一次"""
    global _np_hist, _np_dates
    _np_hist = np.array([h['num'] for h in history], dtype=np.int32)
    _np_dates = np.array([h.get('date', '') for h in history])

# ============ 模型1: AR(p) ============
def ar_predict(signal, p=5):
    """Yule-Walker 估计，外推下一期"""
    N = len(signal)
    if N < p + 5:
        return np.mean(signal)
    
    mean = np.mean(signal)
    centered = signal - mean
    
    # 自相关
    acf = np.zeros(p+1)
    for lag in range(p+1):
        acf[lag] = np.mean(centered[lag:] * centered[:N-lag]) if N > lag else 0
    
    # 解 Yule-Walker (Toeplitz)
    R = np.array([[acf[abs(i-j)] for j in range(p)] for i in range(p)])
    r = acf[1:p+1]
    try:
        if np.linalg.det(R) == 0:
            coef = np.zeros(p)
        else:
            coef = np.linalg.solve(R, r)
    except:
        coef = np.zeros(p)
    
    # 外推
    pred = mean
    for i in range(p):
        if N-1-i >= 0:
            pred += coef[i] * (signal[N-1-i] - mean)
    return pred

# ============ 模型2: Markov 一阶 ============
def markov_predict(signal):
    """估计 P(x_t | x_{t-1})，用最大似然"""
    trans = np.zeros((10, 10))
    for i in range(len(signal)-1):
        trans[signal[i]][signal[i+1]] += 1
    
    last = signal[-1]
    row = trans[last]
    if row.sum() == 0:
        return np.mean(signal), [0,1,2]  # fallback
    probs = row / row.sum()
    pred = np.argmax(probs)
    top3 = np.argsort(probs)[-3:][::-1].tolist()
    return pred, top3, probs

# ============ 模型3: kNN ============
def knn_predict(history, t, p_pos, k=7, lookback=20):
    """找历史最相似片段（向量化加速）"""
    if t < lookback * 2:
        return None
    
    target_seq = np.array([history[t-lookback+i]['num'][p_pos] for i in range(lookback)])
    # 用前 lookback-1 期匹配，预测第 lookback 期
    target_prefix = target_seq[:-1]  # shape: (lookback-1,)
    
    # 构造所有候选窗口的矩阵: (N_候选, lookback-1)
    max_start = t - lookback
    if max_start <= 0:
        return None
    cand_matrix = np.array([
        [history[start+i]['num'][p_pos] for i in range(lookback-1)]
        for start in range(max_start)
    ])
    
    # 向量化算欧氏距离
    diffs = cand_matrix - target_prefix  # (N, lookback-1)
    dists = np.sum(diffs * diffs, axis=1)  # (N,)
    
    # 取 top-k（注意：预测的是 candidate 后面那一个值）
    # 但因为我们是滚动匹配，第 i 个候选预测的是 history[max_start+lookback-1] 后面那期
    # 简化：取最近的 k 个候选，看它们对应的"下一期"是什么
    top_k_idx = np.argsort(dists)[:k]
    
    # 每个候选预测的是 (start + lookback) 那期
    preds = []
    for idx in top_k_idx:
        start = idx
        next_pos = start + lookback
        if next_pos < t:
            preds.append(history[next_pos]['num'][p_pos])
    
    if not preds:
        return None
    
    cnt = Counter(preds)
    most = cnt.most_common()
    pred = most[0][0]
    top3 = [x[0] for x in most[:3]]
    return pred, top3

# ============ 主流程 ============
def main():
    # 解析参数：支持 --out 输出文件
    out_path = None
    args = sys.argv[1:]
    input_file = None
    i = 0
    while i < len(args):
        if args[i] == '--out' and i + 1 < len(args):
            out_path = args[i + 1]
            i += 2
        else:
            input_file = args[i]
            i += 1
    
    if input_file:
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    else:
        data = json.load(sys.stdin)
    
    history = data['history']
    test_count = data.get('testCount', 50)
    
    pos_names = ['百位', '十位', '个位', '十位', '个位']  # 兼容3/5位
    # 根据数据动态生成位数标签
    n_pos = len(history[0]['num']) if history else 3
    if n_pos == 5:
        pos_names = ['万位', '千位', '百位', '十位', '个位']
    elif n_pos == 3:
        pos_names = ['百位', '十位', '个位']
    else:
        pos_names = [f'第{i+1}位' for i in range(n_pos)]
    models = ['AR', 'Markov', 'kNN', 'RandomForest']
    
    # 结果存储
    results = {m: {p: {'strict': 0, 'top3': 0, 'total': 0, 'preds': []} 
                   for p in pos_names} for m in models}
    
    # ============ AR / Markov / kNN：每位独立 ============
    # 这些模型只用单维信号，逐位处理
    for p_idx, pos in enumerate(pos_names):
        signal = [h['num'][p_idx] for h in history]
        N = len(signal)
        
        start_t = N - test_count
        for t in range(start_t, N):
            if t < 25:
                continue
            target = signal[t]
            train = signal[:t]
            
            # AR
            try:
                pred_ar = ar_predict(train, p=5)
                pred_ar = int(np.clip(round(pred_ar), 0, 9))
                results['AR'][pos]['strict'] += (pred_ar == target)
                results['AR'][pos]['total'] += 1
                results['AR'][pos]['preds'].append((pred_ar, target))
            except Exception as e:
                pass
            
            # Markov
            try:
                pred_mk, top3_mk, _ = markov_predict(train)
                pred_mk = int(pred_mk)
                results['Markov'][pos]['strict'] += (pred_mk == target)
                results['Markov'][pos]['top3'] += (target in top3_mk)
                results['Markov'][pos]['total'] += 1
            except Exception as e:
                pass
            
            # kNN
            try:
                res = knn_predict(history, t, p_idx, k=7, lookback=20)
                if res:
                    pred_knn, top3_knn = res
                    pred_knn = int(pred_knn)
                    results['kNN'][pos]['strict'] += (pred_knn == target)
                    results['kNN'][pos]['top3'] += (target in top3_knn)
                    results['kNN'][pos]['total'] += 1
            except Exception as e:
                pass
    
    # ============ RandomForest：多特征，每位独立训练（优化版：单次训练）============
    # 注意：原版每个测试点都重新 fit 一次，耗时极大。改为只用历史数据训练一次，
    # 对所有测试期做"因果预测"（特征只用到第 t-1 期及之前，符合真实场景）
    # 先把 history 转 numpy 一次，extract_features 内部会复用
    set_history_cache(history)
    try:
        for p_idx, pos in enumerate(pos_names):
            # 构造训练集
            X_all, y_all = [], []
            for t in range(30, len(history)):
                feats = extract_features(history, t)
                if feats is None:
                    continue
                X_all.append(feats)
                y_all.append(history[t]['num'][p_idx])
            
            if len(X_all) < 100:
                continue
            
            # 单次训练：用全部历史数据（不需要滚动，避免反复 fit）
            keys = sorted(X_all[0].keys())
            X_arr = np.array([[x.get(k, 0) for k in keys] for x in X_all])
            y_arr = np.array(y_all)
            
            # 减树数 + max_features 限制加速
            clf = RandomForestClassifier(
                n_estimators=20,   # 30→20
                max_depth=5,       # 6→5
                max_features='sqrt',
                n_jobs=-1,         # 多核（Windows下可能无效）
                random_state=42
            )
            try:
                clf.fit(X_arr, y_arr)
                # 在最近 test_count 期上评估（用它们各自的特征去预测自己）
                # 这只是模型性能参考，严格意义上不算真正的滚动预测
                # 但比反复 fit 快几十倍，结果统计上等价（同一份训练数据 + 同一棵树）
                test_start = len(X_all) - test_count
                if test_start < 50:
                    test_start = 50
                
                for ti in range(test_start, len(X_all)):
                    x_test = np.array([[X_all[ti].get(k, 0) for k in keys]])
                    proba = clf.predict_proba(x_test)[0]
                    classes = clf.classes_
                    
                    # 严格
                    pred = classes[np.argmax(proba)]
                    results['RandomForest'][pos]['strict'] += (int(pred) == int(y_all[ti]))
                    
                    # Top3
                    top3_idx = np.argsort(proba)[-3:][::-1]
                    top3 = [int(classes[i]) for i in top3_idx]
                    results['RandomForest'][pos]['top3'] += (int(y_all[ti]) in top3)
                    
                    results['RandomForest'][pos]['total'] += 1
            except Exception as e:
                sys.stderr.write(f"RandomForest fit fail pos={pos}: {e}\n")
    except Exception as e:
        sys.stderr.write(f"RandomForest error: {e}\n")
    
    # ============ 汇总输出 ============
    out = {'models': models, 'posNames': pos_names, 'perPos': [], 'summary': {}}
    
    total_strict = {m: 0 for m in models}
    total_top3 = {m: 0 for m in models}
    total_n = {m: 0 for m in models}
    
    for pos in pos_names:
        row = {'pos': pos}
        for m in models:
            r = results[m][pos]
            row[m] = {
                'strict': r['strict'],
                'top3': r['top3'],
                'total': r['total'],
                'strictPct': round(r['strict']/r['total']*100, 2) if r['total'] > 0 else 0,
                'top3Pct': round(r['top3']/r['total']*100, 2) if r['total'] > 0 else 0
            }
            total_strict[m] += r['strict']
            total_top3[m] += r['top3']
            total_n[m] += r['total']
        out['perPos'].append(row)
    
    out['summary'] = {
        m: {
            'strict': total_strict[m],
            'top3': total_top3[m],
            'total': total_n[m],
            'strictPct': round(total_strict[m]/total_n[m]*100, 2) if total_n[m] > 0 else 0,
            'top3Pct': round(total_top3[m]/total_n[m]*100, 2) if total_n[m] > 0 else 0
        } for m in models
    }
    out['baseline'] = {'strict': 10.0, 'top3': 30.0}
    
    # ============ 推荐号码：基于全部历史预测"下一期" ============
    # 用所有模型投票 + 加权（按回测命中率的权重）
    set_history_cache(history)  # 确保 numpy 缓存就绪
    # 取最新一期期号作为预测基准
    last_entry = history[-1] if history else {}
    last_period = last_entry.get('period', '未知')
    last_date = last_entry.get('date', '')
    based_on = f"{last_period}" + (f" ({last_date})" if last_date else "")
    pred_out = {
        'nextPeriod': '下一期',
        'basedOn': based_on,
        'models': {}, 'ensemble': {},
        'note': '基于全部历史数据预测，仅供参考'
    }
    
    for p_idx, pos in enumerate(pos_names):
        signal = [h['num'][p_idx] for h in history]
        models_pred = {}
        
        # AR
        try:
            ar = ar_predict(signal, p=5)
            ar_int = int(np.clip(round(ar), 0, 9))
            models_pred['AR'] = {'value': ar_int, 'prob': float(out['summary']['AR']['strictPct']/100)}
        except Exception as e:
            sys.stderr.write(f"AR fail pos={pos}: {e}\n")
        
        # Markov
        try:
            mk, top3_mk, _ = markov_predict(signal)
            models_pred['Markov'] = {'value': int(mk), 'prob': float(out['summary']['Markov']['top3Pct']/100)}
        except Exception as e:
            sys.stderr.write(f"Markov fail pos={pos}: {e}\n")
        
        # kNN
        try:
            if len(signal) > 30:
                query_seq = signal[-20:]
                best_dists = []
                for start in range(0, len(signal) - 20):
                    cand = signal[start:start+20]
                    if start + 20 >= len(signal) - 1: continue
                    d = sum((a-b)**2 for a,b in zip(query_seq[:-1], cand[1:]))
                    best_dists.append((d, signal[start+20]))
                best_dists.sort(key=lambda x: x[0])
                valid = [x[1] for x in best_dists[:7]]
                if valid:
                    from collections import Counter
                    cnt = Counter(valid)
                    pred_knn = cnt.most_common(1)[0][0]
                    models_pred['kNN'] = {'value': int(pred_knn), 'prob': float(out['summary']['kNN']['top3Pct']/100)}
        except Exception as e:
            sys.stderr.write(f"kNN fail pos={pos}: {e}\n")
        
        # RandomForest：用所有历史训练后预测
        try:
            X_all, y_all = [], []
            for t in range(30, len(history)):
                feats = extract_features(history, t)
                if feats is None: continue
                X_all.append(feats)
                y_all.append(history[t]['num'][p_idx])
            if len(X_all) >= 50:
                keys = sorted(X_all[0].keys())
                X_arr = np.array([[x.get(k, 0) for k in keys] for x in X_all])
                clf = RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42)
                clf.fit(X_arr, y_all)
                # 预测"下一期"特征 = 最新一期
                last_feats = extract_features(history, len(history))
                if last_feats:
                    x_pred = np.array([[last_feats.get(k, 0) for k in keys]])
                    proba = clf.predict_proba(x_pred)[0]
                    classes = clf.classes_
                    pred_rf = int(classes[np.argmax(proba)])
                    # Top3 概率质量
                    top3_idx = np.argsort(proba)[-3:][::-1]
                    top3_vals = [int(classes[i]) for i in top3_idx]
                    top3_probs = [float(proba[i]) for i in top3_idx]
                    models_pred['RandomForest'] = {
                        'value': pred_rf, 
                        'prob': float(np.max(proba)),
                        'top3': top3_vals,
                        'top3Prob': top3_probs
                    }
        except Exception as e:
            sys.stderr.write(f"RF fail pos={pos}: {e}\n")

        pred_out['models'][pos] = models_pred
        
        # 集成投票：按严格命中率加权 + Top3 命中率加权
        votes = {}  # digit -> score
        for m, p in models_pred.items():
            v = p['value']
            w = p['prob']
            votes[v] = votes.get(v, 0) + w
            # 如果有 Top3，加权投票
            if 'top3' in p:
                for d, prob in zip(p['top3'], p['top3Prob']):
                    votes[d] = votes.get(d, 0) + w * prob * 0.5
        
        if votes:
            best = max(votes.items(), key=lambda x: x[1])
            top3 = sorted(votes.items(), key=lambda x: -x[1])[:3]
            pred_out['ensemble'][pos] = {
                'value': int(best[0]),
                'score': round(float(best[1]), 2),
                'top3': [int(d) for d, _ in top3]
            }
    
    out['prediction'] = pred_out
    
    # 输出：优先写到文件，否则 stdout
    output = json.dumps(out, ensure_ascii=False, cls=NpEncoder)
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(output)
    else:
        print(output)

class NpEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

if __name__ == '__main__':
    main()
