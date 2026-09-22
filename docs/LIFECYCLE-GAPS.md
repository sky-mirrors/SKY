# 请求生命线走查暴露的问题清单

> 来源：对 [REQUEST-LIFECYCLE.md](./REQUEST-LIFECYCLE.md) 示例请求（财务分析报告，5 步 DAG）的全链路走查。每条问题带示例中的实际数值与 file:line 出处。快照日期：2026-09-19。
> 认领状态图例：✅ = 已被 MODEL-CAPABILITY-LEDGER-DESIGN.md（Phase A+B）认领，或已修复（注明批次）；📋 = Phase C/D 路线图已标记结构性解法；❌ = 无人认领；⚠️ = 属设计取舍但代价未被明文承认。
> 复核记录：G-2、G-4、G-8 三条已由主代理二次源码抽查坐实（2026-09-19）。
> G-16 已按坐实工序入册（2026-09-19）：memoryStore 432 行全文通读 + 消费方全库检索（含 useMemoryStore 解构调用排查，排除第三条路径）+ pipelineExecutor workspaceMemoryHandler 通读。
> **验收考试动态坐实（2026-09-20）**：G-16 经手术题三项实测坐实（exam-report.json 可交付率 5.6% vs 线 80%；surgical-report.json）；新增 F-1~F-5 与 EXAM-1 五条考试暴露缺陷入册（见文末「验收考试新发现」）。
> **A3 修复后复考（2026-09-21，非首考基线）**：可交付率 5.6% → **44.4%**（8/18），零干预率 **72.2%** ✓ 过线，平均耗时 25.8s ✓ 过线，仍 NO-GO（<80%）。三分布质变：路由误投 8→0、超时 abort 7→0，剩余失败全部为模型能力问题（文件操作拒答 3、答非所问"销售提案"模板 2、算术/计数错 2、执行偏差 2）。手术题 4/4：偏好注入 PASS、会话归属 PASS、重复任务=语义缓存命中（非蒸馏，符合 G-16 范围声明）。新发现 EXAM-6 入册。首考成绩单已被复考导出覆盖，首考关键指标以本文件与 surgical-report.json 存档为准；复考明细见 `../exam-report.json` 与 `../surgical-report-reexam.json`。
> **EXAM 批修复（2026-09-22）**：排序建议第 4/5 两项落地——P1-D 假完成核验（deliverableCheck 三态闸门三接入点）与 EXAM-1/EXAM-6/F-2/F-4 四项（考试状态迁 examStore + 完成即落盘、双写键退役、自动确认诚实化）。附带工程修复：typecheck 工程引用 TS6305（node 工程先行构建声明 + `emitDeclarationOnly` 杜绝源码树 .js 误产物）、better-sqlite3 类型声明补齐。1864 测试全绿（+15），typecheck 30 基线不变。
> **CHARTER 批（2026-09-22，纯文档）**：机制边界章程三份落位——小模型任务边界（判据三问+允许四类+红线四类+豁免登记）→ [MODEL-CAPABILITY-LEDGER-DESIGN.md](./MODEL-CAPABILITY-LEDGER-DESIGN.md) 第 0 章；六层路由嵌套调用权限（规则零：外层是兜底）→ [REQUEST-LIFECYCLE.md](./REQUEST-LIFECYCLE.md) 2.9 节；机制边界总册+架构调和总纲+重叠区仲裁决策清单 → [MECHANISM-BOUNDARIES.md](./MECHANISM-BOUNDARIES.md)。G-1/3/6/9/10/11/12/13/14/15 的边界承认文本现于 MECHANISM-BOUNDARIES.md 对应条目——**本批零状态改动**，P3 批（G-10/11/12/15）是否据此关闭留待用户裁定；O1-O8 仲裁决策清单待用户裁决（O9 已剔除：A3/P0-B 后超时唯一阶梯；O6 顺延代码批）。零代码，测试与 typecheck 基线无涉。

## 第一批：静默破坏价值（最严重）

### G-1 消费者截断悬崖——分析步骤只看得到文档的 6.7% ❌

S1 `read_file` 读入约 12000 字符财报全文，但 S2（standard 档消费者）经 `extractStepResult` 只吃到 **800 字符**（nano:300 / mini:600 / standard:800 / pro:2000，macroExecutor.ts:376-378）。整个流水线在分析一份它只看过开头的文档；用户以为"分析了财报"，实际营收分析只基于前 800 字。无任何机制检测或告知这个信息瓶颈。
结构性解法在 Phase D（map-reduce），但当前没有任何文档承认这个悬崖的存在。

### G-2 temperature 从未进入请求体——tier 确定性承诺是空的 ✅（H-2 已修）

`MODEL_TIER_CONFIG`（scheduleOptimizer.ts:309-314）定义 nano 0.1 / mini 0.3 / standard 0.5 / pro 0.7，probe 遥测也如实记录 `modelParams`（macroExecutor.ts:618）——但请求体只有 `{model, messages, stream, options.num_predict}`（ollamaProvider.ts:58-59/94-95），apiStore.ts 全文无 temperature。**Ollama 一直用自己的默认温度，nano 档"低温度保证确定性"的承诺从未兑现**。已二次复核坐实。
**修复**（H-2）：macroExecutor llm 步将 `getTierConfig(tier).temperature` 经 routingOptions 传入；apiStore/ollamaProvider 透传至请求体 `options.temperature`；未传时请求体等价现状（冷启动兼容）。测试：ollamaProvider.spec G-2 ×3、apiStore.spec H-1 批。

### G-3 FactGuard 保护窗口只有 5000 字 ❌

ground truth 从 `contextText.substring(0, 5000)` 抽取（macroExecutor.ts:519）——财报后半部分的金额/日期不在防幻觉保护范围内。与 G-1 叠加成最坏组合：模型看不全文档（可能编数字），FactGuard 也看不全（编了不拦）。且保护仅覆盖 targetRoles 含 `finance/legal/hr` 的 manifest。

## 第二批：记账不诚实

### G-4 overkill 把成功记成失败，qualityScore 语义倒挂 ✅（H-3 已修）

示例 S2 实际输出 621 token < 819（standard 上限 4096 × 0.2）→ overkill=true → ZOL 记 **failure**（smartRouter.ts:270-274），20 次窗口后触发阈值 ×1.05 收紧（zeroTokenLearning.ts）。但该次执行完全成功。同时 `qualityScore: overkill ? 5 : 3`（apiStore.ts:398）——**overkill 反而得更高分**，与 ZOL 的 failure 语义直接矛盾。已二次复核坐实。
**修复**（H-3）：ZOLOutcome.outcome 增加 `'overkill'` 第三信号——successRate 只统计 success/(success+failure)（执行成败口径诚实），overkillRate 单独计算；routingAdjustFn 改按 overkillRate 驱动阈值（>0.3 收紧 / <0.05 放松，与原 successRate<0.7/>0.95 触发点行为等价）；qualityScore 显式占位 0=未评测（原 overkill?5:3 系编造）。测试：zeroTokenLearning.spec G-4 拆分 ×4、apiStore.spec H-1 批。

### G-5 "实测成本"实为估算，缓存节省永远不可见 ✅（H-4 已修）

7 处 `recordOutcome` 传的 `actualCost` 全部是 `budgetResult.estimatedCost`（apiStore.ts:634/745/788/831/970/1088/1188；估算逻辑 tokenPricing.ts:61-67，输出按 `min(input×0.5, 上限)`）——账本中没有一条真实费用。`cacheHitTokens` 硬编码 0（ollamaProvider.ts:79-80），OpenAI 返回的 cached_tokens 虽被解析（apiStore.ts:812）但 debugStore 成本计算处硬传 0（debugStore.ts:131/134）——缓存节省在成本账上不存在。
**修复**（H-4）：`actualCostOf(usage, local)` 按实际 usage 经 calculateCost 计价（本地 Ollama 与记账口径一致记 0），7 处 recordOutcome 全部替换；cacheHitTokens 真实值经 record-cost 透传。测试：apiStore.spec H-1 批 ×2。

### G-6 双引擎审核的费效比倒挂 ❌

S1 一个本地 `read_file` 要付一次 **maxTokens 5000** 的审核调用（dualEngineValidator.ts:262-266）——审核比动作本身贵一个数量级；审核缓存 key 含 targetFile（`skillId|targetFile|operation|structHash`，scheduleOptimizer.ts:386-393），文件路径一换即 miss；审核 prompt 看不到文件内容，只看意图与路径。对低危本地读操作，这道门近乎纯开销。

## 第三批：机制承诺与实际行为的落差

### G-7 llm 步"4 次降档重试"是安慰剂 ✅（Phase A+B 靶心）

`pro→standard→mini→nano→rule`（macroExecutor.ts:34-39）降档只改 maxTokens/temperature——模型从头到尾是同一个（事实：tier 从不切换真实模型）。模型能力不够时，4 次尝试是对同一模型的重复失败。已由 MODEL-CAPABILITY-LEDGER-DESIGN.md 认领（无能力账本 → 无法换真正该换的模型；同源问题：降级链 models[0] 盲选、全链路无模型归因）。

### G-8 主聊天路径 traceId 断链 ✅（H-1 已修）

C-11 声称 traceId 贯穿数据层，但主对话调用 `api:chat-completion` 仅传 `{messages, stream, tools}`（dialogStore.ts:2036），无 routingOptions/traceId——**最常用路径的 record-cost 不带归因**；带 traceId 的记账只覆盖 pipeline/macro/funnel 路径。已二次复核坐实。
**修复**（H-1）：主路径及补充/总结调用点（dialogStore :2037/:2278/:2320）经 routingOptions 携带 traceId；apiStore 非流式/流式路径均透传至 record-cost。测试：apiStore.spec H-1 批。

### G-9 熔断/重试细节暗坑 ❌

每请求实际最多 1 次自动重试（递归关闭 retryOnFailure，apiStore.ts:644-648/845-849）；探测失败 TTL 60s（providerChain.ts:11）——短暂掉线的 Ollama 被标记 60s 不可用；anthropic 非流式硬编码 `max_tokens: 4096` 无视传入参数（apiStore.ts:675-682）。

## 第四批：结构脆弱性

### G-10 L0"零 token 层"藏着 LLM 调用 ⚠️

文件名归类用 maxTokens 32 的小调用（l0SkillRouter.ts:80-126），"零 token"名不副实。

### G-11 L1 近乎死层 ⚠️

硬编码 2 条规则（l0SkillRouter.ts:473-519），绝大多数请求穿透——六层漏斗实际是四层。

### G-12 L0.5 结构性排除多步 manifest ⚠️

仅单步 manifest 参与（l0SkillRouter.ts:449-455）——真正复杂的重复劳动（最该快的场景）永远付全价 L2 匹配；快车道只服务琐碎任务。

### G-13 指纹缓存重启即失忆 ❌

持久化只存 resultHashes，重载时 `results: {}`（scheduleOptimizer.ts:88/105）——auto-compile 晋级（10 次 + 80% 真实执行率）攒下的复用资产一重启就清零重攒，晋级机制收益大打折扣。

### G-14 全字符串指纹匹配零容错 ❌

`inputHash = contentHash(filePath+'|'+inputText+'|'+context)`（scheduleOptimizer.ts:123-126）——输入差一个字（"Q3"改"三季度"）即整体 miss，无模糊/部分命中。

### G-15 置信度门值全部未经校准 ⚠️

L0.5 门 0.8/0.9、L1 门 0.6、margin 0.10、green 0.95（funnel.ts:31、toolRetrieval.ts:285-287/506）均为启发式常量，无任何证据表明"0.8 置信 ≈ 80% 正确率"。它们是有数学外衣的直觉。

## 第五批：协作记忆循环断线（来源：会话复盘中的盲区之问，2026-09-19 补充）

### G-16 协作记忆循环断线——系统对用户永久失忆 ✅（A3/P0-C 已修偏好注入，2026-09-21）

> 修复范围说明：本批落地"偏好注入"断点（globalMemory.preferences 经 apiStore.chatCompletion 注入主路径，见 F-1 条目修复明细）。其余断点（高频术语零写入/隐式蒸馏/sessionMemory 只写不读/归档死函数）仍未修，留待后续批次——用户手动设置的偏好现已真实生效，但从行为中自动学偏好（与 EMA 同构的隐式蒸馏）未实现。
> **复考实证（2026-09-21）**：手术题 R1 偏好注入 PASS（"输出要简洁"下周报 106 token 干净收尾 vs 隔离对照 670 token 冗长+虚构）；R3+R4 重复任务第二次 2s 秒回为语义缓存命中（in=0 out=0 记账）而非隐式蒸馏——范围声明得到诚实验证（`../surgical-report-reexam.json`）。

三层记忆的容器齐全（session/project/global，vault 持久化，UI 面板俱备），但循环四断：

1. **globalMemory 零注入**：preferences/frequentTerms/promptTemplates 全库仅两处消费——memoryStore 自身与 DialogPanel UI 展示（DialogPanel.vue:435-450）。上下文构建器（getContextWindow，memoryStore.ts:312-330；memoryAdapter，337-351）只读 conversations+summaries；promptTranslator 全文无 memoryStore 引用。用户在面板手动设了"周报要简洁"，模型永远不知道。
2. **高频术语连写入方都没有**：addFrequentTerm（memoryStore.ts:219-227）全库零调用——"高频术语"区永远显示 0。
3. **sessionMemory 只写不读、归档是死函数**：经 bus 桥写入（dialogStore.ts:230/259 → addDialogMessage，cap 200 条），全库无读取方；archiveSession（memoryStore.ts:130-139）零调用——`holo-session-archive` 键从未被写入过。
4. **拉取通道也到不了偏好**：唯一活着的记忆通道 l1-workspace-memory（pipelineExecutor.ts:102-121，经 domains/memory/handlers.ts:13-15 bus 桥）只服务 getContextWindow（会话消息+摘要）——即使模型主动拉记忆，拿到的也只是聊天记录，不是用户存的偏好。

写入侧同样断：preferences 唯一写入方是面板"+"按钮（DialogPanel.vue:1571-1573）——没有任何机制从用户反馈/纠正/复用行为中隐式蒸馏（对比：机制级学习 EMA/指纹/预算全部自动）。**机制对自己全自动，对用户全手动，且手动也不接线。**

对目标用户的后果——"一个会话一个哲学"：会话内建立的协作约定无出口（归档死、无蒸馏机制），跨会话入口不可靠（偏好不注入、内容靠模型拉取）。信任死亡三步：第一次说"周报要简洁"做对了 → 第二次又给全文版 → 面板手动设偏好依然不理。结论是**"它记不住我，还骗我"**——死存储面板承诺了系统不兑现的事，属"失败/承诺必须显式兑现"的隐性违反，比单纯健忘更伤。

修复方向（记录在册，不展开）：globalMemory 注入上下文组装是小改动；零配置原则下偏好收集须走隐式蒸馏（从反馈/纠正/复用行为中自动学，与 EMA 同构）。**修复排序待成绩单数据**——活儿集重复任务题（同类活儿隔场做两次，第二次干预数应降）与偏好题（面板设"输出简洁"，行为应变）先行实测。

## 状态归档与优先级建议

### G-17 流式路径 ZOL 隔离缺失 ✅（EXAM 批已修）

EXAM 批设计侦查（2026-09-20）发现：非流式路径的 4 处 `recordOutcome` 均有 `!isBenchmarkTraffic` 守卫，但**流式两处收尾路径无守卫**——IPC 流式 `onDone`（apiStore.ts:1003 附近）与 Ollama NDJSON 流式收尾（apiStore.ts:1230 附近）的 `recordOutcome` 无条件调用，benchmark 流式流量会泄漏进 ZOL routingHistory，污染生产路由学习。benchmark 现仅走非流式故未发作，属潜伏缺口；exam 流量恰走流式主路径，不修则考试污染生产学习。
**修复**（EXAM-1/G-17）：引入 `isLearningIsolated = isBenchmarkTraffic || isExamTraffic`，流式两处补守卫（与非流式同口径），全部 8 处 recordOutcome 统一判定。测试：apiStore.spec「G-17：流式 benchmark 流量不写 routingHistory」。

| 编号 | 问题 | 认领状态 | 建议优先级 |
|---|---|---|---|
| G-2 | temperature 未发送 | ✅ H-2 已修 | ~~P0~~ 关闭 |
| G-4 | overkill/qualityScore 语义矛盾 | ✅ H-3 已修 | ~~P0~~ 关闭 |
| G-16 | 协作记忆循环断线 | ✅ A3/P0-C 已修（偏好注入落地，2026-09-21） | ~~P0~~ 关闭（高频术语隐式蒸馏仍留 P2） |
| G-5 | 成本全估算、缓存节省不可见 | ✅ H-4 已修 | ~~P1~~ 关闭 |
| G-1 | 800 字符消费者截断悬崖 | 📋 Phase D 结构解，短期至少需明文承认 | P1 |
| G-3 | FactGuard 5000 字盲区 | ❌ | P1 |
| G-6 | 双引擎审核费效比 | ❌ | P1 |
| G-8 | 主路径 traceId 断链 | ✅ H-1 已修 | ~~P1~~ 关闭 |
| G-17 | 流式路径 ZOL 隔离缺失 | ✅ EXAM 批已修 | ~~P2~~ 关闭 |
| G-7 | 降档安慰剂/盲选/无归因 | ✅ Phase A+B（审阅关卡中） | 已排期 |
| G-9 | 熔断/重试暗坑 | ❌ | P2 |
| G-13 | 指纹重启失忆 | ❌ | P2 |
| G-14 | 指纹零容错 | ❌ | P2 |
| G-10/11/12/15 | 设计取舍代价未明文化 | ⚠️ | P3（文档承认即可） |

**与现有问题体系的关系**：本清单与 `AUDIT-REPORT-2026-09.md`（P0/P1/P2/P3 审计）、`AUDIT-RECONCILIATION-2026-09.md`（对账）互补——审计文档按代码缺陷组织，本文按**机制承诺 vs 实际行为**组织；G-2/G-4/G-5 三条属"声称与实际不符"，直接违背项目"证据优先、如实披露"的机制哲学，建议作为独立小批次优先处理。

---

## 验收考试新发现（2026-09-20，EXAM 批首考 + 手术题）

> 首考 18 题固定集：可交付率 **5.6%**（1/18，仅 Q13 翻译类直连路径通过），零干预率 38.9%（口径失真下界），NO-GO。逐题数据与归因见 `../exam-report.json`；手术题与 F 系列证据见 `../surgical-report.json`。三分布：RaaP 误路由 8 题、超时 abort 7 题、错误自信完成 2 题。

### A3 修复后复考对照（2026-09-21，非首考基线，指纹缓存未污染实测——18 题全部真实调用）

| 指标 | 首考 (9/20) | 复考 (9/21) | 及格线 | 判定 |
|---|---|---|---|---|
| 可交付率 | 5.6% (1/18) | **44.4% (8/18)** | 80% | ✗（8 倍提升） |
| 零干预率 | 38.9%（口径失真下界） | **72.2% (13/18)** | 60% | ✓ 过线 |
| 平均耗时 | ~10s（失败快退） | **25.8s**（真实执行） | 120s | ✓ 过线 |
| 路由误投 | 8 题 | **0 题** | — | ✓ P0-A 实证 |
| 超时 abort | 7 题 | **0 题** | — | ✓ P0-B 实证 |

复考剩余 10 题失败全为模型能力/策略问题，瓶颈从"系统坏了"迁移到"模型太弱"（qwen2.5:3b）+ 工具调用策略：文件操作拒答 3（Q3/Q16/Q18——原生工具在位但 L0 探索路径不走工具调用）、答非所问 2（Q4/Q9 均输出"销售提案"模板，症状完全相同，疑似某 L2 宏/技能误触发，建议单独归因）、算术/计数错 2（Q17 加法 7006652→7008152、Q8 漏去重 13≠12）、执行偏差 2（Q14 该列清单却存"新建文档.docx"、Q15 写 Python 代码未执行）。手术题 4/4 结果见 `../surgical-report-reexam.json`。

### EXAM-1 考试器生命周期缺陷（模式切换孤儿化）✅（EXAM 批已修，2026-09-22）

examRunner 状态寄生于 RuntimePanel 组件实例（RuntimePanel.vue:299），App.vue:22-23 `<WorkbenchShell v-if="uiMode === 'workbench'">` 模式切换即卸载销毁：run() 闭包孤儿化跑完全程但 progress/report 不可达，成绩单无法导出（首考机器判卷结果因此丢失，成绩单为考后重建）。

**修复**：考试状态整体迁入 Pinia store（`src/stores/examStore.ts`）——runner/progress 生命周期与组件解耦，模式切换不孤儿化；run 收口（done/cancelled/error 均返回 report）即写 vault（`exam/holo-exam-report`），刷新/重启后 store 实例化时恢复上次成绩单（phase=done 可导出）；UI 补「重新开考」入口（不再要求刷新页面）。测试：examStore.spec ×8。

### EXAM-6 考试器进度绕过 Vue 响应性——完成后 UI 冻结、成绩单仅存内存（复考发现）✅（EXAM 批已修，2026-09-22）

examRunner.progress 为普通对象，runner 闭包内直接改 raw 对象（`progress.phase = 'done'`）绕过 ref 深层代理 set trap，不触发重渲染；考试期间靠 hotplugStore.eventLog 高频更新"顺带"刷新显示，流量停止后 UI 冻结在「第18题 执行中」（复考实际 10:58:41 已完成，11:05 仍显示 running；点「中止考试」亦无效，cancelled 同非响应式）。需手动触发面板内其他响应式控件才能刷出成绩单。与 EXAM-1 叠加 = 成绩单持续内存扣押。

**修复**：`createExamRunner(deps, { progress })` 支持注入外部 progress 对象——examStore 以 `reactive()` 代理注入，闭包改写直接触发 UI 重渲染（EXAM-6 病理消除）；中止按钮经 store 透传 cancel，响应性不再受组件生命周期影响。测试：examStore.spec「EXAM-6 reactive 注入」+ examRunner.progress.spec 接口契约 ×2。

### F-1 对话消息无会话归属 ✅（A3/P0-C 已修，2026-09-21）

消息 schema 无 sessionId（仅 id/role/type/content/timestamp），全局扁平数组。实测：发送后切换会话，路由/DAG 反馈弹入新会话；同一条消息被执行两次（双倍仲裁成本）；消息碎片散落两个会话。**P0**（用户视角"会话"不可信，G-16 的前置依赖）

**修复**（P0-C，G-16/F-1 同批）：
- `DialogMessage` 增加可选 `sessionId` 归属标记（vault 无 schema 校验，免迁移）
- dialogStore 新增请求级 `originSessionId`（镜像 activeTraceId 模式）：sendMessage 入口捕获发起会话，六个追加原语（addUserMessage/addAssistantMessage/addSystemNotice/addThoughtMessage/addToolLogMessage/updateMessageContent）经 `routeMessageToOrigin` 按归属路由——处理期间切换会话，响应写回原会话（sessionStore.appendSessionMessage），不污染新会话活动数组
- sessionStore 新增 `appendSessionMessage`/`updateSessionMessages`/`updateSessionMessage` 三原语；updateMessageContent 与 docx 附件异步改写对已路由消息按 id 改写原会话存储
- sendMessage 重入守卫（isProcessing 期间拒新请求；排队重发/考试顺序发题放行）+ DialogPanel onSend 统一守卫（Enter 路径 :237 原无禁用）
- 会话新建/切换统一收敛到 dialogStore.newSession/switchSession（返回目标会话；WorkbenchNav 原直接别名赋值 `messages = switched.messages` 系 P0-8 违例一并修复）
- 偏好注入（G-16 落地）：apiStore.chatCompletion 按 taskType 门控注入 `[用户偏好]` system 前缀（chat/llm_generate/未标注任务；exam/benchmark 隔离跳过；结构化输出"只输出JSON"跳过；防重复注入）；缓存键仅取 user 消息故不受影响
- 测试：`test/unit/dialogStore.session.spec.ts`（9 用例）、sessionStore.spec（C2 三原语）、apiStore.spec「P0-C5 隐式偏好注入」
- **复考实证（2026-09-21）**：手术题 R2 长任务发送后立刻新建会话切换，响应完整落原会话（246→260 条持久化）、新会话 0 条零污染、isProcessing 正常复位——首考 S1 的消息碎片散落/双倍仲裁成本已消除（`../surgical-report-reexam.json`）

### F-2 会话持久化双写不一致 ✅（EXAM 批已修，2026-09-22）

`dialog/holo-dialog-messages` 键被最后活跃会话 last-write-wins 覆盖（残缺），真身为 `session/holo-sessions` 内嵌数组（完整）——两处随时间发散，单一事实源缺失。**P1**

**修复**：双写键退役——`saveToStorage` 不再写 `dialog/holo-dialog-messages`，活动消息唯一持久化路径收敛为 `sessionStore.updateActiveMessages → session/holo-sessions`；`loadFromStorage` 移除旧键读取；`initSession` 承担遗留数据一次性迁移（会话空但旧键存在 → 迁入会话 → 删除旧键），并按拷贝恢复会话消息（断 P0-8 数组别名）。测试：dialogStore.session.spec F-2 ×3。

### F-3 shell 错误消息 GBK 乱码

工具失败消息以 GBK 字节流原样上屏（手术题 S3：「找不到文件」显示为乱码），失败原因对用户不可读。**P2**

### F-4 自动确认伪装成用户确认 ✅（EXAM 批已修，2026-09-22）

「✅ 用户确认，直接执行原生工具」在用户不在场/未点击时自动出现（手术题 S1 实锤：用户当时在另一会话）。承诺显式兑现原则被隐性违反；考试 11 题 DAG 暂停全部为自动确认，零干预率口径因此失真。**P1**

**修复**：`confirmPlan(autoExecuted)` 显式区分确认来源——三处自动执行路径（funnel autoExecutable / L0.5 高置信 / L0 Skill 探索）传 `true`，confirmPlan 内四处「✅ 用户确认」文案在自动路径下改为「⚡ 自动执行…（未经用户点击确认）」，debug probe 同步标注确认来源。测试：funnelMainPath.spec F-4 ×2（自动路径不含「✅ 用户确认」、用户路径保留原文案）。

### F-5 宏执行疑似阻塞新输入（观察级）

卡住的宏（步骤无失败行收尾）期间新消息疑似无法发出且无任何痕迹。待复现坐实；若坐实属交互级死锁。**P2（观察级）**

### 修复排序建议（A3 批）

1. ~~**P0** RaaP 仲裁误路由/无回退~~ ✅ A3/P0-A 已修（2026-09-21）：inputForm 门控四接入点 + llmFallback 预过滤 + A4 兜底 + 三模板 inputType 修正（inputForm.spec 24 用例/defaultKernel.spec/toolRetrieval.spec）
2. ~~**P0** 超时体系~~ ✅ A3/P0-B 已修（2026-09-21）：llmTimeouts.ts 统一阶梯（60/150/240/300s，cap 600s）四接入点收敛 + macroExecutor 删遮蔽阶梯 + TimeoutError 确定性归类 + llmTimeoutScale 设置页暴露（llmTimeouts.spec 13 用例/errorClassifier.spec 5 用例）
3. ~~**P0** G-16 记忆注入 + F-1 会话归属（同批）~~ ✅ A3/P0-C 已修（2026-09-21）：见 F-1 条目修复明细（dialogStore.session.spec 9 用例 + sessionStore/apiStore 扩展）
4. ~~**P1** 假完成核验~~ ✅ P1-D 已修（deliverableCheck.ts 三态核验：存在性/非空/相关性，dialogStore L0 收口 + 失败回退直答 + macroExecutor 宏收口三接入点 + 假成功清指纹防重放，fail-open；deliverableCheck.spec）
5. ~~**P1** EXAM-1 + EXAM-6 + F-2 + F-4~~ ✅ EXAM 批已修（2026-09-22）：考试状态迁 examStore（Pinia）+ reactive 进度注入 + 完成即落盘 vault/重启恢复 + 双写键退役收敛单一事实源 + 自动确认诚实化（examStore.spec ×8 / examRunner.progress.spec ×2 / dialogStore.session.spec F-2 ×3 / funnelMainPath.spec F-4 ×2）
6. **P2** F-3 + F-5
