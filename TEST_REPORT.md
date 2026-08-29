# HoloStarmap 测试完全性验收报告

**报告日期**: 2026-08-22  
**测试框架**: Vitest v4.1.11  
**被测版本**: v0.1.0 (commit: current)  

---

## 1. 总览

| 指标 | 数值 |
|------|------|
| 测试文件数 | 5 |
| 总用例数 | 207 |
| 通过数 | 207 |
| 失败数 | 0 |
| **通过率** | **100%** |
| 被测源文件数 | 4 (services) + 1 (stores) + 1 (main.ts 逻辑) |
| 项目源文件总数 | ~25 |
| **文件覆盖率** | **~28%** |
| 发现并修复的Bug数 | 3 |
| 发现但未修的Bug数 | 4 |

---

## 2. 各模块测试明细

### L2 单元测试

| 文件 | 用例数 | 通过 | 覆盖函数/路径 |
|------|--------|------|---------------|
| errorClassifier.test.ts | 22 | 22 | classifyError() 关键词8类快速分类 + LLM fallback 4类 + 回退2路径 + 优先级 + fixHint |
| dualEngineValidator.test.ts | 20 | 20 | shouldValidate() 6路径 + buildActionManifest() 5路径 + 高风险短路3路径 + 缓存1 + LLM审核5路径 |
| scheduleOptimizer.test.ts | 42 | 42 | contentHash/truncate/compilePrompt/fillCompiledPrompt/computeInputFingerprint/computeStepPlan(simulateDataFlow/computeStepOutputHash/findDirtySteps/getTierConfig/computeParallelGroups/ValidationCache |

### L3 IPC集成测试

| 文件 | 用例数 | 通过 | 覆盖函数/路径 |
|------|--------|------|---------------|
| ipcSecurity.test.ts | 75 | 75 | isShellCommandAllowed() 白名单13 + 危险拦截14 + 安全node-e 5 + 非白名单4 + getTimeoutForCommand() 14 + HTTP方法白名单9 + HTTP超时7 + 内网拦截6 + file:read二进制检测3 |

### L4 混沌工程

| 文件 | 用例数 | 通过 | 覆盖函数/路径 |
|------|--------|------|---------------|
| chaos/dialogState.test.ts | 48 | 48 | 7暂停点进出8 + 随机暴力10种子10 + 互斥限制1 + 死锁检测5 + Promise安全8 + 极端场景7 + 状态隔离4 + 边界5 |

---

## 3. 测试中发现并修复的Bug

| # | 严重度 | 文件 | 行号 | 描述 | 状态 |
|---|--------|------|------|------|------|
| 1 | **高** | electron/main.ts | 589 | `Function(` 正则缺 `/i` 标志，`toLowerCase()`后 `Function`→`function` 绕过安全检测 | ✅ 已修复 |
| 2 | **中** | electron/main.ts | 656 | `mkdir` 不在 `QUICK_COMMANDS`，轻操作被当60s标准命令 | ✅ 已修复 |
| 3 | **中** | dialogStore.ts | 1617 | `requestRiskConfirm` 未暴露到 store 返回值，UI无法调用 | ✅ 已修复 |

---

## 4. 测试中发现但未修复的Bug

| # | 严重度 | 文件 | 描述 |
|---|--------|------|------|
| B1 | **高** | dualEngineValidator.ts:27-31 | `extractTargetFile` 正则无法提取 `node -e` 嵌套引号中的文件路径，匹配到闭括号`)` |
| B2 | **高** | dualEngineValidator.ts:111-113 | 双引擎验证器 LLM 失败/输出不可解析时**默认放行**，安全漏洞 |
| B3 | **中** | dialogStore.ts (7个暂停点) | 7个 awaiting* 标志无互斥锁，可同时激活7个暂停状态 |
| B4 | **低** | factGuard.ts:247 | `String.replace()` 自动纠正只替换首次出现，多出现场景只修第一个 |
| B5 | **低** | scheduleOptimizer.ts:191-196 | `resetManifestStats()` 写入不存在的属性 (`failureCount`/`cacheHits`/`cacheMisses`) |
| B6 | **低** | apiStore.ts:33-34 | computed 内有副作用（突变 `circuitBreaker.isOpen` 和 `failureCount`） |
| B7 | **低** | feedbackStore.ts:39 | async `.then()` 未 await，`sideEffects` 首次访问可能过时 |

---

## 5. 未覆盖风险清单

### 高风险（未测试）

| # | 模块 | 风险描述 | 预估影响 |
|---|------|----------|----------|
| H1 | macroExecutor.ts (976行) | **核心执行引擎零测试**：executeMacro 全流程、callToolDirectWithTier 5种工具类型、tier降级循环、错误分类再路由、retry_with_fix自动npm install、FactGuard集成、双引擎审核门控 | DAG执行失败/死锁/安全绕过 |
| H2 | dialogStore sendMessage/confirmPlan | **主对话流程零测试**：sendMessage 260行 + confirmPlan 630行，含RaaP匹配→意图翻译→槽位填充→DAG执行全链路 | 用户无法正常交互 |
| H3 | IPC 实际集成 | **未启动Electron主进程测试**：file:read GBK编码转换、shell:exec 实际spawn+超时SIGTERM→SIGKILL、http:fetch 实际网络请求+内网拦截 | 编码乱码/进程僵尸/SSRF |
| H4 | toolRetrieval raapMatch | **RaaP核心零测试**：向量搜索+关键词+反馈权重融合、3层置信度门控(green/yellow/red) | 匹配错误/误执行 |
| H5 | 端到端流程 | **无E2E测试**：用户输入→RaaP→宏执行→结果返回 完整链路 | 功能不可用 |
| H6 | 安全绕过 | **未测试编码绕过**：node -e Base64编码/unicode转义/模板字符串绕过安全检测 | 远程代码执行 |

### 中风险（未测试）

| # | 模块 | 风险描述 |
|---|------|----------|
| M1 | convMemory.ts | 对话压缩、shouldCompress、detectChallenge |
| M2 | feedbackStore.ts | undoExecution 移动文件、权重衰减、时间衰减 |
| M3 | mcpStore.ts | MCP stdio 连接生命周期、callTool 权限检查 |
| M4 | proactiveScheduler.ts | 主动预生成、manifestUsage日志 |
| M5 | debugStore.ts | replayFromProbe 重放执行、console monkey-patch |
| M6 | apiStore.ts | circuitBreaker open→half-open→close 完整周期、tiered timeout实际触发 |
| M7 | IPC: file:watcher | 文件监听 IPC |
| M8 | IPC: globalShortcut | Ctrl+Space 全局快捷键 |

### 低风险（未测试）

| # | 模块 | 风险描述 |
|---|------|----------|
| L1 | StarMap 3D渲染 | Three.js 场景/节点/交互 |
| L2 | 主题切换 | 深色/浅色主题 |
| L3 | 宏模板自定义 | 创建/编辑/删除 |
| L4 | 星图节点拖拽 | 拖拽重定位 |
| L5 | 对话导出Markdown | 导出功能 |
| L6 | 备份/还原 | zip打包/解包 |
| L7 | App.vue | 内存熔断 performance.memory 触发、嵌入模型状态球 |
| L8 | useThreeScene | 帧率自适应 document.hidden 降帧 |

---

## 6. 覆盖率估算

| 层级 | 被测模块 | 估算行覆盖率 | 估算分支覆盖率 |
|------|----------|-------------|---------------|
| errorClassifier.ts | 114行 | ~85% | ~80% |
| dualEngineValidator.ts | 115行 | ~70% | ~65% |
| scheduleOptimizer.ts | 412行 | ~55% | ~50% |
| main.ts (安全+超时逻辑) | ~200行(提取) | ~60% | ~55% |
| dialogStore.ts (暂停点) | ~80行(提取) | ~30% | ~25% |
| **其余20+文件** | ~8000行 | **0%** | **0%** |
| **项目整体** | ~9000行 | **~10%** | **~8%** |

---

## 7. 发布建议

### 判定：🔴 No-Go

**理由**：

1. **核心执行引擎 macroExecutor.ts（976行）零测试** — 这是整个应用的命脉，包含 DAG 执行、5种工具调用、tier降级、错误再路由等关键逻辑。未经验证不可发布。

2. **主对话流程 sendMessage/confirmPage（890行）零测试** — 用户交互的核心路径，包含 RaaP 匹配→意图翻译→槽位填充→DAG 执行全链路。

3. **IPC 实际集成零测试** — 所有 IPC 测试仅验证了提取出的纯函数逻辑，未启动 Electron 主进程验证实际的文件读取编码转换、进程超时终止、网络请求拦截。

4. **2个高风险Bug未修复** — extractTargetFile 正则失败 + 双引擎验证器默认放行。

5. **项目整体行覆盖率约10%** — 远低于可发布阈值（通常≥60%）。

### Go 前置条件（按优先级排序）

| 优先级 | 条件 | 预估工作量 |
|--------|------|-----------|
| P0 | 补充 macroExecutor.ts 单元测试（核心5种工具+tier降级+错误再路由） | 2-3天 |
| P0 | 修复 B1 (extractTargetFile) + B2 (双引擎默认放行) | 0.5天 |
| P1 | 补充 dialogStore sendMessage/confirmPage 集成测试 | 1-2天 |
| P1 | 补充 IPC 实际集成测试（Electron主进程启动） | 1-2天 |
| P2 | 补充 toolRetrieval raapMatch 测试 | 1天 |
| P2 | 补充 M1-M8 中风险模块测试 | 2-3天 |
| P3 | 行覆盖率提升至 ≥50% | 3-5天 |

---

*本报告仅基于实际执行的207个测试用例生成，未包含任何虚构或推测的测试结果。*
