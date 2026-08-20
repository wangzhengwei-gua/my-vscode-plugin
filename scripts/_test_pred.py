import sys
sys.path.insert(0, 'd:/0.Y003H/Plugin/scripts')

# 强制设置 Python 源码编码
import importlib.util
spec = importlib.util.spec_from_file_location('ml_compare', 'd:/0.Y003H/Plugin/scripts/ml_compare.py')
mc = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mc)
except Exception as e:
    print('load error:', e)
    sys.exit(1)

import json
with open('d:/0.Y003H/Plugin/scripts/_in.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
history = data['history']
signal = [h['num'][0] for h in history]
print('signal len:', len(signal))

# AR
try:
    ar = mc.ar_predict(signal, p=5)
    print('AR ok:', ar)
except Exception as e:
    import traceback
    traceback.print_exc()

# Markov
try:
    mk = mc.markov_predict(signal)
    print('Markov ok:', mk)
except Exception as e:
    import traceback
    traceback.print_exc()

# kNN
try:
    res = mc.knn_predict(history, len(history), 0, k=7, lookback=20)
    print('kNN ok:', res)
except Exception as e:
    import traceback
    traceback.print_exc()