# 浸泡验证手册（Soak Runbook）

> A6 批交付。目标：为 R15（旧六层内联路由退役）采集 funnel 主路径 vs 旧路径的对照证据。
> 数据管道：`soakStore`（[src/stores/soakStore.ts](../src/stores/soakStore.ts)）订阅 `funnel:shadow-diff` / `funnel:routed`，
> 持久化到 vault `soak` 命名空间（各上限 500 条），工作台 RuntimePanel 实时汇总，可导出 JSON 报告。

---

## 1. 环境准备（本机实配）

### 1.1 Ollama（已安装，便携版）

| 项 | 值 |
|---|---|
| 版本 | 0.34.1（官方 zip 便携版，非安装器——本机安装器静默模式失败后改用解包版） |
| 位置 | `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` |
| 模型 | `qwen2.5:3b`（1.9 GB，中文场景；实测 CPU 推理 ~21 tok/s） |
| 端点 | `http://localhost:11434`（默认） |
| 推理设备 | CPU（Intel Iris Xe 核显被 Ollama 自动跳过；内存 15.7 GB） |

**启动服务**（zip 便携版无开机自启，每次使用前需启动）：

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ArgumentList 'serve' -WindowStyle Hidden
# 验证：curl http://localhost:11434/ 应返回 "Ollama is running"
```

**模型升级指引**：standard/pro 档（4096/8192 maxTokens）长文本生成质量不足时可换更大模型：

```powershell
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" pull qwen2.5:7b   # ~4.7 GB，需更高内存
```

### 1.2 应用侧接入（零配置降级链，已核实）

**无需配置任何 API provider**。代码路径（[apiStore.ts:479](../src/stores/apiStore.ts) → `tryDegradeChain` :437-467 →
[providerChain.ts:82-91](../src/services/providerChain.ts) 隐式端点）：

- 无可达 provider / 未配置模型 → 自动降级链 → 探测 `localhost:11434` → 走本地 Ollama
- 隐式端点探测成功后自动选用已拉取模型（`ollama list` 第一个）
- 本地调用费用记 0（`local=true` 记账，不消耗 token 预算的真实金额口径）
- 应用模型档位（nano 512 / mini 1024 / standard 4096 / pro 8192）是 **maxTokens 预算而非模型名**——单模型服务全档位

备选（显式配置，不依赖降级链）：设置页添加 provider，baseUrl `http://localhost:11434`，chatFormat `ollama`，模型 `qwen2.5:3b`。

### 1.3 启用浸泡采集

应用 DevTools 控制台执行后**重载应用**：

```js
window.electronAPI.vaultWrite('config', 'holo-funnel-shadow', '1')
```

验证：工作台 RuntimePanel"热插拔"区出现"浸泡验证"卡片，tag 显示"启用"。

---

## 2. 浸泡操作

1. **前置确认**（工作台 RuntimePanel）：
   - `funnel 主路径` tag = 开启（若显示"已回滚"，点击工作台导航开关恢复）
   - `浸泡验证` tag = 启用
   - Ollama serve 已启动（§1.1）
2. **日常真实使用**：正常对话，有意覆盖各类输入——
   - 通用闲聊/知识问答（explore 路径）
   - 明确单宏意图（"帮我生成会议纪要""考勤异常说明"等 → macro 候选）
   - 文件类任务（拖入文件 + 意图）
   - 模糊意图（触发候选选择/意图确认/槽位填充——暂停点类终点，产生 `match=null` 待人工核对样本）
3. **持续周期**：建议 ≥3 天、累计 ≥50 条自动判定样本（RuntimePanel 卡片"样本"计数不含待核对）
4. 数据持久化在 vault `soak` 命名空间（上限各 500 条），应用重启不丢

## 3. 报告导出与判读

RuntimePanel 浸泡卡片 → 点击"导出浸泡报告" → 生成 `Desktop\HoloStarmap\soak-report.json`：

| 字段 | 判读 |
|---|---|
| `summary.matchRate` | 一致率 = match / (match + mismatch)，**不含待核对样本** |
| `summary.manualReviewCount` | 暂停点类终点（旧侧走 system notice 无法自动判定），逐条人工核对 |
| `mismatchSamples` | 最近 10 条不一致样本（含 input / 双侧终点 / legacyTrail），每条应建立 P2 issue 处置 |
| `manualReviewSamples` | 最近 10 条待核对样本 |
| `byFunnelSource` / `byFunnelKind` | funnel 分源/分终点分布（检查覆盖面是否均衡） |
| `avgShadowDurationMs` | 影子对照额外开销（预期 < 数百 ms，不含 LLM 生成） |

**mismatch 处置流程**：记录 input + funnelEndpoint + legacyEndpoint → 判定哪侧语义正确 → 正确侧不一致则修另一侧（funnel 缺能力补 keywords/manifest；旧侧独有行为评估是否收编）→ 复测。

## 4. R15 退役判据

满足以下全部条件后，可启动**旧六层退役独立批**：

- [ ] 自动判定样本（match + mismatch）≥ 50 条
- [ ] 一致率 ≥ 95%
- [ ] 0 条未解释的不一致（每条 mismatch 均已归因并修复或判定为 funnel 正确）
- [ ] 待核对样本（暂停点类）人工抽查无系统性偏差

不达标：按 §3 处置 mismatch 后延长浸泡；旧路径回滚开关（`vault config:holo-funnel-main = '0'`）保留至退役批完成。

## 附录 A：数据清零

```js
// DevTools 控制台（重载后生效）
window.electronAPI.vaultDelete('soak', 'shadow-reports')
window.electronAPI.vaultDelete('soak', 'routed-records')
```

## 附录 B：Ollama 卸载（回滚环境变更）

```powershell
Get-Process ollama* | Stop-Process -Force          # 停服务
Remove-Item "$env:LOCALAPPDATA\Programs\Ollama" -Recurse -Force   # 程序（1.9 GB）
Remove-Item "$env:USERPROFILE\.ollama" -Recurse -Force            # 模型存储（~2 GB）
Remove-Item "$env:TEMP\deveco\ollama-windows-amd64.zip", "$env:TEMP\chocolatey\Ollama" -Recurse -Force -ErrorAction SilentlyContinue  # 安装介质
```

另：本批为解包安装器装了 Chocolatey 7zip（`choco uninstall 7zip -y` 可卸）。

## 附录 C：故障排查

| 症状 | 处置 |
|---|---|
| 浸泡卡片显示"未启用" | §1.3 的 vaultWrite 未执行或未重载 |
| 卡片样本数不增长 | shadow-diff 仅在 shadow 开关开启后产生；确认发消息后 eventLog 出现"影子对照"条目 |
| 对话报"API not ready" | Ollama serve 未启动（§1.1）或模型未拉取（`ollama list` 应含 qwen2.5:3b） |
| 生成极慢 | CPU 推理下 pro 档（8192 maxTokens）长输出需数分钟；正常现象或升级模型 |
| 导出失败 | 按钮显示"导出失败"；确认 `Desktop\HoloStarmap` 目录可写 |
