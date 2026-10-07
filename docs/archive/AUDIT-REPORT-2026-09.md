# HoloStarmap 全面审计报告（2026-09）

- **审计对象**：`C:\Users\Administrator\Desktop\HoloStarmap` 工作区当前状态（HEAD `ec6a11f checkpoint: pre-kernel-core-fix` + 未提交热插拔改造，66 文件变更）
- **审计方式**：只读。9 簇并行子代理审计 + 主代理对全部 P0 与 P1 抽样逐条源码复核；所有发现附 `文件:行号` 证据
- **审计基线**：docs/ARCHITECTURE.md（1081 行）、docs/HOTPLUG-ARCHITECTURE.md、TEST_REPORT.md 第 5/7/8 节、SECURITY.md
- **工作底稿**：九簇完整报告存于 `C:\Users\Administrator\AppData\Local\Temp\deveco\audit\{A1,A2,A3,A4,A5,A6,B,C,D}-findings.md`（含每条的完整证据与修复建议全文）
- **日期**：2026-09-14

---

## 0. 执行摘要

### 0.1 统计总表（按簇原始计数）

| 簇 | 范围 | P0 | P1 | P2 | P3 | 小计 |
|---|---|---|---|---|---|---|
| A1 | electron 主进程 11 文件 | 6 | 9 | 10 | 7 | 32 |
| A2 | kernel / kernels/default / domains | 0 | 2 新+3 已知确认 | 4 | 8 | 14+ |
| A3 | 路由链 services（15 文件） | 0 | 6 | 11 | 9 | 26 |
| A4 | 执行与安全 services（13 文件） | 1 | 7 | 16 | 10 | 34 |
| A5 | stores 16 文件 | 2 | 2 | 8 | 8 | 20 |
| A6 | composables / data / Three.js / vault 客户端 / benchmark | 0 | 9 | 9 | 9 | 27 |
| B | IPC 前后端对齐 | 0 | 4 | 6 | 2 | 12 |
| C | funnel 主路径生命周期 / 可审计性 | 0 | 9 | 11 | 0 | 20 |
| D | UI/UX（24+ 组件 + App.vue） | 1 | 6 | 13 | 8 | 28 |
| **合计（原始）** | | **10** | **54** | **88** | **61** | **213** |

跨簇去重后：**P0 = 10，P1 ≈ 48，P2 ≈ 75，P3 ≈ 60**。重复项在各条目以 XREF 标注。

### 0.2 Top 10 必修项

| # | 发现 | 一句话 |
|---|---|---|
| 1 | P0-1 / P0-2（A1-1, A1-2） | shell 白名单仅前缀匹配 + `shell:true` → cmd 元字符任意 RCE；`node -e` 黑名单缺 readFileSync/vm/动态 import |
| 2 | P0-7（A5-1） | 冷启动所有 store 先于 vault 同步加载 → 持久化数据全不可见，且默认会话**不可逆覆盖磁盘全部历史会话** |
| 3 | P0-8（A5-2） | 删除活动会话后消息数组按引用注入相邻会话 → 相邻会话历史被覆盖并持久化 |
| 4 | P0-6（A4-1/C-2/A2） | `llm:chat-completion`/`llm:get-gateway` 零 handler → 宏内全部 LLM 步骤死亡、`executePipeline` 入口无条件抛错（流水线 100% 全断） |
| 5 | P0-9（D-1/C-3/A4-2/A5-6） | 高风险确认链三重断裂：handler 返回布尔快照、`requestRiskConfirm` 零调用方、catch fail-open → 高危步骤 100% 被误拒，且链路异常时无确认执行 |
| 6 | P0-3 + P0-4（A1-4, A1-6） | 敏感路径正则 15/18 条 POSIX 风格在 Windows 永不匹配；`file:write` 零扩展名/内容校验 → Startup 持久化 RCE |
| 7 | P0-5（A1-3） | SSRF 防护纯字符串判断：IPv6/十进制 IP/域名解析/302 跟随全放行 |
| 8 | P1-39 + P1-45（C-1, C-9） | probeStep 双重断裂 + `debug:log-event` 等 5 类记录通道全落空 → 宏执行过程**零记录**，可审计性整体坍塌 |
| 9 | P1-16（A3-6） | RaaP 命中返回桩 manifest → 确认 UI 展示"0 步计划"，实际执行未展示步骤——用户同意机制被架空 |
| 10 | P1-33（A6-8） | benchmarkRunner 用伪造指纹写入**生产**指纹库（Date.now 当哈希、结果全同、无副作用集）→ 后续真实执行可复用伪造结果 |

### 0.3 一段话结论

当前工作区的**安全边界（Electron 主进程）在 Windows 上系统性失效**：shell 执行、路径校验、SSRF、文件写入四道防线全部可绕过（P0-1~P0-5）。**数据层存在两条独立的用户数据不可逆丢失路径**（P0-7、P0-8）。**执行内核的核心链路大面积极断**：LLM 步骤、流水线、高风险确认、MCP 直达、候选选择、3/7 暂停点全部死亡（P0-6、P0-9 及 P1 群）。**全链路可审计性不成立**：请求可触发，但步级记录、计费、审计 CSV、工作流时间线、导出包五类采集通道全部落空，且无 traceId 串联（第三章）。`pre-kernel-core-fix` 指向的 4 个内核核心缺陷已在工作区全部修复（第七章）。

---

## 1. P0 清单（10 项，全部经主代理逐条源码复核确认）

### P0-1 shell 白名单元字符 RCE
- **来源**：FIND-A1-1
- **位置**：`electron/shell-security.ts:138-183`；`electron/ipc-handlers.ts:457-461`
- **描述**：`isShellCommandAllowed` 仅做小写前缀匹配（:177 `trimmed.startsWith(allowed)`），不检查任何 cmd 元字符（`&` `|` `>` `<` `^`）；而 `shell:exec` 以 `spawn(opts.command, [], { shell: true })` 原样交给 `cmd.exe /c`。
- **触发与影响**：被攻陷渲染进程可用白名单前缀+元字符执行任意命令：`cd .. & calc`（任意程序）、`echo ... > Startup\x.bat`（开机持久化）、`type C:\Users\<u>\.ssh\id_rsa`（绕过 pathValidator 读任意敏感文件）、`copy` 任意覆写。
- **复核**：✅ 主代理实读确认（前缀匹配 + shell:true 均属实）。
- **修复建议**：弃用 `shell:true`，改 `spawn(file, args, {shell:false})` + 参数级白名单；过渡期先加元字符黑名单拒绝（`/[&|<>^%"]/`），`type/cat/echo` 目标路径过 `validateReadPath`。

### P0-2 `node -e` 受限模式黑名单绕过
- **来源**：FIND-A1-2
- **位置**：`electron/shell-security.ts:17-73`（黑名单）、`:141-152`（node -e 分支）、`:89-114`（可信模板豁免）
- **描述**：黑名单仅覆盖 6 个 require 模块名 + 写类调用。`require('fs').readFileSync('.ssh/id_rsa')`（readFileSync 不在名单）、`require('vm')`、动态 `import('child_process')`、拼接 `require('ch'+'ild_process')`、`process.mainModule.require` 全部放行；配合 P0-1 元字符逃逸独立成立。可信模板豁免允许"签名+合法 writeFileSync"组合向 Desktop/Documents/Downloads 任意写。
- **复核**：✅ 主代理实读 73 行黑名单确认无上述模式。
- **修复建议**：`node -e` 改为服务端固定模板（渲染层只传数据）；至少补齐 readFileSync 全系、`require(\s*\(\s*['"]fs['"]`、动态 import、vm/worker_threads，可信模板改精确哈希比对。

### P0-3 SSRF 防护五类绕过
- **来源**：FIND-A1-3（VULN-16 复核：TEST_REPORT 声称的 TODO 注释已不存在，缓解不存在）
- **位置**：`electron/ipc-handlers.ts:50-59`（isPrivateHostname）、`:503-535`（http:fetch）、`:663/799/1081`（llm 三入口复用）
- **描述**：仅对首跳 URL 的 hostname 字符串做前缀判断。IPv6（`[::1]`、`[::ffff:127.0.0.1]`、fc00::/7）、IPv4 变体（`2130706433`、`0x7f000001`、`0.0.0.0`）、解析到内网的域名（nip.io）、302 重定向跟随、DNS rebinding 全部放行。
- **复核**：✅ 主代理实读确认（:51 仅 localhost/127.0.0.1/三段前缀；:531 fetch 无 `redirect:'manual'`）。
- **修复建议**：校验前 `dns.lookup` 解析全部地址族逐 IP 判私网；`redirect:'manual'` 每跳重验；自定义 Agent 做 IP pinning。

### P0-4 敏感路径防护在 Windows 整体失效
- **来源**：FIND-A1-4
- **位置**：`electron/pathValidator.ts:3-21`（FORBIDDEN_READ_PATHS）、`:65-81`（validatePath）
- **描述**：18 条敏感路径正则中 15 条以 POSIX `/` 书写（`.ssh`、`.aws`、`.kube/config`、`.npmrc`、`/etc/shadow` 等）；`resolve()` 在 Windows 产出反斜杠路径，正则永不匹配。而 `home` 是允许基目录，上述敏感文件全在 home 下 → `file:read` 可读、`file:write` 可写（如向 `.ssh\authorized_keys` 追加公钥）。
- **复核**：✅ 主代理实读确认（15/18 POSIX 风格）。
- **修复建议**：正则改 `[/\\]` 双分隔符或按路径段数组匹配；写路径单独应用敏感目录拒绝清单（含 .ssh、Startup、Start Menu）。

### P0-5 尾随点/空格绕过扩展名黑名单 → RCE 链闭合
- **来源**：FIND-A1-5
- **位置**：`electron/pathValidator.ts:96-106`（validateOpenPath）；`electron/ipc-handlers.ts:914-926`（shell:openPath）
- **描述**：扩展名提取用 `filePath.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')`。主代理复核发现比原报告更糟：对 `evil.bat.`（尾随点）该正则**整体不匹配**，replace 原样返回整个路径字符串当 "ext" → `includes` 必 false → 放行；`evil.bat `（尾随空格）提取为 `.bat ` 同样放行。Win32 ShellExecute 剥离尾随点/空格实际打开 `evil.bat`。与 P0-6 的 `file:write` 无校验组合成完整 RCE 链。
- **复核**：✅ 主代理实读 + 正则推演确认。
- **修复建议**：取扩展名前 `path.basename` 并剥离全部尾随 `.`/空格；openPath 前用 `fs.statSync` 确认最终目标；改用 SAFE_OPEN_EXTENSIONS 白名单模式。

### P0-6 `file:write` 零扩展名/内容校验 → Startup 持久化
- **来源**：FIND-A1-6
- **位置**：`electron/ipc-handlers.ts:159-170`；`electron/pathValidator.ts:33-39`
- **描述**：`file:write` 仅调 `validatePath`（基目录 + 已失效的敏感路径正则），不检查目标扩展名与内容。`home` 基目录覆盖 `Startup`、PowerShell profile 等 → 写入 `Startup\x.bat` 即持久化 RCE；亦可覆写 `.npmrc`/`.gitconfig` 投毒。DANGEROUS_EXTENSIONS 33 项仅挂在 openPath。
- **复核**：✅ 主代理实读确认（:159-170 仅 validatePath）。
- **修复建议**：validatePath 增加写专用模式：拒绝可执行/脚本扩展名、拒绝 Startup/Start Menu/profile 目标；文本写入记录审计日志。

### P0-7 冷启动持久化数据全丢失（不可逆覆盖链）
- **来源**：FIND-A5-1（A6-K2、C 簇交叉确认）
- **位置**：`src/App.vue:738-749`（store 加载）vs `:827`（`await vault.syncFromVault()`）；`src/vault/index.ts:19`（cache-first read）、`:86-88`（readCache）；`src/stores/sessionStore.ts:22-27,192-217`
- **描述**：全部 store 加载器使用同步 `vault.readCache()`（纯内存缓存），而冷启动时缓存在 `syncFromVault()`（App.vue:827）之后才填充——加载器全部读到空。更糟：`dialogStore.initSession()` → `sessionStore.initOrLoad()` 见 0 会话即创建默认会话并 `writeThrough` 写入缓存；`syncFromVault` 随后的 `read()` 被 cache-first 短路，永不读盘；100ms flush 把"仅含默认会话"的数组写盘 → **磁盘全部历史会话被不可逆销毁**。同理任何 store 保存都会以"默认值+增量"覆盖全量磁盘数据。
- **复核**：✅ 三簇独立交叉 + 主代理早前实读确认。
- **修复建议**：启动顺序改为先 `await syncFromVault()` 再加载 store（或发 `vault:synced` 事件触发重载）；`initOrLoad` 在同步屏障前禁止持久化；vault read 对"同步前写入的缓存项"偏向磁盘（epoch 版本化）。注意必须连同 A6-15（cache-first read 永不刷新）一并修复，否则单改顺序无效。

### P0-8 删除活动会话 → 相邻会话历史被引用注入覆盖
- **来源**：FIND-A5-2（原 A5-7，机制已完整追平，升格 P0）
- **位置**：`src/components/DialogPanel.vue:367`；`src/stores/sessionStore.ts:114-122`；`src/stores/dialogStore.ts:2462-2465`；`sessionStore.ts:132-138`
- **描述**：UI 直接调 `sessionStore.deleteSession(s.id)`，无 dialogStore 协调。删除后 `activeSessionId` 重指相邻会话，但 `dialogStore.messages` 仍持有**被删会话的消息数组引用**；下一条消息/通知触发 `saveToStorage` → `updateActiveMessages(messages.value)` 把旧数组**按引用**赋给新活动会话并持久化。因数组别名，后续所有 push 也落入受害会话。
- **复核**：✅ A5 全文精读 + 引用链逐行核对。
- **修复建议**：删除经 dialogStore 动作路由（镜像 switchSession）：重置 `messages.value` 为新活动会话消息的**拷贝**并 `clearAllPausePoints()`；`updateActiveMessages` 改深拷贝或显式断别名。

### P0-9 高风险确认链三重断裂（fail-open catch + 不可达 UI）
- **来源**：FIND-D-1（P0）/ FIND-C-3 / FIND-A4-2 / FIND-A5-6（四簇交叉）；原始 A2-1
- **位置**：`src/domains/dialog/handlers.ts:5-8`；`src/stores/dialogStore.ts:2336-2349`（requestRiskConfirm 零调用方）；`src/services/macroExecutor.ts:496-505`
- **描述**：三重叠加：① handler 同步返回 `store.awaitingRiskConfirm` 布尔快照（恒 false），不调 `requestRiskConfirm`、不弹窗、不等待；② 真正弹 5 分钟超时确认框的 `requestRiskConfirm` 全仓零调用方 → 确认条永不出现；③ macroExecutor catch 仅重抛"用户拒绝"，**其余任何异常被吞后高危命令继续执行**（fail-open）。当前净效果：LLM 判 high 的步骤 100% 以"用户拒绝"名义被误拒（fail-safe 方向的功能坏死）；一旦 dialog 域链路异常，同一 catch 立即翻转为无确认执行。
- **复核**：✅ 主代理实读 handlers.ts + grep 确认 requestRiskConfirm 仅定义/导出两处。
- **修复建议**：handler 改为 `await store.requestRiskConfirm(payload.actionManifest)`（超时视为拒绝）；catch 中除"用户拒绝"外一律按拒绝处理（fail-closed）。用户已预选策略：**fail-closed + 手动确认弹窗**。

### P0-10 `llm:chat-completion` / `llm:get-gateway` 死频道
- **来源**：FIND-A4-1（P0）/ FIND-C-2 / A6-K1 / A2 影响扩展
- **位置**：`src/services/macroExecutor.ts:282,736`；`src/services/pipelineExecutor.ts:227`；`src/kernel/bus.ts:27-33`（无 handler 即 throw）；已注册的是 `api:chat-completion`（`src/domains/api/handlers.ts:5`）
- **描述**：两通道全仓零 registerHandler。① macroExecutor 的 `llm_generate` 工具与 direct 模式宏每次必抛 `[bus] no handler`，四级降级链空转后全败；② `executePipeline` 入口 L227 必抛且在 try/finally 之外 → **整条 L1 流水线执行 100% 崩溃**（A2 扩展确认）；③ confirmPlan 的 NATIVE_TOOLS 快路径在可用通道之前拦截 → 全部原 生计划执行失败。benchmark 窗口因直调 apiStore 绕过总线而"正常"，结构性掩盖了此 P0。
- **复核**：✅ 主代理 grep 确认仅 3 处 request、零注册。
- **修复建议**：macroExecutor 两处改 `api:chat-completion`（payload.signal 可透传）；为 `llm:get-gateway` 注册 handler 或改走 apiStore；修复时 handler 委托 `apiStore.chatCompletion`（带 callerId='macroExecutor'），使宏路径进入语义缓存/预算体系（XREF P1-40）。

---

## 2. P1 清单（去重后 48 项）

编号 P1-1..P1-48；"复核"栏 ✅ = 主代理直接读码/grep 验证；"✕簇" = 多簇独立交叉确认。每条完整证据见对应簇底稿。

### 2.1 主进程（A1 簇，9 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-1 | A1-7 | ipc-handlers.ts:560-574 | backup:restore 无预备份/无条目校验/非原子：损坏或恶意 zip 覆盖现网 15 个 store JSON 无回滚，zip 炸弹可写满磁盘（extract-zip@2.0.1 符号链接穿越在运行时路径已缓解，SECURITY.md 表述需更新） | 恢复前自动快照；解压到临时目录、校验条目（仅 store/*.json、单文件≤10MB）后原子交换 |
| P1-2 | A1-8 | ipc-handlers.ts:480-489; mcp-manager.ts:206-226 | 超时 kill 只杀 cmd 壳进程不杀进程树 → npm postinstall 在"超时已报错"假象下继续执行完毕，孤儿进程累积 | Windows 用 `taskkill /T /F` 或 Job Object 绑定整树 |
| P1-3 | A1-9 | shell-security.ts:116-136; mcp-manager.ts:85-89 | MCP 白名单放行 node/python/uvx 但参数零约束：`node evil.js`、`uvx 任意包` 合法（shell:false 已落实但不限制解释器执行任意脚本） | 解释器参数白名单；脚本路径过 validateReadPath；uvx 包名 scope 白名单 |
| P1-4 | A1-10 | vault-migration.ts:68-134 | 迁移逐条 catch 计 errors，但 errors>0 仍无条件写 `migration_complete` → 失败条目永不重试，渲染层据 success 清理源后数据永久丢失 | errors>0 不写完成标志（或写 partial+失败清单到 vault_meta 供重试） |
| P1-5 | A1-11 | ipc-handlers.ts:545-558 | backup:create 只打包 legacy storeDir，不含 vault SQLite（现主持久化轨道）/vectorDir/knowledgeDir → 用户备份是空壳 | 备份纳入 vaults（先 `wal_checkpoint(TRUNCATE)`）与另两目录；恢复流程对应扩展 |
| P1-6 | A1-12 | ipc-handlers.ts:962; main.ts:22-24 | openVault 裸调用 + whenReady 链无 catch：vault 锁/损坏 → setupIpc 中断，半套 IPC 静默启动，vault:* 全报 no handler 且无用户可见错误 | openVault 单独 try/catch + showErrorBox + 降级注册统一错误对象 |
| P1-7 | A1-13 | ipc-handlers.ts:457-458; shell-security.ts:3 | shell:exec 的 cwd 完全由渲染层指定且不过 validatePath；`npm run` 在白名单 → 伪造 package.json scripts = 任意执行 | cwd 过 validatePath；npm run 移出白名单 |
| P1-8 | A1-14 | pathValidator.ts:65-72 | validatePath 纯字符串前缀比对，不 realpathSync：允许目录内符号链接/junction 指向任意位置（npm postinstall 可创建） | 校验通过后 realpath 再比对基目录 |
| P1-9 | A1-15 | window-manager.ts:16-18; main.ts:62-65 | getMainWindow 唯一无 isDestroyed 守卫：主窗单独关闭后 store:syncToMain 抛 "Object destroyed" → uncaughtException → 1s 强退全部存活窗口 | 补守卫；主窗 closed 视作退出条件 |

### 2.2 内核/领域（A2 簇，2 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-10 | A2-1 / A5-3 ✕2簇 | ruleStore.ts:82-90 | 三条 pack 生命周期订阅误置于 `markFalsePositive()` 函数体内（热插拔改造缩进错误，git diff 证实）：监听器泄漏（N 次误报=3N 永久监听器）+ 首次误报前规则列表不随 pack 挂载同步 | 移至 store 顶层作用域，持 disposer 并暴露 dispose() |
| P1-11 | A2-2 ✅ | dialogStore.ts:511 vs macroExecutor.ts:331 vs domains/mcp/handlers.ts:11 | `mcp:call-tool` 契约错位：dialogStore 发 `{connectionId,toolName,args}`、macroExecutor 发 `{mcpId,...}`、handler 读 `mcpId` → 对话路径全部 MCP 工具步骤必抛"未连接" | 统一 payload 契约（主代理 grep 确认两发送方键名不一致） |

### 2.3 路由链（A3 簇，6 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-12 | A3-1 | embedder.ts:91; semanticCache.ts:607-621; knowledgeBase.ts:369-372 | needsReembedding 仅查维度，伪向量恰为 384 维 → 永远 false；reembedAll 与 knowledgeBase 重嵌入双 no-op，伪向量永久滞留污染检索 | 判定加内容指纹/来源标记；提供一次性清洗脚本 |
| P1-13 | A3-2 | loader.ts:389; kernel/clusters/cache.ts:27-36; apiStore 5 处调用点 | invalidateByPack 已接线但所有调用点传 `packId=''` → pack 失效恒为空集（R6 未端到端接线） | 调用点传入真实 packId |
| P1-14 | A3-3 | scheduleOptimizer.ts:266; macroExecutor.ts:842/832 | findDirtySteps 脏传播方向反转（脏上游而非下游）且调用点传 `{}` → dirtySteps 恒空、指纹以空 stepHashes 保存 | 反转传播方向；调用点传真实变量表 |
| P1-15 | A3-4 ✕2簇 | macroExecutor.ts:817/830/865/1017; scheduleOptimizer.ts:323 | 副作用工具集 5 处定义不一致且**全部**漏 create_docx → docx 结果被缓存复用但文件从未创建=假成功 | 统一导出常量集合并纳入 create_docx |
| P1-16 | A3-6 | toolRetrieval.ts:546-556/751-753/823; dialogStore.ts:1096/1509 | RaaP 命中返回桩 manifest（空 dagPlan/slots）→ 确认 UI 展示"0 步计划+无槽位"，确认后执行的是未展示的真实 manifest——**用户同意机制被架空**（HEAD 即存在） | RaaP 命中返回完整 manifest；或确认条显式标注"计划由工具定义，与展示不同" |
| P1-17 | A3-7 | promptTranslator.ts; macroExecutor.ts:98-300; dialogStore.ts:411-424 | 规划种子/工具清单教 LLM 使用 `file_read`/`directory_tree`，原生分发只认 `read_file` 等 → 规划出的 DAG 必抛"无效工具名"，fuzzyToolMatch 救不了原生路径 | 统一工具名词表（种子与分发共用同一常量） |

### 2.4 执行与安全（A4 簇，6 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-18 | A4-3 | scheduleOptimizer.ts:372-374; dualEngineValidator.ts:180-185 | 双引擎审核缓存 key 不含 userInput → 同 skill 同文件的第二次调用（意图完全不同）命中缓存直接复用 intent_match=true，跳过 LLM 意图复核（TTL 24h/500 条窗口） | key 加输入指纹；或缓存仅复用 parameter_sane，intent_match 每次重判 |
| P1-19 | A4-4 | dualEngineValidator.ts:57-59, 89-98 | shell_exec 仅写操作触发双引擎：`curl`（SSRF/内网探测）、`cat/type`（读敏感文件）完全绕过审计与 URL/路径黑名单 | shouldValidate 增加 containsUrl/readsSensitivePath 判定，复用 isUrlSafe/isPathSafe |
| P1-20 | A4-5 | factGuard.ts:136-148 | L1 实体比对内层循环首个不匹配即 break → 永远只考察 sourceList[0]：输出忠实复述任一非首源实体即伪"严重事实冲突"，正确步骤被误杀 | 遍历全部源实体，全不匹配才记冲突（取差异最小者） |
| P1-21 | A4-6 | nerExtractor.ts:41-46, 9 | normalizeAmount 把"万/亿"单位字符直接删除："3万元"→3.00、"5亿"→5.00 → 与正确换算输出比对差 ~100% 误杀 + minor 路径把正确输出改写回错误值 | 清洗前按后缀单位换算（复用已有 parseChineseAmount/applySuffix） |
| P1-22 | A4-7 ✕2簇 | domainConstraints.ts:14, 3284-3309; App.vue:758 | initPackRuntime fire-and-forget：启动到 pack 挂载完成之间 runConstraints 返回空 → 法规校验静默放行，且窗口期输出经指纹缓存固化，**窗口外也不补检** | 执行入口 await initPackRuntime；或未就绪时显式 not_ready 信号 + 窗口期输出不入缓存 |
| P1-23 | A4-8 | macroExecutor.ts:579-601 | resource_missing 错误分类后从**不可信错误文本**提取包名并**未经确认自动 `npm install`** → 恶意文档嵌入 `cannot find module 'evil'` 即诱导安装任意包 | 安装前走确认弹窗；或限 package.json 已声明依赖 |

### 2.5 stores（A5 簇，2 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-24 | A5-6 | dialogStore.ts:2360-2365; macroExecutor.ts:936-959 | 除 confirm-risk 外另两个暂停点同样死亡：`pauseDagAtStep` 零调用方、`dialog:get-paused-state`/`dialog:request-takeover` 无 handler → DAG 人工暂停/接管整体不可用（轮询/超时/接管 UI 全部形同虚设） | 注册两 handler 绑定 store；UI 动作接线 pauseDagAtStep |
| P1-25 | A5-7 ✅ | dialogStore.ts:1119-1137, 705-724, 1280-1297; apiStore.ts:356-619 | 三条 MCP 直达快速路径只发一次 chat-completion 即展示，**从不执行返回的 toolCalls**（apiStore 本就不执行）→ 用户看到"(无输出)"；:1128 还把整个 result 对象当 content 存库（非字符串消息） | 循环执行 toolCalls 回填（复用 DAG 循环逻辑）；:1128 改 `.content`（主代理实读 :1126-1128 确认） |

### 2.6 composables / vault 客户端 / benchmark（A6 簇，9 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-26 | A6-1 / D-5 ✕2簇 | PipelinePage.vue:244-255 | "▶ 运行"执行的是**存储的**第一条有 dagNodes 的 pipeline，非当前画布；画布节点被置 pending 后永无回写（执行器回调写 pipeline.dagNodes 而非 dag.nodes） | 执行当前画布（nodes+edges → manifest），进度回写画布状态；空画布给出提示 |
| P1-27 | A6-2 ✅ | useDagEngine.ts:406-421; PipelinePage.vue:264 | Delete/Backspace 无 `e.target` 守卫且绑定在 window 上：在宏名/关键词输入框内打字退格即摧毁选中节点+边，无撤销 | input/textarea/contenteditable 目标早退（主代理实读确认无守卫） |
| P1-28 | A6-3 | vault/index.ts:132-141 | flush 定时器回调无 try/catch 且遍历已 splice 的队列：一次 vaultWrite 拒绝 → unhandled rejection + 该 100ms 批次**所有 store 的写全部丢失**（缓存仍持有→重启前不可见） | catch + 重新入队 + 指数退避 |
| P1-29 | A6-4 | vault/index.ts:29-34, 97-102, 136-139 | 立即 write(k,v2) 可被队列中旧 writeThrough(k,v1) 后写覆盖，无按键合并 → 磁盘与缓存分叉 | 按键 coalesce / 单一串行写路径 |
| P1-30 | A6-5 | l2Manifests.ts:408 | `l2-file-creator-v1` 步骤 1 的 node -e 脚本内嵌 3 处 `debugLog(...)`（子进程未定义）→ ReferenceError 在 writeFileSync 之前抛出 → **该工具永远无法创建文件**；另硬编码 'C:\Users\Administrator' 回退与固定文件名覆盖 | 子进程内改 console.log；路径/文件名动态化 |
| P1-31 | A6-6 / A4-17 ✕2簇 | macroExecutor.ts:184-204 | 桌面文件核验三重死：核验脚本内 debugLog 未定义必抛（被吞）+ HOME_DIR 固定 'C:\Users\Default'（不存在的目录）+ 硬编码用户名回退 → "命令成功但文件未找到"提示永不触发 | 子进程内 console.log；用真实用户主目录 |
| P1-32 | A6-7 | benchmarkRunner.ts:118-122, 89 | benchmark 的"优化路径"不做 `{{input}}`/`{{step_N_result}}` 插槽替换（真执行器用 resolveParams）→ LLM 收到字面 `{{step_1_result}}`：测的不是它声称的 DAG 管线 | 复用 resolveParams 做参数解析 |
| P1-33 | A6-8 ✕3簇 | benchmarkRunner.ts:123-131 | benchmark **伪造指纹写入生产指纹库**：stepHashes=Date.now 字符串（全步相同）、每步结果=同一 lastResult、无 sideEffectSteps → 真实运行可复用伪造结果（含 shell_exec/file_write），successCount 虚高触发过早 autoCompile | benchmark 使用隔离命名空间指纹键，或运行期间禁用指纹读写 |
| P1-34 | A6-9 | benchmarkRunner.ts:45-71 × apiStore.ts:356-478 | 档位对比是虚构的：tier 仅改 maxTokens，实际模型恒为 activeModel、生效档位来自 smartRoute → 配合硬编码单价，报告的"成本节省"无实际意义 | 真实切换 tier；或修正统计口径 |

### 2.7 IPC（B 簇，4 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-35 | B-1 | env.d.ts:110; debug/benchmark/rule-review-main.ts:49-50; preload（未暴露）; main.ts:81/137/152 | `ipcRendererSend` 声明但 preload 未暴露，3 个子窗口 main 静默 no-op → `*:ready` 永不发送 → debugWindowReady 永假、pendingDebugSyncs 永不 flush、`store:applyUpdate` 永不达 → **调试监视器跨窗同步整链死亡** | preload 暴露窄接口 `sendWindowReady(window)`；或统一改主进程 did-finish-load（pipeline 窗已是此模式） |
| P1-36 | B-2 | main.ts:62-65; 四个子窗口 main:10/23 | 四个子窗口把每次 pinia 变更推给主窗（storeSyncToMain → store:applyUpdate），但主窗口**零处订阅** onStoreApplyUpdate → 子窗口编辑永不回传，store 静默分叉 | 主窗注册 $patch 桥（镜像子窗口实现） |
| P1-37 | B-3 / D-7 ✕2簇 | RuleReviewPage.vue（零 electronAPI 调用）; preload:276-278 | RuleReview 无边框窗口无拖拽区、无最小化/最大化/关闭按钮（三方法暴露但零调用）→ 只能任务栏/Alt+F4，观感如假死窗 | 加标题栏接线三方法（复制 DebugWindowPage 模式） |
| P1-38 | B-4 | preload:135-136; main.ts:57-60; src/main.ts:11-31 | storeSyncToPipeline 零调用方（主窗 $subscribe 桥只推 debug）→ 主→pipeline 状态同步死；与 P1-36 叠加 = **pipeline 窗口双向状态孤岛** | $subscribe 桥同时推 pipeline；或整链删除 |

### 2.8 可审计性（C 簇，7 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-39 | C-1 / A2-6 | macroExecutor.ts:41-75; domains/debug/handlers.ts:10-17 | probeStep 双断：① 先 request 无 handler 的 `debug:get-step-cost` → 抛错被外层 try 吞 → 后续 emit 不执行；② 即便发出，payload 无 snapshot/message 字段，probeHandler 两分支都不命中直接丢弃 → **宏执行回放零数据** | probeStep 改 emit('debug:log-probe',{snapshot})；注册 get-step-cost handler |
| P1-40 | C-4 ✕簇 | domains/debug/handlers.ts:27-35; kernel/clusters/budget.ts:18; apiStore.ts | `debug:record-cost` 注册但全仓零发射方；kernelRegistry.dispatch 无外部调用方 → **tokenBudget 主链路零记账**，日/月预算判定建立在空数据上 | apiStore.chatCompletion 成功后 emit record-cost（带 tier/category/traceId） |
| P1-41 | C-5 / A5-15 | dialogStore.ts:205,233（发射）; memoryStore.ts:94-97 | `memory:add-dialog-message` 有发射有 handler，但 handler 丢弃 payload（参数 `_` 前缀）仅更新时间戳 → 会话记忆永不积累对话内容，接线是装饰 | 实现持久化（append 到会话记忆）或删除双侧 |
| P1-42 | C-6 | memoryStore.ts:204-212; L0Modal.vue:465 | `addAuditLog` 全仓零调用 → 导出的审计 CSV 永远只有表头——"可审计可采集"核心承诺落空 | 在宏执行/MCP 调用/文件写入等动作点埋 addAuditLog |
| P1-43 | C-7 / D-4 ✕2簇 | workflowLogStore.ts:9-65; DialogPanel.vue:541-569 | workflowLogStore 全部写方法零调用 → 执行时间线 UI `v-if logs.length>0` 恒假；"清空"按钮写 `localStorage['holo-workflow-logs']` 而 store 经 vault 持久化（键还写错）= 安慰剂按钮 | 在 executeMacro/executePipeline 生命周期调用 createLog/updateNodeStatus；清除改调 store action |
| P1-44 | C-8 | dialogStore.ts 40+ 处发射; domains/node/handlers.ts:4 | `node:set-l1-status` 40+ 处 emit 无任何 on() 监听 → 主窗星图 L1 执行状态可视化断裂 | nodeStore 注册 on() 桥（参照 debug 域做法）驱动节点着色 |
| P1-45 | C-9 / A4-19 ✕2簇 | macroExecutor.ts 8 处; pipelineExecutor.ts:230,322,339; debugStore.ts:287-293 | `debug:log-event`（宏全部执行明细）与 `debug:register-abort`/`clear-abort` 零监听 → 执行明细全丢弃；调试窗"终止执行"拿不到任何控制器，**用户无法中止运行中的宏/流水线** | domains/debug 补两个 on() 桥接 emitEvent/registerAbortController |

### 2.9 UI/UX（D 簇，3 项）

| # | 来源 | 位置 | 描述与影响 | 修复方向 |
|---|---|---|---|---|
| P1-46 | D-2 ✅ | dialogStore.ts:2254, 683/1115/1169/1234; RuntimePanel.vue:15-18 | 候选选择流死亡：store 提示"输入编号选择"，但 pickCandidate 零 .vue 引用、sendMessage 无 awaitingCandidatePick 拦截（只查 awaitingRiskConfirm）→ 按提示输编号被当**新请求**发出；RuntimePanel 等待卡片无可点选项（主代理 grep 复核确认） | 渲染候选按钮调 pickCandidate(idx)；sendMessage 拦截数字输入 |
| P1-47 | D-3 | App.vue:675-693; CommandPalette.vue:180; SettingsPage.vue:166; NotificationCenter.vue:93 | Esc 链断裂：App.vue 检查 `ref?.visible`，但三个组件仅 `defineExpose({open,close})` → 恒 undefined → Esc 一律穿透到**相机重置**（设置/通知/面板开着时按 Esc 会重置星图视角）；L0Modal/ApiSettings 根本不在链内；组件内 Esc 无 stopPropagation | 组件暴露 visible/isOpen()；补链；组件 Esc 处理 stopPropagation |
| P1-48 | D-6 | ResultPreviewStage.vue:149-170 | 块编辑保存损坏消息：saveEdit 在 splice 之前用重解析 fragment 覆写 `block.node`（startLine=0 相对值）→ splice 恒定位第 0 行 → 保存任何非首块编辑都会**覆写/损坏整条消息** | 先捕获原 startLine/endLine 再重解析，用原值 splice |

---

## 3. P2 / P3 清单（按簇紧凑格式）

格式：`编号 位置 — 问题 → 修复方向`。"→P1-xx" 表示与该 P1 重复/同根因，不重复计修复。完整证据见各簇底稿。

### 3.1 A1 主进程

**P2（10）**
- A1-16 ipc-handlers.ts:393 — LLM 超时可被用户设置覆盖为小于 tier 最低值 → 校验下限
- A1-17 main.ts:22 — 退出不 closeVault（closeVault 死导入）→ SQLite 无 wal_checkpoint，外部复制/备份可能不一致 → app quit 前 checkpoint
- A1-18 vault:110 — vaultRead 解密失败返回密文原样 → 损坏数据静默流入渲染层 → 返回哨兵+错误上报
- A1-19 ipc-handlers.ts:530 — archiver 错误未监听 → uncaughtException → **备份失败直接退出应用** → 补 error 监听
- A1-20 vault:73 — namespace/key 无格式校验 → 白名单字符校验
- A1-21 mcp-manager.ts:152 — stderrBuffer 无界累积 → 环形缓冲/定期 flush 到日志
- A1-22 main.ts:52 — unhandledRejection 仅日志，无用户可见信号 → 上报通知
- A1-23 ipc-handlers.ts 9 处 — 哨兵值吞异常模式（catch 返回 ''/null）→ 统一 Result 对象
- A1-24 pathValidator.ts:40 — startsWith 大小写敏感误拒合法路径；基目录解析失败退化为 home → 规范化后比对；失败应显式报错
- A1-25 window-manager.ts — 五个窗口全部注入全量 preload（shell:exec/file:write 对调试/规则窗可见）→ 最小权限：按窗口裁剪

**P3（7）**
- A1-26 死导出（bufferToStream）；SECURITY.md 提及的 SAFE_OPEN_EXTENSIONS 在代码中不存在（文档幻觉白名单）→ 同步文档或补实现
- A1-27 net.ts — GET with body 静默丢弃 body → 拒绝或警告
- A1-28 watchfs:15 — 先拆旧 watcher 再校验，失败丢监听 → 先建后拆
- A1-29 vault-migration.ts — 迁移失败无 key 清单 → 失败列表入 vault_meta
- A1-30 store-sync.ts — pendingPipelineNodes 无界 → 完成后清理
- A1-31 main.ts:62 — console-message 用旧签名（新参数被忽略）→ 更新签名
- A1-32 electron 仅 devDependency（17.B1 CONFIRMED：打包器自带，风险=依赖表与文档不一致）→ 依赖审计说明

### 3.2 A2 内核/领域

**P2（4）**
- A2-3 memoryStore.ts:100 — `memory:add-mcp-log` 发送端用 on/emit 自协商、接收端用 registerHandler(invoke) 互不可达 → **MCP 调用日志 100% 丢失** → 统一为 emit/on
- A2-4 dialogStore.ts — `/debug` 命令 parser 识别后无动作 → 实现或移除
- A2-5 死频道群（10+）：node:visual-event、dialog:add-notice、feedback:add-side-effect、funnel:shadow-diff、config:set-* 等有发射无 handler → 逐个接线或删除
- A2-6 `debug:get-step-cost` 零 handler（probeStep 链根因之一，→P1-39）

**P3（8）**
- A2-7 kernel dispatch 每阶段独立 try/catch+continue → 失败阶段静默跳过（→P1-40 同修：dispatch 接线时改为 fail-fast 或汇总报告）
- A2-8 beforeLlm 预算硬阻断不可达（预算记账死链所致 →P1-40 修复后激活）
- A2-9 hook 机制零生产调用方；rule pack veto 声明未实现 → 接线或删除声明
- A2-10 onboardingManager 死模块（零引用）→ 删除
- A2-11 apiStore requestStream finally cleanup 丢弃 → loading 可能永久悬挂
- A2-12 funnel L1 autoExecutable 恒 false（新旧路径平价问题，与 G7 决策联动）
- A2-13 mcp-direct 未匹配工具静默吞（无用户提示）→ 显式提示
- A2-14 initPackRuntime 未 await 与 syncFromVault 读取竞态（→P1-22 同修）

### 3.3 A3 路由链

**P2（11）**
- A3-5 apiStore.ts — sessionSpent 双重计入 → 额度提前耗尽 → 单点记账
- A3-8 apiStore.ts:430 — strategy='block' 静默降级 nano 永不拦截 → block 即硬失败
- A3-9 dualEngineValidator — 验证缓存 key 不含输入内容 → 加输入指纹（与 P1-18 同模式）
- A3-10 scheduleOptimizer — 持久化指纹 results:{} → loadPack 后假命中（步骤显示有缓存结果实为空）→ 保存时剔除空结果或标记
- A3-11 桌面文件核验死（→P1-31）
- A3-12 macroExecutor — 格式转换不落盘即报成功 → 核验文件存在
- A3-13 semanticCache — 计费 emit 字段与消费端错位（→P1-40 一并统一）
- A3-14 semanticCache — 过期覆盖留双份/误逐出 → 单条 upsert
- A3-15 benchmark 伪造指纹（→P1-33）
- A3-16 budget.ts — budget=0 语义错误（0 当"无预算"放行全部；应表禁止或无限）→ 显式三态
- A3-17 规划约束仅 prompt 文本未在分发层强制 → 约束词表硬校验

**P3（9）**
- A3-18 相似度阈值死配置（无 UI/config 键）→ 暴露配置或删死码
- A3-19 自适应阈值不持久（仅会话内）
- A3-20 零 token 模式无法自适应（零成本路径无反馈信号）
- A3-21 textHash 弱 32 位（碰撞风险）→ 换 xxhash64/sha1
- A3-22 语义缓存历史仅 100/500 条（与文档承诺不符）
- A3-23 fallback_l1 死分支
- A3-24 编译缓存无界 → LRU
- A3-25 %USERPROFILE% 未解析即拼接；探索计划硬编码路径
- A3-26 周期实现 daily/session/monthly 与规范文档不符 → 统一口径

### 3.4 A4 执行与安全

**P2（16）**
- A4-9 pathValidator.ts:96-106 — B1 变体 CONFIRMED：pathRe 捕获组错位（`(\/|\\)` 消费分隔符），group 1 返回垃圾路径（与 P0-5 同文件同修，见第 7 章 B1）
- A4-10 apiStore — 降级链重试计时不随档位递减 → 过早放弃
- A4-11 apiStore:476 — rule 终档不可达（strategy 链 bug）
- A4-12 promptTranslator — 模板变量二次展开：LLM 输出注入 `{{...}}` 被再次解析 → 单次展开标记
- A4-13 macroExecutor:728 — 步骤引用 `{{steps.N...}}` 越界静默置空 → 显式错误
- A4-14 dualEngineValidator — V2 约束检查的是输出而非输入（方向错误）
- A4-15 domainConstraints — 单条约束异常静默吞整个法规集 → 逐条隔离
- A4-16 scheduleOptimizer — autoCompiled read_file 使用陈旧缓存（失效未联动，→P1-13）
- A4-17 （→P1-31）
- A4-19 （→P1-45）
- A4-20 factGuard — crossDoc 同型首实体 + percentage 无 NaN 防护
- A4-21 pipelineExecutor — 检查点无版本号 + 失败不清 → 版本化 + 成功即删
- A4-22 apiStore SSE — CRLF 不分帧 + `data:` 无空格丢数据（流式输出截断/粘连）
- A4-23 ruleEngine — 年份过滤吞金额实体
- A4-24 macroExecutor — create_directory/create_docx/MCP 工具参数零校验（路径校验漏洞群，与 P0-5 同批修复）
- A4-25 pipelineExecutor — dagCheckpoint 损坏时清空重建 + 无过期机制

**P3（10）**
- A4-26 pipeline 并发竞态泄漏 + parallel 语义实际串行
- A4-27 NER 瑕疵群（中文数字/百分比/区间边界）
- A4-28 KV 计费对 Anthropic 响应失效
- A4-29 unknown 错误盲重试非幂等操作（file_write 重试即重复写）
- A4-30 evaluateCondition 恒 true + replaceAll 误替换 `{{a.b}}` 变量名
- A4-31 三处早退不清理（监听器/AbortController 泄漏）
- A4-32 降级档成果被 reload 丢弃
- A4-33 抽样规则小瑕疵（样本量/阈值）
- A4-34 R12 装载语义核验 — **通过**（记录为验证项，无缺陷）

### 3.5 A5 stores

**P2（8）**
- A5-3 （→P1-10）
- A5-4 apiStore.ts:66-74 — B3 CONFIRMED+扩展：模型切换 singleton resolver 覆盖 → 首个 Promise 永久挂起（后续同 key 请求全部悬挂直至超时）→ map 存 Promise 全链共享（见第 7 章 B3）
- A5-8 dialogStore — 切换会话无守卫：确认中/执行中切走 → 状态污染 → 会话切换拦截或状态隔离
- A5-9 dialogStore — direct 模式 confirm/slotFill/pickCandidate 静默 no-op（→P1-46 同修）
- A5-10 dialogStore — fact 冲突三选项（采纳/忽略/重试）均走同一路径=装饰性 → 分别实现
- A5-11 apiStore — 经事件总线返回活引用（跨模块状态逃逸）；safeStorage 不可用时 API key **明文落盘** → 返回副本；明文回退加显式警告
- A5-12 pipelineStore — runningPipelineId 完成后不清理 → 永久楔死"已有流水线运行中" → finally 清理
- A5-13 dialogStore — 滚动摘要窗口 off-by-one（压缩存的是上一期摘要）

**P3（8）**
- A5-5 B4 残留：vault 加载完成前的早期写入有丢失竞态（B4 主缺陷已修，见第 7 章）
- A5-14 dialogStore — 每消息全量 JSON 序列化（性能写放大）
- A5-15 （→P1-41）
- A5-16 debugStore — console 猴补永不释放 + 探针文件 read-modify-write 竞态
- A5-17 多处 setInterval 无 dispose
- A5-18 deleteSession 不清 in-flight 队列 → 已删会话消息复活
- A5-19 风险暂停期消息孤立入库 + mode 未验证（→D-9 UI 影响）
- A5-20 未 await 的异步加载竞态群（与 P0-7 加载顺序相关，同批核查）

### 3.6 A6 composables / vault 客户端 / benchmark

**P2（9）**
- A6-10 updateOrbits O(n²) 且每帧分配对象 → GC 卡顿（星图节点多时掉帧）
- A6-11 rebuildNode 不 dispose 旧 geometry/material → GPU 内存泄漏
- A6-12 星图 dispose 不完整 + 无 webglcontextlost 处理 → context 丢失后黑屏
- A6-13 tractor beam 材质每次重建泄漏
- A6-14 应用退出不 flush vault 客户端队列 → 丢最后 100ms 写入（→P1-28 同修：beforeunload flush）
- A6-15 vault cache-first read 永不失效 → 外部修改永不可见（P0-7 的使能项，P0-7 修复时一并处理 TTL/版本）
- A6-16 自定义 manifest 存 localStorage 旁路 vault（数据双轨不一致）
- A6-17 benchmarkRunner 错误计数双计
- A6-18 L0 "零成本"路径未计费（→P1-40 统一记账后消除）

**P3（9）**
- A6-19 画布无环检测缺失 + animFrame 不取消 + IPC 监听不除
- A6-20 每次拾取新建 Raycaster/Vector3（微性能）
- A6-21 knowledgeBase migrate 静默返回 + 无负缓存（反复重试）
- A6-22 benchmark 标签/导出小瑕疵
- A6-23 指纹哈希仅取前 1000 字符（强度不足）
- A6-24 并行早退不清 abort（≈A4-31）
- A6-25 （XREF A5-12）
- A6-26 App.vue no-op removeEventListener（引用不同，永不移除）
- A6-27 Math.random 作种子等杂项

### 3.7 B IPC 对齐

**P2（6）**
- B-5 mcp-manager.ts:222 — mcp:status / mcp:tools 主进程推送零订阅 → MCP 连接状态 UI 永不更新 → 渲染层补 on()
- B-6 preload 六个 vault vector 通道（vectorAdd/...) 渲染层零调用 → 死子系统，接线或删除
- B-7 storeSyncToPipeline（→P1-38）、dataImportZip 单腿、RuleReview 窗口三方法（→P1-37）等五方法零调用
- B-8 env.d.ts 声明 68 vs preload 实际 82（16 方法未声明）→ TS 层零检查，按序补齐
- B-9 tests mock 漂移：10 个 vault 方法缺失 + 形状漂移 → mock 测试假绿 → 从 preload 生成 mock
- B-10 五窗口全量 preload（=A1-25，同修）

**P3（2）**
- B-11 ready 协议不对称（三子窗口手发 vs pipeline 窗 did-finish-load，→P1-35 统一时消除）
- B-12 测试 mock 替换整个 window 对象（隔离不足）

### 3.8 C 可审计性

**P2（11）**
- C-10 apiStore — stream 标志被丢弃：UI 宣称流式但 SSE/KV 路径死 → 实现或移除流式 UI
- C-11 全链路无 traceId → 无法串联一次请求的 路由→规划→执行→成本（**第 5 章给出设计**）
- C-12 审计导出包空壳（依赖 addAuditLog 零调用，→P1-42）
- C-13 funnel:shadow-diff 发射无消费者（灰度对比死）
- C-14 debugLog 生产环境 no-op（静默失败，应至少写文件）
- C-15 debugStore eventLog 仅 50 条且不持久
- C-16 proactiveScheduler 无任何调度器（零 setInterval/cron）→ 死模块
- C-17 （→P1-22）
- C-18 kernel.dispatch 死代码（→P1-40）
- C-19 宏路径绕过语义缓存与预算（→P0-10 修复方向已覆盖）
- C-20 跨窗同步覆盖不全（→P1-35/36 同批）

### 3.9 D UI/UX

**P2（13）**
- D-8 SettingsPage — 主题选择为循环切换按钮（无当前值展示，反直觉）→ 下拉
- D-9 DialogPanel — 风险暂停期输入被孤立处理（→A5-19 同修）
- D-10 CommandPalette — 向导部分输入静默丢弃（Esc/失焦即丢）→ 显式取消确认
- D-11 画布破坏性操作无确认（清空/删除与 P1-27 同批）
- D-12 L0Modal — 用 alert()、无 Esc 关闭、卸载无确认（与 P0-7 同文件）
- D-13 无边框窗最大化按钮不反映状态（最大化后图标不变）
- D-14 Ctrl+P 双处理（App 层与组件层都监听，行为不确定）
- D-15 ApiSettings — provider 删除无确认
- D-16 DebugWindow — 探针导出静默失败；终止执行无确认（→P1-45 接线后生效）
- D-17 SettingsPage — 导入 onchange 错误逃逸（未捕获 → 白屏风险）
- D-18 通知中心"清空"无确认
- D-19 ResultPreviewStage — 编辑中按 Esc 关闭整个预览（丢编辑内容，与 P1-48 同文件同批）
- D-28 跨窗同步 UI 影响（→B-2/B-4，即 P1-36/38）

**P3（8）**
- D-20 死组件（零引用 .vue）
- D-21 App.vue 约 370 行死交互代码（含 A6-26）
- D-22 alert/confirm 与自建通知系统混用（体验不一致）
- D-23 部分窗口英文标题（i18n 不一致）
- D-24 toast 单实例无堆叠 + z-index 低于模态
- D-25 无用导入群
- D-26 组件级 IPC 监听不除（内存泄漏，与 A6-19 同模式）
- D-27 benchmark 着色/导出小瑕疵

---

## 4. IPC 对齐矩阵（B 簇总结）

### 4.1 数字闭合

| 维度 | 数量 | 说明 |
|---|---|---|
| preload 暴露键 | 83 | `platform` + 82 个方法 |
| 主进程注册通道 | 80 | registerHandler（invoke）52 + on/emit 桥 28 |
| 渲染层实际使用 | 65 | 有真实调用方 |
| 零调用（暴露未用） | 17 | 修复或删除清单见 4.3 |
| 暴露但主进程未处理 | **0** | 无"渲染层可调而无人应答"通道（正面结论） |

### 4.2 通道分类

| 类别 | 模式 | 数量 | 代表 | 健康度 |
|---|---|---|---|---|
| 类 1 | 渲染层 invoke → 主进程 handler | 50 | vault:read/write、shell:exec、file:write | ✅ 基本健康（安全漏洞见 P0-1~6） |
| 类 2 | 渲染层 send / 主进程推送 → 渲染层 on | 25+6 | store:applyUpdate、mcp:status | ❌ 死链密集（P1-35/36/44、B-5） |
| 类 3 | 流式 | 1 | llm:chat-completion（stream 回调） | ⚠️ stream 标志实际被丢弃（C-10） |

### 4.3 死链清单（17 零调用 + 关键单向死链）

1. `storeSyncToPipeline`（P1-38）— 主→pipeline 推送无发送方
2. 六个 vault vector 通道（B-6）— 死子系统
3. RuleReview 窗口三方法（P1-37）— 窗口 API 零调用
4. `mcp:status` / `mcp:tools` 推送（B-5）— 零订阅
5. `dataImportZip` 单腿（B-7）等零散方法
6. `ipcRendererSend`（P1-35）— 声明未暴露，三子窗口 ready 协议死
7. 主窗 `store:applyUpdate` 零订阅（P1-36）— 子→主回传死

**修复策略**：对每条死链二选一——补齐调用方（若功能仍要）或整链删除（preload+handler+env.d.ts+mock 四处同删），禁止留半截声明。

---

## 5. 可审计能力矩阵与 traceId 设计（C 簇总结）

### 5.1 九阶段采集现状

| 阶段 | 应采集 | 现状 | 缺口 |
|---|---|---|---|
| 1 请求入口 | 用户输入、会话、时间 | dialogStore 有消息记录 | 无 requestId |
| 2 路由决策 | 命中路径、置信度、pack | funnel 有事件但 shadow-diff 死（C-13） | 无串联 ID |
| 3 规划 | DAG、工具清单、种子 | 无记录 | 规划结果不入日志 |
| 4 用户确认 | 确认内容、耗时 | confirmPlan 有（但 P0-9/P1-16 使确认不可靠） | RaaP 展示与实际不符 |
| 5 执行 | 步骤开始/结束/状态 | `debug:log-event` 零监听（P1-45） | **全丢** |
| 6 工具调用 | 工具名、参数、结果 | probeStep 双断（P1-39）、MCP 日志死（A2-3） | **全丢** |
| 7 LLM 调用 | 模型、tier、prompt 摘要 | debugLog 生产 no-op（C-14） | 无持久化 |
| 8 成本记账 | tokens、费用、缓存命中 | record-cost 零发射（P1-40） | **零记账** |
| 9 结果与审计 | 最终输出、审计事件 | addAuditLog 零调用（P1-42）、导出空壳（C-12） | **审计承诺落空** |

结论：九阶段中 **5/9 完全无数据**，且无任何跨阶段 ID 可串联——当前应用对"每一步可审计可追踪"的满足度接近零，但**管线骨架（事件名、store、导出器）大多已存在**，缺的是接线而非新建。

### 5.2 统一 traceId 设计（建议）

1. **生成**：每次用户请求入口（sendMessage / pipeline 启动）生成 `traceId = crypto.randomUUID()`，存入 dialogStore 当前会话运行态。
2. **传播**：
   - 渲染层 → 主进程：所有 invoke/emit payload 统一附加 `meta: { traceId, stepId?, callerId }`（主进程 handler 可统一读取）。
   - 跨窗口：store:applyUpdate / debug 同步事件原样携带。
   - 子进程（l2 等）：作为参数传入，输出行前缀打印。
3. **落点**：workflowLog 每条、addAuditLog 每条、record-cost 每条、debug:log-event 每条均含 traceId。
4. **消费**：调试窗按 traceId 过滤展示一次请求的完整时间线；审计导出按 traceId 分组。
5. **实施顺序**：先在 P1-39/40/42/45 四条接线修复中同步引入（每条都要动 payload 结构，一次到位避免返工）。

---

## 6. UI/UX 问题分组（D 簇 28 项归纳）

| 组 | 条目 | 主题 |
|---|---|---|
| 对话与运行面板 | D-2（P1-46）、D-9、D-19（P1-48 同文件）、A5-19 | 候选选择死亡、风险期输入孤立、编辑丢失/损坏——**对话主流程的交互闭环有三处断裂** |
| 画布 | D-4（P1-43）、D-5（P1-26）、D-11、P1-27 | 画布运行的是别的东西、按键毁图无确认无撤销——用户对画布的信任基础不成立 |
| 全局键盘与窗口 | D-3（P1-47）、D-13、D-14、D-7（P1-37） | Esc 链/快捷键冲突/无边框窗控制缺失 |
| 确认与破坏性操作 | D-12、D-15、D-16、D-18、D-11 | 五处破坏性操作无确认；与 P0-9（该确认的不确认、不该静默的静默）构成同一主题：**危险操作与确认机制的系统性错配** |
| 设置与表单 | D-8、D-10、D-17、D-25 | 静默丢弃输入、错误逃逸白屏风险 |
| 反馈一致性 | D-20~24、D-22、A2-13 | alert/通知混用、toast 层级、死组件死代码 |
| benchmark UI | D-27、A6-22 | 展示的数据本身失真（P1-32/33/34）——UI 修复前先修数据 |

---

## 7. 基线映射（对既往安全/修复基线的核验结论）

| 基线项 | 结论 | 详情 |
|---|---|---|
| **B1**（路径校验正则缺陷） | **CONFIRMED（变体）** | pathValidator.ts:96-106 pathRe 捕获组错位：`(\/|\\)` 消费分隔符，group 1 返回垃圾路径。与 P0-5（同文件 :3-21 敏感路径正则）同批修复，建议整文件重写为逐段规范化比对 |
| **B2**（三重降级链 fail 语义） | **仲裁：代码 fail-safe，TEST_REPORT 过时** | 代码实读确认降级链失败时拒绝执行而非放行；TEST_REPORT L159"降级为允许执行"表述引用的是修复前行为，文档需更新。真实决策点转为 P0-9（confirm-risk 链的 catch 是 fail-open） |
| **B3**（singleton resolver 竞态） | **CONFIRMED + 扩展** | A5-4：模型切换时 singleton resolver map 被覆盖，首个 in-flight Promise 永久挂起，后续同 key 请求全部悬挂至超时。修复：map 存 Promise 实现全链共享 |
| **B4**（vault 加载竞态） | **FIXED（残留 P3）** | 主缺陷（启动窗口丢更新）已修；残留 A5-5 加载完成前早期写入竞态，低风险 |
| **kernel-core 4 缺陷** | **HEAD 存在 / 工作区已修** | security.ts require 崩溃、cache.ts tokenUsage 错位、fact.ts correctedOutput 错位、index.ts ModelTier 断裂——A2 重审确认工作区四个修复全部落地，**未提交，建议尽快 commit 固化** |
| **VULN-16** | 已在 P0 清单覆盖 | 对应 P0-3（SSRF 五类绕过） |
| **extract-zip 符号链接穿越** | 运行时路径已缓解 | 但 P1-1（restore 无校验）重新打开攻击面，二者同批修 |
| **17.B1**（electron devDep） | CONFIRMED（低风险） | 打包器自带 electron，运行不受影响；依赖表与文档不一致（A1-32） |
| **C1**（shell 元字符） | 对应 P0-1 | 未修复，维持 P0 |

---

## 8. 修复批次建议（G1 决策门输入）

原则：每批独立可验证（`npm test` 1526 基线 + typecheck + build），批内高内聚、批间低耦合，先堵安全再通功能。

| 批次 | 内容 | 条目 | 理由 |
|---|---|---|---|
| **R1 主进程安全** | shell 元字符/黑名单绕过、SSRF、路径校验整文件重写（含 B1）、file:write 校验、backup:restore 校验、MCP 参数约束 | P0-1~6、P1-1/3/7/8、A4-9/24 | 全部在主进程边界，互不依赖渲染层，可先行 |
| **R2 数据安全** | 冷启动加载顺序 + vault 队列/写序/flush/退出、迁移标志、引用注入覆盖 | P0-7、P1-4/28/29（+A6-14）、P0-8 | 用户数据不丢不坏，且为后续批次提供稳定基座 |
| **R3 确认与执行链** | confirm-risk fail-closed + 弹窗、llm 死频道、mcp:call-tool 契约、RaaP manifest、MCP toolCalls 执行、自动 npm install 确认 | P0-9、P0-10、P1-11/16/23/25、P1-24 | 恢复"用户同意"与"宏真正能跑"，二者共同构成执行闭环 |
| **R4 可观测性** | 四条审计接线 + traceId 引入 | P1-39~45、C-11、A2-3 | **建议紧随 R3**：R3 打通的执行链若无观测则无法验收 |
| **R5 路由链正确性** | 伪向量、pack 失效、脏传播、副作用集、工具名词表、意图缓存、双引擎覆盖 | P1-12~15/17/18/19 | 功能正确性主体 |
| **R6 UI 闭环** | 候选选择、Esc 链、块编辑、画布运行/守卫、RuleReview 窗口、跨窗同步 | P1-35~38/46/47/48/26/27 | 用户可见断裂集中修复 |
| **R7 清理与降险** | 死链删除、死代码清理、benchmark 隔离、明文 key 警告、B3/B4 残留 | P1-33/34、A5-4/11、B-5~9、D-20/21 等 | 低风险收尾 |

P2/P3 其余项按簇随对应批次顺带处理（如 A4-9/24 随 R1，A6-14/15 随 R2）。

---

## 9. 覆盖面与方法附录

- **范围**：electron/（main、ipc、security、vault）、src/（kernel、domains、stores、services、composables、views）、ipc 契约（preload、env.d.ts、mock）、测试基线
- **方法**：九个独立审计簇（A1 主进程安全、A2 内核/领域、A3 路由链、A4 执行与安全、A5 stores、A6 composables/vault/benchmark、B IPC 对齐、C 可审计性、D UI/UX）；主代理对全部 10 项 P0 与 5 项 P1 抽样做源码级复核（11/11 确认）
- **基线核验**：B1~B4、kernel-core、VULN-16、extract-zip、17.B1、C1（见第 7 章）
- **测试基线**：`npm test` 1526/1526 通过（注意 TEST_REPORT.md 记载的 1129 为过时数字）；typecheck/build 均绿
- **限制**：动态行为以代码静态推理为主，未做 fuzz/渗透；UI 项未做可用性测试，以桌面应用常规惯例为基准
- **工作底稿**：`%TEMP%\deveco\audit\{A1..D}-findings.md`（每条含完整证据与修复建议，本报告为去重汇总）
