# 请求生命线走查暴露的问题清单

> 来源：对 [REQUEST-LIFECYCLE.md](./REQUEST-LIFECYCLE.md) 示例请求（财务分析报告，5 步 DAG）的全链路走查。每条问题带示例中的实际数值与 file:line 出处。快照日期：2026-09-19。
> 认领状态图例：✅ = 已被 MODEL-CAPABILITY-LEDGER-DESIGN.md（Phase A+B）认领，或已修复（注明批次）；📋 = Phase C/D 路线图已标记结构性解法；❌ = 无人认领；⚠️ = 属设计取舍但代价未被明文承认。
> 复核记录：G-2、G-4、G-8 三条已由主代理二次源码抽查坐实（2026-09-19）。
> G-16 已按坐实工序入册（2026-09-19）：memoryStore 432 行全文通读 + 消费方全库检索（含 useMemoryStore 解构调用排查，排除第三条路径）+ pipelineExecutor workspaceMemoryHandler 通读。

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

### G-16 协作记忆循环断线——系统对用户永久失忆 ❌

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
| G-16 | 协作记忆循环断线 | ❌ | **P0**（对目标用户最致命；先实测确认，修复排序待成绩单） |
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
