"""FastAPI 的请求/响应数据模型（含录入校验）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator


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
