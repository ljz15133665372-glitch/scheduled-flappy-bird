# Muse EEG 实时脑机接口流水线

单文件 Web 实现：从 muse-js 的原始 `eegReadings` 一路走到分类结果与反馈输出。
**全部算法为原生 JavaScript 手写，零第三方依赖**，双击 HTML 即可运行。

- 交付物：`outputs/muse-eeg-pipeline.html`（约 111 KB，自包含）
- 源码工程：`muse-eeg-pipeline/`（分模块开发 → 构建脚本合并成单文件）

---

## 1. 快速上手

1. 打开 `outputs/muse-eeg-pipeline.html`（浏览器直接打开，无需服务器）。
2. 点 **▶ 开始采集**：左上流程条的 6 个步骤会随数据流动依次点亮。
3. 点 **🎯 校准**：自动采集 4 秒睁眼 + 4 秒闭眼并训练分类器（约 17 个标注窗口）。
4. 观察右侧「分类输出」：闭眼时判为 **闭眼 / α 增强**，置信度同步刷新。
5. 点 **👁 注入眨眼** 看去伪迹效果；点 **⚡ 注入工频** 看陷波效果。

> 想看算法对比：关掉左侧「陷波」，PSD 上会立刻竖起 50 Hz 尖峰；关掉「ICA / 回归」，
> 眨眼时波形会出现巨大低频摆动。

---

## 2. 流水线数据流

```
muse-js eegReadings（12 样本/包，4 通道）
        │
        ├─(逐样本，实时)─► ① 带通 1–50 Hz + ② 50/100 Hz 陷波 ──► 时域波形显示
        │
        └─(每滑动一个 step)─► ③ 去伪迹（回归 → FastICA）─► ④ FFT 频带特征
                                     └─► ⑤ 分类器（LDA / SVM / MLP）─► ⑥ 反馈（界面 + HTTP POST）
```

- 采样率 **256 Hz**，包大小 **12 样本**，通道顺序 **TP9 / AF7 / AF8 / TP10**（与 muse-js 电极索引 0–3 一致）。
- 单位统一 **µV**。默认窗口 1.0 s、重叠 50%（即每 0.5 s 出一个分析窗口）。
- 分类标签：`0 = 睁眼 / 基线`，`1 = 闭眼 / α 增强`（依据 α 阻断效应）。

---

## 3. 算法实现要点

### 3.1 信号源与 muse-js 兼容（`01-signal.js`）

- `MuseSimulator`：1/f 噪声 + 10 Hz α 振荡（±35% 随机调频）+ θ + 眼动漂移 + 50/100 Hz 工频，
  眨眼为双指数 EOG 模板（主要落在 AF7/AF8）；支持 `setMode('open'|'closed'|'mixed')`、
  `injectBlink(µV)`、`injectHum(倍率)`。
- `parseMuseJson()`：兼容 muse-js 真实字段，容错解析
  - 通道字段：`eegChannel` / `channel` / `electrode`
  - 样本字段：`samples` / `values` / `data`
  - 外层：裸数组、`{eegReadings:[...]}` 包装、或逐行 JSON（NDJSON）
- `assembleRecording()`：按通道对齐成长度一致的 4×N 矩阵；完全缺失的通道补零，保证后续 DSP 可运行。

### 3.2 滤波（`02-dsp.js`）

- `Biquad`：RBJ 系数公式 + Transposed Direct-Form II（数值稳定，适合逐样本流式处理）。
- `FilterChain`：**每通道独立滤波器状态**，带通可选 2/4/6/8 阶（级联 Q 值经 `butterQ` 校正）。
- 陷波默认 50 Hz + 其谐波（100 Hz），Q 可调 8–60。
- 另备 `fft`（原地 radix-2）、`hann`、`detrend`、`psd`（Welch 平均，输出 µV²/Hz）、`goertzel`（单频幅值，用于工频对比）。

### 3.3 去伪迹（`03-artifact.js`）——两级串联

1. **回归法**：以 AF7/AF8 作为 EOG 代理，多元最小二乘估计传播系数 β，按 `shrink=0.95` 保守扣除，
   避免过度校正伤害脑电成分。
2. **FastICA**：中心化 → 白化 → deflation 式 tanh 不动点迭代 → 成分判定 → 剔除 → 最小二乘重构。
   成分伪迹判据（任一命中即剔除，且强制保留至少 2 个成分兜底）：
   - 峰度偏离高斯（|kurt − 3| 超过阈值，默认 6）
   - 低频占比过高（< 4 Hz 能量占比 > 0.6，典型眼动/漂移）
   - 与 EOG 代理通道高度相关
   - 高频占比过高（肌电特征）

### 3.4 特征（`04-features.js`）

频带划分：δ 1–4 / θ 4–8 / **α 8–13** / β 13–30 / γ 30–45 Hz。

| 特征集 | 维度 | 内容 |
|---|---|---|
| `ab` | 5 | 4 通道 α/β 比 + 全局平均 α/β |
| `bands` | 20 | 4 通道 × 5 频带**相对**功率 |
| `all`（默认） | 29 | 20 相对频带 + 4 通道谱熵 + 4 通道 α/β + 全局平均 α/β |

另有绝对频带功率、Hjorth 参数、峰值频率等可供面板/日志展示（未进向量）。

### 3.5 分类器（`05-classifier.js`）

`Model = 标准化 → PCA（可选）→ 分类器`，三种分类器可热切换：

- **LDA**：正则化闭式解（`lambda=0.05`），样本少时最稳，默认选项。
- **线性 SVM**：Pegasos 在线梯度下降。
- **MLP**：1 隐藏层（8 单元，tanh）+ sigmoid 输出，全批量反向传播（700 epoch，lr 0.08）。

**PCA 的必要性**：29 维特征在只有十几个校准样本时极易过拟合。当 `维度 > 样本数/3` 时自动启用 PCA，
降噪到最多 8 维并保持 ≥95% 方差。

训练后给出两个指标：**训练准确率** 与 **留一法（LOO）交叉验证准确率**——后者才是真实泛化能力。

### 3.6 反馈（`06-ui.js`）

- 界面反馈：判定文字 + 置信度条 + α/β 比值条 + 模型信息。
- HTTP 反馈：勾选「HTTP 回传」后，按 400 ms 节流 POST JSON 到指定端点（默认 `http://localhost:8080/eeg`），
  载荷含 `label / confidence / alphaBeta / t`。

---

## 4. 验证结果

两套自动化验证都在 Node 下运行，不需要浏览器。

### 4.1 算法自检 `node tools/selfcheck.js` —— 14/14 通过

| 项目 | 实测 |
|---|---|
| muse-js 包解析（数组 / eegReadings 包装 / 字段别名） | 通过 |
| 50 Hz 工频衰减 | **61.2 dB**（6.545 µV → 0.0057 µV） |
| 带通内 8–13 Hz 能量保留 | 100% |
| 眨眼回归法去除 | 峰值 42.6 µV → **10.9 µV**（↓74%） |
| 眨眼 ICA 进一步去除 | → **7.1 µV**（剔除 2/4 个成分） |
| 闭眼 vs 睁眼 α 相对功率 | **47% vs 18%** |
| 闭眼 vs 睁眼 α/β | **35.2 vs 1.3** |
| LDA 留一法准确率 | **98%** |
| 线性 SVM 留一法 | **95%** |
| MLP 留一法 | **95%** |
| 500 次在线推理耗时 | 12 ms |

### 4.2 页面端到端冒烟 `node tools/smoke-ui.js` —— 48/48 通过

用最小 DOM 桩真正加载全部 6 个模块并驱动渲染帧，覆盖：

- `init()` 执行、日志 flush、滤波器链描述
- 实时采集 → 分析窗口（6936 样本 / 53 个窗口）→ ICA 表格填充 → 无异常
- 注入眨眼 / 工频不报错
- 一键校准训练成功：**LDA 训练 94% / LOO 94%**（17 个窗口：睁眼 9 / 闭眼 8）
- 模型热切换（LDA → SVM → MLP）自动重训
- 开关联动：关闭陷波、关闭去伪迹、切换特征集、切换窗口长度
- HTTP 反馈确实发出请求到 `http://localhost:8080/eeg`
- JSON 回放模式解析 3200 个包并离线处理完成
- 真实设备入口 `NS.feedPacket`：逐电极攒齐 → 推入 2400 样本 → 触发 8 个分析窗口，
  字段别名（`eegChannel` / `channel` / `electrode` + `samples` / `values`）均可用
- 重置全部状态

---

## 5. 工程结构与重新构建

```
muse-eeg-pipeline/
├── build.ps1                 # 合并 src → outputs/muse-eeg-pipeline.html
├── src/
│   ├── index.html            # UI 结构 + CSS（含 <!-- INJECT_JS --> 注入点）
│   └── js/
│       ├── 01-signal.js      # 模拟信号源 + muse-js 包解析
│       ├── 02-dsp.js         # Biquad / Butterworth / 陷波 / FFT / Welch PSD
│       ├── 03-artifact.js    # 回归去眼电 + FastICA 伪迹剔除
│       ├── 04-features.js    # 频带功率 / 谱熵 / Hjorth
│       ├── 05-classifier.js  # Scaler / PCA / LDA / SVM / MLP
│       └── 06-ui.js          # 流水线编排 + 绘图 + 校准 + 反馈
└── tools/
    ├── selfcheck.js          # 算法数值自检（14 项）
    └── smoke-ui.js           # 端到端 DOM 冒烟（37 项）
```

重新构建（改完 `src/` 后执行）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File muse-eeg-pipeline\build.ps1
node muse-eeg-pipeline\tools\selfcheck.js
node muse-eeg-pipeline\tools\smoke-ui.js
```

构建规则：按文件名排序拼接 `src/js/*.js`，整体塞进一个 `<script>` 标签替换注入点，
以 **UTF-8 无 BOM** 写出单文件——因此最终产物不依赖任何相对路径，可直接分享。

---

## 6. 接入真实 Muse 设备

页面已内置 muse-js 字段解析，两种接法：

**A. 离线回放**：把 `eegReadings` 序列 JSON 化后粘贴到左侧「粘贴真实 muse-js 包」，点开始采集即可离线处理。

**B. 实时订阅**：页面已内置 `window.EEG.feedPacket(pkt)` 入口（逐电极攒齐后自动推进流水线，
渲染由动画帧接管，无需手动刷新），直接订阅 muse-js 的 `eegReadings` 即可：

```js
import { MuseClient } from 'muse-js';
const client = new MuseClient();
await client.connect();
await client.start();
client.eegReadings.subscribe(function (reading) {
  // reading = { index, electrode, samples: Float32Array(12), timestamp }
  // electrode: 0=TP9 1=AF7 2=AF8 3=TP10 —— 与页面通道顺序一致
  window.EEG.feedPacket(reading);   // 也可用 feedPackets([...]) 批量喂入
});
```

`feedPacket` 兼容字段别名：通道取 `eegChannel` / `channel` / `electrode`，
样本取 `samples` / `values` / `data`。返回值是本次实际推入的样本数（尚未攒齐 4 个电极为 0）。

> 注意：外部喂数据时不要在页面上同时点「开始采集」，否则模拟器与设备数据会交错进同一缓冲区。

注意：真实设备信号存在个体差异与电极阻抗波动，校准建议做 2–3 轮取平均；
`α/β` 阈值判据在个体间差异较大，以留一法准确率为准调整特征集与窗口长度。

---

## 7. 已知限制

- **分类器是教学/实验级的**：闭眼/睁眼二分类用于演示整条链路，不代表临床或产品级精度。
- **ICA 在短窗口上运行**：1 s 窗口只有 256 样本、4 个成分，ICA 估计质量受限；伪迹判定带安全阀
  （最多剔除 nCh−2 个成分）以避免误删全部脑电。
- **`FilterChain` 的群延迟估计为占位实现**（返回 0），因滤波为实时流式、无需时域对齐补偿。
- **`ML.explain` 的权重在启用 PCA 后不再对应原始特征名**，界面已在这种情况隐藏该提示。
- **无持久化**：未使用 localStorage，刷新即重置；校准数据保存在内存中。
- 模拟器的 α 幅度切换存在约 0.25 s 平滑过渡，混合模式下每段前后各 1.6 s 会被校准采样跳过。
