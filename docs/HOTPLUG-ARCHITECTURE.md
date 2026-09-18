# Holo 领域与内核双热插拔架构逻辑规格书

| 项 | 值 |
|---|---|
| 文档版本 | v1.0（评审稿）+ Phase 2 实施修订记录 |
| 状态 | 待用户逐节评审 |
| 承接关系 | 深化并细化 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)（该报告描述现状与蓝图，本文聚焦"内核与领域双热插拔"的逻辑完备规格） |
| 性质约定 | 本文锁定**语义与逻辑边界**；接口字段名、超时默认值以实施期定稿为准（见附录 C） |
| 评审方式 | 每节可独立确认；对任一机制的异议请引用机制编号（如 M4.3） |

## 实施修订记录（Phase 2，正文不改动，以本节为准）

以下偏差为 Phase 2 实施期定稿，机制编号对应正文：

| # | 涉及机制 | 偏差与理由 |
|---|---|---|
| R1 | M9 | DSL trigger 增加 `keywordGroups`（二维数组：外层 AND、内层 OR）。理由：法律条文的触发条件普遍是"分配律"组合（如"试用期 AND (约定 OR 条款)"），单层 keywords/allKeywords 无法无损表达；已在 `src/host/pack/dsl.ts` 实现 |
| R2 | M8 | 内置 pack 落盘路径定为 `src/packs/<packId>/`（manifest=`pack.json`，边界层=`boundary/constraints.json` + `boundary/evaluators/*.ts`），由 vite `import.meta.glob` eager 静态收集 |
| R3 | M8/M9 | pack 约束注入生产管道的策略由"testing 状态并存"改为：与内置约束 id 重复时**跳过注入（内置优先）并告警**。理由：并存会造成同一输入双重拦截、消息重复；等价性由 packEquivalence 测试直接对照保障（不经生产管道），Phase 3 退役内置数组后 pack 版自然接管 |
| R4 | M9 | 自检失败的单条约束状态定为 `draft`（非正文所述 `disabled`）。理由：现有 `RuleStatus` 联合类型（`src/models/index.ts`）不含 `disabled`，且 `runConstraints` 只执行 active/testing，draft 天然不生效 |
| R5 | M19 | watch 自动重挂受 `import.meta.glob` 静态编译限制：磁盘文件变更需整页重载才可见；`reloadPack` 提供同数据卸载-重挂的事务演练，热更新语义顺延至运行时 pack 源 |
| R6 | M10 | 缓存 store 去重键由单一 queryHash 扩展为复合键 `hash\|domain\|packId`。理由：原实现跨 domain/跨 pack 复用同 hash 条目会互相顶替（预存缺陷），复合键彻底杜绝跨域污染（M10 意图延伸） |
| R7 | M12 | schema 版本标记 key 为 `holo-partition-schema-version`（值 `1`），存放于 `knowledge` namespace；迁移脚本幂等，重复执行直接跳过 |

## 实施修订记录（Phase 3，正文不改动，以本节为准）

| # | 涉及机制 | 偏差与理由 |
|---|---|---|
| R8 | M5 | L2 内部门（green 0.95/yellow 歧义、消歧四策略 selectDisambigStrategy）与改写策略（selectRewriteStrategy）归属**层默认实现**（`src/kernels/default/`），非 funnel 编排核。理由：门值可配置的仅 L0.5/L1 两个跨层置信门（FunnelGates）；L2 门是 universalMatch 服务内部语义，随层实现走（换内核=换整套层实现，含其内部门） |
| R9 | M7 | 层覆盖（override）的 miss 在 funnel 语境下表达为 `LayerResult {kind:'miss'}`（hooks 层通用契约 `{miss:true}` 的具体化）；HookRunner/OverrideHookEntry/runOverrideWithFallback 泛型化（`HookRunner<LayerResult>`），类型系统直接约束覆盖实现与默认实现同构 |
| R10 | M5 | RaaP 命中 manifest 但无可执行形态（非 macro/chain+dagPlan、非 direct+directCall）时的 planTask LLM 兜底，归属 L2/L3 层默认实现内部（等价旧行为 :1079-1090）。理由：旧行为中该兜底仅在 raapResult 非空路径触发，若降级到 L4 探索会改变行为；L3 仲裁选中不可执行项（如 MCP 工具不在列表）同样落此兜底 |
| R11 | M4/M5/M16 | 灰度期 `KernelRegistry.route`（六层路由入口）不计 inFlight、draining/switching 时直接返回 busy（不入队），主路径切换后并入统一 dispatch 跟踪；shadow 对照（vault `config:holo-funnel-shadow`='1'）仅覆盖层命中级别终点（旧路径层信号经 debug:log-probe 事件流收集），暂停点类终点（candidates/intent-confirm/slot-fill）旧侧走 system notice 无总线事件，`match=null` 留人工核对 |
| R12 | M8/M9 | P3.5 约束主路径切换：内置 `LEGAL_CONSTRAINTS`/`FINANCE_CONSTRAINTS` 退出生产注入路径（`initConstraintStore` 退役），约束库唯一装载入口为 pack 管线（`initPackRuntime` 启动挂载全部内置 pack → `injectExternalConstraints`）；内置数组保留导出仅作 packEquivalence 等价回归基线。注入去重语义由"内置优先"改为"先装载者优先"（reason=`duplicate-id`）。装载为异步：App 启动到挂载完成之间 `runConstraints` 返回空集（factGuard 优雅降级），ruleStore 订阅 `pack:mounted/unmounted/reloaded` 总线事件保持规则列表同步；单 pack 挂载失败仅告警不阻断其余 pack |
| R13 | M4/M19/M7 | P3.6 三项 dev 演练（换内核切换 / pack 热重载 / override 回退）固化为生产单例集成测试 `test/integration/hotplugAcceptance.spec.ts`（真实六层不 mock 层服务，`isEmptyInput` 直达 L4 保证确定性且零 LLM），可重复回归；另在 dev 模式暴露 `window.__holoHotplug = { kernelRegistry, packLoader }` 供浏览器控制台手动演练，两条路径等价 |
| R14 | M4/M5 | 灰度第二步主路径切换：vault `config:holo-funnel-main`='1' 开启后 sendMessage 六层路由经 `kernelRegistry.route`，适配层（dialogStore `routeViaFunnel`/`consumeFunnelOutcome`）消费 FunnelOutcome 驱动 UI（通知/暂停点状态机/自动执行）；funnel error 或适配层异常回退旧六层内联路径（兜底）；flag 开启时跳过 shadow 对照（funnel 已是主路径）。已知保真度损失（灰度期可接受）：① FunnelOutcome 不携带 matchMethod/gate/置信度，L2/L3 命中文案简化为"检索/LLM仲裁"；② L2 翻译超时候选 notice 丢失（仅信息性）；③ `lastDecisionContext` 不再重建（反馈遥测降级，唯一消费方 DialogPanel recordFeedback）；④ 调试探针由逐层细粒度变为单条 `[Router] funnel(源) → …`。偏差修复：mcp-direct 助手消息统一取 `apiResult.content`（旧 L2 分支直接传响应对象为预存 bug）。行为等价由 `test/integration/funnelMainPath.spec.ts` 固化（10 测试：flag 门控/七类 outcome 分派/error 与异常回退） |
| R15 | M4/M5 | 灰度第二步默认翻转：`config:holo-funnel-main` 未配置（null）即走 funnel 主路径（原需显式 '1'），vault 显式 `'0'` 为回滚开关（DevTools 执行 `window.electronAPI.vaultWrite('config','holo-funnel-main','0')` 后重载生效）；vault 读异常时默认主路径。旧六层内联代码**保留**为回滚目标与 funnel error 兜底，彻底退役待翻转后实际运行浸泡验证再独立执行（风险矩阵：checkpoint 回滚能力不拆除） |
| R16 | M4/M5/M8/M19 | 工作台式 UI（funnel 主路径的可观测前台）：① 新增 `funnel:routed` 总线事件（dialogStore `routeViaFunnel` 内 emit，payload `{handled, kind, source?, intent?, autoExecutable?, ts}`，异常兜底 `{handled:false, kind:'exception'}`），工作台运行时面板经 hotplugStore 镜像渲染最近路由结果，不解析探针文案；② 新增 `hotplugStore`（`src/stores/hotplugStore.ts`）：kernelRegistry/packLoader 单例快照 + 6 类 kernel 事件 + 4 类 pack 事件 + `funnel:routed` 的总线镜像（eventLog 上限 50，init 幂等/dispose 退订），`toggleFunnelMain()` 写 vault 后调 dialogStore `refreshFunnelMainFlag()` 清闭包缓存——开关**即时生效无需重载**（修正 R15 的"重载生效"操作路径）；③ 工作台三栏布局（`src/components/workbench/`：WorkbenchShell/WorkbenchNav/RuntimePanel/StatusBar）：复用休眠字段 `uiMode`（'workbench' 默认/'starmap'，configStore 既有 setUiMode/toggleUiMode，`viewMode` 语义不变），左导航（视图切换/五窗口入口/funnel 开关/会话快切）+ 中栏 DialogPanel（新增 `docked` prop：position:static、隐藏拖拽与折叠钮，星图模式零改动）+ 右栏四区（路由与执行/热插拔/Token 预算/探针流）+ 底部状态栏；④ 星图模式整体 `v-if` 门控（StarMap 工作台下卸载释放 GPU；preview 往返在星图模式内仍 v-show 保活），星图专属 HUD（FilterBar/DebugProbePanel/NodeDetailPanel/orb/熔断指示）随模式隐藏，状态栏承接核心状态；首启引导在工作台模式下由 App onMounted 直接打开（星图模式仍由 onStarMapReady 触发）；离开星图时清 starMapRef 防探针/DAG 定时器调用已卸载场景。测试：`test/unit/hotplugStore.spec.ts`（10 测试）+ funnelMainPath.spec 扩展 funnel:routed 断言（11 测试），全量 1526/1526 |
| R16a | 依赖修复 | dev 启动 Electron 秒退排查定论：better-sqlite3 ^13.0.3 的 NAPI 预编译（prebuilds/win32-x64.node）在 Electron 33 主进程 `new Database()` 处 native 硬崩（内存库同样崩，无 JS 异常），且本机 MSBuild（VS18 BuildTools v145 / VS2022 v143 均复现空构建）无法本地编译 electron-ABI 替代，v13 亦无 electron 预编译发行物（404）——vault 在 Electron 下从未真正跑通。修复：降级 `better-sqlite3@^12.11.1` 并以 `prebuild-install -r electron -t 33.4.0` 落位 `build/Release/better_sqlite3.node`（vitest 不加载该模块，node/electron 双 ABI 无冲突；全量 1526/1526、typecheck 51 零新增不变）。注意：重新执行 `npm install` 会触发其 install 脚本以 node-ABI 覆盖 build/Release，届时需重跑上述 prebuild-install 命令恢复 |



---

## 机制索引

本文以 20 个机制（M1-M20）组织全部逻辑。每个机制的规格包含五要素：**入口条件 / 编号步骤 / 每步错误路径 / 回滚路径 / 边界情况**。

| 机制 | 名称 | 所在章节 |
|---|---|---|
| M1 | 插件注册（含回滚与重入防护） | 第 3 节 |
| M2 | 插件卸载（依赖检查与容错清理） | 第 3 节 |
| M3 | NamespacedBus 通道台账（disposer/孤儿扫描） | 第 3 节 |
| M4 | 换内核状态机（draining/switching/回滚） | 第 6 节 |
| M5 | dispatch 逐层执行逻辑 | 第 4 节 |
| M6 | 否决门（全量评估/聚合上报） | 第 5 节 |
| M7 | 覆盖冲突消解（单槽/priority） | 第 5 节 |
| M8 | pack 加载器（事务式分层加载） | 第 8 节 |
| M9 | 约束 DSL 评估器（含逃生舱与自检） | 第 8 节 |
| M10 | 缓存精确匹配（packId 维度） | 第 7 节 |
| M11 | 检索 scope 过滤（partition 正交分区） | 第 7 节 |
| M12 | 存量迁移脚本（备份/对账/回滚） | 第 7 节 |
| M13 | 顾问贡献确定性合并 | 第 5 节 |
| M14 | 运行时权限校验（永不抛入主流程） | 第 3 节 |
| M15 | 在途请求快照（unmount 无 use-after-free） | 第 5 节 |
| M16 | 竞争评分与影子评估（flag-gated） | 第 9 节 |
| M17 | Ollama provider 与 LLM 降级链 | 第 10 节 |
| M18 | 内核纯度 CI 检查 | 第 2 节 |
| M19 | 开发模式 watch 自动重挂 | 第 8 节 |
| M20 | llm-provider 降级链与离线探测 | 第 10 节 |

---

## 目录

- 第 1 节：定位与设计原则
- 第 2 节：内核纯度规则（M18）
- 第 3 节：三层插件体系与注册表（M1 / M2 / M3 / M14）
- 第 4 节：强六层路由——逐层定义与执行逻辑（M5）
- 第 5 节：弱六层路由——三档钩子（M5 / M6 / M7 / M13 / M15）
- 第 6 节：内核插件与五簇热换（M4 + 簇注册逻辑）
- 第 7 节：知识库隔离与零污染（M10 / M11 / M12）
- 第 8 节：DomainPack 三层与声明式维护（M8 / M9 / M19 + 转译清单）
- 第 9 节：竞争模型与内核领域契约（M16）
- 第 10 节：本地优先 / 离线完整 / 联网增强（M17 / M20）
- 第 11 节：实施路线图与分阶段验收
- 附录 A：决策记录表
- 附录 B：术语表
- 附录 C：待定项
- 附录 D：机制-章节-验收映射详表

---

## 第 1 节：定位与设计原则

### 1.1 产品定位

Holo 是面向**中小型企业、个人开发者，尤其非技术人群**的**本地化 AI 桌面工具台**。它不是一个优雅的竞争市场，而是一个让普通用户在自己电脑上把 AI 用起来的工具。本规格书的一切设计决策，都以这条初心为最终裁判：**凡是不帮助用户在本地用起 AI 的复杂性，都应该被砍掉或隐藏**。

### 1.2 核心架构主张

**内核与领域皆为插件。** 对标业界"一切皆插件"的理念，但架构自有主张：

- **换内核 = 换省 token 的调度策略**。六层路由漏斗的本质是一套省 token 调度策略（L0-L2 完全免 LLM、缓存复用、预算控制）。把它封装为可替换的内核插件，意味着激进省 token 内核、质量优先内核、面向低端硬件的轻量内核可以并存、可热切换。
- **换领域 = 专人专用**。法务包给法务、财务包给财务。领域包按需装卸，未安装的用户完全无感。

两者合称**双热插拔**：任意内核插件 × 任意领域包可自由组合（可组合性由第 9 节契约保证）。

### 1.3 硬性设计约束（用户确认，优先级从高到低）

1. **内核纯度**：内核必须领域无关——法律等业务域的知识库、约束、术语不得存在于内核侧（第 2 节）。
2. **知识库零污染**：内核 KB 与各领域 KB 隔离且互不可见，领域 KB 两两互不可见（第 7 节）。
3. **三层声明式易维护**：领域的知识/边界/执行三层内容，维护者/开发者改数据不改代码、不重新编译（第 8 节）。
4. **热插拔 = 运行时装卸**：编译期代码内置，运行时 mount/unmount/重建，无需重启应用；不是外部代码动态加载。
5. **本地优先、离线完整、联网增强**（第 10 节）。
6. **竞争模型与内核领域契约是可选高级模式**：默认关闭、普通用户不可见（第 9 节）。
7. **开源核心 + 付费增强包**：manifest 预留 `license` 字段，付费校验体系不在本轮范围（附录 C）。

### 1.4 现状盘点（本文所有改造的起点）

| 现状 | 位置 | 与目标的差距 |
|---|---|---|
| createKernel 工厂 + 五簇硬编码委托 | [src/kernel/index.ts](../src/kernel/index.ts)（簇 :13-17，dispatch :47-244） | 簇不可替换；dispatch 零调用（真实路径是 dialogStore→apiStore 内联编排） |
| LLMPort 已可热切换 | [src/kernel/plugins/llm.ts](../src/kernel/plugins/llm.ts)（registerLLM/unregisterLLM/getLLM） | 唯一已存在的"端口热换"样板，推广到全部端口 |
| 六层漏斗隐式在 dialogStore | [src/stores/dialogStore.ts](../src/stores/dialogStore.ts)（L0 :601-628、L0.5 :632-691、L1 :693-717、RaaP :721-956、LLM 仲裁 :959-1005、探索 :1008-1037） | 管线须整体抽出为内核插件路由管线（第 11 节 Phase 3） |
| 总线只注册不卸载 | [src/kernel/bus.ts](../src/kernel/bus.ts)（registerHandler :8-13 覆盖式注册、request :19-25 缺 handler 即 throw、listHandlers :64-66） | 无所有权台账、无命名空间、无孤儿检测（M3） |
| 12 个总线域一次性挂载 | [src/App.vue](../src/App.vue):724-735 | 定位为系统层固定域，不参与热插拔 |
| 业务域硬编码（五处泄漏） | 见第 2 节泄漏清单 | 全部迁出为 pack 数据 |
| 知识检索已有 scope 雏形 | [src/services/knowledgeBase.ts](../src/services/knowledgeBase.ts)（SearchScope :195-199、hybridSearch 过滤 :293-309） | ownerType 语义是"摄取目标"非"归属分区"，需正交新增 partition 维度（M11） |
| 缓存宽松匹配（污染向量） | [src/services/semanticCache.ts](../src/services/semanticCache.ts)（domainMatch :151-154、lookup :180-249、store :251-289） | 无域条目可被任何域命中，必须严格化（M10） |
| vault 已有 namespace | [src/vault/index.ts](../src/vault/index.ts)（read/write/delete/list :17-54、writeCache :90、writeThrough :97） | 接口无需扩展即可承载新分区命名，仅需命名规范 |
| 本地嵌入 + 伪向量降级 | [src/services/embedder.ts](../src/services/embedder.ts)（VECTOR_DIM=384） | 缺本地 LLM，"离线完整"未闭环（M17/M20） |

---

## 第 2 节：内核纯度规则（M18）

### 2.1 规则陈述

**内核（kernel/ 目录 + 框架级 services/ 中的非领域设施）必须领域无关。** 法律、财务、人力资源等业务域的知识库、约束规则、术语表、路由偏置，一律不得存在于内核侧。内核将 domain 视为**不透明字符串**：内核代码可以传递它、比较它是否相等，但不得对具体取值（`'legal'`、`'finance'`、`'hr'`）做任何分支、打分、查表。

### 2.2 现状泄漏清单（Phase 1 迁出对象）

| # | 泄漏点 | 位置 | 迁出目标 |
|---|---|---|---|
| ① | 约 55 条法规约束硬编码为 TS 数组，修改需重新编译；且每条约束含命令式 `check` 函数（:25 `checkFn`、:48 `check: checkFn`） | [src/services/domainConstraints.ts](../src/services/domainConstraints.ts)（LEGAL_CONSTRAINTS :96-2911、FINANCE_CONSTRAINTS :2912-3356） | legal/finance pack 的 `boundary/constraints.json`（+ 逃生舱 evaluators，见 M9） |
| ② | 事实守卫触发域硬编码 `TRIGGER_ROLES = new Set(['finance','legal','hr'])` | [src/services/factGuard.ts](../src/services/factGuard.ts):16 | 改为运行时从已挂载 pack 收集触发域注册表 |
| ③ | 路由域偏置硬编码，直接参与 tier 打分 | [src/services/smartRouter.ts](../src/services/smartRouter.ts)（`DOMAIN_ROUTING_TIER_BIAS`，使用点 :201-202 `score += domainBias`） | 改为 L2 顾问钩子（pack `execution/routing.json` 注册，经 M13 合并） |
| ④ | 业务域名字面量硬编码进类型系统 | src/models（`DetectedDomain = 'legal'|'finance'|'hr'|'general'`） | 内核侧泛化为 `string`；`'general'` 保留为内核唯一内置取值；各 pack 自带 id 校验 |
| ⑤ | 内核反向 re-export 域偏置与域偏移（内核依赖上层，违反依赖方向） | [src/kernel/index.ts](../src/kernel/index.ts):274-275（`DOMAIN_REWRITE_OFFSETS`/`DOMAIN_DISAMBIG_OFFSETS`/`DOMAIN_ROUTING_TIER_BIAS`） | 删除 re-export；消费方直接从 pack 钩子注入点取值 |

### 2.3 纯度检查逻辑（M18）

**入口条件**：CI 流水线或本地 pre-commit，扫描范围 = `src/kernel/**` + 框架级 services 白名单清单（pure-services.list，实施期定稿，初始建议含 smartRouter/semanticCache/tokenBudget/factGuard/knowledgeBase/embedder/debugLog 等非领域设施）。

**步骤**：
1. 对扫描范围内全部 `.ts` 文件执行字面量匹配：`'legal'`、`"legal"`、`'finance'`、`"finance"`、`'hr'`、`"hr"`（词边界匹配，避免误伤 `hr` 出现在 `hrm` 之类标识符中时的处理：仅匹配字符串字面量，不匹配标识符）。
2. 命中 → 记录 `{file, line, literal}`，输出违规清单。
3. 检查是否存在白名单登记条目（`purity-whitelist.json`：`{file, line, reason, approvedBy}`）→ 已登记且 reason 充分 → 放行；否则 CI 失败。
4. 白名单登记必须在 PR 中附带评审记录，禁止"先加白名单后补理由"。

**错误路径**：扫描脚本自身崩溃 → CI 直接失败（宁可误报不可漏报）。

**回滚路径**：纯度检查是新增 CI 项，回滚 = 从流水线移除该步骤，无代码影响。

**边界情况**：
- 注释中的领域词（如"该逻辑迁往 legal pack"）不违规——仅匹配字符串字面量，排除注释行（`//`、`/* */` 内）。
- 测试文件（`*.spec.ts`/`*.test.ts`）默认排除——测试需要引用 pack id 做夹具。
- 新 pack 接入后旧泄漏未清完：Phase 1 验收要求五处泄漏清单全部清零（见第 11 节），CI 在 Phase 1 落地时同步启用。

---

## 第 3 节：三层插件体系与注册表（M1 / M2 / M3 / M14）

### 3.1 体系总览

```
┌─────────────────────────────────────────────────────┐
│ 宿主 Host（唯一不可替换层）                            │
│ 职责穷举：globalBus、PluginRegistry、KernelRegistry、 │
│ 端口注册表(llm/persistence/io)、SchemaValidator、     │
│ 生命周期事件。宿主不含：任何路由逻辑、任何业务数据、    │
│ 任何服务状态。                                        │
├─────────────────────────────────────────────────────┤
│ kernel 插件（同时仅一个激活）                          │
│ = 六层路由管线 + 调度策略 + 簇注册表（五簇可单独热换） │
├─────────────────────────────────────────────────────┤
│ domain-pack / tool-provider / llm-provider /          │
│ knowledge-provider（多实例并存，按请求路由/按端口选用）│
└─────────────────────────────────────────────────────┘
```

**端口归属**：LLM/Persistence/IO 端口注册表归**宿主**持有。换内核不换存储，换内核不换模型连接。内核插件经 `ctx.ports` 只读使用端口。

### 3.2 统一插件契约

```ts
type PluginKind =
  | 'kernel'          // 内核插件（同时仅一个激活）
  | 'cluster'         // 簇插件（在激活内核的簇注册表内热换）
  | 'domain-pack'     // 业务域包（三层：知识/边界/执行）
  | 'tool-provider'   // 技能与工具（skillCatalog、L2 manifest、MCP 绑定）
  | 'llm-provider'    // LLM 端口实现（远程网关、Ollama）
  | 'knowledge-provider' // 知识库提供者（内核 KB 与领域 KB 同一机制挂载）

interface HoloPlugin {
  id: string                 // 全局唯一短 id，格式 ^[a-z][a-z0-9-]*$
  version: string            // semver
  kind: PluginKind
  manifest: PluginManifest
  mount(ctx: PluginContext): Promise<void>
  unmount(): Promise<void>   // 幂等：重复调用无副作用；抛错不阻断其他插件卸载
}

interface PluginManifest {
  id: string
  version: string
  kind: PluginKind
  license?: 'open-source' | 'pro'          // 付费增强预留（附录 C）
  display?: { name: string; description: string }
  dependencies?: Record<string, string>    // pluginId -> semver range
  capabilities?: {                        // domain-pack 必填，其余 kind 可选
    priority?: number                     // override 冲突消解用（M7），默认 0
    weight?: number                       // 竞争评分用（M16），默认 1.0
    hooks?: Partial<Record<LayerId | 'boundary', HookTier[]>>
  }
}

interface PluginContext {
  bus: NamespacedBus                       // M3：通道自动带前缀，unmount 自动回收
  ports: Readonly<PortHandles>             // llm/persistence/io 只读句柄
  config: PluginConfigStore                // 插件私有配置（vault: plugin:<id>:config）
  logger: PluginLogger                     // 带 plugin 前缀的分级日志
  validate: SchemaValidator                // mount 内校验自身数据文件
}
```

### 3.3 M1：插件注册 register(plugin)

**入口条件**：调用方传入完整 `HoloPlugin` 对象；PluginRegistry 处于可写状态（宿主已初始化完成）。

**步骤**：
1. **id 校验**：正则 `^[a-z][a-z0-9-]*$` 不通过 → 返回 `{ok:false, errors:['invalid-id']}`；id 已存在于注册表 → 返回 `{ok:false, errors:['duplicate-id: <id>']}`。
2. **manifest 校验**：`SchemaValidator.validate(manifest, 'plugin-manifest')` → 失败 → 返回 `{ok:false, errors:[{path, reason}...]}`（精确到字段路径），插件不入册。
3. **依赖解析**：遍历 `manifest.dependencies`，逐项检查：
   - 目标插件未注册 → 收集进缺失清单；
   - 已注册但版本不满足 semver range → 收集进版本不符清单。
   - 任一清单非空 → 返回 `{ok:false, errors:['missing-deps: [...]', 'version-mismatch: [...]']}`。
4. **环检测**：以本插件为起点对依赖图做 DFS；发现回到起点的路径 → 返回 `{ok:false, errors:['dependency-cycle: a -> b -> a']}`。
5. **构造 PluginContext**：`NamespacedBus(id)` + 只读端口句柄 + `PluginConfigStore`（后端 vault，namespace `plugin:<id>:config`）+ logger + validator。
6. **执行 `await plugin.mount(ctx)`**，外层带超时保护（默认 10s，宿主配置项 `host.mountTimeoutMs`）：
   - **成功** → 注册表记录插件元数据 + 台账条目 → emit 生命周期事件 `mounted{kind,id,version}` → 返回 `{ok:true}`。
   - **抛错或超时** → 进入**全量回滚**（见下）。
7. **重入防护**：mount 执行期间，同一插件 id 再次进入 register → 直接返回 `{ok:false, errors:['reentrant: mount in progress']}`，不等待、不排队（防死锁：mount 内同步等待自身注册完成是实现错误，应立即失败暴露问题）。

**全量回滚路径**（M1.6 失败触发）：
1. 执行台账中该插件已记录的全部 disposer，逐个 `try/catch`（单个 disposer 失败仅记 error 日志，继续下一个）；
2. emit 生命周期事件 `mount-failed{id, error}`；
3. 注册表状态恢复到调用前（插件元数据不入册）；
4. 返回 `{ok:false, errors:['mount-failed: <reason>']}`。

**边界情况**：
- mount 内注册了总线通道但未返回 disposer（插件实现违规）→ 台账按 NamespacedBus 记录兜底（M3.1：所有经 ctx.bus 的注册自动进台账），回滚仍可回收；
- mount 内注册了**其他插件**（合法：如 domain-pack 触发一个 tool-provider 注册）→ 其他插件的注册独立完成，不随本插件回滚；但若本插件声明了对它们的依赖，回滚时仅警告"依赖残留"；
- mount 超时但 mount 函数仍在运行 → 注册表置该 id 为 `zombie` 状态，后续任何 register/unregister 对 zombie id 返回 `{ok:false, errors:['zombie: previous mount timed out']}`，需宿主重启恢复（如实记录此限制，不做强制中断——JS 无法安全杀线程）。

### 3.4 M2：插件卸载 unregister(id)

**入口条件**：id 存在于注册表（不存在 → warning 日志 + no-op 返回）。

**步骤**：
1. **依赖检查**：遍历注册表中全部其他插件的 `manifest.dependencies`，收集声明依赖本插件者：
   - 依赖者非空 → **默认拒绝**，返回 `{ok:false, errors:['has-dependents: [...]']}`；
   - 显式传 `{cascade: true}` 时级联卸载依赖者（级联策略细节为附录 C 待定项，Phase 1 不实现 cascade）。
2. **执行 `await plugin.unmount()`**，`try/catch`：
   - 抛错 → 记录 `unmount-error{id, error}` error 日志，**继续后续清理**（幂等要求：插件的失败不得阻断系统清理与总线回收）。
3. **台账清理**：执行该插件台账中全部 disposer，逐个 `try/catch`，单个失败仅日志。
4. **孤儿扫描**：调 M3.4，输出残留告警。
5. **移出注册表** → emit `unmounted{id}` → 返回 `{ok:true}`。

**回滚路径**：本机制无"半卸载回滚"概念——unmount 是尽力清理，残留只产生 warning，不回滚（重新注册同名插件会重新走 M1 全流程）。

**边界情况**：
- 在途请求正持有该插件的钩子引用 → 由 M15 快照机制保证安全，unmount 不等待在途请求（等或不等是附录 C 待定项；默认不等，理由：长请求会阻塞卸载交互）；
- unmount 期间该插件收到新总线请求 → NamespacedBus 回收后 `request` 自然 throw（bus.ts:19-25 现状行为），调用方按现有错误路径处理。

### 3.5 M3：NamespacedBus 通道台账

**设计动机**：现状 [bus.ts](../src/kernel/bus.ts) `registerHandler`（:8-13）是覆盖式注册（仅 warning），无所有权、无卸载。12 个系统域一次性挂载后从不卸载。热插拔要求：插件卸载后其全部通道干净消失。

**结构**：
```ts
interface NamespacedBus {
  // 插件视角：channel 自动加前缀，注册即入台账
  registerHandler(channel: string, fn: HandlerFn): Disposer
  on(channel: string, fn: HandlerFn): Disposer          // 现状 on 已返回取消函数，台账包装之
  registerStreamHandler(channel: string, fn: StreamHandlerFn): Disposer
  emit(channel: string, payload?: unknown): void
  request<T>(channel: string, payload?: unknown): T
}
interface Disposer { dispose(): void }   // 幂等：重复调用无副作用
```

**步骤（registerHandler 路径）**：
1. 拼接全名：`plugin:<pluginId>:<channel>`；
2. 调 `globalBus.registerHandler(fullName, fn)`（现状覆盖 warning 保留：同名重复注册说明插件实现问题，需暴露）；
3. 创建 `Disposer{ dispose: () => { globalBus.removeHandler(fullName); 台账移除 } }`；
4. 记入台账 `ledger[pluginId].add(disposer)`；
5. 返回 disposer 给插件（插件可提前手动释放）。

**通道命名规则**：
- 插件通道：一律 `plugin:<pluginId>:<channel>` 前缀（如 `plugin:legal:constraint-hit`）；
- 系统域通道：沿用现有裸格式（`node:xxx`、`api:xxx` 等 12 域格式）——两种格式由前缀天然区分，互不冲突；
- 消费方监听插件通道时使用全名（pack 文档需写明全名约定）。

**M3.4 孤儿扫描**：
- 触发时机：① 宿主启动完成后一次；② 每次 M2 卸载清理后一次；
- 逻辑：遍历 `globalBus.listHandlers()`（现状 :64-66 已提供）+ listeners 键集，凡 `plugin:` 前缀且 owner 不在注册表 → 输出 `orphan-channel` warning（含通道名与推测 owner）；
- 孤儿不自动删除（防误删），仅告警——持续存在的孤儿说明某插件清理逻辑有 bug。

**错误路径**：dispose 时通道已不存在（被 clear 或他人删除）→ `removeHandler` 本身是幂等 delete，无异常，安全。

**边界情况**：
- `globalBus.clear()`（现状 :97-101）被外部调用 → 台账与实际状态脱节；规格约定：clear 仅允许宿主在测试环境调用，生产禁用（运行时检测：非测试环境调用 clear → console.error）；
- 插件 A 监听插件 B 的通道（跨插件通信）：合法；B 卸载后 A 的监听永远不触发，A 需自行处理"对端消失"（提供 `onLifecycle` 让 A 感知 B 卸载，见 3.6）。

### 3.6 PluginRegistry 接口汇总

```ts
interface PluginRegistry {
  register(p: HoloPlugin): Promise<MountResult>      // M1
  unregister(id: string, opts?: { cascade?: boolean }): Promise<UnregisterResult>  // M2
  get<T extends HoloPlugin>(id: string): T | undefined
  list(kind?: PluginKind): PluginMeta[]
  onLifecycle(cb: (e: LifecycleEvent) => void): () => void
}
type LifecycleEvent =
  | { type: 'mounted'; id: string; kind: PluginKind }
  | { type: 'unmounted'; id: string }
  | { type: 'mount-failed'; id: string; error: string }
  | { type: 'zombie'; id: string; error: string }
```

**挂载顺序**：register 时按依赖图拓扑插入——被依赖者必须先于依赖者完成 mount（M1.3 已校验目标在册，天然保证）；同批启动挂载时按发现顺序 + 拓扑排序执行；卸载严格逆序（先卸依赖者，M2.1 的依赖检查保证不会先卸被依赖者）。

### 3.7 M14：运行时权限校验

**设计动机**：三档钩子（第 5 节）中 veto/override 是高权限能力，必须防止插件"运行时偷偷越权"（manifest 未声明却调用高权限接口）。

**入口条件**：每次钩子分发点（M5 收集钩子时、M6 收集否决钩子时、M7 覆盖槽检查时）。

**步骤**：
1. mount 成功时（M1.6），把 `manifest.capabilities.hooks` 快照进注册表的权限缓存 `permissionCache[pluginId]`；
2. 钩子分发点统一走 `checkPermission(packId, hook)`：对照缓存中该层声明的档位；
3. **不匹配 → 跳过该钩子 + `permission-denied{packId, hook}` warning，永不向主流程抛错**（一个插件的越权不能打断用户请求）。

**错误路径**：权限缓存缺失（注册表异常）→ 视为无权限，全跳过 + error 日志。

**回滚路径**：无状态，无回滚。

**边界情况**：
- 插件在 mount 后通过闭包拿到其他插件的钩子对象直接调用 → 无法拦截（JS 语言边界），规格约定：钩子只经内核分发点调用才算数，绕过分发点的调用后果自负（文档明示）；
- `capabilities.hooks` 未声明（undefined）→ 该 pack 只有 advisory 权限也没有——一切钩子跳过（保守默认）。

---

## 第 4 节：强六层路由——逐层定义与执行逻辑（M5）

### 4.1 双路由现状澄清（重要）

现状存在**两条"路由"**，目标态将其统一为一条管线：

1. **任务编排路由**（六层漏斗）：隐式在 [dialogStore](../src/stores/dialogStore.ts)（:601-1037）——决定"这个请求由什么能力/计划来服务"；
2. **模型分层路由**（ModelTier 选择）：[kernel dispatch](../src/kernel/index.ts)（:77-110 route 簇）——决定"调 LLM 时用哪个档位的模型"（nano/mini/…，复杂度分级阈值见 [smartRouter](../src/services/smartRouter.ts) :66-76：输入长度 100/500/2000、约束命中 0/2/5、DAG 步数 1/3/6）。

**目标态**：内核插件的 dispatch = 六层任务编排管线；route 簇（模型分层）成为 L3 内部的子步骤（LLM 仲裁/生成前选 tier）；budget/security/cache/fact 簇在 4.4 定义的固定点位调用。现状 dispatch 的簇调用顺序（:50-192 实测）即点位设计的基线。

### 4.2 六层定义表（门值以现状代码实测为准）

| 层 | 输入 | 输出 | 通过门（现状实测） | 未过降级 |
|---|---|---|---|---|
| L0 规则直通 | 原始用户输入 | 直通 TaskPlan + 确认门 | `tryL0Skill(content)` 规则命中（[l0SkillRouter](../src/services/l0SkillRouter.ts) 的 file/system/creation/network/query 域规则） | →L0.5 |
| L0.5 关键词快配 | 输入 + 全部可见 L2 manifest | 单步 manifest 计划 | `tryL05QuickMatch` confidence ≥ **0.8**（dialogStore:635）；置信 ≥ **0.9** 且无 shell 操作 → 自动执行（:679），否则确认门 | →L1 |
| L1 能力直调 | 输入 | 单节点管道计划 + 确认门 | `checkL1Capability`: canHandle && plan && confidence ≥ **0.6**（dialogStore:695） | →L2 |
| L2 RaaP 混合检索 | 输入 + 域标记 + 检索范围 | manifest + 置信度 + gate | universal 匹配 top.score ≥ **0.6** → green（[toolRetrieval](../src/services/toolRetrieval.ts):700）；关键词路径动态 green 门基线 **0.95**（:281 `GATE_GREEN_THRESHOLD`）；yellow+歧义 → ZOL 消歧四策略（show_candidates / auto_pick / ask_clarify / fallback_l1，dialogStore:864-951）；反馈检测正则命中则跳过本层（:738-739） | 红/未命中 → L3 |
| L3 LLM 仲裁/规划 | 输入 + 检索候选 | TaskPlan 或 MCP 直调 | 候选 ≥ 2 个 → LLM 仲裁选中（dialogStore:959-1005）；**进入本层即调 route 簇选 ModelTier，budget 簇先行检查** | 仲裁未命中 → L4 |
| L4 探索模式 | 输入 | 探索计划 + 确认门 | `buildExplorePlan`（dialogStore:1008-1037）；无 shell 操作 → 自动执行（:1025-1029），有 shell → 确认门 | —（终点） |

**"强"的语义**：
- 层级顺序由内核插件持有，**任何钩子不得跳过、重排层级**（override 替换的是"该层的内部实现"，见第 5 节护栏 ①）；
- 每层的**门值**由内核插件配置（可作为内核插件差异点——激进内核可调低 L2 green 门提高直调率），领域钩子只能经 advisory 影响打分，**不能改门值**；
- 每层有且只有一条降级路径（表中右列），降级即"该层宣告未命中"。

### 4.3 M5：dispatch 逐层执行逻辑

**入口条件**：dispatch(input, options, context) 被调用；activeKernel 存在（不存在 → 返回 `{success:false, error:'kernel-vacant'}`，见 M4 边界情况）。

**步骤**（对每一层 L ∈ [L0, L0.5, L1, L2, L3, L4] 依序执行）：

1. **钩子收集**：
   - 该层全部 advisory 钩子（按插件注册顺序排序——注册顺序在 PluginRegistry 中是稳定全序，保证确定性）；
   - 该层 override 槽当前 occupant（M7，至多 1 个；槽状态在请求开始时快照，M15）。
2. **顾问执行**：逐个调 `advisory.contribute(input, ctx)`，逐个 try/catch：
   - 单个失败 → 跳过该贡献 + `advisory-failed{packId, layer}` warning，**继续其余顾问**；
   - M14 权限校验前置：未声明 advisory 权限的跳过。
3. **M13 确定性合并**（详见第 5 节 5.5）：全部贡献合并为 `AdvisoryContribution`。
4. **覆盖执行**：override 槽非空且 M14 通过 → 调 `impl(input, merged, ctx)`，带超时（默认 3s，内核插件配置 `overrideTimeoutMs`）：
   - 抛错 / 超时 → **回退内核默认实现** + 记审计事件 `override:fallback{layer, packId, reason}`；
   - impl 内部返回 `{miss: true}` → 视为"该层未命中"，走降级（覆盖实现可以主动放弃，但不能改变降级去向）；
   - 槽空 → 内核默认实现。
5. **门评估**：层输出对照 4.2 门值：
   - 过门 → 层产出进入下一环节（或直接成为最终计划）；
   - 不过 → 降级至下一层（L4 无降级：等待确认门，用户拒绝 → 请求结束）。
6. **否决门插桩**（位置固定，由内核持有）：
   - `pre-execute`：最终 TaskPlan 确定后、执行前（含 L0-L4 全部路径产出的计划）；
   - `pre-output`：LLM 输出/工具产出确定后、呈现给用户前；
   - 两道门均执行 M6 全量评估。
7. **簇调用点位**（沿现状 [kernel/index.ts](../src/kernel/index.ts) :50-192 实测基线固定）：
   - cache.lookup → dispatch 最前（非流式请求，M10 精确匹配）；
   - route（ModelTier）→ L3 进入时；
   - budget.check → L3 调 LLM 前（不允许 → 返回 budget-exceeded，不降级 L4）；
   - security.check → 首次 LLM 生成前（不安全 → 直接返回 security-blocked）；
   - cache.store → 非流式 LLM 生成完成后；
   - budget.record → 生成完成后；
   - fact.check → 有 manifestRoles 且有产出时（pre-output 否决门之后）。

**错误路径**：
- 任何一层内核默认实现抛错 → 视为该层未命中，降级下一层 + `layer-error{layer}` error 日志（**层层兜底是六层管线的容错语义**）；
- L4 探索模式也抛错 → 返回 `{success:false, error:'all-layers-failed'}` + 用户可见的兜底提示。

**回滚路径**：请求级无状态可回滚（管线是纯前向流）；已产生的 cache.store 不撤销（bad output 不会被命中：M10 匹配仍需过 pre-output 否决门前的产出，被否决的产出**不写入缓存**——store 点位在 pre-output 门之前须重排：**实施注意：现状 store 在 fact check 前，目标态把 cache.store 移到 pre-output 否决门之后**，此为对现状的有意修正，理由：被合规拦截的输出不得进入缓存）。

**边界情况**：
- 空输入/纯空白 → 跳过 L0-L3 直达 L4；
- 流式请求 → cache.lookup 跳过（现状 :51 相同），cache.store 跳过，其余不变；
- 竞争模式开启 → L2 产出多 pack 候选时走 M16，flag 关闭 → 现行单匹配，零额外开销；
- 请求开始后发生换内核（M4 draining）→ 在途请求持 M15 快照跑完，新内核不影响本请求。

---

## 第 5 节：弱六层路由——三档钩子（M6 / M7 / M13 / M15）

### 5.1 三档能力定义与接口

```ts
type LayerId = 'L0' | 'L0.5' | 'L1' | 'L2' | 'L3' | 'L4'
type HookTier = 'advisory' | 'veto' | 'override'

/** 顾问：影响打分与候选，内核保留最终决定权 */
interface AdvisoryHook {
  kind: 'advisory'
  layer: LayerId
  contribute(input: RouteInput, ctx: HookContext): AdvisoryContribution
}
interface AdvisoryContribution {
  scoreDelta?: number                          // 叠加到该层匹配打分
  candidates?: MatchCandidate[]                // 追加候选（去重按 id）
  keywords?: string[]                          // 关键词并集
  fewShots?: FewShotExample[]                  // L3 提示注入（按序追加）
  terminology?: Record<string, string>         // 术语映射（键冲突先注册者胜）
  exploreTemplate?: ExplorePlanTemplate        // L4 探索模板
}

/** 否决：拦截/阻断，内核不可绕过——仅边界层两道门 */
interface VetoHook {
  kind: 'veto'
  position: 'pre-execute' | 'pre-output'
  check(payload: TaskPlan | LLMOutput, ctx: HookContext): VetoResult
}
interface VetoResult {
  veto: boolean
  severity: 'block' | 'warn'
  reason: string
  humanJudgmentPrompt?: string                 // 非空 → 路由人工复核暂停点
}

/** 覆盖：提供该层替代实现，内核委托执行 */
interface OverrideHook {
  kind: 'override'
  layer: LayerId
  impl: LayerImplementation                    // 与内核该层默认实现同签名
}
```

### 5.2 每层能力矩阵

| 层 | 顾问 | 否决 | 覆盖 | 覆盖的典型场景 |
|---|---|---|---|---|
| L0 规则直通 | ✓ | — | ✓ | 域直通规则（如法务文书模板生成直通） |
| L0.5 关键词 | ✓ | — | — | 关键词即数据，覆盖无意义 |
| L1 能力直调 | ✓ | — | ✓ | 域能力 manifest（法务专用节点） |
| L2 RaaP 检索 | ✓ | — | ✓ | 域专用检索器（法条库专用混合检索） |
| L3 LLM 规划 | ✓（few-shot/术语注入） | — | ✓（manifest 声明） | 域规划器（法律意见书专用规划） |
| L4 探索模式 | ✓（域探索模板） | — | ✓ | 域探索生成器 |
| 边界（横切门） | — | ✓（pre-execute / pre-output 两道门） | — | 合规约束否决（M6 + M9） |

### 5.3 四条安全护栏（不可妥协）

1. **覆盖换实现，不跳层级**：override 替换的是"该层的内部实现"；层级顺序、降级路径、门值评估仍由内核持有。覆盖实现可返回 `{miss:true}` 主动放弃，但不能指定"跳到第 N 层"。
2. **否决权仅存在于边界层两道门**：域不得在其他层否决内核决策。任何"域想拦截输出"的需求都归入边界层约束（M9），不允许扩散。
3. **权限声明制**：veto/override 必须逐层写入 `manifest.capabilities.hooks`，mount 时 M1 校验，运行时 M14 复查，越权调用跳过 + warning。
4. **override 回退兜底**：impl 抛错或超时（默认 3s）→ 回退内核默认实现 + 审计事件 `override:fallback`。**用户请求永不因覆盖实现的质量问题而失败。**

### 5.4 M6：否决门逻辑

**入口条件**：dispatch 到达 pre-execute（最终 TaskPlan 已定，未执行）或 pre-output（产出已定，未呈现/未入缓存）。

**步骤**：
1. 收集全部带 `boundary: ['veto']` 权限的 pack 的 VetoHook（M14 权限缓存过滤）；
2. **全量评估，不短路**：逐个调 `check(payload, ctx)`，逐个 try/catch：
   - 钩子自身抛错 → **默认 fail-open**（记 `veto-hook-error{packId}` warning，视作"无意见"）；
   - **严格契约模式**（flag，默认关）下 → fail-closed（视作 `block` + generic reason）——理由：选择严格模式的用户要求合规兜底优先于可用性；
3. **聚合**：
   - 任一结果 `veto && severity==='block'` → **中止流程**，返回聚合报告：全部触发的 veto（block 与 warn）按 pack 注册顺序编号列出 `{packId, reason, severity}`；
   - 仅 warn → 警告附加到产出元数据，继续流程；
4. 任一结果带 `humanJudgmentPrompt` → 路由至现有**人工复核暂停点**（七暂停点体系），用户裁决后继续/终止；
5. **pre-output 门通过后才允许 cache.store**（M5 步骤 7 的实施修正）。

**错误路径**：全部钩子失败（fail-open 下）→ 视为无否决，流程继续 + 汇总 warning。

**回滚路径**：无状态；被 block 的请求返回聚合报告，不产生部分执行副作用（pre-execute 门在任何执行前）。

**边界情况**：
- 同时命中多个 pack 的 block → 全部列出（用户需要知道每一条违规，不是第一条）；
- pre-execute 门 block 了 L0 的直通计划 → 请求结束（不降级重试其他层——否决针对的是"这个计划本身违规"，换层产出的计划是新请求的事）；
- 人工复核暂停点超时/用户忽略 → 默认不执行（保守）。

### 5.5 M13：顾问贡献确定性合并

**入口条件**：M5.2 收集到 ≥ 1 个贡献。

**规则**（全部确定性，无并发，顺序 = 插件注册顺序）：
1. `scoreDelta`：按注册顺序**累加**（浮点，最终一次性加到层匹配分上）；
2. `candidates`：按注册顺序**追加**，按 candidate.id 去重**保留首个**；
3. `keywords`：**并集**（保留出现顺序）；
4. `fewShots`：按注册顺序**追加**（数量上限由内核插件配置，超出截断 + warning）；
5. `terminology`：逐 pack 合并，**键冲突先注册者胜**（后注册者对该键的覆盖被丢弃 + warning）；
6. `exploreTemplate`：**先注册者胜**（单值槽，同 M7 语义但无 priority——探索模板冲突极少，简单规则优先）。

**边界情况**：贡献为空对象 → 无操作；贡献含未知字段 → 忽略未知字段（schema 校验已在 mount 时拦截，运行时宽容）。

### 5.6 M7：覆盖冲突消解

**入口条件**：pack 注册 OverrideHook（M8.4d 钩子注册阶段，或运行时动态注册）。

**步骤**：
1. 目标层 override 槽为空 → 直接入槽；
2. 槽被占 → 比较 `manifest.capabilities.priority`（默认 0）：
   - 新者 priority **更高** → 替换入槽，原占用者降级为未激活（收到 `override-displaced` 通知事件）；
   - 相等或更低 → **拒绝注册** + `override-conflict{layer, incumbent, challenger}` warning；
3. pack unmount → 释放槽 → **不自动晋升**任何等待者（槽空，内核默认实现接管）；被拒的挑战者需重新注册；
4. 槽切换**只影响下一个请求**（在途请求走 M15 快照）。

**边界情况**：
- 两个 pack priority 相同且都必要 → 维护者侧问题，规格选择暴露冲突而非静默裁决（warning 即信号）；
- override 注册发生在 dispatch 进行中 → 入槽动作在当前请求结束后对后续请求可见（注册表写入与快照读取的竞态由单线程事件循环天然串行化，无需锁）。

### 5.7 M15：在途请求快照

**入口条件**：dispatch 开始。

**步骤**：
1. 请求开始时，把当次会用到的全部钩子引用（advisory 列表、override 槽 occupant、veto 列表）与簇实现引用捕获进**请求级快照对象**；
2. 快照对象生命周期 = 请求生命周期；unmount/换簇只清除注册表引用，不动快照；
3. JS GC 保证：只要请求持有快照，被卸载插件的钩子对象不会被回收 → **无 use-after-free**；
4. 语义：**unmount 后的新请求不见旧钩子；在途请求用快照跑完**。

**边界情况**：
- 快照中的钩子内部引用了插件已释放的资源（如 pack KB 检索句柄）→ 钩子自身负责容错（抛错走 M5.2/M6.2 的既有失败路径），规格不承诺"卸载后钩子仍能成功执行"，只承诺"不会崩溃管线"。

---

## 第 6 节：内核插件与五簇热换（M4 + 簇注册逻辑）

### 6.1 KernelRegistry 接口

```ts
interface KernelRegistry {                 // 宿主持有；全局同一时刻仅一个激活内核
  register(k: KernelPlugin): Promise<void>        // 入池（不激活）
  activate(id: string, opts?: { drainTimeoutMs?: number }): Promise<SwitchResult>  // M4
  standby(id: string): Promise<void>              // 非激活内核：unmount 但保留在池
  destroy(id: string): Promise<void>              // 出池
  getActive(): KernelPlugin | undefined
}
```

**内核插件的组成**：六层路由管线实现（每层默认实现 + 门值配置）+ 调度策略参数 + **簇注册表**（五簇委托）。换内核 = 整体替换这一切；换单簇 = 只换局部策略。

### 6.2 M4：换内核状态机

```
            register(k2)           activate(k2)
  empty ────────────────→ pooled ──────────────→ active(k1) ──→ draining ──→ switching ──→ active(k2)
                              ↑                    │              │              │
                              └──── destroy/standby┘              │              │ 新mount失败
                                                    │ 在途归零或超时│              ↓
                                                    │              │        回滚: active(k1)
                                                    └──────────────┘       （k1重挂失败→内核空缺态）
```

**activate(id) 步骤**：
1. id 不在池中 → 返回 `{ok:false, reason:'not-registered'}`；
2. 当前无激活内核 → `k.mount()`（超时 10s）→ 成功：`active(k)` + emit `kernel:activated{id}`；失败：保持 empty，返回 `{ok:false, reason:'mount-failed'}`；
3. id === active → no-op 返回 `{ok:true, reason:'already-active'}`；
4. **draining 期间收到 activate → 拒绝**（`{ok:false, reason:'switch-in-progress'}`）：一次只允许一次切换，杜绝竞态；
5. 不同内核 → 进入 **draining**：
   - 新请求**入队**（队列上限默认 100，溢出返回 `{success:false, error:'kernel-switching-busy'}`——不让用户请求无限堆积）；
   - 等待在途请求数归零 **或** drain 超时（默认 5s，`opts.drainTimeoutMs` 可覆盖）：
     - 归零 → 进入 switching；
     - 超时 → **取消剩余在途请求**（逐个 emit `kernel:switch-cancelled{requestId}`，调用方收到 `{success:false, error:'cancelled-by-kernel-switch'}`）→ 进入 switching；
6. **switching**：`newKernel.mount()`（超时 10s）：
   - 成功 → `oldKernel.unmount()`（try/catch，失败仅日志）→ active = new → **重放队列**（按入队顺序逐个交给新内核）→ emit `kernel:switched{from, to}` → `{ok:true}`；
   - 失败 → **回滚**：old 保持 active（若 old 已被部分卸载则重挂；**old 重挂也失败 → 内核空缺态**：`getActive()` 返回 undefined，全部 dispatch 返回 `kernel-vacant`，emit `kernel:fatal`，应用层展示降级提示并建议重启）→ 队列重放至 old → `{ok:false, reason:'switch-failed-rolled-back'}`。

**standby(id)**：id 为 active → 拒绝（`{ok:false, reason:'active-kernel-must-stay'}`，先 activate 其他才能下线当前）；非 active → unmount 但保留池籍。

**destroy(id)**：id 为 active → 拒绝；否则出池。

**边界情况**：
- 在途请求持 M15 快照 → draining 结束的判定只数请求结束信号（resolve/reject），不等待快照对象 GC；
- 队列重放时某请求已被调用方放弃（取消）→ 重放前检查取消标记，跳过；
- mount 超时但 mount 函数仍在运行 → 同 M1 zombie 语义：该内核插件标记 zombie，池中不可再 activate。

### 6.3 簇注册表与五簇状态归属

```ts
type ClusterKind = 'route' | 'cache' | 'security' | 'budget' | 'fact'
interface ClusterRegistry {                // 内核插件持有
  register(kind: ClusterKind, impl: ClusterImpl): void   // 即时替换委托
  unregister(kind: ClusterKind): void                     // 回退内核默认簇实现
  get(kind: ClusterKind): ClusterImpl
}
```

**五簇状态归属表（"委托可换 vs 完全可换"的边界）**：

| 簇 | 现状模块（委托目标） | 状态归属 | Phase 3 可换级别 |
|---|---|---|---|
| route | [smartRouter](../src/services/smartRouter.ts) | 阈值自适应状态（ZOL，模块内） | 委托可换 |
| cache | [semanticCache](../src/services/semanticCache.ts) | 缓存条目（模块内 exactMap/semanticArray/LRU） | 委托可换 |
| security | [factGuard](../src/services/factGuard.ts) + 审计 | 审计记录、事实库 | 委托可换 |
| budget | [tokenBudget](../src/services/tokenBudget.ts) | 累计用量、预算模式 | 委托可换 |
| fact | [factGuard](../src/services/factGuard.ts) | 事实库 | 委托可换 |

**如实声明的限制**：五簇现状为模块级单例状态（模块顶层 `let`），Phase 3 的"簇热换"= **实现委托可换**（新簇实现接管调用入口，但模块状态仍全局共享——换缓存策略不等于换缓存数据）。**状态容器化**（每内核实例私有状态，真正完全可换）列为 Phase 4+ 路线，本文不承诺。

**簇切换边界**：`register` 即时生效于**下一个请求**（在途请求持 M15 快照）；`unregister` 回退默认实现，**不允许簇空缺**（与内核不同：簇有内核兜底，内核无兜底）。

### 6.4 主路径切换（Phase 3 的目标态）

默认内核插件的 dispatch 成为**唯一编排入口**；dialogStore 瘦身为 UI 适配层（消息渲染、暂停点交互、系统通知），apiStore 内联编排逻辑迁入内核。行为等价要求：七暂停点（confirmation/intentConfirm/slotFill/…）、流式（AsyncIterable）、取消语义在 dispatch 契约中原样保留——验证策略见第 11 节 Phase 3 验收。

---

## 第 7 节：知识库隔离与零污染（M10 / M11 / M12）

### 7.1 隔离矩阵

| 查询发起方 | 可见范围 | 不可见 |
|---|---|---|
| 内核 KB 检索 | kernel | 全部 pack、（user 见 7.2 备注） |
| pack A 检索 | pack A + user（显式授权时） | kernel、其他 pack |
| 用户个人检索（无 partition scope） | user + kernel | 全部 pack |
| 竞争模式影子评估 | 仅各自 pack | 其他一切 |

**user 是否对 pack 可见**：默认不可见；pack manifest 可声明 `needsUserKnowledge: true`（显式授权，UI 提示用户），声明后该 pack 的检索范围附加 user 分区。理由：法务包检索用户的个人文档需要用户知情。

### 7.2 M11：检索 scope 过滤（partition 正交设计）

**关键勘察修正**：现有 `SearchScope.ownerType`（[knowledgeBase.ts](../src/services/knowledgeBase.ts):195-199）取值 `'global'|'session'|'pipeline'|'group'|'conversation'`，语义是**摄取目标**（这份知识属于哪个会话/管道/分组），**不是归属分区**。二者是正交维度，不得复用同一字段。

**设计**：
1. `KnowledgeEntry` 新增字段：
   ```ts
   partition?: 'kernel' | 'pack' | 'user'   // 归属分区；undefined 视为 'user'（存量兼容）
   partitionId?: string                      // partition='pack' 时为 packId
   ```
2. `SearchScope` 新增可选字段 `partition?: { kind: 'kernel'|'pack'|'user'; id?: string }`；
3. hybridSearch 过滤逻辑（在现有 :293-309 scope 过滤**之前**执行）：
   - 显式 partition scope → 仅保留 `entry.partition===kind`（kind='pack' 时还需 `partitionId===id`）的条目；
   - **无 partition scope → 默认范围 = partition ∈ {'user', undefined, 'kernel'}**——**pack 条目对无 scope 查询完全不可见**（零污染的兜底规则：宁可 pack 数据漏出不足，不可 pack 数据泄入他域）；
   - 现有 ownerType/groupIds 过滤逻辑不动，与 partition 过滤**正交叠加**（AND）。
4. 嵌入向量随 entry 存储（现状 chunk 记录携带 vector），partition 标签加在 entry 上 → 查询侧先过滤 entry 再取 chunk，**无需重建向量**。

**错误路径**：partition scope 声明了不存在的 packId → 空结果集（不是错误——pack 卸载后旧引用查询自然为空）。

**边界情况**：
- groupIds 共享组内的条目可能跨 partition（用户把 pack 产出条目拉进个人共享组）→ 共享组语义优先于 partition（用户显式动作视为授权），但 pack 侧检索仍不因此获得 user 条目；
- vault 层不强制分区（分区纪律在检索层执行）：`kernel:*` / `pack:<id>:*` / `knowledge:*` 命名规范 + 白名单见附录 C，物理隔离是纵深防御而非唯一防线。

### 7.3 M10：缓存精确匹配

**现状污染向量**（[semanticCache.ts](../src/services/semanticCache.ts):151-154）：
```ts
function domainMatch(entry, domain) {
  if (!domain) return true      // ← 查询无域 → 任何条目都可命中
  if (!entry.domain) return true // ← 条目无域 → 任何查询都可命中
  return entry.domain === domain
}
```
无域标签条目可被任何域查询命中 = 跨域缓存污染。

**目标逻辑**：
1. `SemanticCacheEntry` 新增 `packId?: string`；
2. lookup(queryText, domain?, packId?) 精确匹配：
   - 精确键命中 → 过期检查 → **`entry.packId === query.packId`**（双方 undefined 视为相等；注意现状 store 把缺失 domain 存为 `''`（:279），packId 语义必须区分：**undefined = 不属于任何 pack；'' 一律视为 undefined 归一化**，规格明确禁止把 '' 用于任何 pack 语义）→ 命中；
   - 向量路径：逐条目 `isExpired` → **packId 精确比对** → cosine 相似度 ≥ 自适应阈值（:157-178 自适应逻辑与 :288 LRU 淘汰**均不动**）；
   - **废除两条宽松隐式通过**（`!domain→true`、`!entry.domain→true`）——domain 维度同样精确化：entry.domain 为 '' 归一化为 undefined，与 query.domain undefined 相等才通过；
3. store：写入时记录请求归属 packId；
4. 新增 `invalidateByPack(packId): number`：移除全部 `entry.packId===packId` 条目（对称于现状 `invalidateByDomain` :300-311），返回移除数；
5. pack unmount → 自动调 invalidateByPack（M8 回滚与卸载均调用）。

**错误路径**：无（匹配逻辑纯函数化，查不到就是 miss）。

**回滚路径**：该修复是行为变更（宽松→严格），回滚 = 恢复旧 domainMatch；上线预期影响：原依赖宽松命中的缓存命中率会下降——**这是有意的**，那些命中本身就是污染。

### 7.4 M12：存量迁移脚本

**入口条件**：Phase 2 首次启用 partition 机制时执行一次；此后每次升级 schema 版本检查幂等跳过。

**步骤**：
1. **备份**：vault 导出涉及 namespace（knowledge 条目、conv、skill）到带时间戳备份；备份失败 → **中止迁移**（宁可不动不可丢数据）；
2. 记录迁移前条目计数（逐 namespace）；
3. 逐条处理：`entry.partition === undefined` → 写入 `partition='user'`（**存量无主条目一律归用户**，不猜归属）；
4. 逐 namespace 计数对账：迁移后总数 === 迁移前总数 → 通过；**不等 → 恢复备份 + 迁移失败报告**；
5. 输出报告：{总数, 修改数, 耗时, 备份位置}；脚本幂等（重复执行第 3 步全为 no-op）。

**边界情况**：
- 迁移中途崩溃 → 重跑（步骤 3 幂等 + 步骤 1 重新备份）；不追求断点续传（数据量级为本地知识条目，全量重跑成本可接受）；
- 用户在迁移后手动删除备份 → 仅影响回滚能力，不影响运行。

---

## 第 8 节：DomainPack——加载、约束 DSL 与转译清单（M8 / M9 / M19）

### 8.1 目录结构

```
packs/legal/
├── pack.json          # manifest（schema 见 8.2）
├── knowledge/         # 知识层：法条、判例、术语条目（KnowledgeEntry JSON 文件）
├── boundary/          # 边界层
│   ├── constraints.json   # 声明式约束（DSL，schema 见 8.3）
│   └── evaluators/        # 逃生舱（TS 文件，仅 DSL 表达不了的少数约束）
├── execution/         # 执行层
│   ├── routing.json       # 路由偏置（替代 DOMAIN_ROUTING_TIER_BIAS 的 legal 项）
│   ├── terminology.json   # 术语映射（promptTranslator 注入）
│   ├── manifests.json     # RaaP 检索池条目（L1/L2 manifest）
│   └── skills/            # 域技能
└── cases.json         # 案例库（few-shot）
```

三层各是纯数据目录（knowledge/boundary/execution），改域 = 改 JSON，不改内核代码——这是"声明式易维护"目标的物理形态。

### 8.2 pack.json schema

```jsonc
{
  "id": "legal",                          // 全局唯一；与内置 pack 重复 → 内置优先 + warning
  "name": "法务专家包",
  "version": "1.0.0",
  "license": "open-source",               // 预留：'open-source' | 'commercial'（付费增强分发用）
  "domain": "legal",                      // 对应 DetectedDomain 语义（泄漏 ④ 迁移目标）
  "priority": 0,                          // override 槽竞争用（M7），默认 0
  "weight": 1.0,                          // 竞争模式竞标权重（M16），默认 1.0
  "needsUserKnowledge": false,            // 显式声明后才可检索 user 分区（M11/7.1）
  "capabilities": {
    "hooks": {                            // 逐层声明，M1 mount 校验 + M14 运行时复查
      "advisory": ["L0", "L1", "L2", "L3", "L4"],
      "veto": ["pre-execute", "pre-output"],
      "override": ["L2"]
    },
    "clusters": []                        // 本 pack 不替簇；空 = 纯领域包
  },
  "compatibility": { "minHostVersion": "0.3.0" }
}
```

### 8.3 constraints.json schema（M9 DSL，勘察修正版）

```jsonc
{
  "id": "legal-labor-overtime-limit",
  "category": "加班时长",
  "description": "每月加班不得超过36小时（劳动法第41条）",
  "severity": "warning",
  "applicability": { "jurisdiction": "PRC" },
  "reliability": { "confidence": "high", "source": { "type": "law", "name": "中华人民共和国劳动法", "article": "第四十一条" } },
  "automationLevel": "full",              // 'full' | 'semi'
  "trigger": {
    "keywords": ["加班"],                 // 或语义（命中任一）
    "allKeywords": ["劳动合同", "试用期"], // 须全命中
    "excludeKeywords": ["已签", "续签"],   // 须全不命中
    "entities": [{ "type": "amount", "minCount": 1 }],
    "numericCapture": [                   // 本轮新增能力（勘察驱动）
      { "pattern": "加班[^0-9]{0,6}([0-9]+)\\s*小时", "captureGroup": 1,
        "compare": ">", "threshold": 36, "unitHint": "小时/月" }
    ]
  },
  "action": {
    "severity": "error",
    "messageTemplate": "每月加班不得超过36小时（检测到 {{capture[0]}} 小时）",
    "requireHumanReview": false,
    "humanJudgmentPrompt": null           // automationLevel='semi' 时必填
  },
  "evaluator": null,                      // 非空则指向 "evaluators/xxx.ts"，优先于 DSL
  "testCases": [ /* 与现有 DomainConstraint.testCases 同构 */ ],
  "sources": [ /* ConstraintSource[] 同构 */ ]
}
```

**字段与现有 DomainConstraint 的映射**：id/category/description/severity/applicability/reliability/testCases/sources 一一对应（[domainConstraints.ts](../src/services/domainConstraints.ts):16-46 的 createConstraint 参数序）；仅 `check` 命令式函数被 `trigger + action + evaluator` 三元组替代。

### 8.4 M8：pack 加载器

**入口条件**：宿主启动扫描内置 `packs/` 目录；或运行时 mountPack(id) 调用（vault 侧 pack 用 `vault.list(namespace)`（[vault](../src/vault/index.ts):44 已支持）枚举 `packs:` 前缀）。

**步骤**：
1. **发现**：读 pack.json → JSON 解析失败 → 错误 `{packId, phase:'manifest', reason:'json-parse', detail}`；
2. **id 冲突**：与内置或已挂载 pack 重复 → 内置优先 + `pack-conflict{id}` warning，外部 pack 拒绝加载；
3. **manifest 校验**：必填字段（id/domain/version/capabilities）+ capabilities.hooks 引用的层合法（LayerId ∪ 门位置）→ 失败 → `{phase:'manifest', reason:'schema', detail: 字段路径}`；
4. **依赖解析**：compatibility.minHostVersion 不满足 → 拒绝；pack 间依赖（暂无）留空；
5. **事务式分层加载**（每层成功才进下一层；全部 disposer 记入加载事务）：
   - **knowledge 层**：逐文件解析 → 注册 KnowledgeEntry（`partition:'pack', partitionId:packId`）→ 生成嵌入向量（本地模型）→ 失败 → 回滚；
   - **boundary 层**：constraints.json schema 校验（错误精确到 `constraints.json#/items/12/trigger/numericCapture/0/compare`）+ evaluator 文件存在性检查 + **mount 自检**：逐条跑 testCases（输入样例 → DSL/evaluator 评估 → 对照 expectedTrigger/expectedMessage）→ **失败约束标记 disabled + `constraint-self-check-failed{id}` warning，不阻挂载**（计划内定：一条坏约束禁用一条，不让整个 pack 挂不上）；
   - **execution 层**：routing/terminology/manifests/skills/cases 逐项注册到对应服务；
   - **钩子注册**：按 manifest.capabilities 构建 AdvisoryHook/VetoHook/OverrideHook → M14 权限缓存更新 → M7 冲突消解；
   - 状态初始化：约束 `automationLevel==='full' && reliability.confidence==='auto'` → active，其余 → testing（沿现状 [initConstraintStore](../src/services/domainConstraints.ts):3166/:3171 规则）；
6. **完成**：emit `pack:mounted{packId}`；加载事务清空（disposer 已移交 PluginRegistry 台账）。

**错误路径**：任一步失败 → **全量回滚**：逆序执行已记 disposer → KB 注销已注册条目 → invalidateByPack 清缓存 → emit `pack:mount-failed{packId, phase, reason}`。

**回滚路径**：mount 失败回滚 = 干净的未挂载态；unmount（M2）复用同一清理序列。

**边界情况**：
- 磁盘上 pack 目录缺子目录（如无 execution/）→ 视为空层，合法（hr pack 就没有约束）；
- knowledge 文件含超大条目 → 嵌入超时单条跳过 + warning，不阻层；
- 同一 pack 重复 mount → 拒绝 `{reason:'already-mounted'}`。

### 8.5 M9：约束评估器逻辑

**入口条件**：pre-output 否决门（M6）触发，对本 pack 的 active/testing 约束逐条评估。

**步骤**：
1. **上下文构造**（保留现状 [runConstraints](../src/services/domainConstraints.ts):3263 行为）：`ctx.entities = extractEntities(sourceText + ' ' + outputText)` —— **合并文本重抽覆盖**，不信任上游已抽实体；上下文字段 = `{sourceText, outputText, entities}`（勘察结论：[ConstraintCheckContext](../src/models/index.ts):1054-1060 五字段中 stepResults/manifestRoles 在 55 条里**零使用**，pack 上下文简化为三字段；逃生舱 evaluator 签名保留五字段兼容）；
2. **evaluator 优先**：`evaluator` 非空 → 调 TS 逃生舱（接收五字段兼容签名），try/catch（失败 → `constraint-error{id}` warning，视作未触发——与 M6 fail-open 一致）；
3. **DSL 评估**（全部 AND）：
   - keywords：任一命中合并文本；
   - allKeywords：全命中；
   - excludeKeywords：全不命中；
   - entities：逐 type 计数 ≥ minCount（实体类型实测仅 amount / percentage / law_article 三类在用）；
   - **numericCapture 逐条**：正则于合并文本执行 → 无匹配 → 该条不满足 → 整体不触发；有匹配 → 取 `captureGroup`（默认 1）的捕获值 → 按 `compare` 与 `threshold` 比较 → 不满足 → 不触发；
4. **触发** → 按 action 生成 ConstraintResult：messageTemplate 渲染（模板变量：`{{capture[i]}}` 捕获值、`{{entity[type]}}` 实体值、`{{keyword}}`）；`severity==='block'` → 进入 M6 聚合；
5. `requireHumanReview===true` → VetoResult 附 humanJudgmentPrompt → 路由人工复核暂停点；
6. testing 状态约束：同样评估，但结果仅记录（审计/调试），**不产生 block**——灰度语义。

**错误路径**：单条约束任何异常 → 该条视作未触发 + warning，绝不中断整批评估。

**边界情况**：
- 中文数字（"两年""三十六小时"）：numericCapture 的 `\d` 捕获不到 → 不触发 → **这正是 #2 归 evaluator 的原因**（中文数字映射 + 年限分档查表是 TS 逻辑）；DSL v2 若增加中文数字映射表可收编部分（附录 C）；
- 同一文本触发多条 → 全部返回（M6 聚合报告逐条列出）。

### 8.6 现有 55 条约束转译清单（全表）

**统计**：LEGAL_CONSTRAINTS（[domainConstraints.ts](../src/services/domainConstraints.ts):96-2911）50 条 + FINANCE_CONSTRAINTS（:2912-3356）5 条 = **55 条**。分类：**48 declarative**（其中 10 条依赖 numericCapture）+ **7 evaluator**；自动化：full 37 / semi 18（semi 连续区间 #33-#50，均带 humanJudgmentPrompt）。升级后 **51 条纯声明式、仅 4 条硬需逃生舱**。

| # | id（:行号） | category | 触发分类 | 自动化 | 转译说明 |
|---|---|---|---|---|---|
| 1 | legal-labor-contract-written (:98) | 劳动合同 | DSL | full | 关键词+取反组（未签/已签判别） |
| 2 | legal-labor-contract-probation-limit (:151) | 试用期 | **evaluator** | full | 中文数字映射 + 期限分档查表 |
| 3 | legal-labor-overtime-limit (:236) | 加班时长 | DSL+numericCapture | full | 捕获加班小时数 > 36 |
| 4 | legal-labor-salary-payment (:286) | 工资支付 | DSL | full | 纯关键词 |
| 5 | legal-labor-dismiss-protection (:334) | 解除劳动合同 | DSL | full | 关键词（孕期/产期/哺乳期 × 解除） |
| 6 | legal-contract-seal (:383) | 合同形式 | DSL | full | 纯关键词 |
| 7 | legal-labor-severance-pay (:434) | 经济补偿 | DSL | full | 纯关键词 |
| 8 | legal-labor-social-insurance (:485) | 社会保险 | DSL | full | 纯关键词 |
| 9 | legal-labor-minimum-wage (:535) | 最低工资 | DSL+numericCapture | full | 捕获工资金额 < 2000 |
| 10 | legal-contract-breach-liquidated-damages (:590) | 违约金 | **evaluator** | full | 万元换算 + 比例 > 30% |
| 11 | legal-labor-dispatch-ratio (:647) | 劳务派遣 | **evaluator** | full | 两 amount 比例算术（DSL v2 可收编） |
| 12 | legal-labor-dispatch-same-pay (:728) | 劳务派遣 | DSL | full | 纯关键词 |
| 13 | legal-labor-annual-leave (:786) | 年休假 | **evaluator** | full | 年限分档查表（20→15/10→10/1→5） |
| 14 | legal-labor-maternity-leave (:848) | 产假 | DSL+numericCapture | full | 捕获产假天数 < 98 |
| 15 | legal-labor-work-injury-compensation (:907) | 工伤 | DSL | full | 关键词+实体 |
| 16 | legal-labor-non-compete-scope (:960) | 竞业限制 | DSL+numericCapture | full | 捕获竞业年限 > 2 |
| 17 | legal-labor-non-compete-compensation (:1017) | 竞业限制 | DSL+numericCapture | full | 捕获补偿比例 < 30% |
| 18 | legal-labor-training-service-period (:1075) | 培训服务期 | **evaluator** | full | 万元换算 + 两值大小 |
| 19 | legal-contract-standard-clause-invalid (:1135) | 格式条款 | DSL | full | 纯关键词 |
| 20 | legal-contract-guarantee-type (:1187) | 保证方式 | DSL | full | 纯关键词 |
| 21 | legal-contract-limitation-period (:1240) | 诉讼时效 | DSL+numericCapture | full | 捕获时效年数 > 3 |
| 22 | legal-ip-copyright-work-for-hire (:1299) | 职务作品 | DSL | full | 纯关键词 |
| 23 | legal-consumer-triple-damages (:1351) | 消费者欺诈 | DSL | full | 关键词+金额实体 |
| 24 | legal-consumer-seven-day-return (:1406) | 网购退货 | DSL | full | 纯关键词 |
| 25 | legal-housing-deposit-limit (:1460) | 租赁押金 | DSL+numericCapture | full | 捕获押金月数 > 2 |
| 26 | legal-housing-lease-term-limit (:1519) | 租赁期限 | DSL+numericCapture | full | 捕获租期年数 > 20 |
| 27 | legal-housing-sale-does-not-break-lease (:1576) | 买卖不破租赁 | DSL | full | 纯关键词 |
| 28 | legal-securities-insider-trading (:1629) | 内幕交易 | DSL | full | 纯关键词 |
| 29 | legal-tax-individual-income-tax (:1681) | 个人所得税 | DSL | full | 关键词+比例实体 |
| 30 | legal-tax-corporate-income-tax (:1740) | 企业所得税 | DSL | full | 关键词+比例实体 |
| 31 | legal-tax-invoice-obligation (:1800) | 发票 | DSL | full | 纯关键词 |
| 32 | legal-corporate-director-duty (:1851) | 董事义务 | DSL | full | 纯关键词 |
| 33 | legal-labor-work-injury-report (:1903) | 工伤申报 | DSL+numericCapture | **semi** | 捕获申报天数 > 30；带 humanJudgmentPrompt |
| 34 | legal-labor-collective-contract (:1963) | 集体合同 | DSL | semi | 纯关键词；人工复核 |
| 35 | legal-contract-standard-clause (:2019) | 格式条款提示 | DSL | semi | 纯关键词；人工复核 |
| 36 | legal-contract-guarantee-period (:2077) | 保证期间 | DSL | semi | 关键词；人工复核 |
| 37 | legal-ip-patent-employee-reward (:2134) | 职务发明奖励 | DSL | semi | 纯关键词；人工复核 |
| 38 | legal-consumer-personal-info-protection (:2190) | 个人信息保护 | DSL | semi | 纯关键词；人工复核 |
| 39 | legal-corporate-capital-contribution (:2246) | 出资义务 | DSL | semi | 纯关键词；人工复核 |
| 40 | legal-dispute-limitation-check (:2301) | 诉讼时效适用 | DSL | semi | 纯关键词；人工复核 |
| 41 | legal-contract-formation-offer-acceptance (:2360) | 要约 | DSL | semi | 纯关键词；人工复核 |
| 42 | legal-contract-simultaneous-performance (:2416) | 同时履行 | DSL | semi | 纯关键词；人工复核 |
| 43 | legal-contract-termination-notice (:2467) | 合同解除通知 | DSL | semi | 纯关键词；人工复核 |
| 44 | legal-ip-copyright-ownership (:2523) | 著作权归属 | DSL | semi | 纯关键词；人工复核 |
| 45 | legal-ip-patent-employee-invention (:2580) | 职务发明申请权 | DSL | semi | 纯关键词；人工复核 |
| 46 | legal-ip-trademark-registration (:2634) | 商标注册 | DSL | semi | 纯关键词；人工复核 |
| 47 | legal-consumer-safety-liability (:2691) | 产品缺陷责任 | DSL | semi | 纯关键词；人工复核 |
| 48 | legal-housing-landlord-maintenance (:2745) | 出租人修缮义务 | DSL | semi | 纯关键词；人工复核 |
| 49 | legal-corporate-shareholder-rights (:2801) | 股东会决议 | DSL | semi | 纯关键词；人工复核 |
| 50 | legal-dispute-arbitration-agreement (:2857) | 仲裁协议 | DSL | semi | 纯关键词；人工复核 |
| 51 | finance-invoice-amount-match (:2914) | 发票金额 | **evaluator** | full | 跨两值差值 \|v0−v1\|>0.01（DSL v2 可收编） |
| 52 | finance-tax-rate-vat (:2970) | 增值税率 | DSL | full | 关键词+比例实体（13/9/6%） |
| 53 | finance-payment-terms-limit (:3018) | 付款期限 | DSL+numericCapture | full | 捕获付款天数 > 60 |
| 54 | finance-depreciation-rate (:3066) | 折旧率 | DSL | full | 关键词+比例实体 |
| 55 | finance-large-transaction-flag (:3116) | 大额交易 | **evaluator** | full | 万元换算后比 50 万阈值（DSL v2 可收编） |

**evaluator 逃生舱共性**（7 条）：万元单位换算、两个提取值间的比例/差值/大小关系、按年限分档查表、中文数字映射——其中 #11/#51/#55 仅差"两捕获值算术表达式"一项，列为 **DSL v2 扩展**（附录 C）；#2/#10/#13/#18 需查表或双值算术，v2 后仍可能保留逃生舱。

### 8.7 M19：开发模式热重载

**入口条件**：`import.meta.env.DEV === true` 且 pack 目录位于本地文件系统。

**步骤**：watch pack 目录树 → 变更防抖（默认 300ms，可配）→ 对目标 pack 执行**完整 unmount + mount 循环**（不增量更新——保证每次重载等价于全新挂载，避免半更新状态）→ 成功 → 控制台输出 `pack:reloaded{packId, 耗时}`。

**错误路径**：重载的 mount 失败 → **旧版本已卸载的状态如实保留** + 报错。规格选择：**不做"失败自动还原旧版"**——开发模式下快速暴露问题优于掩盖；开发者修复文件后下一次 watch 触发自然恢复。

**边界情况**：watch 触发时 pack 正在被 mount/unmount → 排队（防抖后串行执行）。

### 8.8 Phase 2 适配器映射（pack 数据先接入现有服务）

| pack 数据 | 接入点（现状服务） | mount / unmount 动作 |
|---|---|---|
| constraints.json | [runConstraints](../src/services/domainConstraints.ts) 管道 | 注入 active 集 / 摘除并 invalidateByPack |
| routing.json | [smartRouter](../src/services/smartRouter.ts) 域偏置（替代 :201-202 硬编码） | 注册偏置项 / 注销 |
| terminology.json | [promptTranslator](../src/services/promptTranslator.ts) | 术语注入 / 移除 |
| manifests.json | [RaaP 检索池](../src/services/toolRetrieval.ts) | 条目入池 / 出池 |
| cases.json | 案例库（few-shot） | 注册 / 注销 |

全部为 mount 注册 / unmount 注销的对称模式；Phase 3 后这些服务调用点被内核管线簇点位取代，适配器退役。

### 8.9 hr pack 说明

**已建（A5 批，运营层第一批）**。勘察期 hr 域约束实测为 0 条（类型支持 'hr' 但无约束数组——[domainConstraints.ts](../src/services/domainConstraints.ts) 中不存在 HR_CONSTRAINTS），故 hr pack 边界层为空，属合法空层（见 8.8）。

现结构（[src/packs/hr/](../src/packs/hr/)）：

- **pack.json**：domain 'hr'，weight 1.0；
- **execution/manifests.json**：归因表声明 5 个 HR 宏（resume-screening / onboarding-guide-gen / announcement-draft / attendance-exception-note / offboarding-checklist）。归因纪律：`l2-policy-doc-qa-v1` 为 HR/Legal 双角色宏，已由 legal 声明，hr 不重复声明（loader 首声明者赢，glob 字母序 finance→hr→legal）；
- **knowledge/hr-terms.json**：术语层（~21 条，含"非法律意见"声明），经 knowledge 层管线注入 pack 分区 KB。

新增 2 个实战宏（执行真源在 [l2Manifests.ts](../src/data/l2Manifests.ts)，非 pack 内）：`l2-attendance-exception-note-v1`（口述考勤异常→正式说明）与 `l2-offboarding-checklist-v1`（岗位描述→四类交接清单）。均为 2 步 DAG（knowledge_search nano + llm_generate standard，无 shell_exec），不进星图节点表（星图冻结，仅靠 routing.keywords 参与 funnel 候选匹配）。

---

## 第 9 节：竞争模型与契约模式（M16，默认关闭）

### 9.1 竞争模型

**入口条件**：`hostFlags.competitiveMode === true`（默认 **false**，普通用户不可见——开发者配置项）。关闭时 L2 保持现行单匹配语义，**零额外开销**（分支不存在）。

**步骤**（开启时，L2 产出多 pack 候选场景）：
1. 各候选 pack 独立完成本域检索（各自 KB，影子范围见 7.1 隔离矩阵）；
2. **竞标分** = L2 置信度 × `manifest.weight`（默认 1.0）× **质量 EMA**（初始 1.0，每请求后更新：`ema = 0.9 × ema + 0.1 × outcome`，outcome ∈ [0,1] 由用户反馈/执行成败归一）；
3. 最高分 pack **胜出服务**该请求（其候选、钩子、KB 全程生效）；
4. 其余 pack 进行**影子评估**：只读各自 KB 跑约束检查，结果仅入审计日志（`shadow-eval{packId, wouldVeto}`），**不产生任何用户可见影响、不写缓存、不产生副作用**；
5. 请求完成后更新胜者 EMA。

**错误路径**：影子评估抛错 → 静默 + 日志（影子绝不能影响主流程——这是影子存在的全部意义）。

**边界情况**：
- 仅一个 pack 候选 → 退化为单匹配（但仍记录 EMA）；
- 平分 → manifest.weight 再平 → 注册顺序先者胜（确定性兜底）；
- 胜者中途失败（如 override 抛错）→ 走 M5 既有回退（内核默认实现），**不切换到第二名**（切换语义复杂且不可预期，列为附录 C 待定项）。

### 9.2 契约模式两级

| 级别 | 内容 | 默认 |
|---|---|---|
| 轻校验 | mount 时 schema 校验 + capabilities 声明核对（M1/M8） | **开** |
| 严格模式 | 逐请求契约核查（钩子返回值 schema、时效）+ M6 否决 fail-closed | 关（flag-gated，UI 不可见） |

严格模式面向 pack 开发者自测：任何契约违例直接暴露而非容错吞掉。

---

## 第 10 节：本地优先与离线降级（M17 / M20）

### 10.1 离线降级表

| 环节 | 在线行为 | 离线行为 |
|---|---|---|
| L2 检索 | 混合检索（关键词+向量） | **仅关键词路径**；向量相似度门不可用则视为不满足（伪向量禁止参与门判定——宁可不命中，不可假命中） |
| L3 LLM 仲裁/规划 | 远程网关 | Ollama（M17）→ 无本地模型 → **降 L4 探索模式**（探索计划生成同样需 LLM：无 LLM 时 L4 输出"当前离线且无本地模型"的明确提示，六层终点兜底） |
| 语义缓存 | 命中即返回 | **不受影响**（缓存是本地数据，离线时价值反而上升） |
| 约束检查 | 不涉网络 | 不受影响 |
| 嵌入向量生成 | 远程嵌入 | 本地嵌入模型；不可用 → knowledge 摄取暂停（明示用户），检索退化关键词 |

### 10.2 M17：Ollama provider

实现 `LLMPort` 接口的 `ollama-provider`：HTTP API（`/api/chat`），流式经 NDJSON 解析复用现有 sseParser 适配层；模型清单来自 `/api/tags`；上下文长度按模型元数据上报 budget 簇。Ollama 不可达 → provider 自报 unavailable（不抛入主流程）。

### 10.3 M20：provider 降级链

**步骤**：
1. 宿主配置有序 provider 链（默认：远程网关 → Ollama → 无 LLM）；
2. 请求时取链首可用 provider（**探测结果缓存**，失败标记带 TTL，不逐请求探测）；
3. 当前 provider 请求失败且为可重试类（网络/5xx）→ 自动降级下一级 + `llm-degraded{from, to}` 通知（**降级不抛错**——用户得到的是次优答案 + 一条提示，而非失败）；
4. 链尽 → 返回明确错误（对应 10.1 表中 L4 兜底）。

**边界情况**：降级后质量差异（远程大模型 → 本地小模型）→ 产出元数据标记 provider 与 tier，UI 可选提示；budget 簇按 provider 实际计价（Ollama 本地成本记 0 token 费用、仍有 token 计数）。

---

## 第 11 节：实施路线图与分阶段验收

### 11.1 四阶段路线图

```
Phase 1 插件脊柱        Phase 2 DomainPack+隔离        Phase 3 主路径切换        Phase 4 竞争+本地
──────────────         ──────────────────────         ─────────────────        ────────────────
宿主+Registry+Bus      legal/finance pack 试点         dispatch 唯一编排入口     竞争 flag
纯度清理（五处泄漏）     M8/M9/M19 + 55 条转译           dialogStore 瘦身          影子评估
M4 状态机              M10/M11/M12 知识隔离            M5/M6/M7/M13/M15 全激活   M17 Ollama
簇注册表（委托可换）     适配器映射表（8.8）              七暂停点语义等价           M20 降级链
```

依赖关系：Phase 2 依赖 Phase 1 的 Registry/Bus；Phase 3 依赖 Phase 1 状态机与 Phase 2 的 pack 数据形态；Phase 4 依赖 Phase 3 的管线钩子体系。**pack 试点（Phase 2）先于主路径切换（Phase 3）**——先在旁路验证 pack 价值，再动主路径（用户已确认的顺序决策）。

### 11.2 分阶段验收标准

| Phase | 验收项 | 通过标准 |
|---|---|---|
| 1 | 纯度清理 | grep 验证：内核目录（kernel/、services 通用层）无 'legal'/'finance'/'hr' 字面量；typecheck 错误数 ≤ 现基线 51 |
| 1 | 台账与状态机 | M3 台账单测（注册/注销/孤儿扫描）；M4 状态机单测（drain 超时/回滚/内核空缺态） |
| 1 | 簇替换冒烟 | 运行时 register/unregister 五簇各一替身，dispatch 正常 |
| 1 | 回归 | **npm test 1340 全过，零回归** |
| 2 | pack 加载 | legal pack mount 成功；**故意损坏 schema 的 pack 加载失败且错误定位到字段**；失败后无残留（回滚干净） |
| 2 | 约束等价 | **55 条逐条等价对照**：对每条 testCases 输入，pack 化评估结果 === 现状 check 函数结果（含 7 条 evaluator） |
| 2 | 知识隔离 | M10/M11 单测：pack 条目对无 scope 查询不可见；缓存 packId 精确匹配；污染用例（跨域查询）全部 miss |
| 2 | 卸载即收缩 | unmount legal pack 后：检索池/约束/缓存/钩子全部收缩，行为回到未安装态 |
| 2 | 回归 | 1340 零回归 |
| 3 | 主路径等价 | dispatch 冒烟：六层各取一条真实路径（L0 直通/L0.5 快配/L1 直调/L2 green/L3 仲裁/L4 探索）对照改造前行为一致；七暂停点（confirmation/intentConfirm/slotFill/人工复核等）语义等价；流式与取消语义等价 |
| 3 | 三档钩子 | advisory 合并确定性单测（M13 全规则）；veto 聚合/fail-open/严格模式单测（M6）；override 槽竞争与回退单测（M7）；快照单测（M15：卸载后新请求不见旧钩子） |
| 3 | 验证 | 1340 全过 + **手动 dev 三项**（换内核切换、pack 热重载、override 回退演示） |
| 4 | 竞争 flag | flag 关：行为与 Phase 3 完全一致（对照测试）；flag 开：竞标分排序正确、影子评估零副作用（审计日志可查） |
| 4 | 本地优先 | Ollama 冒烟（离线完成一次完整六层请求）；provider 降级链自动降级演示 |
| 4 | 回归 | 零回归 |

### 11.3 风险矩阵

| 风险 | 等级 | 缓解 |
|---|---|---|
| Phase 3 主路径切换（dialogStore 2282 行厚编排逻辑迁移） | **最高** | 行为等价验收前置；分层灰度（内核先并行运行对照，再切默认）；checkpoint 回滚 |
| 宿主-内核边界漂移（边界字段被随手塞进内核） | 高 | M18 纯度检查进 CI（Phase 1 起） |
| 服务单例状态与簇热换的隐式耦合 | 高 | 6.3 如实声明的限制 + 状态容器化列为后续路线 |
| 55 条约束转译语义漂移 | 中 | Phase 2 逐条等价对照（11.2）+ mount 自检 |
| 存量知识条目归属误判 | 中 | M12 全量归 user（不猜）+ 备份对账 |

---

## 附录 A：决策记录

### A.1 用户已确认决策（12 条）

| # | 决策 | 体现 |
|---|---|---|
| 1 | 内核与领域皆为插件（换内核=换调度策略，换领域=专人专用） | 第 3/6/8 节 |
| 2 | 五簇可单独热换 | 6.3 |
| 3 | 三档钩子全要（顾问+否决+覆盖按层分配） | 第 5 节 |
| 4 | pack 试点先于主路径切换 | 11.1 |
| 5 | 领域三层声明式易维护（改数据不改代码） | 8.1 |
| 6 | 六层含探索模式 | 4.2 |
| 7 | 内核纯度（领域知识零残留） | 第 2 节 |
| 8 | 知识库零污染 | 第 7 节 |
| 9 | 竞争模型默认关闭、普通用户不可见 | 9.1 |
| 10 | 开源 + 付费增强（manifest license 字段预留） | 8.2 |
| 11 | 文档升级为逻辑 spec（五要素） | 全文 |
| 12 | 采纳默认规则包（override 单槽 priority / 顾问注册序合并 / 否决全量聚合 / 失败全量回滚） | 5.4/5.5/5.6 |

### A.2 计划内定可改项（8 条，实施期可调整，须记录于此）

| # | 内定项 | 默认值 | 章节 |
|---|---|---|---|
| 1 | veto 钩子自身失败 fail-open（严格模式 fail-closed） | fail-open | 5.4 |
| 2 | testCases 自检失败 → 该约束禁用，不阻挂载 | 禁用不阻挂 | 8.4 |
| 3 | 无 partition scope 默认查 user + kernel | 是 | 7.2 |
| 4 | draining 新请求队列上限 | 100 | 6.2 |
| 5 | 超时默认值 mount 10s / drain 5s / override 3s | 如左 | 6.2/5.3 |
| 6 | DSL 新增 numericCapture 能力（勘察驱动） | 纳入 v1 | 8.3 |
| 7 | DSL v2 扩展项：两捕获值算术表达式（可收编 #11/#51/#55） | 待定 | 附录 C |
| 8 | hr pack（hr 域约束实测 0 条 → 空边界层合法） | 已建（A5 批：归因 5 宏 + 术语层 + 2 实战宏） | 8.9 |

## 附录 B：术语表

| 术语 | 定义 |
|---|---|
| 宿主 Host | Electron 应用骨架：窗口、vault、PluginRegistry、KernelRegistry、flag 配置；不含任何路由与领域逻辑 |
| 内核插件 KernelPlugin | 六层路由管线 + 调度策略 + 五簇委托的提供者；全局同一时刻至多一个激活 |
| 领域包 DomainPack | 领域知识的容器：knowledge/boundary/execution 三层数据 + capabilities 钩子声明 |
| 五簇 | route / cache / security / budget / fact 五个可委托替换的策略簇 |
| 三档钩子 | advisory（顾问，影响打分）/ veto（否决，边界层两道门）/ override（覆盖，单槽层实现替换） |
| 六层 | L0 规则直通 / L0.5 关键词快配 / L1 能力直调 / L2 RaaP 检索 / L3 LLM 仲裁 / L4 探索模式 |
| partition | 知识条目归属维度：kernel / pack / user；与 ownerType（摄取目标）正交 |
| 影子评估 | 竞争模式中未胜出 pack 的只读评估：入审计、零副作用 |
| 逃生舱 evaluator | DSL 表达不了的约束以 TS 文件形式存在，优先于 DSL 执行 |
| 内核空缺态 | M4 回滚失败后 getActive()=undefined 的降级态；全部 dispatch 返回 kernel-vacant |
| 事务式加载 | pack mount 分层进行，任一层失败全量回滚至未挂载态 |

## 附录 C：待定项（实施期定稿）

| # | 待定项 | 当前倾向 | 备注 |
|---|---|---|---|
| 1 | 依赖级联卸载（pack 间依赖暂无） | 暂不需要 | pack 间依赖机制出现时再定 |
| 2 | 质量分 EMA 冷启动（新 pack 无历史） | 初始 1.0 | 竞争模式下新 pack 偏乐观/保守待实测 |
| 3 | vault namespace 白名单终稿 | 附录列出的 12 个 + `pack:*` | 精确集合实施期定 |
| 4 | 内核空缺态的用户呈现 | 应用层降级横幅 + 建议重启 | UI 细节实施期定 |
| 5 | watch 防抖参数 | 300ms | M19 |
| 6 | DSL v2：两捕获值算术表达式 | 倾向纳入 | 可收编 #11/#51/#55，剩 4 条硬逃生舱 |
| 7 | DSL v2：中文数字映射表 | 待定 | 收编后 #2 部分场景可声明式 |
| 8 | 竞争模式胜者失败是否切换第二名 | 倾向不切换 | 9.1 边界情况 |
| 9 | 缓存预热的 pack 间共享策略 | 倾向不共享 | 与零污染原则一致 |

## 附录 D：机制-章节-验收映射

| 机制 | 章节 | 验收（11.2） |
|---|---|---|
| M1 插件注册 | 3.3 | P1 台账单测 |
| M2 插件卸载 | 3.4 | P2 卸载即收缩 |
| M3 NamespacedBus | 3.5 | P1 台账单测 |
| M4 换内核状态机 | 6.2 | P1 状态机单测 |
| M5 dispatch 逐层逻辑 | 4.3 | P3 主路径等价 |
| M6 否决门 | 5.4 | P3 三档单测 |
| M7 覆盖冲突消解 | 5.6 | P3 三档单测 |
| M8 pack 加载器 | 8.4 | P2 pack 加载 |
| M9 约束 DSL 与评估 | 8.3/8.5 | P2 约束等价 |
| M10 缓存精确匹配 | 7.3 | P2 知识隔离 |
| M11 检索 partition | 7.2 | P2 知识隔离 |
| M12 存量迁移 | 7.4 | P2 手动执行报告 |
| M13 顾问确定性合并 | 5.5 | P3 三档单测 |
| M14 运行时权限 | 3.7 | P3 三档单测 |
| M15 在途请求快照 | 5.7 | P3 三档单测 |
| M16 竞争模型 | 9.1 | P4 竞争 flag |
| M17 Ollama provider | 10.2 | P4 本地优先 |
| M18 纯度检查 | 2.2 | P1 纯度清理 |
| M19 开发热重载 | 8.7 | P3 手动 dev |
| M20 provider 降级链 | 10.3 | P4 本地优先 |

---

*规格书完。实施期发现的与本 spec 的偏差，以修订记录形式追加于文档头部元信息表，不静默改动正文。*
