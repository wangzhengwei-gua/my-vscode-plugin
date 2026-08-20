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
    """为第t期生成特征，用历史[0..t-1]"""
    feats = {}
    if t < lookback:
        return None  # 不够
    
    win = history[t-lookback:t]
    
    # 当前期（上一期）号码
    last = history[t-1]['num']
    feats['lastA'], feats['lastB'], feats['lastC'] = last[0], last[1], last[2]
    feats['lastSum'] = sum(last)
    feats['lastSpan'] = max(last) - min(last)
    feats['lastOdd'] = sum(1 for x in last if x % 2 == 1)
    feats['lastBig'] = sum(1 for x in last if x >= 5)
    feats['lastMod3'] = sum(last) % 3
    
    # 近5/10/20期统计
    for W in [5, 10, 20]:
        if t >= W:
            winW = history[t-W:t]
            sums = [sum(h['num']) for h in winW]
            feats[f'r{W}_sum_mean'] = np.mean(sums)
            feats[f'r{W}_sum_std'] = np.std(sums)
            for p in range(3):
                seq = [h['num'][p] for h in winW]
                feats[f'r{W}_p{p}_mean'] = np.mean(seq)
                feats[f'r{W}_p{p}_max'] = max(seq)
                feats[f'r{W}_p{p}_min'] = min(seq)
                # 频率
                for d in range(10):
                    feats[f'r{W}_p{p}_d{d}'] = seq.count(d) / W
    
    # 自相关（lag 1-5）
    if t >= 30:
        for p in range(3):
            seq = [h['num'][p] for h in history[t-30:t]]
            m = np.mean(seq)
            v = np.var(seq) if np.var(seq) > 0 else 1
            for lag in [1, 2, 3, 5]:
                if len(seq) > lag:
                    ac = np.mean([(seq[i]-m)*(seq[i-lag]-m) for i in range(lag, len(seq))]) / v
                    feats[f'ac_p{p}_l{lag}'] = ac
    
    return feats

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
    """找历史最相似片段"""
    if t < lookback * 2:
        return None
    
    target_seq = [history[t-lookback+i]['num'][p_pos] for i in range(lookback)]
    
    # 滑动搜索所有历史窗口
    best_dists = []
    for start in range(0, t - lookback):
        cand = [history[start+i]['num'][p_pos] for i in range(lookback)]
        d = sum((a-b)**2 for a,b in zip(target_seq[:-1], cand[1:]))  # 注意：匹配前19期预测第20期
        best_dists.append((d, history[start+lookback]['num'][p_pos] if start+lookback < t else None))
    
    best_dists.sort(key=lambda x: x[0])
    valid = [x[1] for x in best_dists[:k] if x[1] is not None]
    if not valid:
        return None
    
    cnt = Counter(valid)
    pred = cnt.most_common(1)[0][0]
    top3 = [x[0] for x in cnt.most_common(3)]
    return pred, top3

# ============ 主流程 ============
def main():
    # 支持两种输入：stdin 或 文件参数
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            data = json.load(f)
    else:
        data = json.load(sys.stdin)
    
    history = data['history']
    test_count = data.get('testCount', 50)
    
    pos_names = ['百位', '十位', '个位']
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
    
    # ============ RandomForest：多特征，每位独立训练 ============
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
            
            # 滚动预测：每个测试点用之前所有数据训练
            test_start = len(X_all) - test_count
            for ti in range(test_start, len(X_all)):
                if ti < 50:
                    continue
                X_train = [X_all[i] for i in range(ti)]
                y_train = [y_all[i] for i in range(ti)]
                
                # 特征列对齐
                keys = sorted(X_train[0].keys())
                X_train_arr = np.array([[x.get(k, 0) for k in keys] for x in X_train])
                
                clf = RandomForestClassifier(n_estimators=50, max_depth=8, random_state=ti)
                try:
                    clf.fit(X_train_arr, y_train)
                    x_test = np.array([[X_all[ti].get(k, 0) for k in keys]])
                    proba = clf.predict_proba(x_test)[0]
                    classes = clf.classes_
                    
                    # 严格
                    pred = classes[np.argmax(proba)]
                    results['RandomForest'][pos]['strict'] += (pred == y_all[ti])
                    
                    # Top3
                    top3_idx = np.argsort(proba)[-3:][::-1]
                    top3 = [classes[i] for i in top3_idx]
                    results['RandomForest'][pos]['top3'] += (y_all[ti] in top3)
                    
                    results['RandomForest'][pos]['total'] += 1
                except Exception as e:
                    pass
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
            'strictPct': round(total_strict[m]/total_n[m]*100, 2) if total_n[m] > 0 else 0,
            'top3Pct': round(total_top3[m]/total_n[m]*100, 2) if total_n[m] > 0 else 0,
            'total': total_n[m]
        } for m in models
    }
    out['baseline'] = {'strict': 10.0, 'top3': 30.0}
    
    print(json.dumps(out, ensure_ascii=False, cls=NpEncoder))

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
