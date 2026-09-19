# 模型能力账本与切换成本设计（Phase A+B）

> **项目**:HoloStarmap v0.1.0
> **文档性质**:机制层设计文档(实施前置审阅稿)
> **阶段**:Phase A+B | **状态**:待审阅
> **范围声明**:本文档只谈机制层。星图 UI 是机制实现之后的前端映射,任何"节点如何变亮/变暗/连线"的视觉表达均不在本文档范围内。

---

## 目录

1. [背景与问题陈述](#1-背景与问题陈述)
2. [机制哲学对齐](#2-机制哲学对齐)
3. [设计 A:模型能力账本](#3-设计-a模型能力账本)
4. [设计 B:切换成本模型](#4-设计-b切换成本模型)
5. [接线点与向后兼容](#5-接线点与向后兼容)
6. [参数表](#6-参数表)
7. [分阶段路线](#7-分阶段路线)
8. [测试策略](#8-测试策略)
9. [引入后的新问题与遗留问题](#9-引入后的新问题与遗留问题)
10. [代价与牺牲(明文账单)](#10-代价与牺牲明文账单)

---

## 1. 背景与问题陈述

### 1.1 机制层现状:九个事实(2026-09-19 复核)

以下事实全部经源码核实,构成本设计的出发点:

**事实 1:tier 只是 token 预算,从不选择具体模型。**
`MODEL_TIER_CONFIG`(`src/services/scheduleOptimizer.ts:309-317`)定义了 nano/mini/standard/pro 四档,但每档只携带 `maxTokens` 与 `temperature` 两个参数。`route()`(`src/services/smartRouter.ts:210`)按复杂度评分映射 tier 后,该 tier 仅用于预算检查(`checkBudget`)与成本记账——**每一次 LLM 请求,无论什么 tier,都打向用户配置的唯一 `activeModel`**。

**事实 2:第二个模型只出现在降级链,且是盲选。**
降级路径为 `apiStore.tryDegradeChain` → `buildProviderChain`(`src/services/providerChain.ts:66`)→ `probeChainTarget`(探测 `/api/tags`)→ `pickOllamaModel`(`src/services/providerChain.ts:153`):

```typescript
export function pickOllamaModel(target: DegradeTarget, probe: OllamaProbeResult): string {
  return target.models[0]?.id || probe.models[0]?.id || ''
}
```

`models[0]`——降级目标完全由模型列表的排列顺序决定,没有任何能力评估。

**事实 3:证据基础设施已存在,但没有模型归属。**
- `recordRoutingOutcome`(`src/services/smartRouter.ts:260`,`apiStore` 7 处调用:634/745/788/831/970/1088/1188)按 **tier** 记录执行结果(overkill/tokens/qualityScore);
- `saveExecutionFingerprint`(`src/services/scheduleOptimizer.ts:132`,`macroExecutor.ts:982/1179` 调用)按 **manifestId** 记录执行指纹;
- FactGuard(`runFactGuardV2`)与双引擎审计(`dualEngineValidate`,`macroExecutor.ts:526`)产生丰富的验证信号,但**没有任何一处记录"这次执行用的是哪个具体模型"**。

**事实 4:前缀缓存热度有现成埋点位,但未启用。**
`OllamaUsage`(`src/services/ollamaProvider.ts:24-26`)已定义 `cacheHitTokens`/`cacheMissTokens` 字段,当前硬编码为 `0`/`promptTokens`。

**事实 5:模型身份没有版本信息。**
`ModelInfo`(`src/models/index.ts:106`)仅有 `{id, name}`。而 Ollama `/api/tags` 实际返回模型 `digest`(内容哈希),当前 `probeOllama`(`src/services/ollamaProvider.ts:34-48`)将其丢弃。

**事实 6(2026-09-19 复核新增):benchmark 流量已与学习回路隔离。**
`apiStore` 的 `#5` 语义:benchmark 流量不进 `recordOutcome`→ZOL 路由学习(`apiStore.ts:632`)。**账本接线若放在 `recordOutcome` 内部,将自动继承该隔离**——这决定了账本证据采集的接线位置,并要求测试显式覆盖"benchmark 流量不写入账本"。

**事实 7(2026-09-19 复核新增):代码库已有 EMA 基础设施先例。**
M16 竞争模型引入 `QualityEmaStore`(`src/kernel/competition.ts:76-128`):pack 级质量 EMA,固定 `α=0.1`、初始 `1.0`、clamp `[0,1]`,vault namespace `packStats` **逐键**持久化,`EmaPersistence` 依赖注入接口,`load()` 带格式校验,outcome 常量 success=1.0 / failure=0.0 / negative_feedback=0.2。模型能力 EWMA 必须**结构对齐**该先例(见 3.7)。

**事实 8(2026-09-19 复核新增):预输出否决门已成为统一输出呈现点。**
A2-9/M6.5 引入 `presentExecutionOutput`(`src/stores/dialogStore.ts:787`)——所有执行输出经此呈现,被否决的输出**不入会话记忆、不入执行指纹**。否决事件构成第三个验证信号源(FactGuard/双引擎之外),且其"被拦输出不得进入指纹"的语义与账本复用归因天然一致。

**事实 9(2026-09-19 复核新增):traceId 已贯穿数据层。**
C-11 之后,probe/cost/soak 记录均携带请求级 `traceId` 按请求归因。账本事件应携带 `traceId` 与既有记录对齐,保证"为什么这个模型被降分"可回溯到具体请求。

### 1.2 由此产生的问题

模型网关对用户的机制承诺是"小模型快,大模型准"(`集成工具设计.txt` L1 表格)。在上述事实上,这个承诺是空的:

1. **不知道"谁准"**——没有任何机制能回答"这个模型在这类任务上表现如何";
2. **不知道"切换多贵"**——模型切换(降级、未来的多模型路由)导致的 KV 缓存驱逐/重载延迟、上下文重发,从不计入任何决策;
3. **降级不诚实**——盲选一个模型就装作能接手,违背"节点变暗"的降级哲学(该哲学的完整落地见 Phase C/D 后的诚实降级,第 7 章);
4. **上下文连续性靠重放**——降级后全量对话重发,违背记忆体的结构化状态哲学(Phase C 解决)。

### 1.3 定位:证据地基,不是终结

必须明确定位:**Phase A+B 不能终结"降级重读上下文"与"次级模型长上下文不可靠"这两个问题**(它们的结构性解法分别是 Phase C 上下文账本与 Phase D map-reduce)。A+B 交付的是:

- **立即可得**:修掉降级盲选这个确定性错误行为;
- **远期兑现**:为 C/D 提供决策依据——没有账本,C 不知道降级时提示应重建到什么程度,D 不知道 map 阶段该派哪个模型去。

| 原始担忧 | A+B 交付 | 诚实结论 |
|---|---|---|
| 前缀缓存碎片化 | 流水线内亲和 + 切换有价让降级更保守 | 部分解决;日常双模型交替的碎片化在 A+B 中不存在(因为尚无日常双模型机制),结构性终结依赖 Phase D 的角色分工 |
| 降级重读上下文 | 让"该不该切"更明智 | 未解决;切换发生后仍全量重读,结构性解法是 Phase C |
| 弱模型损失 KB/约束/执行 | 消灭"不知情地用弱模型" | 解决一半;所有候选都弱时仍只能"选最不差的","变暗进规则引擎"属后续阶段 |
| 次级模型长上下文不可靠 | 上下文桶能发现并回避 | 能发现(靠失败证据垫背)、能回避(回避后长上下文任务仍无人可派),结构性解决靠 Phase D |

---

## 2. 机制哲学对齐

本设计遵循 Holo 的四条机制层原则,并接受它们推出的硬约束:

| 原则 | 在本设计中的体现 |
|---|---|
| **证据优先于配置** | 能力判断不来自任何静态配置表,而来自真实执行积累的验证通过率;与 auto-compile"真实执行占比 ≥ 0.8 才晋级"同源——指纹体系的证据闭环从 manifest 级别下沉到具体模型级别 |
| **每层机制为省 token 而存在** | 切换成本显式定价后计入决策,碎片化从"免费副作用"变为"可见成本";流水线亲和消除流水线内的无意义切换 |
| **本地优先** | 切换成本默认按本地 Ollama 形态建模(KV 驱逐/重载延迟),远程 API 形态参数化支持;降级链本身即本地优先的体现 |
| **不过度工程** | 账本建在现有 fingerprintStore/manifestStats/vault 基础设施上;所有接线改动为可选参数/增量调用;典范性与路由效率信号本阶段**只记录不消费** |

**硬约束(由哲学直接推出):**

- H1:一切对用户不可见,零新增配置项。办公者用户不感知账本存在;
- H2:冷启动退化等价现状——账本为空时,降级行为与 `models[0]` 时代完全一致,系统**不会比现在更差**;
- H3:L0 规则路由永远第一顺位。能力账本只回答"必须调模型时调谁",不触碰"要不要调模型"。

---

## 3. 设计 A:模型能力账本

### 3.1 三信号:对"指纹命中率作能力代理"提案的修正

原始提案(以执行指纹命中率作为模型能力判断的代理指标)存在一个必须修正的混淆:

> **缓存命中率反映的是输入重复度,不是模型能力。** 产出万金油套话的弱模型可能命中率很高(输出都差不多,极易被后续执行命中),产出差异化结果的强模型反而 miss。

因此本设计将原始提案**分解为三个独立信号**,不塌缩为一个数字:

| 信号 | 定义 | 证据源 | 本阶段是否消费 |
|---|---|---|---|
| **能力** | 验证通过指示器的 EWMA(见 3.4) | 执行成败、FactGuard 结果、双引擎审计结果、overkill | **消费**——降级链排序 |
| **典范性** | 该模型产出被后续执行复用为指纹的比率 | `findCachedExecution` 命中事件归因到产出模型 | 只记录(后续 tier 晋级依据;马太效应预警见 9.4) |
| **路由效率** | 缓存命中率本身 | 指纹缓存/语义缓存命中 | 经 `recordRoutingOutcome` 既有通路喂给 ZOL 学习回路,**不新建机制** |

### 3.2 模型身份:digest 进 key(版本漂移防护)

账本 key 的归一化结构:

```
{providerBase}|{modelId}|{digest8}
```

- `providerBase`:baseUrl 去尾斜杠并小写(复用 `providerChain.normalizeBase` 的归一化规则);
- `modelId`:模型标识(Ollama 的 name,如 `qwen2.5:7b`);
- `digest8`:模型内容哈希前 8 位。来源:Ollama `/api/tags` 返回的 `digest` 字段(当前被 `probeOllama` 丢弃,需扩展捕获);无 digest 的 provider(OpenAI 格式远程端点)该段为 `na`。

**防护逻辑**:同名模型更新了量化版本/模型文件 → digest 变化 → 产生新账本条目 → 旧证据不再污染新模型的能力评估。代价是更新后账本清零重积累(已知权衡,见 9.2)。

配套改动:`ModelInfo` 增加可选 `digest?: string` 字段;`probeOllama` 映射时保留 digest。

### 3.3 数据结构

```typescript
// src/services/modelCapabilityLedger.ts

interface ModelKey {
  providerBase: string
  modelId: string
  digest8: string            // 'na' 表示无 digest 的 provider
}

interface TaskBucketStat {
  executions: number
  execFailures: number       // 执行失败:超时/报错/空输出——归因明确,直接降能力分
  validationFailures: number // 验证失败:FactGuard/双引擎拦截——归因有噪声,半权重计分
  retries: number
  promptTokensSum: number
  completionTokensSum: number
  latencyMsSum: number
  outputReuseCount: number   // 典范性:该模型产出的指纹被后续执行复用的次数
  lastUpdatedAt: number
}

interface ModelLedgerEntry {
  key: string                // "{providerBase}|{modelId}|{digest8}"
  globalStat: TaskBucketStat // 不分桶的全局统计(冷启动主依据)
  buckets: Record<string, TaskBucketStat>
  // bucket key: "{taskType}|{ctxBucket}",ctxBucket: 's'(<1k est tokens)/'m'(1k-8k)/'l'(>8k)
  capabilityEwma: number     // 能力信号,见 3.4
  switchLatencyEwma?: number // B 模块实测切换延迟(半衰期 1 天)
  unproven: boolean          // globalStat.executions < UNPROVEN_THRESHOLD(5)
}
```

### 3.4 失败分账与能力信号

**失败分账**(避免"任务难"与"模型差"的混淆):

| 失败类型 | 判定 | 计分方式 |
|---|---|---|
| `exec_fail` | 请求超时、HTTP 报错、空输出 | 归因明确(模型背锅),**全权重**计入 EWMA 降分 |
| `validation_fail` | FactGuard 拦截、双引擎审计不通过、预输出否决门拦截、overkill | 归因有噪声(可能是源文档问题、任务本身难) | **半权重**计入;且该桶样本量 `executions < VALIDATION_FULL_WEIGHT_MIN(10)` 时**不计分,只记录** |

**能力 EWMA**:

```
capabilityEwma = α × score(currentExecution) + (1 − α) × capabilityEwma
score: pass = 1.0 | exec_fail = 0.0 | validation_fail = 0.5(满足计分条件时)
α 由半衰期 7 天折算(与 routingHistory 7 天保留周期一致),按时间戳差逐次计算
```

冷启动:`executions == 0` 时 `capabilityEwma` 初始化为 0.5(中性先验),`unproven = true`。

### 3.5 公开 API

```typescript
recordModelExecution(key: ModelKey, event: {
  taskType?: string           // 无 taskType 时计入 global + 'general' 桶
  ctxBucket: 's' | 'm' | 'l'
  outcome: 'pass' | 'exec_fail' | 'validation_fail'
  retries: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
  traceId?: string            // 与 C-11 数据层对齐:按请求归因,可回溯到具体请求(事实 9)
}): void

recordOutputReuse(key: ModelKey): void
// macroExecutor 命中指纹缓存时调用,归因到产出该指纹的模型(依赖指纹的 stepModels 字段,见 5.1)

getCapabilityScore(key: ModelKey, taskType?: string, ctxBucket?: 's'|'m'|'l'): number
// 优先级:taskType+ctxBucket 桶 → taskType 桶 → globalStat → -1(无记录)
// unproven 返回 -1,与"证明弱"(低分)严格区分

pickRankedModels(candidates: ModelKey[], taskType?: string, ctxBucket?: 's'|'m'|'l'): ModelKey[]
// 排序规则:
//   1. 已证明模型按 getCapabilityScore 降序
//   2. unproven 模型以 ε=EXPLORATION_EPS(0.1) 概率(单一伯努利试验)整体插到首位——探索
//   3. 其余(无记录/unproven 未被探索选中)按 candidates 原序垫底
// 探索随机数必须可注入(测试传 mock Random),保证确定性可测

loadLedger(): Promise<void>
// vault 读取 + 历史恢复;写入走 debounce(1s)writeThrough
```

### 3.6 持久化

- 存储:vault(`vault.writeThrough('routing', 'holo-model-capability-ledger', json)` / `vault.readCache`),与 `smartRouter` 的 routingHistory 同模式同分区;
- 容量:条目上限 `LEDGER_MAX_ENTRIES = 200`,超出按 `lastUpdatedAt` LRU 淘汰;
- 载入时机:`initSmartRouter()` 附近的应用初始化阶段。

### 3.7 与既有 EMA 基础设施的关系(对齐 M16 QualityEmaStore)

代码库已有 pack 级质量 EMA 先例(`src/kernel/competition.ts:76-128`)。模型能力账本**结构对齐、语义区分**:

| 维度 | QualityEmaStore(pack 级,M16) | 本设计能力 EWMA(模型级) |
|---|---|---|
| 衰减 | 固定 `α=0.1`(按次衰减) | **时间感知半衰期 7 天**(低频执行场景下按次衰减过慢,且无法表达"昨天的证据今天打折") |
| 初始值 | `1.0`(乐观——pack 注册即信任) | `0.5`(中性——模型必须挣得信任,与 unproven 语义配合) |
| clamp | `[0,1]` | `[0,1]`(一致) |
| 持久化 | vault ns `packStats` 逐键 writeThrough | 本设计整体 JSON + debounce(条目含桶细分与多字段,逐键粒度不适用;模式同 routingHistory) |
| 可测性 | `EmaPersistence` DI + `clearForTest()` | 同样提供持久化注入 + `clearForTest()`(**采纳**) |
| outcome 常量 | success=1.0 / failure=0.0 / negative_feedback=0.2 | pass=1.0 / exec_fail=0.0 / validation_fail=0.5 |

**validation_fail=0.5 高于 negative_feedback=0.2 的理由**:FactGuard/双引擎/否决门拦截是结构化验证证据,可信度高于用户情绪化负反馈;但低于执行失败的确定性归因(超时/报错必然是模型侧问题),故取中间值 0.5。

两个 EMA 体系**正交互不干扰**:pack 级 EMA 回答"哪个技能包该胜出",模型级能力回答"该派哪个模型去执行"。

**第三个验证信号源**:预输出否决门(`presentExecutionOutput`,`dialogStore.ts:787`)的拦截事件按 `validation_fail` 计入账本——与 FactGuard/双引擎同账,归因到产出该输出的模型。M6.5"被拦输出不入执行指纹"的既有语义保证了否决产出不会进入复用归因,天然自洽。

---

## 4. 设计 B:切换成本模型

### 4.1 成本函数

```typescript
// src/services/switchCostModel.ts

interface SwitchCost {
  latencyMs: number
  tokenCost: number   // 折算为 token 数,便于与能力分归一合并
}

function estimateSwitchCost(
  fromKey: string | null,     // null = 会话首个模型,无切换成本
  toKey: string,
  ctxTokens: number,          // 当前上下文估算 token 数
  deployment: 'local' | 'remote',
  inputPricePerKToken = 0     // remote 形态由 tokenPricing 价目表查询
): SwitchCost
```

| 形态 | latencyMs | tokenCost |
|---|---|---|
| **local**(Ollama/vLLM) | 目标模型实测重载延迟 EWMA(`switchLatencyEwma`,无实测时用体量先验:模型名含 `0.5b/1.5b/3b/7b/14b` → 3s/5s/6s/10s/15s 档,其余 8s)+ `ctxTokens × 0.5ms`(KV 重新评估) | **0**(本地重发不花钱,只花时间) |
| **remote** | 800ms 网络先验 | `ctxTokens`(全部重计费;单价在排序处统一乘,此处只报 token 量) |

### 4.2 实测回写

```typescript
recordMeasuredSwitch(modelKey: string, measuredLatencyMs: number): void
// apiStore 在降级成功后记录"请求发出 → 首 token"耗时
// EWMA 半衰期 1 天;随账本一起持久化(ModelLedgerEntry.switchLatencyEwma)
```

已知局限:该耗时混入网络状况/服务器负载/提示长度因子,本地形态可控,远程形态基本是噪声(见 9.5)。

### 4.3 消费点 1:降级链排序

`pickOllamaModel` 新签名(context 参数可选,保证向后兼容):

```typescript
export function pickOllamaModel(
  target: DegradeTarget,
  probe: OllamaProbeResult,
  context?: {
    taskType?: string
    ctxTokens?: number
    fromModelKey?: string | null
  }
): string
```

排序算法:

1. `probe.models` 全部构造 `ModelKey`(digest 来自扩展后的 probe 结果);
2. `pickRankedModels` 得到能力有序候选;
3. 对前 3 名计算 `estimateSwitchCost`;
4. 最终序 = `capabilityScore − λ × normalizedSwitchCost`,其中 `normalizedSwitchCost = tokenCost/1000 + latencyMs/10000`(两分位归一到 0.x 量级),λ = `SWITCH_COST_LAMBDA(0.15)`;
5. 返回第一名 `modelId`。

**退化保证**:context 缺省时退化为纯能力排序;账本全空时退化为 `models` 原序——即现状行为,但仅限冷启动期。

### 4.4 消费点 2:流水线内模型亲和

`macroExecutor` 执行 L2 manifest DAG 时:

1. 执行开始确定 `pipelineModel`:默认 = activeModel;
2. **仅当同时满足以下全部条件**时选择已证明的便宜模型:
   - 活跃 provider 探测结果中存在**其他**模型;
   - 该模型 `unproven === false` 且能力分 ≥ activeModel 的能力分(或 activeModel 无记录);
   - 当前 manifest 的 `maxTier ≤ 'mini'`(低档任务才值得用便宜模型);
3. 执行内所有步骤固定使用 `pipelineModel`——亲和不需要逐步计算切换成本,固定本身就是"切换成本无穷大"的表达;
4. 任一条件不满足 → 进入 4.5 流水线级探索判定;探索未触发 → `pipelineModel = activeModel`,行为与现状 **100% 一致**。

**明确不做**(属 Phase D):按步选模型、全局 tier→模型映射、用户配置界面。

### 4.5 流水线级探索(企业双模型形态的拟合加速)

**动机**:ε 探索若只挂在降级事件上(4.3),会出现"可靠性冻结拟合"的死锁——主模型越可靠 → 降级越罕见 → 备选模型长期 unproven → 4.4 的亲和永远无法触发。企业双模型部署(主模型强且稳、备选为专用小模型)恰好落入此死锁,必须提供第二条探索通路。

**规则**:manifest 执行开始时,若 4.4 未命中,且:
- 活跃 provider 上存在 `unproven === true` 的其他模型;
- 当前 manifest 的 `maxTier ≤ 'mini'`;

则以 `PIPELINE_EXPLORATION_EPS` 概率(单一伯努利试验,随机数可注入)将整条流水线交给该模型执行。**整条流水线只做一次探索决策**——流水线内所有步骤仍固定同一模型,亲和原则不变。

**风险边界**:
- 只发生在低档任务(maxTier ≤ mini)——探索失败的爆炸半径被任务档位限制;
- FactGuard/双引擎审计照常生效——大错仍会被拦截;
- manifest 自带的 `fallbackStrategy`(retry/skip/ask_user)照常兜底执行失败;
- 探索产出的 exec_fail/validation_fail 全部进入账本——这正是要采集的证据,失败即拟合。

**与 4.3 降级探索的关系**:两条通路共用账本、互不干扰;4.5 让小模型在低风险任务上"练兵",4.3 在降级时消费练兵成果。企业双模型形态下,4.5 是主要证据来源,4.3 是主要消费场景。

---

## 5. 接线点与向后兼容

### 5.1 改动清单

| 文件 | 改动 | 兼容性保证 |
|---|---|---|
| `src/services/modelCapabilityLedger.ts` | **新建**:3.3-3.6 全部内容 | 纯增量 |
| `src/services/switchCostModel.ts` | **新建**:4.1-4.2 全部内容 | 纯增量 |
| `src/models/index.ts` | `ModelInfo` 增加可选 `digest?: string`;按需导出 `ModelKey`/`SwitchCost` 共享类型 | 可选字段,零破坏 |
| `src/services/ollamaProvider.ts` | `probeOllama` 映射时保留 digest | ModelInfo 扩展,零破坏 |
| `src/services/scheduleOptimizer.ts` | `ExecutionFingerprint` 增加可选 `stepModels?: Record<number, string>`(步骤号 → 账本 key);`saveExecutionFingerprint` 增加可选参数透传 | 持久化向后兼容:读旧 JSON 时 `stepModels` 为 `undefined`,判空跳过 |
| `src/services/providerChain.ts` | `pickOllamaModel` 按 4.3 新签名改造,import 账本与切换成本 | context 可选;`apiStore.ts:419/453/1210` 三处调用同步更新 |
| `src/stores/apiStore.ts` | ① `recordOutcome` 内调用 `recordModelExecution`(归因到当次实际模型,含降级目标;**事件携带 traceId**;接线于 `recordOutcome` 内部以自动继承 benchmark 流量隔离——事实 6);② `tryDegradeChain` 成功后调用 `recordMeasuredSwitch`;③ 三处 `pickOllamaModel` 调用传入 context(taskType 取自 routingOptions,ctxTokens 取自 estimatedInput) | 新增调用性质,不改返回值 |
| `src/stores/dialogStore.ts` | `presentExecutionOutput` 否决分支调用 `recordModelExecution(validation_fail)`,归因到产出该输出的模型(事实 8) | 新增调用,不改呈现逻辑 |
| `src/services/macroExecutor.ts` | ① 指纹保存透传 stepModels;② 命中指纹缓存时 `recordOutputReuse` 归因到产出模型;③ FactGuard/双引擎验证结果按失败分账回写;④ 4.4 亲和 + 4.5 流水线级探索 | ④ 无证据且探索未触发时走原路径,零行为变化 |

### 5.2 全局兼容承诺

- **所有对既有函数的改动均为可选参数或新增调用**,不存在签名破坏(除 `pickOllamaModel` 的可选第三参数,缺省行为已定义);
- 冷启动(账本空)时:降级排序退化为 models 原序、流水线亲和退化为 activeModel——**系统行为与改动前完全一致**;
- 测试基线 89 文件/1699 用例(2026-09-19 实测)不破坏;providerChain 既有测试需同步 mock 账本依赖。

---

## 6. 参数表

全部以具名常量集中定义于各服务文件头部,禁止散落魔法数字:

| 常量 | 值 | 含义 | 调参指引 |
|---|---|---|---|
| `UNPROVEN_THRESHOLD` | 5 | globalStat.executions 低于此值 → unproven | 升高→更保守,探索更多 |
| `EXPLORATION_EPS` | 0.1 | unproven 模型插首位的探索概率 | 降低→更少差结果、更慢积累 |
| `PIPELINE_EXPLORATION_EPS` | 0.2 | 流水线级探索概率(仅 maxTier≤mini 且存在 unproven 备选) | 高于降级探索:低档任务风险有界,值得更快拟合 |
| `CAPABILITY_HALF_LIFE_MS` | 7 天 | 能力 EWMA 半衰期(对齐 routingHistory 7 天保留) | — |
| `SWITCH_HALF_LIFE_MS` | 1 天 | 切换延迟 EWMA 半衰期 | — |
| `VALIDATION_FULL_WEIGHT_MIN` | 10 | 验证失败开始计分的桶最小样本量 | 升高→更抗噪声、更迟钝 |
| `SWITCH_COST_LAMBDA` | 0.15 | 切换成本惩罚系数 | 升高→更粘当前模型 |
| `LEDGER_MAX_ENTRIES` | 200 | 账本条目上限(LRU) | — |
| `CTX_BUCKET_BOUNDS` | 1000 / 8000 | 上下文桶边界(est tokens) | — |
| `LOCAL_SWITCH_PRIOR_MS` | 体量分档 3000/5000/6000/10000/15000/8000(兜底) | 无实测时的本地重载延迟先验 | 按模型名启发式匹配 |

以上均为**初始经验值**,预期在真实使用中校准;如后续接入 ZOL 式自适应再议,本阶段不自动调参。

---

## 7. 分阶段路线

```
Phase A+B(本文档)          Phase C                    Phase D
能力账本 + 切换成本    →    上下文账本:降级时     →    map-reduce 角色分工:
(证据地基)                  从结构化 ledger 重建          便宜模型只做短上下文 map
                            最小提示,不重放对话          强模型只做综合 reduce
                                 ↓                          ↓
                          诚实降级(节点变暗):        tier 与账本冲突的裁决机制
                          无能力证据的降级目标          (证据 vs 用户偏好的优先级)
                          进规则引擎,不静默接手
```

**依赖关系**:
- C 依赖 A——"重建到什么程度"需要账本知道目标模型的能力边界;
- D 依赖 A——"map 派谁去"需要账本的长上下文桶证据;
- 诚实降级依赖 A 成熟(账本有足够证据才能负责任地说"没人能干")。

**已知张力(标记给 C/D)**:账本按具体模型建档案,路由按抽象 tier 决策。A+B 阶段两者仅在降级链与流水线亲和两个点交汇,无冲突;C/D 铺开 tier→模型绑定时,必须回答"tier 说该用 standard、账本说这个模型在该任务上不行"的裁决问题,以及"用户手动偏好 vs 账本结论"谁赢的问题。**本阶段明确不回答,只标记。**

---

## 8. 测试策略

| 层 | 内容 |
|---|---|
| **新单元测试** `test/unit/modelCapabilityLedger.test.ts` | EWMA 衰减(构造时间序列断言收敛);digest 变更 → 旧条目隔离、新条目清零;执行失败/验证失败分账(validation_fail 在样本 <10 时不降分);unproven 冷启动返回 -1;ε 探索确定性(mock 注入 Random);LRU 淘汰;旧持久化数据兼容(stepModels 为 undefined 的指纹 JSON 可正常载入);`pickRankedModels` 排序稳定性;**benchmark 流量隔离**(benchmark 请求不写账本,继承 apiStore #5 语义);**持久化注入与 clearForTest**(对齐 QualityEmaStore 可测性模式) |
| **新单元测试** `test/unit/switchCostModel.test.ts` | local/remote 双形态成本;体量先验分档;实测回写 EWMA;λ 惩罚排序(构造能力分高但切换贵的候选,验证被压后);fromKey=null 零成本 |
| **接线测试**(macroExecutor/dialogStore 既有测试文件扩展) | 4.4 亲和触发条件;4.5 探索确定性(mock Random)、仅限 maxTier≤mini、整条流水线单次决策、探索失败时 fallbackStrategy 兜底;**否决门信号**(`presentExecutionOutput` 拦截 → validation_fail 入账,归因正确) |
| **回归** | `npm test` 全量 89 文件/1699 用例(2026-09-19 实测基线);providerChain 既有测试同步更新(mock 账本与切换成本模块) |
| **类型** | `npm run typecheck`(vue-tsc,两个 tsconfig)0 error |
| **冒烟(可选)** | `npm run dev` + 本地多模型 Ollama,断开主 provider 触发降级:降级目标应为账本排序结果;debug 面板可见 ledger 记录 |

---

## 9. 引入后的新问题与遗留问题

本章是明文承诺:引入 A+B 不是免费的,以下问题会**新出现**或**继续存在**。

### 9.1 探索成本(新出现)

ε-greedy 探索有两条通路:**降级级**(4.3,ε=0.1)与**流水线级**(4.5,ε=0.2,仅低档任务)——**用真实用户体验换系统知识**。冷启动期用户遇到"偶尔更差"的概率上升,且 4.5 使探索不再限于降级场景。缓解:流水线探索仅在 maxTier≤mini 任务上发生 + FactGuard 拦大错 + manifest fallbackStrategy 兜底。残留:试探出"这模型不行"的结论可能要花数次失败。

**未来缓解路径的代码库先例已存在**(本阶段不实施,仅标记):影子评估零副作用铁律(`competition.runShadowEvaluation`)与浸泡管线模式(`soakStore`,config 门控 `holo-funnel-shadow` + 结构化报告 + traceId 关联 + 人工复核样本)证明"不惊扰用户的对照评估"在此代码库是可行形态。将来的模型影子验证(离线对照跑两模型、只记证据不影响用户)可复用该模式,把 9.1 的探索成本从"用户付费"转为"机器付费"——依赖使用场景中存在可廉价重放的请求流,故仍留给后续阶段。

### 9.2 证据滞后与 digest 清零的代价(新出现)

能力 EWMA 半衰期 7 天意味着能力变化要几天才能反映;digest 进 key 后,**每次模型文件更新,该模型的全部能力证据清零重积累**——频繁更新模型的用户会长期处于冷启动态。这是版本漂移防护的镜像代价,选择"宁可错杀证据,不可错信过期证据"。

### 9.3 小样本误判(新出现,已缓解)

unproven 阈值 5 次仍偏低;验证失败的归因噪声(源文档问题被算到模型头上)由失败分账缓解,但不能根除——桶维度(taskType)部分隔离"任务难"混淆,小样本下噪声依然存在。

### 9.4 典范性信号的马太效应(潜在,已隔离)

常被选的模型积累更多复用记录 → 更常被选,即使能力持平。本阶段典范性**只记录不消费**,正是为了不让这个循环进入决策;将来消费时必须引入机会校正(类似 Thompson sampling 对探索的补偿)。

### 9.5 切换延迟测量的混入因子(新出现)

首 token 耗时混入网络/负载/提示长度,本地形态可控,远程形态基本是噪声。EWMA 平滑但不能分离因子——远程形态下切换成本估计的置信度低,λ 惩罚实际起作用的主要是 tokenCost 项。

### 9.6 tier 与账本的语义张力(遗留,标记给 C/D)

见第 7 章。A+B 不处理,但 C/D 必须回答。

### 9.7 收益范围依赖后续阶段发生(遗留)

如果真实用户群(企业办公者)永远只配一个本地模型,账本只在降级场景生效,流水线亲和几乎不触发(不存在第二个已证明模型)。**A+B 在单模型现实下是轻量补丁,在多模型未来下是地基——价值兑现依赖 C/D 是否发生。这是投资判断,应在批准本文档时清醒做出。** 例外:企业双模型部署形态(附录 A)下,4.4/4.5 在本阶段内即激活并形成证据正循环,A+B 的价值无需等待 C/D 即可兑现。

### 9.8 原始问题中未解决的部分(遗留)

- 降级后全量重读上下文(→ Phase C);
- 所有候选都弱时的诚实降级/变暗(→ 依赖账本成熟);
- 次级模型长上下文/多文件的结构性方案(→ Phase D)。

---

## 10. 代价与牺牲(明文账单)

批准本设计 = 接受以下账单。

### 10.1 立刻支付(一次性)

| 项 | 量级 |
|---|---|
| 实施与审阅时间 | 2 个新服务 + 7 个文件接线(含 dialogStore 否决门)+ 2 个测试文件,估 700-900 行新代码;全量测试回归 |
| 代码库简单性 | 认知负担从"看规则"变为"理解统计机制"(EWMA、三信号、ε-greedy、失败分账)——"不过度工程"预算被实际消耗一块 |

### 10.2 持续支付(运行时)

| 项 | 量级 |
|---|---|
| 冷启动探索期体验波动 | ~10% 降级机会用于试探,部分产出差结果(9.1) |
| 记账开销 | 每次执行 recordModelExecution/EWMA 更新(微秒级)+ vault 持久化(KB 级)——技术上可忽略 |

### 10.3 本质性牺牲(设计无法消除,只能接受或拒绝)

1. **可解释性从"逻辑可审计"降为"统计可审计"**——`models[0]` 任何人一眼看懂;账本排序后,"为什么这次选了它"需要查 EWMA 状态、探索随机数、桶命中情况。出问题的排查路径变长,debug 面板必须暴露账本内部状态。
2. **fail-closed 哲学的第一道裂缝**——ε-greedy 是 Holo 中第一个"明知未证明还主动尝试"的机制。在降级场景可辩护(本来就没有已证明选项),但它是原则性让步,需清醒批准。
3. **未来架构的部分锁定**——账本 key 结构、三信号、桶定义将成为 C/D 的既成事实;若 C/D 推翻这些结构,改地基比现在贵得多。
4. **"证据与配置冲突时谁赢"被推迟,没有被回答**——A+B 阶段该问题不存在(无多模型配置界面),但它藏在必然要打开的抽屉里(9.6)。

### 10.4 不需要牺牲的(设计中守住的)

- **现有行为零变化**:所有改动可选参数化,冷启动退化等价现状;单模型用户体验与今天完全一致;
- **零新增用户配置**(用户不可见约束守住);
- **1699 测试基线**不破坏;
- **回滚能力**:两个新服务删除即回滚;vault 新 key(`holo-model-capability-ledger`)独立于现有 key,删除无副作用;接线改动可最小撤销。

---

## 附:与既有机制的关系图

```
                    ┌─ L0 规则路由(不触碰,H3)
                    ├─ L0.5 关键词匹配(不触碰)
请求 → 路由漏斗 ────┼─ 缓存查找(命中 → recordOutputReuse / 路由效率信号喂 ZOL)
                    ├─ smartRouter.route()(不触碰:tier 逻辑不变)
                    └─ LLM 调用(apiStore.chatCompletion;benchmark 流量按 #5 隔离,不进账本)
                          ├─ 成功/失败 → recordModelExecution(携带 traceId) [A·证据采集]
                          ├─ 降级链 → pickOllamaModel(账本排序 − λ·切换成本) [A+B·消费点1]
                          │              └─ 降级成功 → recordMeasuredSwitch [B·实测回写]
                          └─ L2 manifest DAG(macroExecutor)
                                ├─ 执行开始 → pipelineModel 亲和/探索决策 [B·消费点2 + §4.5]
                                ├─ 每步执行 → stepModels 归属 [A·证据采集]
                                ├─ FactGuard/双引擎 → validation_fail 半权重分账 [A·证据采集]
                                ├─ 预输出否决门(presentExecutionOutput 拦截) → validation_fail [A·证据采集]
                                └─ 指纹命中 → recordOutputReuse [A·典范性]
```

---

## 附录 A:企业双模型部署形态(预训练小模型 + 专业训练大模型)

企业将自训练的两个模型(小模型 + 大模型)接入 Holo,是 A+B 价值兑现最快的部署形态。本附录给出该形态下的预期拟合动态、可靠性特征与企业侧配套纪律。

### A.1 拟合速度:为什么更快

| 机制原因 | 效果 |
|---|---|
| **冻结 digest** | 自训练模型是不再变动的制品——账本 key 稳定,证据只增不减,§9.2 的"更新即清零"镜像代价基本消失 |
| **企业负载高重复性** | L2 场景胶囊的本质就是重复劳动(合同审查/周报/财报解读),`(modelId × taskType × ctxBucket)` 状态空间小且被高频访问,unproven 阈值(5)在重复工作流上数天内跨越 |
| **探索空间有界** | 只有一个备选模型,ε 试探很快遍历;4.5 流水线级探索让小模型在低档任务上持续练兵,不依赖降级事件 |
| **亲和正循环** | 小模型证明后,maxTier≤mini 的 manifest 稳定路由给它 → 证据加速积累 → 分工进一步固化 |

### A.2 投产可靠性:为什么更可靠

- **降级链退化为确定性已知对**:双方 proven 后,降级目标永远是"能力已知、切换延迟实测(非先验)"的那个模型,λ 惩罚项被真实测量校准;
- **桶级能力图 = 诚实的分工地图**:小模型在窄任务类型上证明强、在长上下文桶崩塌,路由自动利用这一分化——"预训练小模型 + 专业大模型"的合理分工由证据发现,无需人工配置;
- **验证体系与训练解耦**:账本测量的是"忠实度"(FactGuard 对照源文档),不是"知识量"——fine-tuned 大模型超出源文档的幻觉同样被拦截,专业训练买不通验证。

### A.3 企业侧配套纪律(前提条件)

1. **digest 钉住与再训练节奏**:每次再训练 → digest 变 → 该模型账本清零重积累。频繁(如每周)再训练 = 永久冷启动。建议:按发布节奏再训练,每次发布后预留数天重新拟合期;训练管道固定量化版本;
2. **新任务类型的桶冷启动属预期行为**:fine-tune 不自动带来"可靠"——可靠 = 按桶挣出来的验证通过率,新任务类型首次接入从 unproven 起步;
3. **小模型的角色边界由账本发现,不由人指定**:预训练小模型可能域内极强、域外极差——这正是桶维度存在的意义;不要预设"小模型一定配 mini 档",让证据说话。

### A.4 该形态下仍不解决的问题(属 Phase C/D)

- 跨流水线的双模型交替导致的前缀缓存碎片化(4.4 亲和已消除流水线内最大碎片源,结构性解决靠 Phase D 角色分工);
- 降级时的全量上下文重读(Phase C);
- 双模型全部不可用时的诚实降级/变暗(依赖账本成熟)。

---

*本文档经用户审阅批准后进入实施(Phase A+B Step 2);实施完成后,Phase C/D 各自需要新的设计文档与审阅。*
