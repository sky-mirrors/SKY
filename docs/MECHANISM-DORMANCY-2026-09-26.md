# 机制休眠 / 半接体检（2026-09-26 快照）

> 目的：把「已实现但未被使用 / 没发挥其作用 / 半接」的机制摸清楚，供后续分波修复。
> 本表是**静态扫描快照**，真值以代码为准——动手前先按 `file:line` 复核（扫描只认字面名，见文末口径）。

## 一、结论

应用「实现了」的能力明显多于「接线 / 上屏」的能力。休眠集中在三类：**① 域处理层**（`registerHandler` 后全仓无请求方）、**② 服务层的管理 / 诊断 API**（缓存统计、路由分析、预算配置、约束访问器…）、**③ 一次性迁移**（写好了但从没被调用）。真正「该删的死码」很少——多数是「设计好的接口面」或「还没上屏的能力」，属取舍而非清理。

## 一之二、已落地（2026-09-26，本轮）

按「跑 + 上屏」决策：

- **§二 `knowledgeMigration` → 跑**：`migrateKnowledgePartitions()` 已接入启动（`src/App.vue`，紧随 `pruneExpired`）；版本守卫命中即 skipped，幂等。启动日志实测 `[knowledge-migration] partition 回填`。
- **§3.3 的管理 / 诊断 API → 上屏**：新增调试台「运行统计」面板（`src/components/DebugWindowPage.vue` + `src/stores/debugStore.ts` 的 `mechanismStats`），聚合 **semanticCache**（条数 / 命中率 / 节省 tokens / 自适应阈值）、**smartRouter**（路由样本数 / 过度路由率 / 自适应阈值）、**tokenBudget**（今日 / 本月花费 / 模式）、**domainConstraints**（激活 / 总数）四组既有 getter；经既有 `storeSync` 镜像到独立调试窗（DOM 实测渲染成功）。
- **仍不上屏的（§3.3 内）**：`toolRetrieval` / `nerExtractor` / `tokenEstimate` 那些是**内部 helper**（非「可上屏的对外面」），留作模块内实现，不建面板。

## 二、休眠模块（src 内零 importer，仅测试引用）：1

- `src/services/knowledgeMigration.ts`（M12 knowledge partition 回填，`migrateKnowledgePartitions`）——**待裁决**。读侧已把 `undefined` 兜底为 `user`（`knowledgeBase.ts:377` 的 `(e.partition || 'user')`），故回填**非必需**。要跑就在启动接线（模块自带版本守卫 + 备份 + 计数对账，幂等），不要就删。

## 三、死导出

### 3.1 本次已删（零引用零测试）

- `src/services/toolRetrieval.ts` 的 `rewriteQuery`——恒等 stub（`return query`）。
- `src/kernel/plugins/llm.ts` 的 `hasLLM`、`src/vault/index.ts` 的 `useVault`——死访问器（实际调用走 `getLLM` / 直接 import `vault`）。

### 3.2 真死但**故意不动**（cluster 模块形状契约）

`src/kernel/clusters/{route,cache,security,budget,fact}.ts` 里未被 `clusters.X.*` 调用的成员：`tryDirectCommand` / `tryQuickMatch` / `checkCapability` / `classifyInputDomain`（route）、`invalidate`（cache）、`shouldFactCheck` / `quickSafetyCheck`（security）、`estimateTokenCount` / `getMode`（budget）、`crossDocCheck`（fact）。它们是 `ClusterImpls` 的模块形状（`typeof defaultRoute` 等），删除会改动**设计接口面** ⇒ 归类「该裁」，留给你定。
（另：`src/exam/examCases.ts:25` 的 `EXAM_FIXTURE_DIR` 是文档性常量、零代码引用，留着无害。）

### 3.3 未接但被测（生产零调用、仅测试引用）：约 60（**待裁决**，多为「没上屏的管理 / 诊断面」）

按模块聚合（扫描所见，逐条待 grep 复核）：
- `semanticCache`（8）：缓存统计 / 阈值（getCacheSize / getCacheEntries / getCacheSavings / resetSavingsCounters / get+resetAdaptiveThreshold / invalidateExpired / setConfig）
- `smartRouter`（7）：路由分析（analyzeRoutingEfficiency / getRoutingHistory / clearRoutingHistory / getMaxTokensForComplexity / getTierForComplexity / get+resetAdaptiveThresholds）
- `tokenBudget`（8）：预算与成本记录（getBudget / setBudget / getTierWhitelist / setTierWhitelist / getDailySpent / getMonthlySpent / getCostRecords / resetSessionSpent）
- `domainConstraints`（5）：getActiveConstraints / getConstraintsByAutomationLevel / getExternalConstraintIds / LEGAL_CONSTRAINTS / FINANCE_CONSTRAINTS
- `constraintFeedback`（5）：getFeedbackLog / getFeedbackForConstraint / calculateFalsePositiveRate / calculateStatsForConstraint / clearFeedbackLog
- `toolRetrieval`（7）：isOnline / manifestFingerprint / segmentChinese / generateNGrams / keywordMatchScore / extractKeywordsFromDescription / raapMatch
- `nerExtractor`（4）：extractEntitiesByType / extractChineseNumberEntities / extractLawArticleEntities / extractCompanyNameEntities
- 零散：fileContext.destroyFileContextWatch、convMemory.clearConvMemory、storageMonitor.migrateVectorsToFiles、providerChain.clearProbeCache、l1Capabilities.describeRequiredL1、pipelineExecutor.getAllHandlers、scheduleOptimizer.getManifestStats、tokenPricing.loadPricingFromStorage、tokenEstimate.{estimatePromptTokens,getContextWindowBudget,truncateToTokenLimit}、writeGate.resetWriteGrantCache、zeroTokenLearning.clampThreshold、knowledgeBase.{getEntriesByOwner,searchKnowledgeInGroup}、errorClassifier.classifyErrorForUser、ollamaProvider.isOllamaFormat、memory.getConversations、promptTranslator.searchTaskCases、funnelGates.FUNNEL_GATE_DEFAULTS、strategySelector.countFinanceTerms

## 四、总线

### 4.1 死发射（有 emit 无 on）：9

- 8 个 `node:*` DAG / 星图通道（`dialogStore` 发、无监听）：`node:update-dag-step`、`node:set-dag-chain`、`node:clear-dag-chain`、`node:dag-chain-push-step`、`node:dag-chain-set-deps`、`node:mark-task-chain-complete`、`node:highlight-l2-candidates`、`node:set-l0-red-flash`——按既定口径「星图暂且不论」**暂缓**。
- `llm-degraded`（`src/services/providerChain.ts` 的 `emitDegraded`）——源码注释写明是「供域层 / 调试面板订阅」的扩展点；**用户可见**的降级通知走 `notification:add`（那条是通的）⇒ **保留**。

### 4.2 死监听（`registerHandler` 后无请求方）：31

- **已确认无请求方**（域处理层建了、但组件绕过它直接用 store）：`data:storage-breakdown` / `data:storage-total` / `data:export`（`src/domains/data/handlers.ts`；`DataManagement.vue` 里连 `globalBus` 都没有）、`session:get-active`、`mcp:list-tools`、`node:select-node`、`pipeline:start` / `pipeline:list`、`knowledge:get-entries` / `knowledge:get-groups`。
- `kernel:*` / `pack:*`（`hotplugStore` 的生命周期监听）——**待核**：发射方可能在主进程或别的总线，本扫描只覆盖 `src` + `electron` 里的**字面**通道名。
- 其余约 14 个多为 `request` 多行 / 变量名拼装的**误判**，需逐项复核。

## 五、方法与口径（可复跑）

脚本在 `~/.rivet/scratch/`（会话本地）：

- `scan-wave1.py`：「死导出」= 除定义文件外全 `src` 无该名（词边界）；再三分——`internal-only`（本文件自用）/ `unwired-tested`（仅测试引用）/ `truly-dead`（哪都没用）。「休眠模块」= `services|stores|composables` 下 `.ts` 在 `src` 内零 importer（**静态 `from` 与动态 `import()` 都算**——这点很关键，漏动态 import 会把 `imageRenameByDate`/`deliverableCheck`/`sessionMemoryContext` 误报为休眠）。
- `scan-bus-channels.py`：`globalBus.emit|request|requestAsync('chan')` 对 `registerHandler|on('chan')`。**已修**正则以覆盖 `request<T>('chan')`（原漏 → 14 个误报）。

**两把尺子都只认字面通道名 / 标识符**：多行调用、变量名拼装、经 registry 的成员访问之外的动态派发会漏。故本表对每类都单列了已知误报源；**动手前仍须 grep 复核**。
