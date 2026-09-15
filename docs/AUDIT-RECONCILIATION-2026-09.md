# HoloStarmap 审计对账报告（2026-09）

- **对账对象**：AUDIT-REPORT-2026-09.md 全部 213 项发现（原始计数，含跨簇 XREF 重复）vs 当前 HEAD `acdc875`
- **对账方式**：9 簇并行只读复核代理，按"缺陷机制"在当前源码逐条定位验证（报告行号已漂移，不按旧行号找）；每条附当前 `文件:行号` 证据
- **修复波次**：R1-R7（`7a03001`..`4129457`，按提交信息声称修复范围）+ e826b69（85 项独立源码级修复，52 文件）+ acdc875（CI）。提交声称一律以源码实证为准
- **日期**：2026-09-16
- **对账覆盖**：201 条独立可验证项（12 条纯 XREF 重复项未重复验证）

---

## 0. 执行摘要

| 维度 | 数量 | 结论 |
|---|---|---|
| 独立验证项 | 201 | FIXED 83（41%）/ PARTIAL 33（16%）/ OPEN 85（42%） |
| P0（10） | 9 FIXED / 1 PARTIAL | **P0-2 存在现行可达绕过残留（P0 级）**，其余 9 条命脉级缺陷全部真修 |
| P1（48） | 34 FIXED / 6 PARTIAL / 8 OPEN | 确认链/死频道/审计接线主体已通；事实校验三件套（P1-20/21）与 benchmark 群（P1-30/31/32）完全未触碰 |
| P2/P3（143） | 40 FIXED / 26 PARTIAL / 77 OPEN | P3 修复率极低（≈14%），与各批次声称范围一致——P3 从未被系统性覆盖 |
| 修复声称真实性 | 13 处偏差 | 详见第 3 章；最严重：P1-10 为**纯注释修复**、A5-13 修复无效、R4 traceId 言过其实 |
| 修复引入的新问题 | 19 项 | 详见第 4 章；最重：P0-7 降级路径复活（P2）、traceId 并发污染（P2）、autoCompile 门槛疑似写反（P2） |

**一句话结论**：R1-R7 + 85 项扫荡真实修掉了全部"命脉级"缺陷（shell/SSRF/路径/冷启动/确认链/死频道/审计接线），但（a）两处安全修复留有可达绕过，（b）13 处"声称已修"与实际不符，（c）P2/P3 残余技术债体量仍然庞大（OPEN+PARTIAL 共 118 项）。建议在进入 Phase 4 本体（B1/B2）前插入一个**安全与声称偏差收尾批（A3）**。

---

## 1. P0/P1 对账明细（58 条）

状态列：✅=FIXED，◐=PARTIAL，❌=OPEN。

### 1.1 P0（10 条）

| ID | 状态 | 当前证据 | 说明 |
|---|---|---|---|
| P0-1 | ✅ | shell-security.ts:21-32,324-331 | 元字符黑名单 + 词边界白名单 + type/cat 等路径参数强制过 validateReadPath/WritePath；`cd .. & calc`、Startup 写入、读 id_rsa 三链封死 |
| P0-2 | ◐ | shell-security.ts:34-104,120-145 | 黑名单大幅扩充（readFileSync/vm/动态 import 等），但 `require(process.env.M)`（env 注入 ='fs'）+ `openSync/writeSync`（不在名单）仍构成**任意写盘链**，绕过 validateWritePath 全部三道校验——P0 残留现行可达，建议 node -e 整体禁用或改服务端固定模板 |
| P0-3 | ✅ | ipc-handlers.ts:111-232,758-797 | IPv4 全保留段 + IPv6 + dns.lookup 逐 IP + IP pinning + 重定向逐跳重验，五类绕过闭合 |
| P0-4 | ✅ | pathValidator.ts:4-24,89-91,145-150 | realpath + 分隔符归一化后匹配，POSIX 正则在 Windows 生效 |
| P0-5 | ✅ | pathValidator.ts:113-128,160-196 | 尾随点/空格/ADS 冒号在 read/write/open 三路直接拒绝 |
| P0-6 | ✅ | pathValidator.ts:27-45,167-188; ipc-handlers.ts:346-381 | validateWritePath：FORBIDDEN_WRITE_PATHS + DANGEROUS_EXTENSIONS + 10MB 上限，Startup 持久化通道关闭 |
| P0-7 | ✅ | src/main.ts:79-87; vault/index.ts:18-124 | syncFromVault 前置于 mount + preSyncKeys 磁盘优先，覆盖链双重封死。**但见第 4 章：sync 失败降级路径仍具破坏性** |
| P0-8 | ✅ | DialogPanel.vue:375; dialogStore.ts:2706-2718; sessionStore.ts:133-140 | 删除经 dialogStore 路由 + messages 拷贝重置 + 存储层一律浅拷贝写入 |
| P0-9 | ✅ | domains/dialog/handlers.ts:5-14; dialogStore.ts:2519-2542; macroExecutor.ts:533-544 | handler 真实 await 弹窗（5 分钟超时=拒绝）+ macroExecutor catch 一律 fail-closed |
| P0-10 | ✅ | macroExecutor.ts:297-304,812-818; domains/api/handlers.ts:56-61 | 宏两处改走 api:chat-completion（含 signal/callerId 透传）；llm:get-gateway 已注册 |

### 1.2 P1（48 条）

| ID | 状态 | 当前证据 | 说明 |
|---|---|---|---|
| P1-1 | ◐ | ipc-handlers.ts:66-91,835-874 | 快照/临时目录/条目校验/回滚已修；**zip 炸弹防护校验后置于 extract**，解压阶段仍可写满磁盘 |
| P1-2 | ◐ | ipc-handlers.ts:714-742; mcp-manager.ts:243-249 | shell:exec 已用 taskkill /T /F 杀树；**stopMcpProcess 手动停止 MCP 仍只杀直接子进程** |
| P1-3 | ◐ | shell-security.ts:159-213; pathValidator.ts:47-55 | 参数约束已加；**file:write 可写 .py/.txt/.md（.py 竟在 SAFE_OPEN_EXTENSIONS）+ `node x.txt`/`python x.py` = 组合 RCE 链仍可达** |
| P1-4 | ✅ | vault-migration.ts 已删除 | 迁移通道整文件端到端删除（以删除方式修复） |
| P1-5 | ❌ | ipc-handlers.ts:814-833 | backup:create 仍不含 vault SQLite/vectorDir/knowledgeDir，备份仍是空壳 |
| P1-6 | ❌ | ipc-handlers.ts:1274; main.ts:24-26 | openVault 仍裸调用无 catch，vault 打开失败=半初始化静默启动 |
| P1-7 | ✅ | ipc-handlers.ts:643-655; shell-security.ts:316-320 | cwd 强制 validatePath + npm run 移出白名单 |
| P1-8 | ✅ | pathValidator.ts:93-111,134-139 | realpathDeepest 解析最深已存在祖先，symlink/junction 逃逸消除 |
| P1-9 | ✅ | window-manager.ts:16-19; main.ts:78-81 | isDestroyed 守卫 + closed 置空 + 动态 getter |
| P1-10 | ❌ | ruleStore.ts:82-92 | **e826b69 的 C-12 是纯注释修复**：三条 pack 生命周期订阅仍在 markFalsePositive() 体内，监听器泄漏机制原样（见第 3 章） |
| P1-11 | ✅ | domains/mcp/handlers.ts:15 | handler 双字段兼容（mcpId / connectionId），两种发送方均可达 |
| P1-12 | ✅ | embedder.ts:106-108; semanticCache.ts:320-647 | VectorWithMeta.isPseudo 全链贯通 + 旧记录保守视为伪的一次性迁移 |
| P1-13 | ✅ | apiStore.ts:407-889; host/pack/loader.ts:217-401 | loader 提供 domain→packId 归因，全部缓存调用点透传真实 packId |
| P1-14 | ✅ | scheduleOptimizer.ts:267-303; macroExecutor.ts:988 | dependents 反向索引沿下游传播 + 调用点传真实变量表 |
| P1-15 | ✅（有死角） | toolRegistry.ts:26-38; macroExecutor.ts:947 | SIDE_EFFECT_TOOLS（含 create_docx）统一；**但 autoCompiled 分支 :947 仍用旧集合判重用 → A4-16 成漏网死角** |
| P1-16 | ✅ | toolRetrieval.ts:532-546; domains/node/handlers.ts:48 | resolveL2Manifest 经 bus 回查真实清单，确认 UI 与执行同源 |
| P1-17 | ✅ | promptTranslator.ts:16-56; toolRegistry.ts:53-61 | 规范名词表 + TOOL_NAME_ALIASES + dispatch 前 normalizeToolName |
| P1-18 | ✅ | scheduleOptimizer.ts:382-389 | 缓存 key 加入 structHash(userInput) |
| P1-19 | ✅ | dualEngineValidator.ts:61-78,112-117 | containsDangerousUrl + readsSensitivePath 纳入触发判定 |
| P1-20 | ❌ | factGuard.ts:132-148 | **自 ec6a11f 起从未被触碰**：内层循环首不匹配即 break，多实体场景伪"严重事实冲突"误杀稳定复现 |
| P1-21 | ❌ | nerExtractor.ts:41-46 | **自 ec6a11f 起从未被触碰**：normalizeAmount 仍删"万/亿"，"3万元"→3.00，差 ~100% 误杀 |
| P1-22 | ◐ | main.ts:79-87（vault 半边已修）; App.vue:552; packRuntime.ts:19-35 | vault 竞态已修；initPackRuntime 仍 fire-and-forget、无 ready 门禁 → 冷启动约束空窗期仍在 |
| P1-23 | ✅ | macroExecutor.ts:644-659 | 自动 npm install 前必经 confirm-risk，异常 catch→不安装 |
| P1-24 | ✅ | domains/dialog/handlers.ts:23-36; DialogPanel.vue:203-209 | 两 handler 绑定 store + UI 暂停入口接线 |
| P1-25 | ✅ | dialogStore.ts:533-556 | executeMcpToolCalls 执行器，三条直达路径循环执行 toolCalls 回填 |
| P1-26 | ✅ | PipelinePage.vue:267-327; App.vue:514-534 | 画布拓扑序经 pipelineRunRequest 代跑 + 进度按 step-N→runOrder 回写 |
| P1-27 | ✅ | useDagEngine.ts:410-415 | INPUT/TEXTAREA/isContentEditable 目标早退 |
| P1-28 | ✅ | vault/index.ts:131-175,200-211 | flushNow 逐条 try/catch + 失败重入队 + 指数退避 |
| P1-29 | ◐ | vault/index.ts:15,92-98 | 队列已按 fullKey Map 合并；**立即 write() 仍不取消该键排队项，旧值倒灌新值的竞态仍在**（注释宣称已杜绝，与实际不符） |
| P1-30 | ❌ | l2Manifests.ts:408 | node -e 脚本内嵌 debugLog 未定义必抛于 writeFileSync 前 → **该工具永远无法创建文件** |
| P1-31 | ❌ | macroExecutor.ts:202,208,121 | 核验脚本 debugLog 未定义 + HOME_DIR='C:\Users\Default'（不存在）三重死均在 |
| P1-32 | ❌ | benchmarkRunner.ts:114,123,146 | 优化路径仍不做 {{input}}/{{step_N_result}} 插槽替换，测的不是声称的管线 |
| P1-33 | ✅ | benchmarkRunner.ts:13-68 | 隔离 benchFingerprints（上限 50）+ 真实结果，不再污染生产指纹库 |
| P1-34 | ✅ | statsTracker.ts:145-152; benchmarkRunner.ts:76-83 | 按建议采"修正统计口径"方案：methodology 字段如实披露单模型/固定单价口径 |
| P1-35 | ✅ | window-manager.ts:171-174; main.ts:94-112 | 改主进程 did-finish-load 判 ready，幻影声明与三子窗调用全删 |
| P1-36 | ✅ | src/main.ts:55-70 | 主窗 onStoreApplyUpdate→$patch 桥 + applyingRemoteUpdate 防回环（双向验证闭环正确） |
| P1-37 | ✅ | RuleReviewPage.vue:12-78 | 标题栏三按钮 + drag 区域接线 |
| P1-38 | ✅ | src/main.ts:31-48 | $subscribe 桥扩 pipeline 白名单 + 防抖 |
| P1-39 | ✅（残留） | macroExecutor.ts:55-87; domains/debug/handlers.ts:32-35 | get-step-cost 独立 try + handler 已注册 + {snapshot} 包装；残留：recordStepCost 全仓零调用 → tokenUsage 恒 undefined |
| P1-40 | ✅（残留） | apiStore.ts:388-400; debugStore.ts:125-135 | 四成功点发射 record-cost 落 tokenBudget；残留：**chatCompletionStream 成功路径（apiStore.ts:745-750）不发射**——流式一旦启用将绕过记账 |
| P1-41 | ✅ | memory/handlers.ts:19-26; memoryStore.ts:105-119 | on() 桥 + 会话记忆落库（上限 200） |
| P1-42 | ✅ | macroExecutor.ts:550-563; memoryStore.ts:239-247 | 宏副作用/MCP 调用埋点 addAuditLog（带 traceId），CSV 有数据 |
| P1-43 | ✅ | macroExecutor.ts:846-883; workflowLogStore.ts:82-100 | 执行生命周期接线 + 清空按钮改走 store action |
| P1-44 | ✅ | domains/node/handlers.ts:8-15; nodeStore.ts:56-77 | on() 桥被星图/状态栏/闪烁循环三处消费 |
| P1-45 | ✅（跨窗残留） | domains/debug/handlers.ts:48-81 | 三桥接通、主窗可中止；残留：调试窗终止按钮打不到主窗控制器（abortControllers 窗口本地），安慰剂依旧 |
| P1-46 | ✅ | dialogStore.ts:915-936; RuntimePanel.vue:15-27 | awaitingCandidatePick 拦截 + 可点候选按钮 |
| P1-47 | ◐ | App.vue:426-452; OnboardingWizard.vue:210 | 五主弹层 visible 暴露 + Esc 链已通；**OnboardingWizard 仍仅 expose {open,close} 且不在链内**，首启向导开 Esc 仍穿透重置相机 |
| P1-48 | ✅ | ResultPreviewStage.vue:154-193 | 先捕获原行号再重解析 + 后续块行号平移 |

---

## 2. P2/P3 对账明细（143 条）

### 2.1 A1 主进程（P2×10 / P3×7）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A4-9 | ✅ | pathValidator.ts:113-122 | pathRe 捕获组错位已被 getSafeExtension 取代 |
| A1-16 | ❌ | shell-security.ts:354-356 | 用户超时可整体替换 tier 且无下限，分层策略可被弱化 |
| A1-17 | ✅ | main.ts:180-184 | before-quit 接通 closeVault（隐含 WAL checkpoint） |
| A1-18 | ❌ | vault.ts:45-53 | vaultRead 解密失败仍返回密文原样 |
| A1-19 | ✅ | ipc-handlers.ts:821-828 | archiver error 已监听，备份失败不再杀应用 |
| A1-20 | ❌ | vault.ts:76-84 | namespace/key 无格式校验，两套持久化 API 强度不一致 |
| A1-21 | ❌ | mcp-manager.ts:130-152 | stderr/stdout buffer 仍无界累积 |
| A1-22 | ❌ | main.ts:20-26 | unhandledRejection 仍仅日志 |
| A1-23 | ❌ | ipc-handlers.ts:282-888 | 9 处哨兵值吞异常原样，catch 无日志 |
| A1-24 | ❌ | pathValidator.ts:139,75-81 | 大小写敏感比对 + 基目录含 home（白名单=整个用户 profile） |
| A1-25 | ❌ | window-manager.ts:39-255 | 五窗口全量 preload，无 senderFrame 校验（≡B-10） |
| A1-26 | ◐ | pathValidator.ts:47,67,222 | 死代码两处已清；SAFE_OPEN_EXTENSIONS 33 项仍零消费者，且 .py 在列（与 P1-3 残留相关） |
| A1-27 | ❌ | ipc-handlers.ts:775 | GET/HEAD body 仍静默丢弃 |
| A1-28 | ❌ | ipc-handlers.ts:890-895 | watchfs 仍先拆旧 watcher 再校验 |
| A1-29 | ✅ | vault-migration.ts 已删除 | 随文件删除消除 |
| A1-30 | ❌ | main.ts:8,49 | pendingPipelineNodes 无上限无去重 |
| A1-31 | ❌ | window-manager.ts:57-59 | console-message 仍旧签名 |
| A1-32 | ◐ | package-lock.json:3180 | electron 经 lockfile 可复现；显式钉 devDependencies 仍缺（=路线图 D2） |

### 2.2 A2 内核/领域（P2×4 / P3×8）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A2-3 | ✅ | memory/handlers.ts:58-60 | on() 桥 + 兼容双 payload 形态，MCP 日志可达 |
| A2-4 | ◐ | DialogPanel.vue:897-915; dialogStore.ts:883-897 | 主入口已通；dialogStore.sendMessage 的 /debug 分支仍是死频道（经双击旁路触发行为不一致） |
| A2-5 | ◐ | node/handlers.ts:13-15 等 | set-l1-status/add-audit-log/add-dialog-message 已桥接；visual-event、dag-chain-push-step、add-notice、feedback:add-side-effect、shadow-diff、config:set-* 仍死频道 |
| A2-6 | ✅ | debug/handlers.ts:32-35 | get-step-cost 已注册 + probeStep 双 try 拆分（→P1-39） |
| A2-7 | ❌ | kernel/funnel.ts:181-185 | 六层编排层仍 try/catch+continue 静默降级；kernel.dispatch 仍零生产调用方 |
| A2-8 | ❌ | kernel/funnel.ts:162-166 | beforeLlm 全仓仅 funnel 自引，'budget-blocked' 生产不可达 |
| A2-9 | ❌ | packs/*/pack.json:11; funnel.ts:198 | 两个 shipped pack 声明 veto:["pre-output"] 但无 pre-output 评估点，声明能力未实现 |
| A2-10 | ❌ | onboardingManager.ts:1-43 | 死模块原样，建议删除未执行 |
| A2-11 | ◐ | apiStore.ts:728-761; kernel/bus.ts:91-103 | apiStore 侧已包装 cleanup；kernel/bus requestStream 仍丢弃 handler 返回的 cleanup |
| A2-12 | ❌ | kernel/funnel.ts:146-149,215 | L1 autoExecutable 恒 false（与旧路径平价，无回归） |
| A2-13 | ✅ | dialogStore.ts:771-775 | mcp-direct 未命中显式提示 + 错误日志 |
| A2-14 | ✅ | main.ts:79-87; App.vue:551-552 | P0-7 时序重排消除 pack 写入/读取竞态（≠P1-22 的 fire-and-forget 半边） |

### 2.3 A3 路由链（P2×11 / P3×9）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A3-5 | ❌ | tokenBudget.ts:85-258 | sessionSpent 双计原样；**P1-40 接通后双计从休眠转为实际生效** |
| A3-8 | ✅ | tokenBudget.ts:114-151; apiStore.ts:446-450 | block→allowed:false + apiStore 硬 throw |
| A3-9 | ✅ | scheduleOptimizer.ts:382-389 | key 加 structHash(userInput) |
| A3-10 | ✅ | scheduleOptimizer.ts:82-104 | 持久化改存 resultHashes，空结果不再假命中 |
| A3-11 | ❌ | macroExecutor.ts:202-215 | 桌面核验死（→P1-31） |
| A3-12 | ❌ | l0SkillRouter.ts:171-192 | 非 docx 转换不落盘即报成功 |
| A3-13 | ✅ | semanticCache.ts:237-277 | 按条目档位全价口径计费 |
| A3-14 | ✅ | semanticCache.ts:158-348 | 过期覆盖前彻底摘除旧僵尸 + deleteExactIfOwned |
| A3-15 | ✅ | benchmarkRunner.ts:57-68 | 隔离指纹（→P1-33） |
| A3-16 | ❌ | tokenBudget.ts:39-47 | budget=0 时 0>=0 恒超限，三态语义仍未实现 |
| A3-17 | ❌ | promptTranslator.ts:150-292 | "≤5步/8000预算"仍仅 prompt 文本；fallback 计划仍用不存在的 tool:'auto' |
| A3-18 | ❌ | semanticCache.ts:27,442-444 | similarityThreshold 死配置 |
| A3-19 | ❌ | semanticCache.ts:519-636 | 自适应阈值不持久化 |
| A3-20 | ❌ | smartRouter.ts:70-223 | 零成本路径无反馈信号，constraintHits_trivial 恒冻结 0 |
| A3-21 | ❌ | smartRouter.ts:141-147 | textHash 仍 32 位 djb2 |
| A3-22 | ❌ | smartRouter.ts:107,363 | 内存 500 / 落盘 100 不变 |
| A3-23 | ❌ | dialogStore.ts:1332; kernels/default/index.ts:203 | fallback_l1 死分支原样 |
| A3-24 | ❌ | scheduleOptimizer.ts:14-40 | 两级编译缓存无界 |
| A3-25 | ◐ | macroExecutor.ts:121-161 | %USERPROFILE% 执行层已解析；l0SkillRouter.ts:527 硬编码 skillRules[0] + 回退值仍 'C:\Users\Default' |
| A3-26 | ❌ | models/index.ts:1136-1193 | daily/session/monthly 与文档"日/周/月"口径不符 |

### 2.4 A4 执行与安全（P2×16 / P3×10，XREF 3 条略）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A4-10 | ❌ | macroExecutor.ts:276-283 | stepTimeout 仍按初始 tier 一次计算 |
| A4-11 | ❌ | macroExecutor.ts:313-318 | nano 失败直接抛，rule 终档不可达 |
| A4-12 | ❌ | scheduleOptimizer.ts:42-49 | 模板变量二次展开 |
| A4-13 | ❌ | scheduleOptimizer.ts:45 | 槽位越界静默置空 |
| A4-14 | ❌ | factGuard.ts:200-207 | 约束检查的是输出而非输入（方向错误） |
| A4-15 | ❌ | domainConstraints.ts:3297-3305 | 单条约束异常静默吞 |
| A4-16 | ❌ | macroExecutor.ts:947-948 | autoCompiled 分支判重用不含 read_file → 陈旧缓存复用（P1-15 统一修复的死角） |
| A4-20 | ❌ | crossDocValidator.ts:49-112 | 首实体不匹配即 break + percentage 无 NaN 防护 |
| A4-21 | ❌ | pipelineExecutor.ts:206-436 | 检查点无版本号 + 失败不清 + 无 TTL |
| A4-22 | ✅ | sseParser.ts:16-171 | CRLF 分帧 + \r 剥离 + data: 单空格规范（e826b69 B-11 覆盖全部场景） |
| A4-23 | ❌ | ruleEngine.ts:6 | 1900-2099 年份过滤吞金额实体 |
| A4-24 | ✅ | dualEngineValidator.ts:121-126,196-221 | create_directory/docx/list_directory/MCP 纳入 + isPathUnsafe 阻断链 |
| A4-25 | ❌ | dagCheckpoint.ts:22-99 | 损坏静默置空 + 无过期 + pruneExpired 零调用 |
| A4-26 | ◐ | pipelineExecutor.ts:57-311 | 60s 超时竞态与 resume 格式已修；parallel 模式实际仍串行 |
| A4-27 | ❌ | nerExtractor.ts:22-287 | 万元/亿元死分支、单字数字、手机号误判等瑕疵群 |
| A4-28 | ❌ | sseParser.ts:62-121 | uncached_tokens 非官方字段；Anthropic cache 字段未解析 |
| A4-29 | ❌ | errorClassifier.ts:42-108 | unknown 盲重试非幂等操作 |
| A4-30 | ❌ | macroExecutor.ts:450-466 | evaluateCondition 恒 true + 金额取首数字 + replaceAll 短串误替换 |
| A4-31 | ◐ | macroExecutor.ts:794-1192 | 五处 unregisterAbort 已补；compiledPromptCache 仍无界 |
| A4-32 | ❌ | constraintFeedback.ts:19-114 | feedbackLog 无界 + reloadPack 后降级成果丢失不持久化 |
| A4-33 | ❌ | domainConstraints.ts:2992-3048; security.ts:29 | 发票金额取前两 amount + VAT 白名单含 0 + risk_level 未验证标 low |

### 2.5 A5 stores（P2×8 / P3×8，XREF 2 条略）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A5-4 | ✅ | dialogStore.ts:2522-2574 | 顶替时先结算旧 resolver（fail-closed），Promise 不再挂起 |
| A5-8 | ◐ | WorkbenchNav.vue:119-126; dialogStore.ts:2691-2701 | DialogPanel 拷贝已做；**WorkbenchNav 仍活引用赋值 + 无 isProcessing 守卫**（见第 4 章语义分叉） |
| A5-9 | ◐ | dialogStore.ts:2283-2479 | direct 三处可执行；pickCandidate 的 macro-无-dagPlan 支路仍静默 no-op |
| A5-10 | ◐ | dialogStore.ts:2483-2631 | "重新生成"可见；三选项仍无真正恢复执行机制，"继续执行"提示误导 |
| A5-11 | ◐ | apiStore.ts:908-979 | get-config 深拷贝 + 明文警告标志已加；**gatewayAdapter.listModels/getActiveProvider 活引用仍出仓 + plaintextKeyWarning 无 UI 消费者** |
| A5-12 | ✅ | pipelineStore.ts:47-89 | 成败两路均清 runningPipelineId |
| A5-13 | ❌ | dialogStore.ts:483-484,2206-2219 | **R7 的 B-05 修复无效**：await 被去重守卫（return 而非 return promise）短路，off-by-one 原样 |
| A5-5 | ◐ | feedbackStore.ts:213; vault/index.ts | vault 冷启动空读已消；secureStore sideEffects 早期读竞态仍在 |
| A5-14 | ❌ | dialogStore.ts:2664-2676; memoryStore.ts:25-290 | 每消息全量序列化写放大不变 |
| A5-16 | ❌ | debugStore.ts:243-419 | console 猴补永不释放 + 探针文件竞态 |
| A5-17 | ❌ | feedbackStore.ts:215-221 | setInterval 无生产释放路径 |
| A5-18 | ✅ | vault/index.ts:57-64 | vault.delete 同步清 cache/dirtyKeys/排队写，复活路径封死 |
| A5-19 | ◐ | dialogStore.ts:903-914,2660 | 风险期排队重发已修；mode 恢复无 allow-list 未修 |
| A5-20 | ❌ | App.vue:508 等 | apiStore.loadFromStorage 未 await 等竞态群原样 |

### 2.6 A6 composables / vault / benchmark（P2×9 / P3×9，XREF 1 条略）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| A6-10 | ❌ | useThreeScene.ts:1903-1978 | updateOrbits O(n²) 每帧分配 |
| A6-11 | ✅ | useThreeScene.ts:1337 | disposeNodeObject（守卫共享纹理/池对象） |
| A6-12 | ◐ | useThreeScene.ts:2850-2879 | dispose 覆盖面已扩；webglcontextlost 仍无处理 |
| A6-13 | ✅ | useThreeScene.ts:1103-1113 | tractorBeam 材质懒创建单例复用 |
| A6-14 | ✅ | vault/index.ts:179-198 | flushBeforeUnload 尽力排空（best-effort 已声明） |
| A6-15 | ✅ | vault/index.ts:43-119 | syncFromVault 直读磁盘逐键刷新（P0-7 配套） |
| A6-16 | ❌ | l2Manifests.ts:433-456 | 自定义 manifest 仍 localStorage 旁路 vault |
| A6-17 | ❌ | benchmarkRunner.ts:92,188 | 错误双计（recordError 后 rethrow 再计） |
| A6-18 | ❌ | benchmarkRunner.ts:102-107; l0SkillRouter.ts:122 | L0 命中不进 benchmark tracker |
| A6-19 | ✅ | useDagEngine.ts:509-570 | wouldCreateCycle + animFrame 取消 + IPC disposer |
| A6-20 | ❌ | useThreeScene.ts:1118-1693 | 每次拾取 new Raycaster/Vector2 等微性能 |
| A6-21 | ◐ | vault/index.ts:30-78 | migrate 已随 B-6 删除；负缓存仍无 |
| A6-22 | ◐ | benchmarkRunner.ts:267; ipc-handlers.ts:357 | 导出已修；L1 命中仍误标 'l05'、expectedRoute 死数据 |
| A6-23 | ❌ | scheduleOptimizer.ts:78-165 | 指纹仅前 1000 字符 + persistDirty 竞态 + **autoCompile 门槛疑似写反**（见第 4 章） |
| A6-24 | ✅ | macroExecutor.ts:1143-1147 | 并行 ask_user 早退 wfComplete + unregisterAbort |
| A6-26 | ✅ | App.vue:502-505,817-822 | 具名 handler 同引用移除 + 死函数删除 |
| A6-27 | ❌ | topology.ts:236; l2Manifests.ts:408-413 | Math.random 种子 + 死配置 + 固定文件名 |

### 2.7 B IPC 对齐（P2×6 / P3×2）+ 死链矩阵

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| B-5 | ✅ | mcpStore.ts:396-429 | bindProcessPush 订阅 mcp:status/mcp:tools |
| B-6 | ✅ | preload.ts:256-266（已删） | 六 vector 通道端到端删除 |
| B-7 | ◐ | DataManagement.vue:108-130 | 仅 dataImportZip 接线；**mcpGetStatus/backupList/appHealth/knowledgeListEntries 仍零调用死链** |
| B-8 | ✅ | env.d.ts:9-126 | 脚本化比对 81↔81 双向零差异 |
| B-9 | ✅ | mockElectronAPI.ts:74-192 | vault 四件套等补齐（但见第 4 章：新增 5 方法未入 mock） |
| B-10 | ❌ | window-manager.ts:39-255 | ≡A1-25，五窗口全量 preload |
| B-11 | ✅ | window-manager.ts:115-174 | ready 协议统一为 did-finish-load |
| B-12 | ❌ | mockElectronAPI.ts:200-205 | 整体替换 window 对象，隔离不足 |

**17 条死链清单现状**：已接线 8 / 已删除 10（含 ipcRendererSend 链）/ 仍死链 4（mcpGetStatus、backupList、appHealth、knowledgeListEntries）。

### 2.8 C 可审计性（P2×11）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| C-10 | ◐ | domains/api/handlers.ts:5-15 | handler 仍不读 payload.stream，dialogStore 10 处 stream:true 全走非流式；chatCompletionStream 已实现但零请求方 |
| C-11 | ◐ | trace.ts:1-15 | 仅生成+渲染层传播；funnel:routed/DialogMessage 无 traceId、跨窗未做、**消费端为零**（详见第 3 章 R4 声称核查） |
| C-12 | ◐ | debugStore.ts:314-316 | 导出仍只序列化 currentSession；探针数据已非空，"空壳"大幅缓解 |
| C-13 | ❌ | dialogStore.ts:658 | funnel:shadow-diff 仍零消费者 |
| C-14 | ❌ | debugLog.ts:5-6 | 生产 no-op，连 console 都不调 |
| C-15 | ❌ | hotplugStore.ts:32-53 | eventLog 50 条不持久无导出 |
| C-16 | ❌ | proactiveScheduler.ts:1-43 | 死模块原样 |
| C-17 | ◐ | main.ts:81-87; packRuntime.ts:19-35 | ≡P1-22（vault 半边修，fire-and-forget 半边在） |
| C-18 | ❌ | kernelRegistry.ts:183-252 | dispatch 仍死代码（预算拦截由 apiStore.checkBudget 旁路补齐） |
| C-19 | ✅ | macroExecutor.ts:297-304; apiStore.ts:401-449 | 宏路径经 callerId 进入 smartRoute+checkBudget+语义缓存体系 |
| C-20 | ◐ | main.ts:57-70 | 主→pipeline 已补；主→调试白名单仍仅 3 store |

**九阶段采集矩阵**：完全无数据阶段由 5/9 降至约 2/9（阶段 5/6/8/9 已通；仍缺阶段 7 生产持久化、阶段 3 规划记录；跨阶段串联仍未成立）。

### 2.9 D UI/UX（P2×14 / P3×8）

| ID | 状态 | 证据 | 说明 |
|---|---|---|---|
| D-8 | ✅ | SettingsPage.vue:22-23 | select 直达 + setTheme |
| D-9 | ✅ | dialogStore.ts:908-913,2494-2517 | 排队+重发 |
| D-10 | ❌ | OnboardingWizard.vue:180-204; CommandPalette.vue:159-162 | 部分输入静默丢弃 + 直写 activeModel 不切 provider |
| D-11 | ◐ | PipelinePage.vue:148-153 | 仅清空画布加确认（且用原生 confirm，见第 4 章）；其余三子缺陷原样 |
| D-12 | ◐ | L0Modal.vue:344-431 | Esc 已通；4 处原生 alert + 卸载/删除无确认仍残留 |
| D-13 | ❌ | electron/main.ts:56-58 | 无最大化状态事件推送，按钮静态 |
| D-14 | ✅ | App.vue:415-424 | 组件层 Ctrl+P 移除，单一语义 |
| D-15 | ❌ | ApiSettings.vue:58,173-175 | provider 删除无确认 |
| D-16 | ❌ | DebugProbePanel.vue:198-203 | 探针导出失败零反馈 + 终止无确认 |
| D-17 | ◐ | DataManagement.vue:110-154 | 主路径已修；DOM 回退路径 onchange 仍逃逸 |
| D-18 | ❌ | NotificationCenter.vue:9 | 清空无确认 |
| D-19 | ✅ | ResultPreviewStage.vue:23 | 编辑中 Esc .stop 只取消块编辑 |
| D-28 | ✅ | src/main.ts:31-69 | 跨窗同步落地（≡P1-36/38） |
| D-20 | ✅ | src/components/ 目录 | 三个死组件物理删除 |
| D-21 | ✅ | App.vue:1-1197 | 死交互代码删除（1468→1197 行） |
| D-22 | ❌ | L0Modal 等 5 处 | alert/confirm 混用未迁移，D-11 修复反而新增一处 |
| D-23 | ❌ | RuleReview 子组件 | 英文标题未汉化 |
| D-24 | ❌ | Notification.vue:12-42 | toast 单实例 + z-index 1500 低于多数模态 |
| D-25 | ❌ | NodeDetailPanel.vue:130,155 | dialogStore 导入零使用 |
| D-26 | ✅ | PipelinePage.vue:333-357 | IPC disposer 随卸载注销 |
| D-27 | ❌ | BenchmarkPage.vue:191-264 | savingsClass 3/4 行空转 + 导出失败静默 |

---

## 3. 修复声称真实性核查（13 处偏差）

| # | 条目 | 声称来源 | 实际状态 | 严重度 |
|---|---|---|---|---|
| 1 | P0-2 | R1 | 黑名单可经 `require(process.env.M)` + openSync/writeSync 绕过，任意写盘链现行可达 | **P0 残留** |
| 2 | P1-3 | R1 | file:write 可写 .py/.txt + MCP 解释器执行，组合 RCE 链仍可达 | **P1 残留** |
| 3 | P1-1 | R1 | zip 炸弹防护校验后置于 extract | P1 半修 |
| 4 | P1-2 | R1 | stopMcpProcess 仍不杀进程树 | P1 半修 |
| 5 | P1-10 | e826b69（C-12） | **纯注释修复**：注释准确描述了正确修法但代码一行未动，且注释会误导后续维护者认为已修 | P1 未修 |
| 6 | P1-29 | R2 | 立即写不取消排队项，倒灌竞态仍在；代码注释宣称"已杜绝"，与实际不符 | P1 半修 |
| 7 | A5-13 | R7（B-05） | 加了 await 但被去重守卫短路（return undefined 而非 return promise），off-by-one 逐字原样 | P2 修复无效 |
| 8 | A5-11 | R7 | gateway 活引用出仓 + 明文警告无 UI 消费者 | P2 半修 |
| 9 | A5-8 | e826b69（B-17） | 仅 DialogPanel 拷贝；isProcessing 守卫未做，WorkbenchNav 仍活引用 | P2 半修 |
| 10 | B-7 | R7 | 5 条死链仅接线 1 条（dataImportZip） | P2 半修 |
| 11 | P1-47 / D-11 | R6 | OnboardingWizard 不在 Esc 链；D-11 四项子缺陷只修一项 | P1/P2 半修 |
| 12 | traceId（C-11） | R4（"统一 traceId"） | 仅生成+渲染层传播落地；落点（funnel:routed/DialogMessage）与消费端（过滤/分组 UI）缺失，跨窗未做 | P2 言过其实 |
| 13 | P1-45 / P1-39 | R4 | 主窗终止已通但调试窗终止仍安慰剂；recordStepCost 零调用使 stepCosts 恒空 | P1 带残留 |

---

## 4. 修复中引入的新问题（19 项）

| # | 级别 | 位置 | 问题 |
|---|---|---|---|
| 1 | **P2（P0 残留窄化）** | main.ts:81-85 | P0-7 降级路径：sync 失败仅 console.error 继续 mount，空缓存启动时默认会话照旧 writeThrough → 覆盖链在"sync 异常"场景复活（触发面从每次冷启动收窄为 sync 抛异常），建议 fail-fast |
| 2 | **P2** | trace.ts:4 | traceId 用模块级全局变量，pipeline 启动/并发 sendMessage 互相污染，审计归因错误；建议改随调用链传参 |
| 3 | **P2** | scheduleOptimizer.ts:163-167 | autoCompile 新增 hitRate≥0.8 门槛疑似写反：10 次纯缓存命中（hitRate=100%）反而成为晋级最短路径，与原缺陷方向一致甚至强化 |
| 4 | **P2** | apiStore.ts:745-750 | chatCompletionStream 成功路径不发射 record-cost——C-10 残留一旦修复、流式启用，将整体绕过记账 |
| 5 | **P2** | benchmarkRunner.ts:76-83; apiStore.ts:508-509 | benchmark 经 chatCompletion 压测真实消耗日/月/会话预算并污染 ZOL 路由学习与 routingHistory（P1-33 只隔离了指纹库）；叠加 A3-5 双计与 A3-16 budget=0 恒超限可意外触发 block |
| 6 | P2 | WorkbenchNav.vue:119-126 | 切换会话语义分叉：DialogPanel 拷贝 vs WorkbenchNav 活引用，同一功能两个入口语义相反 |
| 7 | P3 | mcp-manager.ts:94-97 | MCP spawn 调试日志**无条件落盘用户桌面**（mcp-spawn-debug.log），不受 HOLO_DEBUG 控制，信息泄露+目录污染 |
| 8 | P3 | mcp-manager.ts:104 | npx shell:true 通道未拦 `%`，与 P0-1 修复标准不一致 |
| 9 | P3 | ipc-handlers.ts:783-795 | 手动重定向循环中 30x 响应体未消费未 cancel，socket 滞留 |
| 10 | P3 | debug/handlers.ts:32; debugStore.ts:108 | recordStepCost 零调用 → stepCosts 恒空，get-step-cost 成安慰性 handler |
| 11 | P3 | debugStore.ts:163-177 | DEV 环境 debugLog 先被 captureConsole 计数再被 record-cost 计一次，DEV token 统计约翻倍（生产不受影响） |
| 12 | P3 | apiStore.ts:412 | 语义缓存命中也 emit record-cost（全 0 token），getCostBreakdownByCategory 的 callCount 被灌水稀释 |
| 13 | P3 | mockElectronAPI.ts | mock 漂移复发：e826b69 新增的 vectorDeleteBin/pipelineRunRequest/onPipelineRunEvent/onPipelineRunRequest/pipelineRunProgress 5 方法未入 mock，P1-26 新链路在 mock 测试下不可见 |
| 14 | P3 | PipelinePage.vue:151 | D-11 修复用原生 window.confirm，加重 D-22（原生对话框混用） |
| 15 | P3 | CommandPalette.vue:164; SettingsPage.vue:22; main.ts:61 | 修复注释的审计编号错乱（D-11↔D-14、D-12↔D-8、D-13 歧义），按注释回溯会误导 |
| 16 | P3 | dialogStore.ts:904-916 | 候选选择流：先 addUserMessage 再拦截，会话记录留下孤立"2" |
| 17 | P3 | dialogStore.ts:2502-2506 | 风险排队消息忙等 600 次后静默清空（5 分钟硬丢弃，有提示无补救） |
| 18 | P3 | App.vue:514 | onPipelineRunRequest 的 disposer 被丢弃不注销（与刚修掉的 A6-19(c) 同型） |
| 19 | P3 | vault/index.ts:104-119 | 冷启动串行逐 key 读放大 mount 阻塞时长（性能面）；另 A2-4 /debug 双路径分裂（dialogStore 死频道分支） |

---

## 5. 残余技术债清单（后续排期输入）

### 5.1 建议插队（A3 收尾批，先于 Phase 4 本体）

| 优先级 | 条目 | 理由 |
|---|---|---|
| **P0** | P0-2 残留（node -e 间接 require + openSync/writeSync） | 现行可达任意写盘，绕过全部路径校验；建议 node -e 整体禁用或服务端固定模板 |
| **P1** | P1-3 残留（file:write .py/.txt + MCP 解释器） | 组合 RCE 链现行可达；.py 移出 SAFE_OPEN_EXTENSIONS + 解释器可执行扩展名收紧 |
| **P1** | P1-20 / P1-21（factGuard 首实体 break / nerExtractor 万亿归一化）+ A4-20（crossDoc 同型） | 事实校验三件套完全未触碰，中文金额/多实体场景伪冲突误杀稳定复现 |
| **P1** | P1-5 / P1-6（备份空壳 / openVault 裸调用） | 用户数据安全面，改动小收益大 |
| **P1** | P1-10（ruleStore 订阅外提） + P1-29（立即写取消排队项） | 两处"声称已修"的补课，各为小改动 |
| **P1** | P1-30 / P1-31 / P1-32（l2 创建文件必抛 / 桌面核验三重死 / benchmark 不做插槽替换） | benchmark/l2 群功能坏死，机制明确易修 |
| **P2** | 第 4 章 #1-#5（P0-7 降级 fail-fast、traceId 传参化、autoCompile 门槛、流式记账、benchmark 预算隔离） | 修复波次引入的回归性风险，趁热修 |

### 5.2 P2 存量（随批次处理）

P1-1/P1-2 残留半边、P1-22 ready 门禁、A1-16/18/20/21/22/23/24、A1-25≡B-10、A2-5 死频道群、A2-7/8/9、A3-5/12/16/17、A4-10..16/20/21/23/25、A5-8/9/10/11/13、A6-10/16/17/18、C-10/11/13/14/15/16/18/20、D-10/13/15/16/17(半)/18、第 4 章 #6/#7

### 5.3 P3 存量（低优先）

A1-26(半)/27/28/30/31/32(半)、A2-4(半)/10/11(半)/12、A3-18..26、A4-27..33、A5-5(半)/14/16/17/19(半)/20、A6-12(半)/20/21(半)/22(半)/23/27、B-12、D-22..27、第 4 章 #8..#19

### 5.4 与 Phase 4+ 路线图的衔接

- A3 收尾批完成后进入 **B1+B2（M17 Ollama + M20 降级链）**；C-10（stream 标志丢弃）与 B1/B2 同域，建议并入该批一并处理（chatCompletionStream 已实现但零请求方，M17 实施时自然接通——届时必须先修第 4 章 #4 流式记账缺口）
- A2-9（pack veto 声明未实现）与 B3 竞争模型同触碰 kernel 评估点，归入 B3 批
- C-11 traceId 收尾（落点+消费端+传参化）可与 R4 遗留的 P1-39 残留（recordStepCost）合并为一个可观测性小批
- A1-32（electron 钉版）即路线图 D2，维持原计划

---

## 6. 方法与限制

- 每条结论均由当前源码 `文件:行号` 实证，未沿用审计报告行号；"FIXED" 要求指出具体修复机制，"OPEN" 要求确认缺陷机制仍在
- 行号基于 HEAD `acdc875`，后续提交会漂移，使用时应按机制重新定位
- 九簇复核相互独立，跨簇同一发现（如 A1-25≡B-10）在两簇各自验证，结论一致
- 动态行为仍以静态推理为主；"现行可达"判定（P0-2/P1-3 残留）基于机制推演，未经运行时渗透验证
