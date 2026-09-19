# Holo 请求生命线：一个请求的完整机制旅程

> 本文以一个具体请求为例，按时间顺序拆解它穿过 Holo 全部机制的每一步：每个数值、每个置信度判断、每个分支条件，以及"是哪条边界把它推到那里"。事实快照日期：2026-09-19。所有 file:line 均经源码核实。
> 姊妹文档：`ARCHITECTURE.md`（静态架构）、`MODEL-CAPABILITY-LEDGER-DESIGN.md`（待实施的模型能力账本设计）。
> 问题清单：`LIFECYCLE-GAPS.md`（本走查暴露的 15 条机制问题与认领状态）。

**示例请求**：用户输入 `分析 C:\Users\李明\Desktop\Q3财报.docx，生成财务分析报告，重点看营收和净利润`（约 40 字符，财务域，含文件路径与明确产出物——能穿过分层路由的每一道门）。

## 0. 全景图

```
sendMessage (dialogStore.ts:1016)
 ├─ traceId / 竞争记录消费 / 排队 / 候选映射
 ├─ API 就绪检查；buildVariableContext（KB top5 + 工具 top10）
 └─ routeViaFunnel → kernelRegistry.route
     └─ runFunnel 层序 L0→L0.5→L1→L2→L3→L4（空输入直达 L4）
         L0   8 条规则表（零 token）
         L0.5 关键词 hitRatio×1.5 置信，门 0.8 / 自动 0.9+无shell
         L1   2 个单节点管道，门 0.6 → 单步 llm_generate
         L2   RaaP：向量+关键词 RRF k=60，margin≥0.10，green 0.95
              → 歧义四策略 / M16 竞争 → finalizeRaapPlan → DAG 计划
         L3   LLM 仲裁（≥2 候选，maxTokens 128，置信恒 0.5）
         L4   探索模式（无 shell 自动执行）
         每层 plan → pre-execute 否决门 → FunnelOutcome
执行期：确认暂停点 → executeMacro（指纹缓存 → 数据流预检 → 逐步：
  规则引擎 → 双引擎/confirm-risk → callToolDirectWithTier → FactGuardV2）
LLM 内部：语义缓存(0.92 自适应阈) → 复杂度打分 → tier → manifestMaxTier 封顶
  → checkBudget → 成功后 recordOutcome → ZOL 阈值自调
呈现期：pre-output 否决门(M6.5) → 会话记忆 → M16 EMA 结算 → 浸泡对照
```

## 1. 第 0 幕：入口预处理（dialogStore.sendMessage，dialogStore.ts:1016）

| # | 发生了什么 | 数值/规则 | 归属机制 |
|---|---|---|---|
| 0.1 | `/debug` 前缀拦截 | 精确匹配 | 调试通道 |
| 0.2 | 生成 traceId = `crypto.randomUUID()`（:1036），失败回退 `trace-{ts}-{rand}` | UUID v4 | C-11 数据层：后续 probe/cost/soak 记录按此归因 |
| 0.3 | 竞争记录消费（M16）：上一轮有 `pendingCompetitionRecord` 时——本输入是任务非反馈（`FEEDBACK_RE: /没有\|不行\|不对\|错误\|失败\|找不到\|不是/i` 不命中，长度 ≥30 不走短反馈）→ 记录作废 | 负反馈才记 EMA outcome=0.2 | 竞争质量账 |
| 0.4 | 风险确认期输入进 `_riskQueuedInputs` 排队；候选期纯数字映射 `pickCandidate(n-1)` | | 暂停点架构 |
| 0.5 | addUserMessage：>500 字截为前 200+后 100；`memory:add-dialog-message` 落记忆 | :217-237 | 记忆体 |
| 0.6 | API 就绪：`isReachable && activeModel`；本例 Ollama 已通、activeModel=`qwen2.5:14b` | | 网关前置 |
| 0.7 | buildVariableContext：知识库 top **5** + 工具意图 top **10** + 选中节点 + 引擎 | :328-372 | 变量上下文 |
| 0.8 | 分叉：`config:holo-funnel-main !== '0'`（默认开）→ `routeViaFunnel()`；旧六层内联保留为回滚兜底 | :682-692 | 漏斗架构 |
| 0.9 | （若 `holo-funnel-shadow='1'`）浸泡影子对照 fire-and-forget 并行启动 | soakStore 容量 500 | A6 浸泡管线 |

组装 `DefaultKernelContext`：allL2Manifests + MCP 工具 + visibleL2Ids + selectedRole + `strictVeto`（`holo-strict-veto`，默认关）+ `competitiveMode`（`holo-competitive-mode`，默认关）→ `kernelRegistry.route`。

**空输入边界**：`content.trim()===''` 时 `startIdx=5`，跳过 L0–L3 直达 L4（funnel.ts:166）。

## 2. 第一幕：六层路由漏斗（每层 miss 才降级；层内异常视为 miss）

### L0 规则路由（l0SkillRouter.ts:148，8 条规则）

命中 = triggerPatterns 任一命中 且 forbiddenPatterns 全不命中 且 buildPlan 非 null。

| 规则 | 触发（节选） | 禁止（节选） | 本例 |
|---|---|---|---|
| 1 格式转换 | 转换/导出/另存 + docx\|pdf… | 审查/合规/条款/风险/法律/合同 | miss |
| 2 快速 Shell | `^(ls\|dir\|pwd\|cat…)\b` | 格式/转换/分析… | miss |
| 3 简单文本生成 | `^(写\|生成\|帮我写…)` | 周报/财报/合同… | miss |
| 5/6 文件创建/文件夹 | 创建/新建… | 分析/报告/审查… | miss |
| 8 快速文件操作 | `^(读取\|查看\|打开…)` | 分析/审查/转换… | miss |

命中产出是确定性 L1 计划（非直接答案），且**恒需用户确认**（规则 7"简单查询"的计划是 `llm_generate` nano 档——L0 命中仍可能走一次 nano LLM）。本例 8 条全 miss → L0.5。

### L0.5 关键词快配（l0SkillRouter.ts:415-471）

- **仅单步 manifest 参与**（`mode==='direct'` 或 steps.length===1，:449-455）——多步 DAG manifest 被结构性排除；
- `hitRatio = matched/kws`；`margin = top − second`（无第二名=1）；
- **置信度**：`hitRatio ≥ 0.4 && margin ≥ 0.1` 时 `min(hitRatio × 1.5, 1.0)`，否则 0；
- 漏斗门 `DEFAULT_FUNNEL_GATES = { l05Pass: 0.8, l05Auto: 0.9, l1Pass: 0.6 }`（funnel.ts:31）；
- 自动执行 = `score ≥ 0.9 && !planContainsShellExec`（funnel.ts:152）；领域 pack 可经 advisory scoreDelta 叠加影响过门（M13，路由阶段唯一 pack 插桩点）。
- 本例：多步"财务分析报告"manifest 被排除；单步候选置信不足 → miss → L1。

### L1 单节点管道直调（l0SkillRouter.ts:473-519）

- 硬编码 2 条：`l1-model-gateway`（翻译/生成文本/润色…，禁止 文档/报告/审查…）、`l1-knowledge-feeder`（搜索知识/查知识库…）；
- 置信度 `min(命中数/总数 × 2, 0.9)`，门 0.6；命中计划恒为单步 `llm_generate`。
- 本例 miss → L2。

### L2 RaaP manifest 匹配（本例命中层）

前置边界——反馈检测：`lastAssistantContent.length>50 && FEEDBACK_RE` 或短输入负反馈 → L2 直接 miss。

universalMatch（toolRetrieval.ts:548-695）：
1. 可见性 + 角色过滤（命中角色分 ×1.3 封顶 1）；否定词（不要/别/禁止/除了…）→ 关键词分 ×0.3；用户反馈权重 `mod × 0.5`；文件上下文 boost；
2. 双通道：向量余弦 + 关键词（分词/ngram2-4 级联：全命中 1 / 部分 0.8 / 子词 0.8 / ngram 0.6 / 模糊 0.5×overlap）→ **RRF 融合 k=60**；
3. 动态阈值：kw 基准 0.6 / vec 基准 0.85（fallback 0.90），P50/P95 平滑，clamp [0.3, 0.98]；
4. 门判定：强信号（kw≥dynKwHigh 或 vec≥dynVecHigh）且 **margin ≥ 0.10** → 命中；`≥ GATE_GREEN_THRESHOLD(0.95)` → **green 非歧义**；强信号 margin<0.10 → yellow 歧义；中信号（kw≥0.3 或 vec≥0.55）+ margin≥0.10 → yellow；否则 null 拒匹配。

本例：财务分析报告 manifest kw≈0.92、vec≈0.96、第二名 margin=0.37 → green 非歧义命中 → `finalizeRaapPlan`：mode='macro' 有 dagPlan → **L2 DAG 计划**（5 步：read_file → llm_generate(standard)×2 → llm_generate(pro) → create_docx）。

歧义分支（本例未走）：
- M16 竞争（`holo-competitive-mode='1'`，默认关；跨 ≥2 pack 才触发）：`竞标分 = confidence × packWeight(默认1.0) × 质量EMA`；EMA `0.9×ema + 0.1×outcome`，初始 1.0，clamp [0,1]，outcome 成功 1.0/失败 0.0/负反馈 0.2；平分按注册 seq 兜底；
- 否则消歧四策略（candidates/intent-confirm…），`topScoreGap ≥ 0.15 && 域信号匹配 → auto_pick`。

**pre-execute 否决门**（funnel.ts:206-218）：计划返回前对全部 pre-execute 钩子**全量评估不短路**；blocked 或存在 humanJudgmentPrompts → `{kind:'blocked'}`"⛔ 否决门拦截"（M6.4 保守哲学）。

### L3 / L4（本例未走）

- L3 LLM 仲裁：L2 miss 且关键词 RRF top3 ≥ 2 候选；maxTokens 128 小调用选编号；命中置信恒 0.5；
- L4 探索模式：文件场景复用规则 1，否则单步 llm_generate；无 shell → 自动执行。

## 3. 第二幕：计划确认 → executeMacro（macroExecutor.ts:782）

含副作用步骤 → 用户确认暂停点 → confirmPlan() → executeMacro。

执行前两道检查：
1. **数据流预检** simulateDataFlow（scheduleOptimizer.ts:200-265）：`{{step_N_result}}` 引用不存在步骤 → error → 整体 throw；未声明 depends_on → 仅 warning；
2. **指纹缓存**：`inputHash = contentHash(filePath+'|'+inputText+'|'+context)`（:123-126）；`findCachedExecution(manifestId, inputHash)`；
   - 命中 + `autoCompiled`（successCount ≥ **10** 且**真实执行占比 ≥ 0.8**，:70-72/:164-172）→ 编译态路径：llm 步复用缓存（每步省 2000 token），副作用步强制重放，**失败步中止且不写指纹**；
   - 命中非编译 → findDirtySteps 按步输出哈希（`structHash(result[0:1000])`）判脏并沿依赖 BFS 下传；干净步复用（llm 省 2000/步、其他 500）；
   - **副作用步骤结果永不入缓存**（P1-15）；容量 50 FIFO；落盘 debounce 2s；**持久化只存 resultHashes——重启后只能判脏步、不能复用输出**；
   - 本例首次执行 → miss。

`maxIterations = 步数 × 2`；每轮写 checkpoint（失败步不复原，D-04）。

## 4. 第三幕：步骤循环

### S1 read_file（单就绪 → 500ms 暂停/接管轮询）

**双引擎审核门**（dualEngineValidator）：非 shell 工具恒 shouldValidate；审核缓存 key=`skillId|targetFile|operation|structHash(userInput[0:500])`（TTL 24h，>500 删最旧 50）；isHighRisk 短路不调 LLM 直接 `true/false/high`；LLM 审核调用 maxTokens 5000、prompt 要求只输出 `{"intent_match":…,"parameter_sane":…,"risk_level":…}`。

三条硬边界：
- `intent_match=false` 或 `parameter_sane=false` → **throw 中止**；
- `risk_level='high'` → `dialog:confirm-risk` **fail-closed（P0-9）**：链断裂/超时/异常均按拒绝；用户侧 5 分钟超时 resolve(false)、新请求顶替旧 Promise 也按 false；
- **审核器自身故障 = 阻断态**：解析失败/调用异常 → `false/false/medium`。

（shell_exec 的 shouldValidate 收窄为写操作/危险 URL/敏感路径——`/etc/passwd、C:\Windows、169.254.169.254…` 在表上，P1-19。）
read_file 上限 **200000 字节**。

### S2+S3 llm_generate(standard)（同依赖 → Promise.all 并行）

- 规则引擎优先：`manifest.ruleBasedFallback?.enabled` 命中 → 零 token 返回（lineage=rule_engine）；
- **FactGuard 前置**：tool=llm_generate 且 targetRoles 含 `finance/legal/hr` 且上下文（前 5000 字）提取出实体 → 抽 ground truth；
- 调用：`maxTokens = min(args, 4096)`，`callerId: 'macro:standard'`，步级超时 `STEP_TIMEOUT_MS: nano 8000 / mini 15000 / standard 30000 / pro 60000`；**llm 步 4 次尝试 + 逐档降级 `pro→standard→mini→nano→rule`**。

### 深潜 chatCompletion 内部（apiStore.ts:469）——9 道关卡

1. **语义缓存**：资格 `(!tools || 无工具) && messages ≤ 5`；精确键 = MurmurHash3(trim().toLowerCase()) × domain × packId；语义键 = 余弦 ≥ **自适应阈值（初始 0.92，clamp [0.80,0.95]，目标命中率 0.3，每 20 查询 ±0.01）**；命中 → 直接复用、usage 全 0、路由 cacheHint confidence=1.0；容量 500、TTL 24h；
2. **benchmark 隔离（#5）**：`taskType==='benchmark'` 排除出四张表——语义缓存读写、预算 block、ZOL 学习、record-cost；
3. **预算门 checkBudget**：默认日 ¥10/会话 ¥5/月 ¥200、warnThreshold 0.8；`≥0.95 critical(推荐 mini)/≥0.8 warning(推荐 standard)/超支 exceeded(推荐 nano)`；策略 block/warn/degrade（默认 degrade）；模式白名单 zero 仅 nano、economy 仅 nano+mini；
4. **复杂度打分 → tier**：文本长度（100/500/2000 三档 0-3 分）+ 约束命中（0/2/5）+ DAG 步数（1/3/6）+ 历史 token（>3000 +2 / >800 +1）+ creative/write +1 + 域偏置（legal +1/finance 0/hr −1）；`≤1 trivial→nano / ≤3 simple→mini / ≤6 moderate→standard / >6 complex→pro`；manifestMaxTier 可封顶；**confidence = budgetCapped ? 0.6 : 0.9**；本例 S2 score=5 → standard；
5. **熔断器**：3 次失败 open、冷却 30s、期满返还重试预算；
6. **请求发出**：`model` 一律 = activeModel（**tier 从不切换真实模型**）；Ollama 渲染进程直连 `POST /api/chat`（主进程 SSRF 防护拒 loopback），body `{model, messages, stream:false, options:{num_predict}}`；
7. **超时矩阵**：≤512 → 15s / ≤4096 → 45s / ≤8192 → 75s / >8192 → 120s，绝对上限 180s，三 signal AbortSignal.any 合并；
8. **失败路径**：退避 1000ms×retryCount；每请求实际最多 1 次自动重试（递归关闭 retryOnFailure）；超时不重试直接降级判定；`isRetryableProviderError`：AbortError/401/403/404 → 不可降级；5xx/429/timeout/网络类 → 可降级 → tryDegradeChain：探测 `GET /api/tags`（3s 超时；失败 TTL 60s、成功 300s）→ `pickOllamaModel = target.models[0]?.id || probe.models[0]?.id || ''`——**盲选第一个，无能力评估（Phase A+B 靶心）**；链全灭 → "所有 LLM 通道均不可用"；
9. **成功记账**：Ollama `prompt_eval_count/eval_count` 实测，`cacheHitTokens: 0` 硬编码（全记 miss）；local=true 费用记 0、token 照记，debug:record-cost 带 traceId；recordOutcome：**overkill = 实际输出 < 档上限 × 0.2 且非 nano**；qualityScore = overkill?5:3；overkill 记 failure 喂 **ZOL**：每 20 次触发、取 50 条算成功率、`<0.7 → 阈值 ×1.05`、`>0.95 → ×0.95`、clamp 默认值 ±30%；routingHistory 上限 500、7 天过期、持久化最近 100 条。

**FactGuard 后置**（factGuard.ts）：

| 实体 | 匹配判据 | 不匹配 severity |
|---|---|---|
| 金额 | diff<0.01 且 pctDiff<0.001 | pctDiff>10% → critical，否则 minor |
| 日期 | diffDays ≤ 1 | >3 天 → critical，否则 minor |
| 百分比 | diff<0.1 | >1 → critical，否则 minor |
| 编号/证件/账号 | 严格相等 | 恒 critical |
| 人名/公司名 | 相等或互含 | minor |

处置：critical → throw → `acquirePausePoint('factResolution')` 人工裁决；仅 minor 可修正 → **自动替换输出**；幻觉实体记日志。

**消费者截断边界**：下游步骤吃 `step_N_result` 时按**消费者 tier 截断**：`nano:300 / mini:600 / standard:800 / pro:2000` 字符（macroExecutor.ts:376-378）。

### S4 llm_generate(pro)

复杂度重算 score=7 → complex → pro，maxTokens 8192、步级 60s、调用 75s 档。

### S5 create_docx（副作用）

双引擎：路径后缀匹配 → 放行；Desktop 写盘后二次核验（node -e FILE_EXISTS，5s）。

**错误处理分层**：abort 停；retry_with_fix+resource_missing+shell_exec → 自动 npm install（**必须过 confirm-risk**，30s 超时）重试一次；retry → 原参重试一次；step.fallback → 换兜底工具（默认 mini）；`fallbackStrategy==='ask_user'` → 任一步失败即整体中断。

### 收尾

常规路径无论有无失败步都写指纹（编译态才"失败不写"）；S5 副作用被过滤；successCount 0→1；lineage 记录每步来源（tool_call/llm_standard/llm_pro/rule_engine/cache_reuse/replay_reuse/fallback…）；probeStep 快照（输出截 2000 字、modelParams、tokenUsage、traceId）发 `debug:log-probe`。

## 5. 第四幕：呈现与事后

- **pre-output 否决门（M6.5，dialogStore.ts:787）**：全量评估 pre-output 钩子；blocked 或人工复核提示 → 只发"⛔ 否决门拦截"通知，**不 addAssistantMessage——被否决输出不入会话记忆、不入指纹**；fail 策略三明治：内核无方法→放行；门异常→放行；钩子异常→默认放行，**strict-veto 开时翻转为 fail-closed**；
- **M16 竞争结算**：成功呈现 EMA=1.0；步骤失败 0.0；下轮负反馈 0.2；败者影子评估**零副作用铁律**（只读 wouldVeto，不写缓存无 UI 无状态）；
- **A6 浸泡结算**（shadow 开时）：旧路径终点 vs 漏斗终点；`unknown` 或暂停点类终点 → `match=null`（**不计入 matchRate 分母**——诚实的统计边界）；记录带 traceId 入 soakStore（容量 500），可导出 soak-report.json；
- **记忆与上下文**：助手消息入记忆；下轮历史取最近 3 条原文 + 更早摘要（截 500 字）；≥4 条才生成摘要（最近 20 条、每条截 200 字、maxTokens 512）；上下文硬上限 **200000 字符**，超限从第一条非 system 消息删起。

## 6. 三个贯穿不变式

1. **tier 从不换模型**——nano/mini/standard/pro 只决定 maxTokens（512/1024/4096/8192）、temperature（0.1/0.3/0.5/0.7）、步级超时（8/15/30/60s）、计价档；每次请求都打向唯一 activeModel。第二个模型只在降级链出现且是 models[0] 盲选——当前机制层最大确定性缺陷，Phase A+B（MODEL-CAPABILITY-LEDGER-DESIGN.md）的靶心；
2. **每个置信度都有明确出处**：L0.5 = hitRatio×1.5（门 0.8/0.9）；L1 = 命中数×2 封顶 0.9（门 0.6）；L2 = 向量+关键词 RRF 融合分（green 0.95/margin 0.10）；L3 = 恒 0.5；路由层 = 0.9 或预算压档 0.6。无黑箱概率；
3. **fail 方向按代价不对称**：安全门（双引擎/confirm-risk/FactGuard critical）fail-closed——审核器坏=阻断；呈现门（pre-output）默认 fail-open，strict-veto 可翻转。每道门的"宁可错杀/宁可放行"都有明文理由。
