"""LED 满档读数标定的 CP-SAT 反求核心。

问题
====
已知 n（3～6）路通道在 m（3～12）组样本下的整数驱动级
``d[j][i] ∈ [0, 255]``，以及实测的整数线性 RGB
``y[j][c] ∈ [0, 6000]``。实测值按

    y[j][c] = round( Σ_i R[i][c] · d[j][i] / 255 )

解释（四舍五入到整数），反求每路满档读数 ``R[i][c] ∈ [0, 1000]``，
且各路三色不全为零。

整数化
======
令 ``S[j][c] = Σ_i R[i][c] · d[j][i]``（非负整数）。四舍五入条件
``y − 1/2 ≤ S/255 < y + 1/2`` 等价于::

    2·S ≥ 255·(2y − 1)
    2·S ≤ 255·(2y + 1) − 1

因此整个模型完全是整数线性的（2S/255 永远不会落在 .5 上，
不存在舍入方向歧义）。

结论判定
========
1. 模型不可行 ⇒ 样本矛盾（infeasible）；
2. 存在一组解后，再强制“至少一个未知数与该解不同”重解：
   - 重解不可行 ⇒ 解唯一（unique）；
   - 重解仍有解 ⇒ 标定不唯一（non_unique）。
两次搜索只要有一次未能在时限内给出确定结论，就返回 unknown，
绝不把“没搜完”报告成无解或唯一。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ortools.sat.python import cp_model

# 结论状态
UNIQUE = "unique"
INFEASIBLE = "infeasible"
NON_UNIQUE = "non_unique"
UNKNOWN = "unknown"


class CalibrationError(RuntimeError):
    """标定器内部异常（矛盾/不唯一/超时不在此列，由状态字段表达）。"""


@dataclass(frozen=True)
class CalibSample:
    # 与通道同序的驱动级，每项 0～255
    drives: tuple[int, ...]
    # 实测整数线性 RGB，每项 0～6000
    measured: tuple[int, int, int]


@dataclass(frozen=True)
class CalibrationResult:
    status: str
    # 通道 ID（与入参同序）
    ids: list[str] = field(default_factory=list)
    # status == unique 时，与 ids 同序的满档 (R, G, B)
    readings: list[tuple[int, int, int]] = field(default_factory=list)
    message: str = ""


def _build_model(
    n: int, samples: list[CalibSample]
) -> tuple[cp_model.CpModel, list[list[cp_model.IntVar]], list[list[cp_model.IntVar]]]:
    """构造基础模型，返回 (model, R[i][c], S[j][c])。"""
    m = cp_model.CpModel()

    # 未知数：每路每色满档读数 0～1000
    rvars = [[m.new_int_var(0, 1000, f"R_{i}_{c}") for c in range(3)] for i in range(n)]
    # 各路三色不全为零
    for i in range(n):
        m.add(sum(rvars[i]) >= 1)

    # 每样本每色的加权和 S = Σ R·d
    svars: list[list[cp_model.IntVar]] = []
    max_s = 255 * 1000 * n
    for j, smp in enumerate(samples):
        row: list[cp_model.IntVar] = []
        for c in range(3):
            s = m.new_int_var(0, max_s, f"S_{j}_{c}")
            m.add(s == sum(rvars[i][c] * smp.drives[i] for i in range(n)))
            y = smp.measured[c]
            # round(S/255) = y  ⇔  y-1/2 ≤ S/255 < y+1/2（全部乘开写成整数式）
            m.add(2 * s >= 255 * (2 * y - 1))
            m.add(2 * s <= 255 * (2 * y + 1) - 1)
            row.append(s)
        svars.append(row)
    return m, rvars, svars


def _run(
    model: cp_model.CpModel, time_limit_seconds: float
) -> tuple[cp_model.CpSolver, int]:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.num_search_workers = 8
    return solver, solver.solve(model)


def calibrate(
    ids: list[str],
    samples: list[CalibSample],
    time_limit_seconds: float = 10.0,
) -> CalibrationResult:
    """按样本反求满档 RGB。

    返回 ``CalibrationResult.status``：
    ``unique`` / ``infeasible`` / ``non_unique`` / ``unknown``。
    """
    n = len(ids)

    # ---- 第 1 次：可行性 ----
    m1, rvars1, _ = _build_model(n, samples)
    solver1, st1 = _run(m1, time_limit_seconds)
    if st1 == cp_model.INFEASIBLE:
        return CalibrationResult(
            status=INFEASIBLE,
            ids=list(ids),
            message=(
                "样本矛盾：不存在任何 0～1000 的整数满档 RGB（各路三色不全为零）"
                "能同时解释全部样本（实测值 = Σ(满档读数×驱动级)/255 四舍五入）。"
                "请核对驱动级与实测读数后重录样本。"
            ),
        )
    if st1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return CalibrationResult(
            status=UNKNOWN,
            ids=list(ids),
            message=(
                f"搜索未完成：可行性判定在 {time_limit_seconds:g}s 内没有结论"
                f"（求解器状态：{solver1.status_name(st1)}）。"
                "尚不能判定无解或唯一，请增加样本或稍后重试。"
            ),
        )

    first = [
        tuple(solver1.value(rvars1[i][c]) for c in range(3)) for i in range(n)
    ]

    # ---- 第 2 次：强制与第一组解至少一处不同，检验唯一性 ----
    m2, rvars2, _ = _build_model(n, samples)
    differs = []
    for i in range(n):
        for c in range(3):
            b = m2.new_bool_var(f"diff_{i}_{c}")
            m2.add(rvars2[i][c] != first[i][c]).only_enforce_if(b)
            differs.append(b)
    m2.add(sum(differs) >= 1)

    solver2, st2 = _run(m2, time_limit_seconds)
    if st2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return CalibrationResult(
            status=NON_UNIQUE,
            ids=list(ids),
            message=(
                "标定不唯一：存在多组合法的满档 RGB 参数都能解释全部样本，"
                "无法确定真实读数。请补充更多样本（尤其让各路在不同驱动级下"
                "单独或组合点亮）后重新标定。"
            ),
        )
    if st2 == cp_model.INFEASIBLE:
        return CalibrationResult(
            status=UNIQUE,
            ids=list(ids),
            readings=first,
            message="标定成功：满档 RGB 已由整数约束证明唯一。",
        )
    return CalibrationResult(
        status=UNKNOWN,
        ids=list(ids),
        message=(
            f"搜索未完成：已找到至少一组合法参数，但唯一性检验在 "
            f"{time_limit_seconds:g}s 内没有结论"
            f"（求解器状态：{solver2.status_name(st2)}）。"
            "尚不能报告“唯一”，请增加样本或稍后重试。"
        ),
    )
