"""满档读数标定的正确性冒烟测试（不依赖 pytest）。

覆盖：
- 唯一恢复（3 路 / 6 路，含四舍五入带的样本）；
- 样本矛盾（全零驱动非零实测、满档实测强迫某路全零）；
- 标定不唯一（某路不可观测、低驱动级舍入带宽过大）；
- 四舍五入语义边界（±0.5 带内合法、带外矛盾）。
"""

import sys

sys.path.insert(0, "/workspace")

from app.calibrator import (  # noqa: E402
    INFEASIBLE,
    NON_UNIQUE,
    UNIQUE,
    CalibSample,
    calibrate,
)


def synth(readings, drives_list):
    """按页面同样的 half-up 规则，由真实读数+驱动级生成实测整数。"""
    out = []
    n = len(readings)
    for d in drives_list:
        y = []
        for c in range(3):
            s = sum(readings[i][c] * d[i] for i in range(n))
            y.append((2 * s + 255) // (2 * 255))
        out.append(CalibSample(drives=tuple(d), measured=tuple(y)))
    return out


def expect(name, samples, ids, status, readings=None):
    res = calibrate(ids, samples, time_limit_seconds=10)
    assert res.status == status, f"{name}: 期望 {status}，实际 {res.status}"
    if readings is not None:
        assert res.readings == readings, (res.readings, readings)
    print(f"[OK] {name}: {res.status}")


# ---------------------------------------------------------------- 唯一恢复
R3 = [(1000, 120, 40), (160, 1000, 90), (60, 80, 1000)]
ids3 = ["R", "G", "B"]
expect(
    "3路唯一(对角+混合)",
    synth(R3, [(255, 0, 0), (0, 255, 0), (0, 0, 255),
               (128, 200, 64), (100, 100, 100), (0, 255, 255)]),
    ids3, UNIQUE, R3,
)

# 满档对角样本：S=255R 精确落在舍入带中心，单组即可固定该路读数
expect(
    "3路仅对角满档即唯一",
    synth(R3, [(255, 0, 0), (0, 255, 0), (0, 0, 255)]),
    ids3, UNIQUE, R3,
)

# ---------------------------------------------------------------- 矛盾
expect(
    "矛盾-全零驱动非零实测",
    [CalibSample((0, 0, 0), (1, 0, 0)),
     CalibSample((255, 0, 0), (1000, 0, 0)),
     CalibSample((0, 255, 0), (0, 1000, 0))],
    ids3, INFEASIBLE,
)
expect(
    "矛盾-满档实测强迫某路全零",
    [CalibSample((255, 0, 0), (0, 0, 0)),
     CalibSample((0, 255, 0), (0, 1000, 0)),
     CalibSample((0, 0, 255), (0, 0, 1000))],
    ids3, INFEASIBLE,
)

# 同一驱动配置给出两个互不相容的实测（两个 y 间隔足够远）
expect(
    "矛盾-同驱动两次实测冲突",
    [CalibSample((200, 100, 50), (100, 100, 100)),
     CalibSample((200, 100, 50), (900, 100, 100)),
     CalibSample((255, 0, 0), (1000, 0, 0))],
    ids3, INFEASIBLE,
)

# ---------------------------------------------------------------- 不唯一
expect(
    "不唯一-第3路不可观测",
    synth(R3, [(255, 0, 0), (0, 255, 0), (128, 128, 0)]),
    ids3, NON_UNIQUE,
)
expect(
    "不唯一-低驱动级舍入带宽",
    synth([(10, 10, 10), (20, 20, 20), (30, 30, 30)],
          [(1, 1, 1), (2, 1, 0), (1, 0, 2)]),
    ids3, NON_UNIQUE,
)
# 仅 200/255 的单路样本：R∈{999,1000} 都能四舍五入到同一实测
expect(
    "不唯一-非满档驱动的舍入歧义",
    synth(R3, [(200, 0, 0), (0, 200, 0), (0, 0, 200), (201, 53, 77)]),
    ids3, NON_UNIQUE,
)

# ---------------------------------------------------------------- 舍入边界
# 手造样本验证区间整数化：R=1000, d=127 -> 127000/255=498.04 -> y=498；
# 舍入带 [497.5, 498.5) 对应 R∈[999.0,1001.0) 与 [0,1000] 相交得 {1000}？
# 下界 ceil(255*497.5/127)=ceil(1000.5)=1001 >1000 —— 故换 d=126：
# 126000/255=494.12 -> y=494，带对应 R∈[998.99,1000.99)∩[0,1000]={999,1000}，多解
edge_ok = [CalibSample((126, 0, 0), (494, 0, 0)),
           CalibSample((0, 255, 0), (0, 500, 0)),
           CalibSample((0, 0, 255), (0, 0, 500))]
res = calibrate(ids3, edge_ok, time_limit_seconds=10)
assert res.status == NON_UNIQUE, res.status
print("[OK] 舍入带内多解 -> non_unique")

# 同一通道再补一个满档样本把 R1 钉为 1000，则 d=126 时实测必为 494（恰好一致，无矛盾）；
# 改成 492（落在 1000 的舍入带之外）即矛盾
edge_bad = [CalibSample((126, 0, 0), (492, 0, 0)),
            CalibSample((255, 0, 0), (1000, 0, 0)),
            CalibSample((0, 255, 0), (0, 500, 0)),
            CalibSample((0, 0, 255), (0, 0, 500))]
expect("舍入带外矛盾", edge_bad, ids3, INFEASIBLE)

# ---------------------------------------------------------------- 6 路
import random

random.seed(7)
R6 = [tuple(random.randint(0, 1000) for _ in range(3)) for _ in range(6)]
while any(all(v == 0 for v in t) for t in R6):
    R6 = [tuple(random.randint(0, 1000) for _ in range(3)) for _ in range(6)]
ids6 = ["A", "B", "C", "D", "E", "F"]
ds = [[random.randint(0, 255) for _ in range(6)] for _ in range(12)]
for i in range(6):
    ds[i] = [0] * 6
    ds[i][i] = 255
expect("6路12组唯一恢复", synth(R6, ds), ids6, UNIQUE, R6)

# 12 组但第 6 路从不点亮 -> 不唯一
ds2 = [d[:] for d in ds]
for d in ds2:
    d[5] = 0
expect("6路但一路不观测", synth(R6, ds2), ids6, NON_UNIQUE)

print("\n全部通过 ✔")
