# 机制体检：未使用 / 未发挥作用 / 作用不大 / 边界不清的机制（2026-09-25）

> 口径（用户 2026-09-25 指示）：测试只要**超过基线、不是回归**即可；重点转向「未被使用 / 还没发挥其作用 / 作用不大 / 边界不清晰」的机制。
> 方法：**机器扫描**（两个脚本，可复跑）而非读文档——项目文档里的"待办/未修"标记已被证明严重过期（快照 §〇 复核时发现六项早已修完）。
> 脚本：`~/.rivet/scratch/scan-bus-channels.py`、`~/.rivet/scratch/scan-dead-exports.py`（均只读 src/ 与 electron/）。

---

## 一、死总线频道（发射/监听不对称）

机器比对 `globalBus|bus` 的 `emit/request/requestAsync('X')` 与 `registerHandler('X')|bus.on('X')`：

| 类别 | 数量 |
|---|---|
| 有发射、无监听 | **18** |
| 有监听、无发射 | 43（含 generics 调用导致的**假阴性**，见下） |

### 已修（本轮，`domains/debug/handlers.ts`）
**`/debug` 斜杠命令是坏的**——`dialogStore.ts:1270-1284` 对 `debug:activate` / `debug:deactivate` / `debug:update-environment` 与 `dialogStore.ts:3354` 对 `debug:unfreeze-buffer` **只 emit、全仓无人监听**；真正的开关是 `debugStore` 的方法（App.vue / DialogPanel / DebugWindowPage 直接调）。⇒ 用户输入 `/debug` 会看到「🔍 调试模式已开启 — 输入 /debug 关闭」，**但调试模式并未开启（谎报）**。已按该文件既定模式（`on()` 桥接 + HMR disposer）接进 `debugStore`。RED→GREEN：`test/unit/debugHandlers.spec.ts` 4 例（修前 4/4 红）。

### 待处置
| 频道 | 位置 | 判读 | 建议 |
|---|---|---|---|
| `config:set-job-role` / `set-api-configured` / `set-knowledge-fed` / `mark-onboarding-complete` / `reset-onboarding` | `services/onboardingManager.ts:15-43` | **所属模块整体零消费者**（见第二节） | 随模块一并处置 |
| `llm-degraded` | `services/providerChain.ts:214` | **冗余**：同函数 `bus.request('notification:add', …)` 已把降级送达通知中心（`providerChain.ts:196` 注释自称"供域层/调试面板订阅"，但从未有订阅者）。**不是功能缺口** | 删广播，或接到调试台（`debug:log-event`）让降级在调试台可见 |
| `node:set-dag-chain` / `update-dag-step`(×12) / `mark-task-chain-complete`(×7) / `clear-dag-chain` / `highlight-l2-candidates` / `dag-chain-push-step` / `dag-chain-set-deps` / `set-l0-red-flash` | `stores/dialogStore.ts:1970-2580` | **125 节点星图的装饰性可视化**——发射密集、零监听 | 用户已明确「星图暂且不论」，**本轮不动** |
| `debug:activate/deactivate/update-environment/unfreeze-buffer` | 见上 | 已修 ✅ | — |

**扫描局限（避免误判）**：`requestAsync<T>('x')` 这类**带泛型**的调用不被我的正则捕获，故"有监听无发射"那 43 条里混有假阴性（如 `dialog:confirm-write` 实际经 `globalBus.requestAsync<WriteDecision>` 发出）。**用该表前须逐条 grep 复核**。

---

## 二、零引用导出（`services/` `stores/` `composables/`）

在 3 个目录内定义、而 src/ 其它文件**无任何词引用**的导出：**117 个**（不含 tests 计数，故"被测试用"的也会入列）。

### 已坐实的"真死"（模块级）

> ⚠️ **2026-09-27 复核：下表三项均已接线，本节标记作废**——onboardingManager（`App.vue:361` + `OnboardingWizard.vue:176/209/211` + `domains/config/handlers.ts:22-78`）、tokenPricing（`App.vue:332` `initPricingFromVault` + 设置页新增「计价」tab）、dagCheckpoint 读侧（`DialogPanel.vue:1699` 可恢复徽章 + `App.vue:336` `pruneExpired`）。残留死导出：`isStepComplete` / `resetOnboarding` / `loadPricingFromStorage`（仅 mock 引用）。
| 项 | 证据 | 判读 |
|---|---|---|
| **`services/onboardingManager.ts` 全模块** | `completeStep`/`isStepComplete`/`shouldShowOnboarding`（L9/28/45）全仓零消费者；而 `OnboardingWizard.vue` **自己手搓**了同一件事（直接 `configStore.setJobRole` / `markFirstLaunchDone` / `apiStore.addProvider`，`finish()` 在 L~180） | **同一功能两套机制**：一套（含 5 个 `config:*` 频道）整个是死的，且步骤语义还与 UI 不一致（模块有 `knowledgeFed` 步、UI 没有）⇒ **边界不清晰**。建议**删除模块**（另一套在跑且更完整），或反过来让 UI 复用它——二选一，不要并存 |
| `services/tokenPricing.ts` 的**用户计价层** | `setUserPricing`/`getUserPricing`/`resetUserPricing`/`loadPricingFromStorage`/`initPricingFromVault` 全零引用，且**全仓无计价 UI**。而 `calculateCost`（用默认单价）在 apiStore/debugStore/tokenBudget 广泛在用 | **写而不读**：`setUserPricing` 会落盘 `pricing/holo-user-pricing`，但**没有任何 load 被调用** ⇒ 即便有写入方，重启也丢。无 UI ⇒ 该层目前是残留。建议删除该层（保留 `getPricingForTier`/`calculateCostByTier`/`calculateCost`），或补 UI 并接 load |
| `services/dagCheckpoint.ts` 的 resume 读侧 | `getIncompleteCheckpoints`（=resume 候选查询）与 `pruneExpired`（24h 过期回收）零引用 | 写侧（`saveCheckpoint`/`getCheckpoint`）在用、且已有 `MAX_CHECKPOINTS=20` 上限 ⇒ **resume 机制半接**（H-11 在册："resume 无调用方"）。建议明确：要么接 resume，要么删读侧并承认"仅做上限淘汰" |

### 已坐实的"集群性半接"（可观测/可配置/可审计面未接线）
以下模块的**核心路径是活的**，但整片 get/set/reset/统计 导出零消费者 ⇒ 机制在跑却**看不见、也调不动**：

| 模块 | 零引用的"管理面" | 影响 |
|---|---|---|
| `services/constraintFeedback.ts` | `getFeedbackLog`/`getFeedbackForConstraint`/`calculateFalsePositiveRate`/`calculateStatsForConstraint`/`clearFeedbackLog` | 写侧活（`factGuard` → `processConstraintResults` → `checkAutoDowngrade`），**"误报率>30% 自动禁用 / >20% 自动降级"的自治在跑但结果无处可见、无法审计、无清理入口** |
| `services/semanticCache.ts` | `setConfig`/`getCacheSize`/`getCacheEntries`/`getCacheSavings`/`resetSavingsCounters`/`getAdaptiveThreshold`/`resetAdaptiveThreshold` | 缓存的命中/节省/自适应阈值全不可见、不可调 |
| `services/tokenBudget.ts` | `getBudget`/`setBudget`/`getTierWhitelist`/`setTierWhitelist`/`getRecommendedTier`/`downgradeTier`/`getDailySpent`/`getMonthlySpent`/`getCostRecords`/`resetSessionSpent` | 预算的配置/日周消耗/记录查询全不可见 |
| `services/smartRouter.ts` | `analyzeRoutingEfficiency`/`getRoutingHistory`/`clearRoutingHistory`/`getAdaptiveThresholds`/`resetAdaptiveThresholds`/`getMaxTokensForComplexity`/`getTierForComplexity` | 路由学习（ZOL）的执行历史/效率分析/阈值整定全不可见 |
| `services/tokenPricing.ts` | `getUserPricing` 等（见上） | 同模块 |

**统一建议**：这些面正是"**调试台 / 工作台**该消费的东西"。逐个补 UI 成本高；**建议先挑 1-2 个（首选 `constraintFeedback` 的自治审计——它有真实安全语义；次选 `tokenBudget` 的消耗面）接到既有 `debugStore`/工作台面板**，其余在文档中登记为"已具备接口、待接 UI"。

---

## 三、扫描局限与假阳性（用表前必读）

1. **tests 未计入引用**：如 `clearProbeCache`、`looksLikeWhitelistRejection` 零引用是对 **src/** 而言，`test/` 里有消费者。
2. **模块加载期自调用**：`services/proactiveScheduler.ts:43` 在模块顶层 `initProactiveScheduler().catch(()=>{})` ⇒ 导出虽零引用，**机制在跑**（勿误判为死）。
3. **barrel 重导出**：若某导出被 `index.ts` 再导出，我的计数会算作"有引用"（即漏报，不会误报死）。
4. **泛型调用**：`f<T>('chan')` 不被捕获（见第一节）。
5. **废弃但无害 vs 边界不清**：`sseParser` 的 `parseSSELines`/`extract*Delta` 4 个零引用导出，疑为被主进程 `streamUsage.ts` 取代的遗留——**属"该删"而非"该接"**。

---

## 四、本轮改动

- **`src/domains/debug/handlers.ts`**：接线 `debug:activate` / `debug:deactivate` / `debug:update-environment` / `debug:unfreeze-buffer` → `debugStore`。修掉 `/debug` 谎报。
- **`test/unit/debugHandlers.spec.ts`**：新增 4 例（修前 4/4 红 → 修后 4/4 绿）。
- 全量 `npx vitest run`：**145 files / 2260 passed / 2 failed**（2 例为在册环境失效 `hotplugAcceptance`；较基线 2256 **+4**）——**非回归**。`npm run typecheck` exit 0。
