# LED 混光配方台（本地）

以 **OR-Tools CP-SAT** 精确求解多通道 LED 混光的**最小总功率**配方；
**Python / FastAPI** 提供接口，页面为**原生 HTML / CSS / JavaScript**（无前端框架、无构建步骤）。

## 一条命令启动

```bash
docker compose up --build
```

启动后浏览器访问：

- 配方台页面：<http://localhost:8000/>
- 接口文档（Swagger UI）：<http://localhost:8000/docs>
- 健康检查：<http://localhost:8000/api/health>

停止：`Ctrl+C`（后台运行则用 `docker compose down`）。端口在
`docker-compose.yml` 中映射为宿主机 `8000`，如被占用可改成 `"8080:8000"`。

不使用 Docker 时也可本地运行（Python 3.11）：

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 使用说明

1. **通道录入**：3～6 路 LED，ID 唯一。
   - 满档线性 RGB：`0～1000` 整数，三色**不全为零**；
   - 满档功率：`1～10000 mW` 整数；
   - 可随时增删通道（3 路时禁止再删、6 路时禁止再加），“载入示例”恢复内置样例。
2. **满档读数标定（可选）**：不知道各路满档 RGB 时，在 ② 中录入 `3～12` 组实测样本：
   - 通道 ID 直接取自 ① 的当前通道表（无需重复录入）；
   - 每组含各路驱动级（`0～255` 整数）与实测整数线性 RGB（`0～6000`）；
   - 实测按 **`round(Σ(满档读数 × 驱动级) / 255)`**（四舍五入到整数）解释，
     CP-SAT 用纯整数约束反求每路 `0～1000` 的满档 RGB（三色不全为零）；
   - 结论分四种，页面分别明确报告：
     - **样本矛盾**：不存在任何合法满档读数能解释全部样本；
     - **标定不唯一**：存在多组合法参数（请增加样本，尤其让各路单独点亮）；
     - **搜索未完成**：时限内无确定结论时**不报告无解、也不报告唯一**；
     - **唯一**：只有整数模型证明解唯一时才显示各路读数，并可
       **一键写回当前通道表（保留原功率）**，随后直接进行 ③④ 的配方求解；
   - “生成示例样本”按当前通道表合成自洽样本（对角满档 + 混合驱动）。
3. **目标与容差**：目标线性 RGB 各为 `0～1000` 整数，共用整数容差 `0～20`。
4. 点击 **“求解最省功率配方”**：
   - 有解时显示目标/实际色块（标准 sRGB 传递函数）、各路驱动级、
     分量误差、逐路功率贡献与总功率；
   - 驱动级可直接手动修改，页面会按精确公式实时预览色块/误差/功率，
     “恢复最优驱动级”一键回到最优配方；
   - **无可行解时给出明确提示，不返回任何近似配方。**

## 数学模型

每路通道 i 的驱动级为整数决策变量 `d_i ∈ [0, 255]`。

- 各色实际线性分量（**不裁剪、不做四舍五入**）：

  ```text
  actual_c = (Σ_i reading[i][c] · d_i) / 255
  ```

  约束（两边同乘 255，全部写成整数线性式，令 `s_c = Σ_i reading[i][c] · d_i`）：

  ```text
  255·(target_c − tolerance) ≤ s_c ≤ 255·(target_c + tolerance)
  0 ≤ s_c ≤ 255·1000
  ```

- 总功率（mW）：

  ```text
  P = (Σ_i power_i · d_i) / 255
  ```

CP-SAT 分两阶段精确求解（见 `app/solver.py`）：

1. **最小化** `Σ_i power_i · d_i`（分母 255 为正的常数，不影响最优性）；
2. 在总功率等于最优值的解中，最小化按 **ID 字符串升序**排列的驱动级序列的
   **字典序**。实现上以 256 为基把序列编码为单个整数目标
   （每位数字 0～255 严格小于基数，编码与字典序一一对应；6 路时最大值
   `256⁶ − 1 ≈ 2.8×10¹⁴`，int64 安全）。

模型判定为不可行时，接口返回 `feasible: false` 且不带任何配方；
仅当 CP-SAT 确认最优（OPTIMAL）时才返回方案。

模型判定为不可行时，接口返回 `feasible: false` 且不带任何配方；
仅当 CP-SAT 确认最优（OPTIMAL）时才返回方案。

## 标定模型

反求满档读数 ``R[i][c] ∈ [0, 1000]``（各路三色不全为零）时，令

```text
S[j][c] = Σ_i R[i][c] · d[j][i]
```

第 j 组样本的实测整数 `y[j][c]` 满足 `round(S/255) = y`（四舍五入），
即 `y − 1/2 ≤ S/255 < y + 1/2`，两边乘开写成**纯整数线性约束**：

```text
2·S ≥ 255·(2y − 1)
2·S ≤ 255·(2y + 1) − 1
```

（`2S/255` 不可能落在半整数上，无舍入方向歧义。）

判定流程（见 `app/calibrator.py`，两次 CP-SAT 搜索）：

1. 求一组可行 `R`：不可行 ⇒ **样本矛盾**；时限内无结论 ⇒ **搜索未完成**；
2. 再求一组“与第一组至少一个未知数不同”的可行解：
   不可行 ⇒ **唯一**（才允许写回）；仍有解 ⇒ **标定不唯一**；
   时限内无结论 ⇒ **搜索未完成**（不冒充唯一）。

## API

### `POST /api/solve`

请求体示例：

```json
{
  "channels": [
    {"id": "R", "r": 1000, "g": 120, "b": 40,  "power_mw": 3200},
    {"id": "G", "r": 160,  "g": 1000, "b": 90, "power_mw": 2800},
    {"id": "B", "r": 60,   "g": 80,  "b": 1000, "power_mw": 3400},
    {"id": "W", "r": 820,  "g": 800, "b": 760, "power_mw": 6500}
  ],
  "target_r": 600,
  "target_g": 420,
  "target_b": 180,
  "tolerance": 12
}
```

响应主要字段：`feasible`、`channels[].drive`（驱动级，与输入同序）、
`sorted_ids`（字典序 tie-break 实际使用的 ID 顺序）、`actual_rgb`、`errors`、
`in_range`、`total_power_mw`、`power_num`（总功率的整数分子，实际功率
`power_num / 255`）。录入不合法返回 HTTP 422 并附字段级错误信息。

### `POST /api/calibrate`

通道只取 ID（标定**不涉及功率**，写回时前端保留各通道原 `power_mw`）；
样本 `drives` 与 `channels` 同序，每项 `0～255`，`measured` 每项 `0～6000`，
样本数 `3～12`。

```bash
curl -s http://localhost:8000/api/calibrate -H 'Content-Type: application/json' -d '{
  "channels": [{"id": "R"}, {"id": "G"}, {"id": "B"}, {"id": "W"}],
  "samples": [
    {"drives": [255,   0,   0,   0], "measured": [1000, 120,  40]},
    {"drives": [  0, 255,   0,   0], "measured": [ 160, 1000,  90]},
    {"drives": [  0,   0, 255,   0], "measured": [  60,  80, 1000]},
    {"drives": [  0,   0,   0, 255], "measured": [ 820, 800,  760]},
    {"drives": [128, 200,  64,  30], "measured": [ 739,  959,  431]},
    {"drives": [100, 100, 100, 100], "measured": [ 800,  784,  741]}
  ]
}'
```

唯一时的响应（`status` 为 `unique` / `infeasible` / `non_unique` / `unknown`
四者之一；后三者不带 `channels`）：

```json
{
  "status": "unique",
  "channels": [
    {"id": "R", "r": 1000, "g": 120, "b": 40},
    {"id": "G", "r": 160,  "g": 1000, "b": 90},
    {"id": "B", "r": 60,   "g": 80,  "b": 1000},
    {"id": "W", "r": 820,  "g": 800, "b": 760}
  ],
  "message": "标定成功：满档 RGB 已由整数约束证明唯一。"
}
```

- `infeasible`：样本矛盾，没有任何合法满档读数；
- `non_unique`：多组合法参数都能解释样本，需要补样本；
- `unknown`：搜索未完成，**不得**据此判定无解或唯一。

通道数/ID、样本数、驱动级与实测值类型与范围不合法时返回 HTTP 422
（布尔值、小数、缺失、越界均明确拒绝）。

## 显示说明

色块按**标准 sRGB 传递函数**显示：线性分量先除以 1000 归一化，再按
`c ≤ 0.0031308 ? 12.92c : 1.055c^(1/2.4) − 0.055` 编码为 8 位 sRGB。
若某个实际分量超出 0～1000（模型不裁剪），色块仅在显示时钳制到 0/255
并在悬停提示中说明；表格中的实际值与误差仍为未裁剪的精确值。

## 目录结构

```text
app/
  main.py        # FastAPI 应用与 /api/solve、/api/calibrate、静态页面挂载
  solver.py      # 配方：CP-SAT 两阶段精确求解
  calibrator.py  # 标定：CP-SAT 反求满档读数（唯一/矛盾/不唯一/未完成）
  schemas.py     # 请求/响应模型与录入校验
static/
  index.html   # 页面结构
  style.css    # 样式
  app.js       # 通道/样本编辑、标定与写回、求解、色块/误差/功率计算与手动预览
Dockerfile
docker-compose.yml
requirements.txt
test_solver.py       # 求解器冒烟测试（含 3 路穷举对照，可直接 python3 运行）
test_calibrator.py   # 标定器冒烟测试（唯一/矛盾/不唯一/舍入边界）
```

## 技术栈

- Python 3.11 / FastAPI / Uvicorn / Pydantic v2
- OR-Tools CP-SAT（`ortools` Python 包，自带原生求解器，镜像无需额外系统库）
- 前端：原生 HTML + CSS + 无依赖 JavaScript
