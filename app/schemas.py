"""FastAPI 的请求/响应数据模型（含录入校验）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator


def _reject_bools_and_floats(v: object, label: str) -> None:
    """在 Pydantic 强转之前拦截 bool / 非整数浮点（JSON 的 1.0 不算整数）。"""
    if not isinstance(v, list):
        return
    for x in v:
        if isinstance(x, bool) or (isinstance(x, float) and not x.is_integer()):
            raise ValueError(f"{label}必须是整数，不能是布尔值或小数")


class ChannelInput(BaseModel):
    id: str = Field(..., description="通道 ID，全局唯一")
    r: int = Field(..., ge=0, le=1000, description="满档线性 R")
    g: int = Field(..., ge=0, le=1000, description="满档线性 G")
    b: int = Field(..., ge=0, le=1000, description="满档线性 B")
    power_mw: int = Field(..., ge=1, le=10000, description="满档功率 (mW)")

    @field_validator("id")
    @classmethod
    def _strip_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("通道 ID 不能为空")
        return v

    @model_validator(mode="after")
    def _not_all_zero(self) -> "ChannelInput":
        if self.r == 0 and self.g == 0 and self.b == 0:
            raise ValueError("满档 RGB 不能全为零")
        return self


class CalibChannelInput(BaseModel):
    """标定只需要通道 ID（与页面当前通道一一对应，按序取值）。"""

    id: str = Field(..., description="通道 ID，全局唯一")

    @field_validator("id")
    @classmethod
    def _strip_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("通道 ID 不能为空")
        return v


class CalibSampleInput(BaseModel):
    drives: list[int] = Field(..., description="各路驱动级，与 channels 同序，0～255")
    measured: list[int] = Field(
        ..., min_length=3, max_length=3, description="实测整数线性 RGB，0～6000"
    )

    @field_validator("drives", mode="before")
    @classmethod
    def _reject_non_int_drives(cls, v: object) -> object:
        _reject_bools_and_floats(v, "驱动级")
        return v

    @field_validator("drives")
    @classmethod
    def _check_drives(cls, v: list[int]) -> list[int]:
        if any(not 0 <= x <= 255 for x in v):
            raise ValueError("每组样本的各路驱动级必须是 0～255 的整数")
        return v

    @field_validator("measured", mode="before")
    @classmethod
    def _reject_non_int_measured(cls, v: object) -> object:
        _reject_bools_and_floats(v, "实测 RGB")
        return v

    @field_validator("measured")
    @classmethod
    def _check_measured(cls, v: list[int]) -> list[int]:
        if any(not 0 <= x <= 6000 for x in v):
            raise ValueError("实测 RGB 必须是 0～6000 的整数")
        return v


class CalibrateRequest(BaseModel):
    channels: list[CalibChannelInput] = Field(..., description="3～6 路通道，ID 唯一")
    samples: list[CalibSampleInput] = Field(..., description="3～12 组标定样本")

    @model_validator(mode="after")
    def _check(self) -> "CalibrateRequest":
        if not 3 <= len(self.channels) <= 6:
            raise ValueError("LED 通道数必须为 3～6 路")
        ids = [c.id for c in self.channels]
        if len(set(ids)) != len(ids):
            dup = sorted({x for x in ids if ids.count(x) > 1})
            raise ValueError(f"通道 ID 必须唯一，重复 ID：{', '.join(dup)}")
        if not 3 <= len(self.samples) <= 12:
            raise ValueError("标定样本必须为 3～12 组")
        n = len(self.channels)
        for j, smp in enumerate(self.samples):
            if len(smp.drives) != n:
                raise ValueError(
                    f"第 {j + 1} 组样本的驱动级数量（{len(smp.drives)}）"
                    f"必须与通道数（{n}）一致"
                )
        return self


class CalibReading(BaseModel):
    id: str
    r: int = Field(..., ge=0, le=1000)
    g: int = Field(..., ge=0, le=1000)
    b: int = Field(..., ge=0, le=1000)


class CalibrateResponse(BaseModel):
    # unique / infeasible / non_unique / unknown
    status: str = Field(..., description="标定结论")
    channels: list[CalibReading] = []
    message: str = ""


class SolveRequest(BaseModel):
    channels: list[ChannelInput] = Field(..., description="3～6 路 LED，ID 唯一")
    target_r: int = Field(..., ge=0, le=1000)
    target_g: int = Field(..., ge=0, le=1000)
    target_b: int = Field(..., ge=0, le=1000)
    tolerance: int = Field(..., ge=0, le=20, description="共用整数容差")

    @model_validator(mode="after")
    def _check_channels(self) -> "SolveRequest":
        if not 3 <= len(self.channels) <= 6:
            raise ValueError("LED 通道数必须为 3～6 路")
        ids = [c.id for c in self.channels]
        if len(set(ids)) != len(ids):
            dup = sorted({x for x in ids if ids.count(x) > 1})
            raise ValueError(f"通道 ID 必须唯一，重复 ID：{', '.join(dup)}")
        return self


class ChannelSolution(BaseModel):
    id: str
    drive: int = Field(..., ge=0, le=255)
    r_full: int
    g_full: int
    b_full: int
    power_full_mw: int


class SolveResponse(BaseModel):
    feasible: bool
    target: list[int]
    tolerance: int
    # 字典序 tie-break 实际使用的 ID 顺序
    sorted_ids: list[str] = []
    channels: list[ChannelSolution] = []
    actual_rgb: list[float] = []
    errors: list[float] = []
    in_range: list[bool] = []
    total_power_mw: float | None = None
    power_num: int | None = Field(
        default=None, description="总功率的整数分子，实际功率 = 该值 / 255"
    )
    message: str = ""
