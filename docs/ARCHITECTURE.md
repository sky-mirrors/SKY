# HoloStarmap 架构分析报告

> **项目**:HoloStarmap v0.1.0(全息星图集成工具控制台)
> **作者**:sky-mirrors | **许可**:Apache-2.0 | **平台**:Windows(Electron 桌面应用)
> **报告基线**:293 个源码/配置/文档文件,合计 70,863 行(其中 `src/` 41,011 行),统计不含 node_modules/dist/out/coverage/.git/.idea、package-lock.json 与二进制图标。
> **阅读方法**:架构关键路径(electron/、kernel/、domains/、入口文件、data/topology、benchmark)由本报告逐一精读原文;services(41 文件)、stores(15)+composables(2)、components(31+App.vue)、test(86 文件)与 config/l2_manifests(20)通过并行子任务全量阅读后汇总,关键数字均回溯源码核实。完整覆盖表见附录 B。

---

## 目录

1. [项目定位与设计愿景](#1-项目定位与设计愿景)
2. [技术栈与工程配置总览](#2-技术栈与工程配置总览)
3. [进程与窗口模型](#3-进程与窗口模型)
4. [微内核架构解析](#4-微内核架构解析)
5. [领域层与事件总线](#5-领域层与事件总线)
6. [服务层全景](#6-服务层全景)
7. [状态管理层](#7-状态管理层)
8. [UI 层:组件与可视化](#8-ui-层组件与可视化)
9. [数据与配置层](#9-数据与配置层)
10. [持久化与 Vault](#10-持久化与-vault)
11. [安全模型](#11-安全模型)
12. [Token 成本优化体系](#12-token-成本优化体系)
13. [测试体系](#13-测试体系)
14. [构建与发布链路](#14-构建与发布链路)
15. [端到端数据流](#15-端到端数据流)
16. [设计模式与技术亮点](#16-设计模式与技术亮点)
17. [技术债、风险与改进建议](#17-技术债风险与改进建议)
18. [附录](#18-附录)

---

## 1. 项目定位与设计愿景

### 1.1 一句话定位

HoloStarmap 是一个**本地优先(local-first)的桌面 AI 工具操作系统**:它把"调用 LLM"这件事工程化为一个由微内核、事件总线、分层路由、多重缓存与安全审计组成的完整体系,再用一张 125 节点的 3D 星图作为统一交互界面,目标是让非技术岗位(财务/HR/销售/法务/通用办公)的用户以最低成本、最高安全边界使用 AI 工具。

设计文档把这一理念称为 **RaaP(Robot-as-a-Product,机器人即产品)**(`集成工具设计.txt`、`L2工具编译标准V1.0.md`):AI 不应以"聊天窗口"形态交付,而应以"产品化的工具节点"形态交付——每个工具有确定性身份(identity)、确定性视觉(visual)、确定性路由(routing)与确定性执行(execution)。

### 1.2 星图隐喻与四层节点体系

整个 UI 与信息架构建立在天体物理隐喻上(`README.md`、`src/data/topology.ts`):

| 层级 | 天体隐喻 | 数量 | 实际含义 |
|---|---|---|---|
| L0 | 用户本体(恒星核心) | 1 | 用户输入的统一入口(`l0-user-core`) |
| L1 | 行星(6 颗,锁定轨道) | 6 | 基础能力节点:知识库投喂员、模型网关(L0.5 基建)、任务翻译官、流水线搭建台(编排者)、工作区记忆体、结果美化师 |
| L2 | 卫星(锚定行星停转) | 20 | 岗位工具胶囊:合同风险审查、周报自动草稿、财报一句话解读等,对应 20 个声明式 manifest |
| L3 | 社区星尘(外层球面) | 98 | 社区自动推荐工具占位节点(斐波那契球面分布,热度随机模拟) |

合计 125 节点——这也是 package.json `description` 中"125 节点太空拓扑交互界面"的出处。值得注意的是,设计文档中 L2 卫星"锚定行星停转"的隐喻(`ringStyle: solid`)在代码中**并无对应实现**:3D 层 L1 行星默认 `orbitRadOscAmp=0`(稳定球面轨道),L2 卫星反而带 0.03–0.07 的随机轨道振荡;代码中唯一叫"锚定"的是 L3 专属动作 `nodeStore.anchorL3Node()`(冻结 7 天内将坍缩节点的衰减)。文档隐喻与实现语义错位(见第 8 章)。

### 1.3 三个一等公民目标

贯穿全部代码的三个设计优先级(依据:`README.md`、`SECURITY.md`、`L2工具编译标准V1.0.md` 及各服务实现):

1. **Token 成本最小化**:五级拦截漏斗(L0 规则 → L0.5 关键词 → L1 直调 → RaaP 混合检索 → LLM 规划)+ 语义缓存 + 执行指纹缓存 + KV 缓存观测 + 零 Token 学习,形成"能不调 LLM 就不调"的完整体系(第 12 章专述)。
2. **安全边界**:主进程白名单(shell/路径/HTTP/MCP)+ 渲染进程双引擎审计 + 三层事实守卫 + 法规约束库,所有高危动作执行前可拦截、执行后可校验(第 11 章专述)。
3. **本地优先**:所有数据(配置/会话/知识向量/记忆)默认存于本机 SQLite Vault + safeStorage 加密;嵌入模型(`all-MiniLM-L6-v2`)经 transformers.js 本地推理,离线时降级为哈希-正弦伪向量,功能不中断。

### 1.4 产品形态

- 单实例桌面应用,5 个窗口:主窗口(星图+对话)、流水线工作台、调试监视器、Token 优化压测台、规则审核台(第 3 章)。
- 面向 5 种职业角色(`JobRole`):`finance` / `hr` / `sales` / `legal` / `general`,角色影响工具推荐加权(×1.3/×1.5)与路由域偏置(legal +1、hr −1)。
- 内置 21 个可安装技能(绑定 MCP 服务器)、20 个官方 L2 工具胶囊、5 个官方 MCP 目录项;支持用户自定义 manifest(localStorage 持久化)。

---

## 2. 技术栈与工程配置总览

### 2.1 依赖清单(package.json,v0.1.0)

**运行时依赖(15 个)**:

| 依赖 | 版本 | 用途 |
|---|---|---|
| electron 工具链 | @electron-toolkit/utils ^4.0.0 | 主进程工具 |
| vue | ^3.5.0 | 渲染层 UI 框架 |
| pinia | ^2.2.0 | 状态管理(15 个 store) |
| three | ^0.170.0 | 3D 星图 |
| @xenova/transformers | ^2.17.2 | 本地嵌入模型(MiniLM-L6-v2, 384 维) |
| better-sqlite3 | ^13.0.3 | Vault 持久化(WAL 模式) |
| docx / mammoth / pdf-parse / xlsx | 9.7.1 / 1.12.1 / 2.4.5 / 0.18.5 | Office/PDF 文档读写 |
| archiver / extract-zip | 7.0.0 / 2.0.1 | 备份 zip 打包/恢复 |
| dompurify | ^3.4.14 | HTML 净化 |
| marked | ^18.0.9 | Markdown 渲染 |
| iconv-lite / jschardet | 0.7.3 / 3.1.4 | 编码检测与转换(中文文件兼容) |

**开发依赖(7 个)**:electron-vite ^5.0.0、@vitejs/plugin-vue ^6.0.8、vitest ^3.0.0 + @vitest/coverage-v8 ^3.0.0、@electron/rebuild ^4.2.0、tsx ^4.23.12、axios ^1.7.0。

> **工程异常(值得注意)**:`package.json` 的 dependencies/devDependencies 中**均无 `electron` 与 `electron-builder`**,但存在 electron-builder 的 `build` 配置段(`asar: false`、`win.target: portable`、`afterPack: ./build-after-pack.js`)。这意味着构建/打包依赖环境全局安装的 electron 与 electron-builder,克隆仓库后 `npm install` 并不能开箱即跑。`SECURITY.md` 提到 "electron 33.4.0" 的已知漏洞,说明实际环境用的是全局 33.4.0。

### 2.2 npm scripts

```
dev             electron-vite dev
build           electron-vite build
preview         electron-vite preview
test            vitest run          # 实际运行 61 个 spec(e2e 被排除)
test:watch      vitest
test:coverage   vitest run --coverage
postinstall     electron-vite postinstall
```

注意:**没有独立的 typecheck/lint script**,类型检查依赖编辑器/构建时的 TS 编译;`CONTRIBUTING.md` 的代码标准(禁 any/as、文件 kebab-case、composable 用 use 前缀)靠 PR 模板 checklist 人工约束。

### 2.3 TypeScript 配置

- `tsconfig.json`(20 行):`strict: true`、target ES2020、`isolatedModules`、路径别名 `@/* → ./src/*`,覆盖 `src/` 与 `electron/`。
- `tsconfig.node.json`(22 行):主进程专用(composite、declaration),include 仅 `electron/**/*.ts`,声明输出到 `./out/main`。

### 2.4 构建配置

- `electron.vite.config.ts`(49 行):标准三段式(main/preload/renderer);renderer 定义 **5 个入口**:`index`(主窗口)、`pipeline`、`debug`、`benchmark`、`rule-review`,分别对应根目录 5 个 HTML。
- `vitest.config.ts`(28 行):`environment: 'node'`、`globals: true`、include `test/**/*.spec.ts`、**exclude `test/e2e/**`**;coverage 仅统计 `src/services/**` 与 `src/stores/**`,perFile 阈值 lines/functions/statements 40%、branches 30%;别名 `@ → src`、`@electron → electron`(后者使 `test/ipcSecurity.spec.ts` 能直接测主进程安全模块)。
- `build-after-pack.js`(33 行):electron-builder afterPack 钩子,打包后把整个 `node_modules` 复制进 `resources/app`——与 `asar: false` + `win portable` 配套的"免 asar 全量复制"方案,产物体积大但保证 better-sqlite3 等 native 模块可加载。

### 2.5 许可与合规文件

- `LICENSE`(198 行):Apache License 2.0 全文。
- `NOTICE`(21 行):Copyright 2026 sky-mirrors + 第三方许可清单(Vue/Pinia/Three/Electron MIT、transformers.js Apache-2.0、DOMPurify Apache-2.0 OR BSD-3-Clause 等 11 项)。
- `package.json` `license: "Apache-2.0"`。
- ⚠️ `quality-report.json` 中却记载 `"license": "MIT (confirmed in package.json)"`——**与事实不符**,见第 17 章文档失真清单。

---

## 3. 进程与窗口模型

### 3.1 主进程入口(electron/main.ts,173 行)

启动序列:`requestSingleInstanceLock`(单实例)→ `app.whenReady` → 初始化 Vault(`initVault`,better-sqlite3)→ 执行 localStorage→Vault 迁移(`migrateVault`)→ 创建主窗口 → 注册 IPC 处理器。第二个实例启动时聚焦已有主窗口。`will-quit` 时关闭 Vault 连接。

### 3.2 五窗口矩阵(electron/window-manager.ts,277 行)

| 窗口 | 尺寸 | 标题 | 入口 |
|---|---|---|---|
| 主窗口 | 1280×800 | — (frameless) | `index.html` |
| 流水线工作台 | 1200×800 | HoloStarmap - 流水线工作台 | `pipeline.html` |
| 调试监视器 | 800×400 | HoloStarmap - 调试监视器 | `debug.html` |
| Token 优化压测台 | 1000×700 | HoloStarmap - Token优化压测台 | `benchmark.html` |
| 规则审核 | 1200×800 | HoloStarmap - 规则审核 | `rule-review.html` |

全部 5 个窗口 **frameless**(标题栏由渲染层 App.vue/页面组件自绘)。统一 `webPreferences`:`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`(主窗口入口为 `out/renderer/index.html`,辅助窗口同理)。

### 3.3 preload 桥(electron/preload.ts,283 行 + types.d.ts 54 行)

`contextBridge.exposeInMainWorld('electronAPI', {...})` 暴露约 **68 个 IPC 方法**,按功能分组:

- 窗口控制(minimize/maximize/close)与 4 个辅助窗口 open/close/最小化到主窗口
- LLM:`llmChatCompletion` / `llmChatCompletionStream` / `llmListModels`
- Shell:`shellExec`(带超时);文件:`fileWrite/fileRead/createDirectory/createDocx/resolvePath`
- KV 存储:`storeRead/storeWrite/storeDelete`;二进制向量:`vectorWriteBin/vectorReadBin/vectorListKeys`
- Vault 六件套:`vaultRead/Write/Delete/List` + `vaultReadVector/WriteVector/DeleteVector/ListVectors` + `vaultMigrate/vaultGetStats`
- 安全:`safeStorageEncrypt/safeStorageDecrypt`
- MCP:`mcpSpawn/mcpStop/mcpListTools/mcpCallTool/mcpStatus` + 事件订阅
- 备份:`backupCreate/backupRestore`;数据:`dataExportZip/dataImportZip`
- 文件监视:`watchfsSetDir/watchfsGetDir/onWatchfsChanged`
- 知识库:`knowledgeIngest/knowledgeSearch`
- **跨窗口状态同步**:`storeSyncToMain` / `storeSyncToPipeline` / `storeSyncToDebug` / `onStoreApplyUpdate`(三向同步的核心,见 3.4)
- 调试/压测/规则审核窗口专用通道(`debug:*`、`benchmark:*`、`rule-review:*`)与 `onIpcMessage` 通用事件

主进程侧由 `ipc-handlers.ts`(1252 行,全部 IPC handler 的宿主)与 `mcp-manager.ts`(226 行,stdio MCP 子进程管理)承接。

### 3.4 渲染层入口与跨窗口状态同步

`src/` 下 5 个入口:`main.ts`(主窗口)+ `benchmark-main.ts` / `debug-main.ts` / `pipeline-main.ts` / `rule-review-main.ts`(各 32–51 行,结构高度一致):

1. `createApp(页面组件)` + Pinia;
2. 安装 Pinia 插件:订阅每个 store 的 `$subscribe`,把变更的 state 快照经 `storeSyncToMain` 发往主进程——**主窗口/benchmark/debug/rule-review 三个入口带 100ms 防抖与 pendingSyncs 合并**(同一 store 的多次变更只发最后一份),`pipeline-main.ts` 是唯一不带防抖的入口;
3. 注册 `onStoreApplyUpdate` 回调:接收主进程分发的其他窗口状态,按目标 store 已有 key 过滤后 `$patch`;
4. 挂载后发送 `xxx:ready` 信号(`debug:ready` / `benchmark:ready` / `rule-review:ready`)。

主进程(`ipc-handlers.ts`)作为中继:把某窗口的 store 快照转发给其他窗口(`storeSyncToPipeline/Debug`),实现"调试监视器实时显示主窗口 store 状态"的观测能力。这是该项目跨窗口通信的唯一机制——**没有用 BroadcastChannel,也没有窗口间直连 IPC**。

### 3.5 进程边界与信任模型

```
┌────────────────────────── Electron 主进程(受信)──────────────────────────┐
│  main.ts → window-manager → ipc-handlers(1252 行)                        │
│  ├─ shell-security.ts(命令白名单/黑名单/超时)   ← 所有 shell/http 的唯一出口 │
│  ├─ pathValidator.ts(路径白名单)                                          │
│  ├─ vault.ts(SQLite + safeStorage)                                        │
│  └─ mcp-manager.ts(stdio 子进程)                                         │
└──────────────▲──────────────────────────────▲───────────────────────────┘
               │ contextBridge(68 方法)       │
┌──────────────┴──────────┐  ┌───────────────┴────────────────────────────┐
│ 主窗口渲染进程(不受信)  │  │ 辅助窗口 ×4(同构渲染进程)                  │
│ App.vue + 31 组件        │  │ PipelinePage/DebugWindowPage/…             │
│ 15 Pinia stores          │  │ 各自的 Pinia(经主进程中继同步)             │
│ kernel + 41 services     │  └────────────────────────────────────────────┘
└─────────────────────────┘
```

所有危险能力(shell/文件写/http/MCP)都被隔离在主进程并由白名单约束;渲染进程拿到的 `electronAPI` 不含任何"绕过校验"的通道。渲染进程内部的二次防线(双引擎审计/FactGuard)是纵深防御,而非唯一屏障(第 11 章)。

---

## 4. 微内核架构解析

### 4.1 总览

`src/kernel/`(12 文件,共 1,126 行)实现了一个教科书式的微内核:内核本体只做**编排**,具体能力以"cluster(能力簇)→ service(实现)"与"port(端口)→ facade(适配器)"两种方式外挂:

```
kernel/
├── index.ts      (276) 内核工厂 createKernel + dispatch 主流程
├── types.ts      (258) 全部端口与数据契约(KernelContext/KernelResult/LLMPort/IOPort…)
├── bus.ts        (143) HoloEventBus + globalBus 单例
├── context.ts    (25)  createReadOnlyContext(Object.freeze 只读快照)
├── clusters/           五个能力簇(纯委托层)
│   ├── route.ts    (86)  → smartRouter / l0SkillRouter / tokenEstimate / tokenBudget
│   ├── cache.ts    (51)  → semanticCache
│   ├── security.ts (46)  → dualEngineValidator
│   ├── budget.ts   (41)  → tokenBudget / tokenPricing
│   └── fact.ts     (39)  → factGuard / nerExtractor / crossDocValidator
├── facades/            两个端口适配器
│   ├── persistence.ts (39) localStorage 持久化端口 + 命名空间装饰器
│   └── io.ts         (100) electronAPI 桥接的 IOPort(31 个方法)
└── plugins/
    └── llm.ts        (22) LLM 插件注册表(registerLLM/getLLM 单例)
```

值得注意的取舍:**kernel 不管理领域状态**。`dispatch()` 是无状态函数——上下文(`KernelContext`)由调用方传入,内核把 persistence/io 注入 effectiveContext 后逐簇调用。`kernel/index.ts` 尾部还 re-export 了 smartRouter/ZOL/tokenBudget/semanticCache 的初始化函数,充当这些全局服务的聚合出口(也造成 kernel → services 的反向依赖,见 17 章)。

### 4.2 dispatch 主流程(kernel/index.ts:46-243)

一次 `kernel.dispatch(input, options, context)` 的完整决策链:

```
1. 语义缓存查询(stream 模式跳过)
   └─ 命中 → 直接返回 {fromCache:true, tier, costRecord.cost:0}
2. 路由决策 routeCluster.route → smartRouter(复杂度评分 + ZOL 自适应阈值 + 域偏置)
3. 预算检查 budgetCluster.check(tokenBudget:三周期/白名单/超支策略)
   └─ 不允许 → 返回 budget-exceeded 错误
4. 安全校验 securityCluster.check(仅当 !skipSecurity && 未传 messages)
   └─ 不安全 → 返回 security-blocked 错误
5. LLM 调用(仅当 !routeOnly && options.messages)
   ├─ stream:chatCompletionStream → 返回 AsyncIterable
   └─ 非流式:chatCompletion → 写语义缓存 → 记账(budgetCluster.record)
6. 事实校验(仅当 !skipFactCheck && manifestRoles && responseText)
   └─ factCluster.check:实体抽取 → FactGuard V2 三层校验
7. 返回 KernelResult(routingDecision/budgetCheck/securityResult/factResult/costRecord 全量带回)
```

该流程把"**缓存 → 路由 → 预算 → 安全 → 生成 → 校验**"六个关注点按固定顺序串联,每一步的中间结果都随 `KernelResult` 返回,供调用方(macroExecutor/apiStore)做 UI 呈现与血缘追踪。

### 4.3 事件总线 bus.ts(143 行)

`HoloEventBus` 提供三套原语:

1. **request/response**:`registerHandler(channel, fn)` + `request/requestAsync(channel, payload)`——单 handler 通道,重复注册会 console.warn 并覆盖。这是领域间同步调用的主通道。
2. **pub/sub**:`on(channel, fn)` 返回取消函数,`emit` 遍历 Set 并捕获异常——多播事件。
3. **流式**:`registerStreamHandler` + `requestStream` 返回 `StreamHandle`(on('chunk'|'done'|'error') + cancel),供 SSE 流跨模块透传。

`globalBus` 是全局单例;`clear()` 供测试隔离使用。通道命名约定 `域:动作`(如 `api:chat-completion`、`debug:log-probe`)。

### 4.4 端口与插件(types.ts)

- **LLMPort**(3 方法):`chatCompletion` / `chatCompletionStream` / `listModels`——由 `plugins/llm.ts` 注册表持有,未注册时 `getLLM()` 抛错(fail-fast)。实际实现由 apiStore 在启动时注入。
- **PersistencePort**(4 方法):get/set/delete/keys;默认实现 `localStoragePersistence`,可经 `createNamespacedPersistence(prefix)` 装饰出命名空间视图。
- **IOPort**(31 方法):store/vector/shell/file/docx/http/mcp/llm/safeStorage/dialog/backup/knowledge/watchfs/platform 全量能力,由 `facades/io.ts` 逐方法转发到 `window.electronAPI`(可选链 + 默认值,electronAPI 缺失时不崩)。

### 4.5 只读上下文 context.ts(25 行)

`createReadOnlyContext(result)` 用双层 `Object.freeze` 把 KernelResult 的各决策字段冻结成 `ReadOnlyKernelContext`,防止下游篡改路由/安全/事实结论——一个 25 行却体现"不可变传播"设计意识的小文件。

---

## 5. 领域层与事件总线

### 5.1 结构:12 个领域 = 门面 + 处理器

`src/domains/` 下 12 个子目录,每个域固定两个文件:

- `index.ts`(2–11 行):**门面(facade)**,re-export 该域对外的 store、service 与类型——外部代码应从 `@/domains/xxx` 导入,而非深挖具体路径;
- `handlers.ts`(12–43 行):**总线处理器注册**,把 `域:动作` 通道绑定到 store 方法。

| 领域 | index.ts 门面导出 | handlers.ts 注册的通道 |
|---|---|---|
| api | useApiStore + 7 个类型 | `api:chat-completion`、`api:chat-completion-stream`、`api:detect-domain`、`api:is-ready`、`api:list-models`(5) |
| app | session/notification/skill/rule/workflowLog 五个 store + commandPaletteSearch | `session:get-active`、`notification:add`、`skill:list`(3) |
| config | useConfigStore + 类型 | `config:get`、`config:set`、`config:get-terminology`(3) |
| data | dataExporter/dataImporter/storageMonitor + 类型 | `data:storage-breakdown`、`data:storage-total`、`data:export`(3) |
| debug | useDebugStore + debugLog + 类型 | `debug:log-probe`、`debug:record-cost`(2) |
| dialog | useDialogStore + resultBeautifier 三函数 + 类型 | `dialog:confirm-risk`、`dialog:set-mode`(2) |
| feedback | useFeedbackStore + computeQueryFingerprint + 类型 | `feedback:get-weight`、`feedback:get-weights`、`feedback:record-outcome`(3) |
| knowledge | useKnowledgeStore + knowledgeBase 五函数 | `knowledge:get-entries`、`knowledge:get-groups`(2) |
| mcp | useMcpStore + 5 个类型 | `mcp:list-tools`、`mcp:call-tool`、`mcp:get-connections`(3) |
| memory | useMemoryStore + 类型 | `memory:get-recent`、`memory:add-mcp-log`(2) |
| node | useNodeStore + toolRetrieval/fileContext 函数 + 类型 | `node:get-nodes`、`node:select-node`、`node:get-context`、`node:get-roles`(4) |
| pipeline | usePipelineStore + pipelineExecutor + dagCheckpoint | `pipeline:list`、`pipeline:start`(2) |

合计 **34 个 request/response 通道**,全部在 `App.vue` 启动时统一注册(`App.vue:722-734`:createKernel 后依次调用 12 个 `registerXxxHandlers(globalBus)`)。

### 5.2 领域层之外的"第二通道集"

domain handlers 只是总线流量的一部分。stores 与 services 之间还有一组**自行注册/请求**的通道(注册点分散在 store 内部与服务内部):

- `node:set-l1-status`、`node:set-dag-chain`——dialogStore 执行过程中共 emit 47 处,**但全仓库无任何订阅者**:nodeStore 未注册监听,其可视化状态机(`setL1Status`/`setDAGChain`)也无直接调用方——本意驱动 3D 视觉的这两条通道实际是"发进虚空"的死接线(完整分析见 8.6 与 17.C11);
- `api:chat-completion`——apiStore/LLM 调用路径 emit,debugStore 订阅以自动记账;
- `debug:register-abort`——pipelineExecutor/macroExecutor 注册全局 AbortController,调试面板可一键中止;
- `dialog:get-paused-state`、`dialog:request-takeover`——macroExecutor 每 500ms 轮询暂停态、请求人工接管某步;
- `knowledge:get-group`——knowledgeBase 检索时请求共享分组;
- `feedback:get-weight` / `feedback:record-outcome` / `feedback:add-side-effect`——toolRetrieval 调权重、macroExecutor 记副作用;
- `config:get` / `config:set-*`——onboardingManager、commandPaletteSearch 等服务零状态地读写配置(经总线而非直接 import store)。

这套"**服务不 import store,只发事件**"的纪律是该项目解耦的核心:41 个 services 中仅 memory.ts/memoryFacade 与少数动态 import 例外(见 7.3 与 17 章)。

### 5.3 一个值得注意的疑点

`domains/dialog/handlers.ts:5-8` 的 `dialog:confirm-risk` 处理器仅**返回** `store.awaitingRiskConfirm` 标志位,并未挂起等待用户确认;而 `macroExecutor` 在双引擎判定 high 风险时以该通道请求确认。真正的"暂停等人"由 `dialog:get-paused-state` 轮询机制承担(7 暂停点状态机,见 13 章 chaos 测试),`dialog:confirm-risk` 更像一个查询接口而非阻塞原语——命名与语义存在错位,详见 17 章。

---

## 6. 服务层全景

`src/services/` 共 **41 个模块,12,552 行**,是全项目逻辑密度最高的一层。按功能分为八组:

### 6.1 分组总表

| 组 | 模块(行数) |
|---|---|
| **A. 路由与直通**(五级漏斗前三级) | l0SkillRouter(544)、smartRouter(400)、strategySelector(231)、mabOptimizer(11)、proactiveScheduler(43) |
| **B. Token 经济** | tokenBudget(355)、tokenEstimate(39)、tokenPricing(95)、zeroTokenLearning(191) |
| **C. 缓存** | semanticCache(554)、scheduleOptimizer(392,含执行指纹缓存) |
| **D. 检索与匹配**(RaaP) | toolRetrieval(833)、embedder(93)、vectorStore(158)、terminologyMap(34)、fileContext(106) |
| **E. 规划与执行** | promptTranslator(474)、pipelineExecutor(364)、macroExecutor(1061)、dagCheckpoint(88)、ruleEngine(114) |
| **F. 安全与事实** | dualEngineValidator(234)、factGuard(246)、nerExtractor(344)、domainConstraints(3356)、constraintFeedback(118)、crossDocValidator(170) |
| **G. 知识与记忆** | knowledgeBase(409)、convMemory(127)、memory(46) |
| **H. 支撑** | sseParser(175)、debugLog(7)、hash(8)、secureStore(54)、storageMonitor(132)、errorClassifier(133)、onboardingManager(48)、resultBeautifier(325)、commandPaletteSearch(135)、dataImporter(23)、dataExporter(282) |

### 6.2 五级成本拦截漏斗(组 A/D/E 协作)

请求从"免费"到"最贵"依次尝试,每级都试图用更便宜的机制拦截:

```
L0   l0SkillRouter.tryL0Skill        8 条正则技能规则(格式转换/快速Shell/文本生成/HTTP/文件/文件夹/查询/文件操作)
     └─ 文件名提取四级瀑布:命名正则 → "关于X的文档" → 文件名.扩展名 → LLM 兜底判定(maxTokens=32)
L0.5 tryL05QuickMatch                关键词命中率(hitRatio≥0.4 且 margin≥0.1 才计分)+ 置信度门槛 0.8;
     └─ 仅 direct 模式或 DAG 单步允许直通,多步一律交回 RaaP
L1   checkL1Capability               模型网关/知识检索两个 L1 节点判定,置信度门槛 0.6(封顶 0.9)
RaaP toolRetrieval.universalMatch    中文分词 + n-gram 关键词打分 ∥ 向量余弦 → RRF(k=60)融合 → 动态分位数阈值门控
     └─ 否定词 ×0.3 / 总线反馈 ±0.5 / 文件上下文 boost / 角色加成 ×1.3 四重调分
LLM  promptTranslator.planTask       few-shot 案例库 + 思维链提示词,DAG 规划(maxTokens=768,≤5 步)
```

路由侧(smartRouter)叠加:复杂度四维评分(长度/约束/DAG 步数/历史 token)→ tier 映射(nano/mini/standard/pro → 512/1024/4096/8192 maxTokens)→ manifest 上限 → 预算封顶;9 个阈值全部交给 ZeroTokenLearner 自适应(成功率 <0.70 收紧 ×1.05、>0.95 放宽 ×0.95,±30% clamp),**自适应本身零 token 消耗**——这是项目最具辨识度的自研模式。

### 6.3 多层缓存矩阵(组 B/C)

| 缓存 | 机制 | 容量/TTL | 失效策略 |
|---|---|---|---|
| 语义缓存 semanticCache | 精确 textHash → 向量余弦两级查询;MurmurHash3 + 手写 LRU 双向链表 | 500 条 / 24h | 相似度阈值自适应(0.80–0.95,50 次窗口每 20 次调整);按域/约束失效 |
| 执行指纹缓存 scheduleOptimizer | manifestId+输入指纹定位;逐步输出哈希(前 1000 字符)找脏步骤,脏依赖传播 | 50 个指纹 | shell_exec 等副作用步骤强制不复用;成功 ≥10 次且命中率 ≥0.8 晋升 autoCompiled |
| 路由缓存 toolRetrieval | query+indexHash 为键 | 100 条 / 30min | 索引指纹变化即整体失效 |
| 验证缓存 scheduleOptimizer | 双引擎审核结果(skill_id+target+operation) | 500 条 / 24h | 超限删最旧 50 |
| 消歧缓存 promptTranslator | LLM 选编号结果 | 1h TTL | — |
| KV 缓存观测 sseParser | 解析 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` 两代字段 | 服务端侧 | DeepSeek 定价 ¥0.02/M(未缓存 ¥1/M) |

配套经济系统:tokenBudget 三周期(session 内存累加 / daily / monthly 从 costRecords 过滤)+ 三模式白名单(zero 仅 nano、economy +mini、standard 全开)+ 超支三策略(block/warn/degrade)+ 告警梯度(95% critical);tokenPricing 内置四档价目(输入 ¥0.0005–0.0175/1k)并支持用户自定义单价与缓存折扣。

### 6.4 双执行体系(组 E)

- **pipelineExecutor(L1 轻量流水线,364 行)**:6 个内置 handler(知识检索/模型网关 60s 超时/任务翻译/工作区记忆/结果美化/流水线构建)+ Kahn 拓扑 + localStorage 检查点(`holo-pipeline-checkpoints`)续跑 + 全局中止。定位:"把任务串起来"。
- **macroExecutor(L2 宏引擎,1061 行)**:8 类内置工具(file_write/create_directory/create_docx/shell_exec/read_file 上限 200KB/http_request/llm_generate/knowledge_search)+ MCP 动态工具(`mcpId___toolName`);四级降级链 pro→standard→mini→nano→rule(每档独立超时 60/30/15/8s,最多 4 次);执行编排:参数解析(插槽+模板变量 `{{step_N_result}}`)→ 规则引擎优先 → 双引擎审计 → 工具执行 → FactGuard V2 → 错误分类自愈(npm 缺依赖校验包名后自动安装重试);**11 种血缘来源**(llm_pro/llm_standard/llm_mini/llm_nano/rule_engine/cache_reuse/auto_compiled/skipped/tool_call/fallback/replay_reuse)量化节省 token。定位:"把任务安全、省钱、可恢复地执行完"。
- **dagCheckpoint(88 行)** 专职 macroExecutor:确定性检查点 ID(manifestId+输入三要素 31 位 hash)→ 20 条 LRU / 24h 过期 / 断点续跑。
- **ruleEngine(114 行)** 是 macroExecutor 的"零 LLM 对立面":9 种条件操作符 + 优先级规则 + 模板输出,数字提取自动过滤 1900–2099 年份干扰。

### 6.5 事实校验链(组 F)

`nerExtractor`(9 类实体正则,中文数字亿/万分段解析,法条"条第款项"结构化)是底座,之上三层:

1. **factGuard V2(L1 实体比对)**:金额容差 0.01/0.1%、日期 ±1 天、百分比 0.1,编号类精确匹配;minor 自动修正(correctedText)、critical 抛错;幻觉实体记日志;仅 finance/legal/hr 角色触发。
2. **domainConstraints(L2 法规约束)**:**55 条中国法规规则**(法律 50 + 财务 5,3356 行,项目最长文件),每条含法条三级溯源 + ≥2 回归用例 + automationLevel;法定数字硬编码(试用期 1/2/6 月、月加班 36h、违约金 30%、产假 98 天、个税 3–45%…)。规则生命周期自治理:full+auto 过测→active;误报 >30% →deprecated、>20% →confidence 降级;testing 触发 ≥5 次且误报 <20% →自动转正。
3. **crossDocValidator(L3 跨文档)**:O(n²) 文档两两实体比对,冲突转统一 ConstraintResult,汇入 constraintFeedback 滑动窗口(100 条,样本 ≥10 才评估)。

而 **dualEngineValidator** 管"事前":本地规则引擎(10 条危险路径 + 7 条危险 URL 正则,命中直接 high 短路)∥ LLM 三元组审计(intent_match/parameter_sane/risk_level),LLM 失败 fail-safe 阻断。与 factGuard 的分工:**dual 管"该不该执行",factGuard 管"说得对不对",crossDoc 管"材料间是否一致"**。

### 6.6 知识与记忆(组 G)

- **knowledgeBase(409 行)**:摄取(语义分块 512 token + 指纹去重)→ BM25(k1=1.5,b=0.75)∥向量双路各召回 20 → RRF(k=60) → 五级作用域(global/session/pipeline/group/conversation);双层持久化(vault + 文件系统二进制向量)。
- **convMemory(127 行)**:对话轮次增量索引(水位时间戳)+ 周期摘要(保留 20 条)+ **质疑检测**(20 个中文质疑短语 + 数值近似检测:相对差 <30% 视为质疑信号触发记忆回查)。
- **memory(46 行)**:memoryStore 的薄适配器,流水线只依赖 MemoryAdapter 抽象。

### 6.7 已发现的服务层缺陷

`semanticCache.ts:553` 调用的 `reembedAll()` 在整个 src 目录**无定义**(import 的 `needsReembedding` 亦未使用),错误被 `.catch(() => {})` 吞掉——`initSemanticCache` 末尾的重嵌入逻辑实际是死代码(重构遗留),详见 17 章。

---

## 7. 状态管理层

### 7.1 十五个 Pinia store 总表

`src/stores/` 共 15 个 store,合计 6,760 行:

| store | 行数 | 角色 | 持久化 |
|---|---|---|---|
| dialogStore | 2298 | **厚编排**:路由瀑布 + 多轮循环 + DAG 执行 + 7 暂停点 | vault |
| apiStore | 955 | LLM 网关(薄编排:逻辑下沉 smartRouter/semanticCache/tokenBudget/sseParser) | vault + secureStore(API Key 双写 safeStorage) |
| nodeStore | 611 | 星图拓扑/L1 状态机/DAG 链/一次性视觉事件队列 | vault |
| debugStore | 439 | 探针/控制台捕获/计费/回放导出 | 部分**绕过 vault 直用 electronAPI.store** |
| mcpStore | 438 | MCP 连接/工具/权限矩阵 | vault |
| memoryStore | 385 | 三层记忆 + 历史压缩(TOKEN_BUDGET_DEFAULT=4000) | 快照经 electronAPI.storeWrite |
| sessionStore | 306 | 多会话 + QA/叙事双模式 Markdown 导出 | vault |
| feedbackStore | 238 | 反馈记录 + 技能权重时间衰减 | electronAPI.store |
| configStore | 219 | 主题/偏好/首引导 | vault |
| pipelineStore | 209 | 流水线定义 + DAG 编辑态 + **executor 注入点** | vault |
| notificationStore | 192 | 通知队列/优先级/过期 | vault |
| ruleStore | 167 | **纯代理**:9 个 action 一行委托 domainConstraints | — |
| skillStore | 125 | 技能安装/依赖 | vault |
| workflowLogStore | 93 | 工作流日志 | vault |
| knowledgeStore | 85 | 知识分组 CRUD(最小) | vault |

### 7.2 四种 store 形态

1. **纯状态壳**(6 个):configStore、knowledgeStore、sessionStore、skillStore、notificationStore、workflowLogStore——只有 state + setter,vault readCache/writeThrough 持久化;
2. **服务代理**(1 个):ruleStore,自身无逻辑;
3. **薄编排**(2 个):apiStore、debugStore——状态在 store,重逻辑全部下沉 service;
4. **厚编排**(1 个):**dialogStore(2298 行)**——全应用唯一把执行循环写在 store 内的模块,是复杂度最大单点(见 17 章)。

### 7.3 依赖纪律:唯一例外

全 stores 层**唯一**的 store→store 直接 import 是 `dialogStore → sessionStore`(消息直写);其他跨 store 交互走 globalBus 事件(`mcp:call-tool`、`api:chat-completion`、`memory:add-mcp-log`、`knowledge:create-group` 等)。服务层同样遵守该纪律(memory.ts 依赖 memoryStore 属有意设计;errorClassifier/dualEngineValidator 等用**动态 import** 规避循环依赖并实现按需加载)。注意:dialogStore 发出的两条 `node:*` 通道无订阅者,属断线(见 8.6)。

### 7.4 pipelineStore 的依赖注入模式

状态层对执行逻辑零依赖:`dialogStore` 启动时把执行函数注入 `pipelineStore.registerPipelineExecutor`,流水线编辑器(PipelinePage + useDagEngine)只管编辑 nodes/edges,执行由注入的 executor 完成——编辑态(pipelineStore)与执行态(dialogStore)经组件层桥接的双向通道。

### 7.5 持久化三轨并存(风险点)

1. **正轨**:vault 的 readCache(启动)/writeThrough(变更),`holo-*` 命名空间,100ms 批量 flush;
2. **绕行**:debugStore / feedbackStore / memoryStore 部分数据直用 `electronAPI.storeRead/storeWrite`(不经 VaultClient 缓存);
3. **敏感轨**:apiStore 的 API Key 走 secureStore + safeStorage 系统级加密。

三轨并存带来一致性代价(备份/导出需同时覆盖 vault 与裸 store 键,见 dataExporter 的 7 类收集器),详见 17 章。

---

## 8. UI 层:组件与可视化

UI 层由 App.vue(1,412 行,唯一页面外壳)+ 31 个组件(11,985 行)+ 2 个 composables(3,368 行)构成,合计约 16,800 行,占 src 四成——与微内核的"薄壳"哲学相反,全项目两个最大单文件(DialogPanel 2,927、useThreeScene 2,810)都在这一层,是复杂度最重的层。

### 8.1 App.vue:外壳兼内核装配器(1,412 行)

三段结构:模板 1-85 / 脚本 87-973 / 样式 975-1,412。

- **自绘标题栏**(3-19):frameless 窗口左侧 7 个功能入口(探针环🔍/压测台📊/规则审核⚖️/主题切换/通知铃🔔/设置⚙️/星图↔预览切换),右侧最小化/最大化/关闭走 electronAPI 窗口控制;
- **模板挂载 13 个组件**(20-55:DialogPanel、FilterBar、StarMap、ResultPreviewStage、DebugProbePanel、NodeDetailPanel、ApiSettings、Notification、NotificationCenter、CommandPalette、SettingsPage、OnboardingWizard、L0Modal)+ 6 个内联浮层(节点工具提示、相机重置按钮、内核状态球、熔断指示器、内核详情弹窗、历史快照弹窗);
- **内核装配**:onMounted 内 `createKernel()`(722)后一口气注册 12 组 domain handlers(723-734:api/app/config/data/debug/dialog/feedback/knowledge/mcp/memory/node/pipeline),再 `kernel.registerLLM` 注入 apiStore 的同步/流式两端点(735-742)——"内核+插件"在渲染进程组装完成;
- **启动自检**:L2 清单动态加载 + `requestIdleCallback` 后台预构建向量索引(787-807,timeout 3s);**向量 IPC 读写回环自测**(813-845:写 `_selftest` 键→读回比对,失败经 debugStore 发系统警告);
- **三个定时器**:10s 内核状态刷新(219)、**100ms 视觉同步循环**(879-917,轮询 nodeStore consume* 队列驱动星图特效——当前恒空转,见 8.6)、100ms 主动建议检查(940-964,每 3000 tick 即 **5 分钟**触发一次 proactiveScheduler 预生成,以 nano/mini 档预热缓存);
- **键盘与注入**:Ctrl+P 开命令面板、Esc 逐层关闭(640-661);`window._holoStarMapDblClickCommand`(745)把"双击 L2→注入 promptTemplate"回调递给 useThreeScene(其 1275 行调用);
- **布局协议**:StarMap 容器让位 CSS 变量 `--dialog-panel-width`(默认 460px,StarMap.vue:84-85),DialogPanel 拖宽经 panelWidthChanged→App.vue→StarMap onResize 三级联动;
- **死接线注记**:ApiSettings 挂载处的 `@saved="onApiSaved"`(49)——ApiSettings 全文件无任何 emit,监听器永不触发。

### 8.2 useThreeScene:星图渲染引擎(2,810 行)

全项目技术密度最高的文件:一个 composable 实现 Three.js 场景的全部渲染、物理、拾取与特效。

- **场景骨架**:TrackballControls(左键拾取/中键缩放/右键旋转);**零光源设计**——不设一盏灯,全靠材质自发光+加法混合营造星云;125 个节点画进 4 个 THREE.Points 批量对象,连同背景星场共 15,700+ 粒子;
- **分层视觉**:L1 六核按业务域着色(Finance #ffd700 / HR #ff6699 / Sales #00ff88 / Legal #88ccff / General #ccbbff,L0.5 网关 #ff8800);L2 呼吸浮动(振幅 0.03-0.07),locked 后信标旋转;L3 按社区热度渐变,近 7 天用过的节点红闪(与探针警报同色 #ff2819),长期未用坍缩为"残骸";
- **物理与拾取**:O(n²) 粒子间斥力(1.8/1.2/0.6 三档,L1 恒定不动);射线拾取以 <5px 屏幕距离判定点击;拖拽 L2 到 L1 触发 swapLevels;悬停高亮邻近连线走 `nodeStore.getNeighbors`(即 9.1 的邻接表——按其判据 L1/L2 悬停永远无连线);
- **DAG 链视觉**:紫色虚线 #9944ff(dash 0.15/gap 0.08),七种步态样式(running #44ddff / done #ffdd44 / failed #ff4444 / replanned #ff8800 / reuse #44ff88 / skip #555566),端点跟随节点、幽灵 sprite 收尾;
- **性能**:8 项手段——批量 Points、零光源、页面隐藏降频至 1FPS(LOW_FPS_INTERVAL 1000ms,2666-2678)、rAF 单循环串接 20 个 update 函数、smoothstep 缓动 flyToNode 等;
- **对外接口**:return 24 项 API(2809 行):init/dispose/isReady/hitTest/nodeMeshes/startOnboarding/setDegradedVisuals/rebuildNode/spawnStarLogAsteroid/triggerStarLogReturn/triggerL1Flash/triggerProbeFlash/triggerConvergenceBeam/triggerL0PulsarBurst/highlightL2Candidates/setL2Selected/triggerDAGChain/setDAGStepStatus/clearDAGChain/setThemeBackground/flyToNode/resetCamera/hoveredNodeInfo/onResize。**其中特效类函数过半当前不可达(8.6)。**

### 8.3 DialogPanel:对话主面板(2,927 行)

全项目最大文件,脚本区止于 1,711 行,其余近半为模板与样式。注意:**仓库中不存在 ChatPanel 组件**(部分旧文档这么称呼)——聊天 UI 全部内嵌于此。

- **流式渲染**:bus 流事件→dialogStore 流式状态→组件 watch 渲染,占位光标闪烁;消息正文经 DOMPurify 消毒后展示;
- **七类人工确认条**:plan / intent / slot-fill / fact-conflict / **risk-confirm** / dag-pause / takeover,对应 dialogStore 七个暂停点(chaos 测试的 7 状态机);risk-confirm 需手动输入确认语——高风险确认的实际承担者(ConstraintConfirmCard 是孤儿组件,见 8.5);
- **血缘标签条**:每步消息下按来源打标,10 类样式(rule_engine/cache_reuse/auto_compiled/llm_pro/llm_standard/llm_mini/llm_nano/skipped/tool_call/fallback,2419-2427);
- **宏构建器**:聊天内直接创建自定义工具,保存为 l2-custom-* 清单(经 saveCustomManifest→localStorage);undoExecution 可撤销上一次宏执行;
- **事件出口**:openPreview/openMcp/cameraFlyTo/panelWidthChanged——731 行调用 `emit(...)` 而 defineEmits 直到 734 行才声明(闭包后置生效,可读性陷阱)。

### 8.4 useDagEngine + PipelinePage:流水线工作台

- **useDagEngine.ts(558 行)**:DAG 编辑引擎——节点定宽 NODE_W 180;四态状态机;贝塞尔边 21 点采样(供命中检测与箭头绘制);缩放钳制 [0.3,3];rAF+脏标记按需重绘;Kahn 拓扑布局。**没有环检测**:连线成环时 Kahn 静默丢弃环上节点,编辑器无任何提示(17.C13);
- **PipelinePage.vue(506 行)**:流水线窗口页(pipeline.html 入口),基于 useDagEngine 提供节点面板/属性编辑/连线管理,可把流水线导出为 L2 自定义工具(l2-custom-*);执行不在此处——经 pipelineStore.registerPipelineExecutor 注入的 dialogStore 执行器完成(见 7.4)。

### 8.5 其他窗口页与剩余组件

- **DebugWindowPage**(384,debug.html):调试监视器窗口——探针事件流冻结上限 500 条,支持 time-travel 回放;
- **BenchmarkPage**(371,benchmark.html):压测台窗口——sleepMs 500-30000 可调节流(23 行);
- **RuleReview**(rule-review.html,8 子组件共 1,500 行):法规规则审核——automationLevel 三档建议、verdict 流转(approved→approveRule / needs_revision→draft / rejected→deprecated)、RuleFeedbackChart 误报率 >20% 告警;注:RuleEditForm(62 行)名字带 Edit 实为只读展示,RuleReviewForm 采集的 comment 未随表单提交(17.C14);
- **OnboardingWizard**(466):首启引导——五相动画(waiting→pulsing→stardust→exploding→done),exploding 后 2s 落幕 markFirstLaunchDone(StarMap.vue:36-42);applyJobRoleTemplates 按职业预装模板;
- **其余主力组件**:L0Modal(1,066,L0 直达弹窗:技能安装/MCP 连接)、NodeDetailPanel(596,节点详情/锁定/上下文恢复)、ApiSettings(488,端点/密钥/模型探测)、DebugProbePanel(481,内核决策探针)、ResultPreviewStage(409,结果预览)、SettingsPage(350)、CommandPalette(342,Ctrl+P)、DataManagement(314,存储占用/导出/清理)、NotificationCenter(309)、ToolSelector(174)、FilterBar(178,星图过滤——只写 nodeStore,defineEmits 空转);
- **孤儿组件 3 个**(全仓库无 import,唯一"引用"是 terminologyMap.ts:16 的术语表字符串):**DebugPage**(563,旧版内嵌调试页,已被 DebugWindowPage 取代)、**JobRoleSelector**(143)、**ConstraintConfirmCard**(142,高风险确认职责实际由 DialogPanel 的 risk-confirm 确认条承担)。

### 8.6 执行可视化链路:三重断裂(本章头号发现)

设计意图:宏执行时星图应实时上演"视觉戏剧"——L1 闪烁、DAG 链生长、汇聚光束、脉冲星爆发。但这条链路**三个环节全部断裂**,当前构建中整套执行特效静默失效:

```
dialogStore(执行循环)
  │ bus.emit:node:set-l1-status ×45 / node:set-dag-chain ×2 / node:clear-dag-chain ×3
  ▼ ①断裂:全仓库无任何 bus.on 订阅这三条通道——事件发进虚空
  nodeStore(可视化状态机)
  │ setL1Status/setDAGChain/markTaskChainComplete/emitNodeVisualEvent/addConnectionFlow
  ▼ ②断裂:上述写函数全仓库零调用方——状态机从未被驱动
  App.vue 100ms 轮询(879-917):consumeL1Flashes/consumeTaskChainComplete/consumeL2Highlights
  ▼ ③断裂:队列恒空,轮询空转;且 StarMap ready 载荷(StarMap.vue:58)只转发
    useThreeScene 24 项 API 中的 8 项——triggerL1Flash/triggerConvergenceBeam/
    highlightL2Candidates 不在其列,App.vue:883/886/890 的无守卫调用一旦执行即
    TypeError(恰好因②恒空而永不触发;DAG 三调用则有 if 守卫,893/908/914)
```

- **失效清单**:L1 闪烁、DAG 链、汇聚光束、L0 脉冲星爆发、缓存命中脉冲、L2 高亮、探针红闪、连接流粒子——useThreeScene 特效函数过半不可达;
- **修复成本极低**:补 bus.on→nodeStore 写函数→StarMap 载荷补 3 个转发,合计约 10 行,故列为 P1(17.C11)而非 P2;
- **相邻死代码**:空 if 块(useThreeScene.ts:2423-2424)、StarMap 声明未发的 dragStart/dragEnd(StarMap.vue:20-26)、App.vue `@saved` 死监听(49)、FilterBar 空 defineEmits、RuleReviewForm comment 采集未提交、DialogPanel emit 先于 defineEmits(731 vs 734)。

---

## 9. 数据与配置层

`src/data/`(4 文件,1,317 行)+ `config/l2_manifests/`(20 JSON)构成星图的"宇宙常数"。

### 9.1 拓扑生成 topology.ts(273 行)

125 个节点全部由代码生成,规则精确如下:

| 层 | 生成规则 | 位置 | gridIndex |
|---|---|---|---|
| L0(1) | 手写常量 `l0-user-core` | (0,0,0) | [0,0,0] |
| L1(6) | 手写常量,轴向 ±2.5 | (±2.5,0,0)/(0,±2.5,0)/(0,0,±2.5) | ±5 单轴 |
| L2(20) | 12 立方体棱中点 + 8 角点,统一 ×3.0 | 距原点 3√2≈4.24 / 3√3≈5.20 | 舍入后的缩放坐标(±3/0) |
| L3(98) | 斐波那契球面(黄金角 137.5°),半径 5 | 单位球点 ×5 | **单位球坐标舍入**(−1/0/1) |

- L1 六节点描述与 `README.md` 一一对应,其中 `l1-model-gateway` 带 `isL05: true`(L0.5 基建)、`l1-pipeline-builder` 带 `isOrchestrator: true`(指挥家),全部 `locked: true`。
- L2 由 20 条 `L2Template`(id/名称/角色/父 L1/comboToolIds/描述)与几何位置按序号取模拼装;每个模板的 `jobRoles` 决定角色筛选(`getJobRoleTemplates`)。
- L3 的 98 个名字是**硬编码中文数组**(`topology.ts:195-216`),`communityHeat: Math.random()*100`、`lastUsedAt: 最近 30 天内随机`——**每次刷新都不同**,是典型的"演示期模拟数据混入生产数据文件"(17 章)。

**邻接生成的实现怪癖**:`buildAdjacencyMap` 以 gridIndex 曼哈顿距离 =1 判邻接(`topology.ts:250-267`)。由于 L0=[0,0,0]、L1=±5、L2=±3、L3∈{−1,0,1}³,代入可知:**L1 与任何节点距离 ≥5、L2 互距 ≥3、L2 与 L3 互距 ≥5,全部无边**;邻接表实际只含 L3↔L3 与少量 L3→L0(如球面两极 [0,±1,0])的边。该映射仅被 nodeStore 持有(`nodeStore.ts:9,169`),而星图悬停连线(`useThreeScene.showConnections` → `nodeStore.getNeighbors`)恰恰以它为数据源——按上述判据,**悬停 L1/L2 节点永远没有连线可显示**(邻居恒为空),只有悬停 L3 能亮起邻近连线(见第 8 章)。

### 9.2 技能目录 skillCatalog.ts(515 行)

21 个可安装技能:每个含名称、描述、绑定的 MCP 服务器与工具、安装状态;安装态经 skillStore 持久化到 vault。与 mcpCatalog 的 5 个官方 MCP 条目(filesystem / memory / sequential-thinking / github / context7,`mcpCatalog.ts`,64 行)配套,构成"技能 = MCP 能力的预置封装"。

### 9.3 L2 清单 l2Manifests.ts(465 行)——运行时真源

- 20 个 `L2ToolManifest` 内置对象,严格遵循五段式 schema(identity / visual / routing / execution / cacheMeta,与 `L2工具编译标准V1.0.md` 一致)。
- 自定义清单 CRUD:`saveCustomManifest / loadCustomManifests / removeCustomManifest`,持久化在 localStorage 键 **`holo-custom-manifests`**;DialogPanel(聊天内创建工具)与 PipelinePage(流水线导出为工具)都会调用保存。
- 消费链(全部动态 import,利于首屏):`App.vue:787-802` 启动时加载 → `nodeStore.loadL2Manifests` → `toolRetrieval.buildL2Index` 预构建向量索引(带指纹版本号,变更即重建);`debugStore.ts:357`、`App.vue:924` 按需 `getManifestById`。

### 9.4 config/l2_manifests/(20 个 JSON)——无人消费的声明式工件

20 个 JSON 与 TS 清单一一对应(58–106 行/个),同样是五段式 schema,执行模式分布 **direct 6 / macro 13 / chain 1**。但全仓库检索显示:**没有任何 ts/js/html 代码引用该目录**——它们不参与运行时,是"规格快照/评审存档"性质的工件。由此产生**双源漂移风险**:TS 运行时清单与 JSON 存档若手工修改不同步,规则评审台(审的是 domainConstraints 法规规则,不是这些 JSON)也不会发现(17 章)。

### 9.5 类型基座 models/index.ts(1,189 行)

全部领域类型的唯一来源:ToolNode/ToolLevel/AdjacencyMap/InteractionState/DegradedState/IngestProgress/L3DecayState/CircuitBreakerState/ConnectionFlow/L2ToolManifest/JobRole/SchemaField 等,被 data、stores、domains、components 共享。

---

## 10. 持久化与 Vault

### 10.1 三层架构

```
渲染进程                          主进程
┌──────────────────────┐   IPC   ┌─────────────────────────────┐
│ VaultClient(169 行)  │ ──────► │ vault.ts(131)+vault-schema  │
│ 内存Map缓存+写队列    │  13方法  │ better-sqlite3 WAL           │
│ 100ms批量flush        │ ◄────── │ kv表+vectors表(BLOB)         │
└──────────────────────┘         └─────────────────────────────┘
        ▲ 迁移                            ▲ safeStorage 按值加密
        └── vault-migration.ts(141 行):首次启动 localStorage → Vault 一次性搬迁(~30 个 holo-* 键,迁移标志防重)
```

- **VaultClient(src/vault/index.ts)**:每个 store 调 `readCache`(启动装载,命中内存 Map 即返回)与 `writeThrough`(变更入队,100ms 批量落库);`readBypass` 强制走 IPC 读新值;`dirtyKeys` 跟踪未落盘键。
- **vault-schema.ts(28 行)**:kv(key, value)与 vectors(id, key, dim, data)两表 DDL,WAL 模式。
- **vault.ts(131 行)**:读写删列 + 向量 BLOB 存取;敏感值(API Key 等)逐值 safeStorage 加密,普通值明文入库——"按需加密"而非整库加密。
- **备份**:backupCreate/backupRestore 把 SQLite 库文件与元数据用 archiver 打 zip 输出到桌面;dataExporter(282 行)另有 7 类收集器汇总导出(dataExportZip),dataImporter(23 行)负责 zip 回灌。

### 10.2 三轨并存(事实上的分层)

| 轨道 | 机制 | 使用方 |
|---|---|---|
| 正轨 | VaultClient → vault | 15 个 store 的绝大多数状态 |
| 绕行轨 | `electronAPI.storeRead/storeWrite` 直连(仍走主进程 localStorage 语义键值库) | debugStore(计费/日志)、feedbackStore(反馈记录)、memoryStore(快照) |
| 敏感轨 | secureStore(54 行)→ safeStorage | apiStore 的 API Key(vault 与 safeStorage 双写) |

另有第四类"轻状态"停留在渲染进程 localStorage:内核 PersistencePort 默认实现就是 localStorage——semanticCache 条目、ZOL 自适应阈值、自定义 L2 清单(`holo-custom-manifests`)、流水线检查点(`holo-pipeline-checkpoints`)都在此。**"重状态进 Vault、轻状态进 localStorage"是事实标准,但从未写成文档**,三轨+localStorage 并存使备份/导出必须多方收集(17 章)。

---

## 11. 安全模型

### 11.1 威胁模型

三个前提假设:①LLM 输出不可信(可能被提示注入诱导生成危险指令);②MCP 工具是不可信的外部能力;③本机敏感文件(密钥/凭据)不可外泄。防线由此分为主进程硬边界与渲染层纵深两级。

### 11.2 主进程硬边界(shell-security.ts 212 行 + pathValidator.ts 124 行)

**Shell 执行五条规则**(`shell-security.ts`):

| 规则 | 内容 |
|---|---|
| 白名单 | 13 条命令(npm install/run、dir、ls、cat、echo、type、mkdir、copy、cp、cd、pwd、pip install),前缀匹配 |
| node -e 受限通道 | 55 个危险模式正则(require child_process/net/http、process.exit、eval、.exec(、rm -rf、powershell、curl、模板字符串注入…)命中即拒;6 个可信签名(docx/xlsx/pdf-parse/mammoth/archiver/marked)可豁免部分写文件模式(仅允许写 Desktop/Documents/Downloads 或 USERPROFILE) |
| npm install 包名校验 | 正则 `(@scope/)?name` 逐包校验,防命令注入 |
| MCP 专属 | npx/node 脚本仅能经 MCP spawn 执行;MCP 命令白名单 5 条(npx/node/python3/python/uvx),npx 限定 `@modelcontextprotocol/` 或 `@anthropic/` 作用域 |
| 超时分级 | 快命令 10s(19 条)/标准 60s / 重命令 120s(6 条)/绝对上限 180s;用户自定义超时被钳制 |

**HTTP 出口**(`shell-security.ts:209-212`):方法白名单 GET/POST/PUT/PATCH/DELETE/HEAD;请求体上限 **1MB**(1024×1024);按方法超时 10–30s,绝对上限 60s。(`.github/SECURITY.md` 宣称 1.2MB/77 模式/19 命令——实测 1MB/55 模式/13 命令,见 17 章失真清单。)

**路径防线**(pathValidator.ts):写/读仅允许 5 个基目录(userData、desktop、documents、downloads、home);18 个敏感路径正则绝对禁读(.ssh/.gnupg/.aws/.kube、/etc/shadow、Windows SAM/SYSTEM、凭据目录等);`validateOpenPath` 拦截 33 个危险扩展名(.exe/.bat/.ps1/.dll…);`sanitizeKey` 约束 KV 键名(≤128 字符、`[a-zA-Z0-9_-]`、防 `..` 遍历)。

**回归防线**:`test/ipcSecurity.spec.ts`(355 行)内置 **VULN-01..18** 漏洞回归用例,每个历史漏洞一条测试钉死;根目录另有 errorClassifier / dualEngineValidator / scheduleOptimizer 三个安全相关 spec。

### 11.3 渲染层纵深(执行前 → 执行后 → 呈现前)

```
执行前   dualEngineValidator(234 行)
         本地规则:10 危险路径 + 7 危险 URL 正则,命中直接 high 短路
         ∥ LLM 三元组审计(intent_match / parameter_sane / risk_level)
         → 任一引擎判 high 即弹窗;LLM 不可用时 fail-safe 一律阻断(宁可误杀)
         → 判定缓存 500 条/24h(skill_id+target+operation)
执行后   factGuard V2(246 行)+ nerExtractor(344 行)
         9 类实体抽取;容差:金额 0.01/0.1%、日期 ±1 天、百分比 0.1
         minor 自动修正 → critical 中断;仅 finance/legal/hr 角色触发
材料间   crossDocValidator(170 行):多文档实体 O(n²) 比对,冲突转法规约束结果
法规     domainConstraints(3,356 行):55 条中国法规规则,生命周期自治理
呈现前   resultBeautifier(325 行):手写 Markdown 渲染,协议过滤 javascript:/data:/vbscript:
         + DOMPurify 兜底
```

### 11.4 密钥与已知缺口

- API Key:apiStore 双写 vault(值级 safeStorage 加密)与 secureStore;明文不出主进程。
- 缺口:①`asar: false` + portable 打包整包复制 node_modules,资源可被就地篡改;②electron 未锁定版本(不在 dependencies,SECURITY.md 提到的 33.4.0 漏洞无法通过 lockfile 审计);③`dialog:confirm-risk` 语义错位(5.3);④L3 随机热度数据无安全意义但混在拓扑生产文件中。

---

## 12. Token 成本优化体系(项目核心卖点)

### 12.1 目标与总体架构

一句话:**能不调 LLM 就不调;必须调就用最便宜的档;调过了就想法子下次不再调。** 落地为"五级拦截漏斗 × 多层缓存 × 自适应阈值 × 全链路记账"四件套。

### 12.2 五级拦截漏斗

| 级 | 机制 | 成本 | 关键参数 |
|---|---|---|---|
| L0 | l0SkillRouter 规则技能(8 类正则) | 0 | 文件名提取四级瀑布,LLM 兜底仅 32 token |
| L0.5 | 关键词命中率 + 置信度门槛 | 0 | hitRatio≥0.4 且 margin≥0.1 计分;门槛 0.8;仅 direct/单步可直通 |
| L1 | 两节点能力判定 | 0 | 门槛 0.6(封顶 0.9) |
| RaaP | toolRetrieval 混合检索 | 0(本地向量) | BM25 式关键词 ∥ 向量余弦 → RRF(k=60)→ 动态分位阈值;否定词 ×0.3、反馈 ±0.5、角色 ×1.3 |
| LLM | promptTranslator DAG 规划 | 高 | few-shot + 思维链,maxTokens 768,≤5 步;规划结果交 macroExecutor 执行 |

实测绕过率(完全不经过 LLM 直接完成的请求占比)30–85%(`benchmark-result-professional.json`,按用例组分层)。

### 12.3 多层缓存矩阵

| 缓存 | 键 | 容量/TTL | 命中策略 |
|---|---|---|---|
| 语义缓存 semanticCache(554 行) | textHash 精确 → 向量余弦 | 500 条/24h | 相似度阈值自适应 0.80–0.95(50 次窗口每 20 次调一次);手写 LRU;按域失效 |
| 执行指纹 scheduleOptimizer(392 行) | manifestId+输入指纹 | 50 个指纹 | 逐步输出哈希找脏步骤,脏依赖传播;副作用步骤(shell_exec)强制不复用;≥10 次且命中率 ≥0.8 晋升 autoCompiled |
| 路由缓存 toolRetrieval | query+索引指纹 | 100 条/30min | 索引指纹变化整体失效 |
| 验证缓存 scheduleOptimizer | skill+target+op | 500 条/24h | 双引擎判定复用 |
| KV 缓存(服务端) | — | — | sseParser 解析两代字段(cached_tokens / prompt_cache_hit_tokens),DeepSeek 计价 ¥0.02/M vs 未缓存 ¥1/M |

### 12.4 模型分档与经济系统

- 四档模型 tier(smartRouter 复杂度四维评分决定):nano 512 maxTokens / mini 1024 / standard 4096 / pro 8192。
- tokenPricing 价目(元/1K tokens):输入 0.0005 / 0.0015 / 0.005 / 0.0175;输出 0.0015 / 0.006 / 0.015 / 0.07;支持自定义单价与缓存折扣。
- tokenBudget(355 行):三周期(session/daily/monthly)× 三模式白名单(zero 仅 nano、economy +mini、standard 全开)× 超支三策略(block/warn/degrade),95% 预警,记账上限 1000 条。
- macroExecutor 四级降级链 pro→standard→mini→nano→rule(超时 60/30/15/8s),失败自动降档重试,rule 引擎兜底零成本。
- **11 种血缘来源**(llm_pro/llm_standard/llm_mini/llm_nano/rule_engine/cache_reuse/auto_compiled/skipped/tool_call/fallback/replay_reuse)记录每步"钱花在哪、省在哪",RaaP 模式估算节省 2000 token/步、规划 500 token/步。

### 12.5 自适应体系(零 Token 学习)

- ZOL(zeroTokenLearning,191 行):9 个路由阈值随成功率自适应(<0.70 收紧 ×1.05,>0.95 放宽 ×0.95),±30% clamp,窗口 20 次/样本 50——**阈值调参本身不花一个 token**。
- 语义缓存阈值、指纹晋升、技能权重时间衰减(feedbackStore)、mabOptimizer(11 行,MAB 桩位)同属该体系。

### 12.6 压测台与实测结果

- **应用内压测台**(`src/benchmark/` 3 文件):16 个用例五组(A–E);statsTracker 计价(输入 ¥1/M 未缓存、¥0.02/M 缓存,输出 ¥2/M,语义缓存命中成本 ¥0.0001);baseline vs optimized 对比,结果导出 `Desktop\HoloStarmap\benchmark-result.json`,经主窗口"压测台"窗口(BenchmarkPage 371 行)可视化。
- **仓库级脚本**(`test/benchmark/` 11 文件,三层演进):run-benchmark(376)→ v2(520)→ professional(714),配套中英文报告生成器与流式验证脚本。
- **实测结果**(`benchmark-result-professional.json`,377 行,120 用例):token 节省 24–25%,成本节省 22–25%,KV 命中率 62–75%,绕过率 30–85%;**TTFT 节省率可为负(−17%)**——缓存写入开销在首字延迟上的代价被如实记录,未粉饰。

---

## 13. 测试体系

### 13.1 规模与分布(静态统计)

**64 个 spec / 291 个 describe / 1,238 个测试用例**;vitest 默认实际运行 61 个 spec(e2e 被排除)。

| 位置 | spec 数 | 代表文件 |
|---|---|---|
| test/unit/ | 55 | smartRouter(532 行)、semanticCache(480)、toolRetrieval(474)、macroExecutor×4(util/macro/step/tools/dag,合计 1,549) |
| test/ 根目录 | 4 | **ipcSecurity(355 行,VULN-01..18 回归)**、dualEngineValidator(476)、scheduleOptimizer(387)、errorClassifier(167) |
| test/chaos/ | 1 | dialogState(564 行):7 暂停点状态机混沌测试 |
| test/integration/ | 1 | macroExecutor.e2e(234 行):宏执行全链路 |
| test/e2e/ | 3 | launch / l0Skill / stress(vitest 排除,手动跑) |

配套:edge 2 个 CLI 脚本(edge-test 301 行、multi-model-test 259 行)、benchmark 11 个文件(见 12.6)。

### 13.2 Mock 体系(测试基建的精华)

- `mockElectronAPI.ts`(192 行):模拟全部 ~68 个 electronAPI 方法,内置两轮深拷贝状态池防止测试间串扰,自动挂到 `globalThis.window`——**渲染层代码无需感知测试环境**。
- `mockStores.ts`(531 行)/ `mockServices.ts`(516 行):15 个 store 与核心服务的预置替身。
- fixtures 5 个(topology 165 / manifests 83 / entities 51 / messages 43 / index 4)+ testHelpers(12 行)。

### 13.3 覆盖率与已知缺口

- vitest coverage 仅统计 `src/services/**` 与 `src/stores/**`,perFile 阈值 lines/functions/statements 40%、branches 30%——**kernel、domains、components、composables 不在覆盖范围**。
- 无组件级测试(@vue/test-utils 未安装,environment 为 node);e2e 默认不跑;**无 CI 自动化**(.github 下无 workflows)。
- 文档漂移:README 称 442 个测试、TEST_REPORT 称 1,129 个(48 文件)——与静态统计 1,238 个均不一致(17 章)。

---

## 14. 构建与发布链路

### 14.1 开发链路

electron-vite 5 三段式:main(electron/)→ preload → renderer(src/,**5 个 HTML 入口**对应 5 窗口);`@electron/rebuild` 编译 better-sqlite3 native 模块;scripts 用 tsx 直跑 TS;vitest 3 做测试。`dev`/`build`/`preview` 三个标准 script。

### 14.2 发布打包(package.json build 段)

- appId `com.holostarmap.app`,仅 **Windows portable** 单文件目标;
- **`asar: false`** + afterPack 钩子 `build-after-pack.js`(33 行)把整个 node_modules 复制进 `resources/app`——以体积和防篡改性换取 native 模块(better-sqlite3/transformers.js 模型加载)的零配置可运行。

### 14.3 工程异常(与 17 章联动)

1. **electron 与 electron-builder 均不在 dependencies/devDependencies**——构建依赖环境全局安装,仓库不可复现构建;
2. 无 GitHub Actions(5 个 .github 文件全是 issue/PR 模板与 SECURITY.md);
3. 无 lint/typecheck script,`CONTRIBUTING.md` 的代码标准(禁 any/as 等)仅靠 PR 模板人工勾选;
4. `.gitignore` 忽略 `benchmark-result*.json` 等生成物,但仓库里仍提交了 4 份(benchmark-result.json/v2/professional、test-multi-model-results、test-edge-results)——与忽略规则自相矛盾。

### 14.4 辅助脚本(scripts/)

generate-comparison-doc.ts(1,099 行,生成对比文档)、generate-analysis-report.ts(776 行,生成分析报告)、gen-icon.mjs(54 行,生成图标)。

---

## 15. 端到端数据流

### 15.1 流 A:一次"便宜的"问答(L0.5 直通)

```
用户输入(DialogPanel)
  → dialogStore.executeUserMessage
  → 路由瀑布:l0SkillRouter 未中 → tryL05QuickMatch 命中(置信度 ≥0.8)
  → kernel.dispatch
     ├─ semanticCache 查询(未命中)
     ├─ smartRouter 复杂度评分 → tier(如 mini)
     ├─ tokenBudget.check(session/daily/monthly 三周期校验通过)
     ├─ LLM 调用 → apiStore(chatCompletion 经 LLMPort)
     │    → preload.llmChatCompletion → 主进程 ipc-handlers(axios,SSE)
     │    → sseParser 逐 chunk 解析(含 KV 缓存字段)→ bus emit 流事件
     │    → dialogStore 流式状态 → DialogPanel watch 渲染(仓库无 ChatPanel 组件);
     │      debugStore 订阅 api:chat-completion 自动计费
     ├─ 响应写 semanticCache;budget 记账
     └─ factCluster.check(finance/legal/hr 角色时)
  → sessionStore 消息落库(dialogStore 直写)→ vault writeThrough
  → 跨窗口同步:store 快照 → 主进程中继 → 调试监视器实时可见
```

### 15.2 流 B:L2 宏执行(含人工风险暂停)

```
命中 L2(RaaP universalMatch 或星图点选)
  → macroExecutor.execute(manifest,输入)
  ├─ dagCheckpoint 命中?→ replay_reuse 整链回放(0 token)
  └─ 未命中 → 逐步:
       ① 参数插槽解析(模板变量 {{step_N_result}})
       ② ruleEngine 规则优先(能规则不 LLM)
       ③ dualEngineValidator 审计
             high → dialogStore 暂停点 + DialogPanel risk-confirm 确认条
                    (手动输入确认语;ConstraintConfirmCard 为孤儿组件,未挂载)
                   → dialog:get-paused-state 每 500ms 轮询
                   → 用户可 dialog:request-takeover 人工接管该步
       ④ 工具执行:8 类内置(file_write/create_docx/shell_exec/read_file/http_request/…)
            或 MCP(mcp:call-tool → mcpStore → preload → mcp-manager stdio
                    → 主进程 isMcpCommandAllowed 白名单校验)
            或 LLM 步:降级链 pro→standard→mini→nano→rule(每档独立超时)
       ⑤ 步后 FactGuard V2(实体容差比对,minor 自动修正/critical 中断)
        ⑥ 血缘记录(11 种来源);node:set-dag-chain 照常发射,但该通道三重断裂,
           3D DAG 链视觉实际不生效(8.6)
       ⑦ workflowLogStore 日志;检查点写 dagCheckpoint
  → 全链完成:resultBeautifier 渲染 → ResultPreviewStage 预览
  → 节省统计(tokenSaved/costSaved)入 debugStore → 压测口径复用
```

### 15.3 流 C:冷启动

```
主进程:单实例锁 → initVault(better-sqlite3 WAL)→ migrateVault(localStorage→Vault,~30 键)
  → 创建 1280×800 frameless 主窗口
渲染进程:main.ts(40 行)createApp+Pinia → App.vue onMounted:
  ① 15 个 store 并行 vault readCache 恢复
  ② 12 组 domain handlers 注册(App.vue:723-734)
  ③ L2 清单动态加载(App.vue:787-802)→ nodeStore.loadL2Manifests → buildL2Index 向量索引
  ④ initSemanticCache(嵌入模型 transformers.js 本地加载,离线降级哈希伪向量)
  ⑤ skillStore/MCP 连接状态恢复;onboardingManager 首检 → OnboardingWizard 或直入星图
```

---

## 16. 设计模式与技术亮点

| # | 模式 | 落点 |
|---|---|---|
| 1 | 微内核 + 能力簇 | kernel/index.ts 只编排,route/cache/security/budget/fact 五簇纯委托(kernel/clusters/) |
| 2 | 端口与适配器 | PersistencePort/IOPort(31 方法)+ facades/persistence、facades/io |
| 3 | 插件注册表 | plugins/llm.ts(registerLLM/getLLM 单例,未注册 fail-fast) |
| 4 | 事件总线 + 服务定位器混合 | globalBus:34 个 request 通道 + 多播 on + 流句柄;服务不 import store 的纪律 |
| 5 | 门面统一出口 | domains/*/index.ts 全部 re-export,外部不触内部路径 |
| 6 | 依赖注入 | pipelineStore.registerPipelineExecutor(编辑态与执行态解耦) |
| 7 | 不可变传播 | createReadOnlyContext 双层 Object.freeze(kernel/context.ts,25 行) |
| 8 | 装饰器 | createNamespacedPersistence(命名空间视图) |
| 9 | 手写 LRU 双向链表 | semanticCache(MurmurHash3 + LRU,零依赖) |
| 10 | RRF 融合排序 | toolRetrieval / knowledgeBase 双路召回融合(k=60,三处复用) |
| 11 | fail-safe 默认拒绝 | dualEngineValidator LLM 失败即阻断;embedder 离线降级伪向量 |
| 12 | 降级链 | macroExecutor 四级模型降级 + pipelineExecutor 超时回退 |
| 13 | 确定性检查点 ID | dagCheckpoint(manifestId+输入三要素 31 位 hash,可重放) |
| 14 | 零 Token 自适应 | ZOL 9 阈值成功率反馈调参,不消耗 token |
| 15 | 血缘追踪 | 11 种来源量化"每步省在哪"(成本可观测性的稀有实践) |
| 16 | 跨窗口状态中继 | 主进程作 store 快照路由器(100ms 防抖 + pending 合并) |

**最有辨识度的三个亮点**:①五级成本漏斗把"是否调 LLM"变成工程问题而非玄学;②zeroTokenLearning 让路由阈值自调参且分文不花;③全链路血缘 + 应用内压测台,使"省了多少钱"可复现、可审计。

---

## 17. 技术债、风险与改进建议

### 17.A 文档失真清单(声称 vs 实测)

| # | 声称 | 实测 | 出处 |
|---|---|---|---|
| A1 | 测试数 442(README)/ 1,129·48 文件(TEST_REPORT) | **64 spec / 1,238 用例 / 61 默认运行** | vitest.config.ts + 静态统计 |
| A2 | Shell 白名单 19 命令 / 77 危险模式(README、SECURITY.md) | **13 命令 / 55 模式** | shell-security.ts:1-73 |
| A3 | HTTP 体上限 1.2MB(.github/SECURITY.md) | **1MB**(1024×1024) | shell-security.ts:209 |
| A4 | 许可 "MIT (confirmed in package.json)"(quality-report.json) | **Apache-2.0** | LICENSE + package.json |
| A5 | electron 33.4.0 为项目依赖(.github/SECURITY.md) | **package.json 无 electron 依赖项** | package.json |

**结论:项目文档由 AI 辅助生成后未随代码同步,数字普遍不可信;本报告全部数字以源码实测为准。**

### 17.B 工程配置风险

1. **electron/electron-builder 缺席依赖表**(P0):克隆后 `npm install` 无法构建;SECURITY.md 承认的 electron 33.4.0 漏洞无法通过 lockfile 审计与升级。
2. **asar:false + portable 全量复制**(P1):资源可就地篡改、包体巨大、启动复制慢;正确姿势是 asar:true + asarUnpack native 模块。
3. **无 CI、无 lint/typecheck**(P1):1,238 个测试没有自动执行机制;CONTRIBUTING 的禁 any/as 标准无工具强制。
4. **覆盖率口径偏窄**(P2):仅 services+stores 计覆盖,阈值 40%/30% 偏低;kernel/domains/UI 零覆盖。

### 17.C 代码级问题

| # | 问题 | 位置 | 等级 |
|---|---|---|---|
| C1 | `require('@/services/factGuard')` 在 Vite ESM 渲染层中 `require` 未定义,该路径一旦执行即运行时崩溃 | kernel/clusters/security.ts:34 | P0(潜在) |
| C2 | `reembedAll()` 未定义且被 `.catch(()=>{})` 吞错,重嵌入逻辑为死代码 | semanticCache.ts:553 | P1 |
| C3 | `dialog:confirm-risk` 仅返回标志位,与 macroExecutor 的"等待确认"语义错位 | domains/dialog/handlers.ts:5-8 | P1 |
| C4 | dialogStore 2,298 行厚编排单体(执行循环写在 store 内),全项目最大复杂度单点 | src/stores/dialogStore.ts | P1 |
| C5 | 持久化三轨 + localStorage 轻状态并存,备份/导出需 7 类收集器兜全 | 见 10.2 | P2 |
| C6 | config/l2_manifests 20 个 JSON 无任何代码消费,与 TS 运行时真源双源漂移 | 见 9.4 | P2 |
| C7 | L3 随机热度/时间戳混入生产拓扑文件,每次刷新变化 | topology.ts:236-237 | P2 |
| C8 | 55 条法规规则硬编码 3,356 行,法规修订必须发版 | domainConstraints.ts | P2 |
| C9 | 巨型文件:DialogPanel 2,927 / useThreeScene 2,810 / App.vue 1,412 行 | src/ | P2 |
| C10 | mockElectronAPI 68 方法手工维护,与 preload 漂移无检测 | test/utils/ | P3 |
| C11 | **执行可视化链路三重断裂**:node:* 通道无订阅→nodeStore 写函数零调用→StarMap 载荷缺 3 个转发,L1 闪烁/DAG 链/汇聚光束等全部失效;App.vue:883/886/890 无守卫调用埋雷 | App.vue:879-917 / nodeStore / StarMap.vue:58 | P1 |
| C12 | 孤儿组件 3 个(DebugPage 563 行/JobRoleSelector/ConstraintConfirmCard)滞留仓库,术语表仍引用其名 | src/components/ | P2 |
| C13 | useDagEngine 无环检测:Kahn 布局静默丢弃环上节点,编辑器无提示 | useDagEngine.ts | P2 |
| C14 | UI 层死接线散项:@saved 死监听、FilterBar 空 defineEmits、StarMap 未发的 dragStart/dragEnd、RuleReviewForm comment 未提交、空 if 块、emit 先于 defineEmits | App.vue:49 等 | P3 |

### 17.D 改进建议(按优先级)

- **P0**:修复 C1(改动态 import);把 electron/electron-builder 钉进 devDependencies 并生成 lockfile;删除 C2 死代码。
- **P1**:接回执行可视化管线(约 10 行,C11);开启 asar + asarUnpack;加 GitHub Actions(vitest + tsc --noEmit);拆分 dialogStore(执行循环移入 macroExecutor 已有骨架);统一 dialog 确认语义(C3)。
- **P2**:法规规则外置为带版本号的 JSON + 运行时加载;L2 清单单源化(JSON 为源,构建期生成 TS 或直接运行时加载);三轨持久化收敛到 Vault;L3 演示数据移出 topology;文档数字由 scripts 自动生成,杜绝 A 类失真。
- **P3**:为 mockElectronAPI 加"与 preload.ts 对齐"的契约测试;补 kernel/domains 覆盖率。

---

## 18. 附录

### 18.1 附录 A:关键数字速查

| 维度 | 数值 |
|---|---|
| 文件总数 / 总行数 | 293 / 70,863(src 142 文件 / 41,011 行) |
| 窗口 | 5 个(全部 frameless):1280×800 / 1200×800×2 / 1000×700 / 800×400 |
| IPC 方法(preload) | ~68 个;域通道 34 个 |
| 微内核 | 12 文件 1,126 行;dispatch 七步链 |
| 服务 | 41 模块 12,552 行(最大 domainConstraints 3,356 行) |
| 状态 | 15 store 6,760 行(最大 dialogStore 2,298 行) |
| UI | 31 组件 + App.vue(1,412)+ 2 composables(useThreeScene 2,810 行);孤儿组件 3;执行可视化三重断裂(8.6) |
| 星图 | 125 节点 = 1 L0 + 6 L1 + 20 L2 + 98 L3;21 技能;24 L2 清单(direct 6/macro 17/chain 1,A5 批新增 2 宏未入星图节点表);5 MCP |
| 安全 | Shell 白名单 12 命令 / 55 危险模式;路径基目录 5 / 禁读正则 18 / 危险扩展 33;HTTP 上限 1MB;法规规则 55 条;VULN 回归 18 条 |
| Token 体系 | 5 级漏斗;4 档模型(512/1024/4096/8192);11 种血缘;实测节省 token 24–25% / 成本 22–25% |
| 测试 | 64 spec / 1,238 用例(默认运行 61);mock 68 方法;coverage 仅 services+stores(40%/30%) |

### 18.2 附录 B:全项目文件清单(293 文件)

> 行数为逐文件实测;职责为一句话概括。统计口径:不含 node_modules/dist/out/coverage/.git/.idea、package-lock.json、tsbuildinfo、二进制图标。

**根目录(26)**

| 文件 | 行数 | 职责 |
|---|---|---|
| index.html | 25 | 主窗口 HTML |
| pipeline.html / debug.html / benchmark.html / rule-review.html | 17×4 | 四个辅助窗口 HTML |
| package.json | 54 | 依赖与 electron-builder 配置(见 14.3 异常) |
| tsconfig.json / tsconfig.node.json | 20 / 22 | 渲染层 / 主进程 TS 配置 |
| electron.vite.config.ts | 49 | 三段式构建,renderer 5 入口 |
| vitest.config.ts | 28 | 测试配置(node 环境,e2e 排除) |
| build-after-pack.js | 33 | afterPack:复制 node_modules 进产物 |
| LICENSE / NOTICE | 198 / 21 | Apache-2.0 全文 / 第三方许可 |
| README.md | 233 | 项目自述(数字失真见 17.A) |
| CONTRIBUTING.md | 113 | 贡献标准(禁 any/as 等) |
| SECURITY.md | 36 | 安全声明(数字失真见 17.A) |
| TEST_REPORT.md | 279 | 测试报告(与实测不符,17.A1) |
| quality-report.json | 81 | 质量快照(许可信息错误,17.A4) |
| L2工具编译标准V1.0.md | 810 | L2 五段式 schema 设计标准 |
| 集成工具设计.txt | 92 | RaaP 设计宣言 |
| .gitignore | 38 | 忽略规则(与已提交的 result json 矛盾) |
| benchmark-result.json / -v2 / -professional | 46 / 219 / 377 | 压测结果三代 |
| test-multi-model-results.json / test-edge-results.json | 178 / 226 | 多模型与边缘测试结果 |

**.github(5)**:SECURITY.md(49)、ISSUE_TEMPLATE/bug_report.md(40)、feature_request.md(23)、config.yml(5)、PULL_REQUEST_TEMPLATE.md(24)。**无 workflows——项目没有 CI。**

**config/l2_manifests(20,声明式存档,无代码消费)**

l2-financial-report-brief(85)、l2-reimbursement-check(96)、l2-weekly-report-draft(85)、l2-contract-risk-review(96)、l2-legal-clause-compare(106)、l2-resume-screening(86)、l2-onboarding-guide-gen(88)、l2-sales-proposal-draft(78)、l2-client-email-compose(58)、l2-meeting-minutes-gen(86)、l2-doc-translate-en(58)、l2-ppt-outline-gen(58)、l2-data-excel-summary(86)、l2-announcement-draft(58)、l2-competitor-analysis(94)、l2-policy-doc-qa(58)、l2-email-categorizer(107)、l2-budget-forecast(86)、l2-nd-review-checklist(58)、l2-kpi-report-gen(96)——与 `src/data/l2Manifests.ts` 一一对应的 JSON 规格快照(见 9.4)。

**electron(11)**

| 文件 | 行数 | 职责 |
|---|---|---|
| main.ts | 173 | 主进程入口:单实例/Vault 初始化/建窗 |
| window-manager.ts | 277 | 5 窗口创建与生命周期 |
| preload.ts | 283 | contextBridge 暴露 ~68 个 IPC 方法 |
| ipc-handlers.ts | 1,252 | 全部 IPC handler 宿主 |
| shell-security.ts | 212 | Shell/HTTP/MCP 白名单与超时(11.2) |
| pathValidator.ts | 124 | 路径基目录/敏感路径/扩展名校验 |
| vault.ts / vault-schema.ts / vault-migration.ts | 131 / 28 / 141 | SQLite Vault/DDL/ localStorage 迁移 |
| mcp-manager.ts | 226 | stdio MCP 子进程管理 |
| types.d.ts | 54 | 主进程类型声明 |

**scripts(3)**:generate-comparison-doc.ts(1,099)、generate-analysis-report.ts(776)、gen-icon.mjs(54)。

**src/ 骨架(10)**:main.ts(40,渲染入口)、env.d.ts(115,类型声明)、models/index.ts(1,189,类型基座)、infrastructure/index.ts(15)、vault/index.ts(169,VaultClient)、App.vue(1,412,根组件)、pipeline-main.ts(32)、debug-main.ts(51)、benchmark-main.ts(51)、rule-review-main.ts(51)(四个辅助窗口入口)。

**src/kernel(12)**:index.ts(276,内核工厂+dispatch)、types.ts(258,契约)、bus.ts(143,事件总线)、context.ts(25,只读上下文)、clusters/route.ts(86)、cache.ts(51)、security.ts(46)、budget.ts(41)、fact.ts(39)、facades/persistence.ts(39)、facades/io.ts(100)、plugins/llm.ts(22)。

**src/domains(24)**——index.ts 均为门面 re-export,handlers.ts 注册总线通道:

| 域 | index | handlers | 域 | index | handlers |
|---|---|---|---|---|---|
| api | 2 | 43 | feedback | 2 | 26 |
| app | 11 | 21 | knowledge | 3 | 14 |
| config | 2 | 23 | mcp | 2 | 20 |
| data | 5 | 19 | memory | 2 | 14 |
| debug | 3 | 19 | node | 4 | 25 |
| dialog | 4 | 14 | pipeline | 4 | 14 |

**src/services(41)**

| 文件 | 行数 | 职责 |
|---|---|---|
| l0SkillRouter.ts | 544 | L0 规则技能直通(8 类)+ 文件名提取瀑布 |
| smartRouter.ts | 400 | 复杂度四维评分 + tier 映射 + 域偏置 |
| strategySelector.ts | 231 | 执行策略选择(direct/宏/链) |
| mabOptimizer.ts | 11 | 多臂老虎机桩位 |
| proactiveScheduler.ts | 43 | 主动调度提示 |
| tokenBudget.ts | 355 | 三周期预算/白名单/超支策略 |
| tokenEstimate.ts | 39 | token 估算(CJK 1.8/其他 0.25) |
| tokenPricing.ts | 95 | 四档价目 + 自定义单价 |
| zeroTokenLearning.ts | 191 | ZOL 零 token 阈值自适应 |
| semanticCache.ts | 554 | 语义缓存(MurmurHash3+LRU+阈值自适应) |
| scheduleOptimizer.ts | 392 | 执行指纹缓存 + 验证缓存 + autoCompile |
| toolRetrieval.ts | 833 | RaaP 混合检索(RRF+分位阈值+反馈调权) |
| embedder.ts | 93 | 本地嵌入(transformers.js,离线降级) |
| vectorStore.ts | 158 | 向量存取(BLOB/余弦) |
| terminologyMap.ts | 34 | 术语映射 |
| fileContext.ts | 106 | 文件上下文检索加权 |
| promptTranslator.ts | 474 | few-shot DAG 规划(≤5 步/768 token) |
| pipelineExecutor.ts | 364 | L1 流水线(6 handler+拓扑+检查点) |
| macroExecutor.ts | 1,061 | L2 宏引擎(8 工具+降级链+血缘) |
| dagCheckpoint.ts | 88 | 确定性检查点(20 条 LRU/24h) |
| ruleEngine.ts | 114 | 规则引擎(9 操作符,零 LLM) |
| dualEngineValidator.ts | 234 | 双引擎执行前审计(fail-safe) |
| factGuard.ts | 246 | 事实守卫 V2(实体容差三层) |
| nerExtractor.ts | 344 | 9 类实体抽取(中文数字解析) |
| domainConstraints.ts | 3,356 | 55 条中国法规约束+生命周期自治理 |
| constraintFeedback.ts | 118 | 约束误报反馈(滑动窗口禁用/降级) |
| crossDocValidator.ts | 170 | 跨文档实体冲突校验 |
| knowledgeBase.ts | 409 | BM25+向量双路知识检索(五级作用域) |
| convMemory.ts | 127 | 对话记忆增量索引+质疑检测 |
| memory.ts | 46 | memoryStore 薄适配器 |
| sseParser.ts | 175 | SSE 流解析(两代 KV 缓存字段) |
| debugLog.ts | 7 | 调试日志透传 |
| hash.ts | 8 | FNV-1a 36 进制哈希 |
| secureStore.ts | 54 | safeStorage 密钥存取 |
| storageMonitor.ts | 132 | 存储占用监控 |
| errorClassifier.ts | 133 | 8 类错误分类(关键词快分+LLM 慢分) |
| onboardingManager.ts | 48 | 首启引导状态机 |
| resultBeautifier.ts | 325 | Markdown 渲染+XSS 过滤+DOCX/PPTX |
| commandPaletteSearch.ts | 135 | 命令面板搜索(前缀/角色/时间加权) |
| dataImporter.ts / dataExporter.ts | 23 / 282 | zip 导入 / 7 类收集器导出 |

**src/stores(15)**

| store | 行数 | 职责 |
|---|---|---|
| dialogStore.ts | 2,298 | 厚编排:对话循环/瀑布路由/DAG 执行/7 暂停点 |
| apiStore.ts | 955 | LLM 网关:熔断重试/流式/计费 |
| nodeStore.ts | 611 | 星图拓扑/L1 状态机/DAG 链/视觉事件 |
| debugStore.ts | 439 | 探针/控制台捕获/计费/回放 |
| mcpStore.ts | 438 | MCP 连接/工具/权限矩阵 |
| memoryStore.ts | 385 | 三层记忆+历史压缩 |
| sessionStore.ts | 306 | 多会话+双模式导出 |
| feedbackStore.ts | 238 | 反馈记录+权重时间衰减 |
| configStore.ts | 219 | 主题/偏好/首导标志 |
| pipelineStore.ts | 209 | 流水线定义+executor 注入点 |
| notificationStore.ts | 192 | 通知队列 |
| ruleStore.ts | 167 | domainConstraints 纯代理 |
| skillStore.ts | 125 | 技能安装/依赖 |
| workflowLogStore.ts | 93 | 工作流日志 |
| knowledgeStore.ts | 85 | 知识分组 CRUD |

**src/components(31)**

| 组件 | 行数 | 职责 |
|---|---|---|
| DialogPanel.vue | 2,927 | 对话主面板:消息流/流式渲染/自定义工具创建 |
| L0Modal.vue | 1,066 | L0 用户输入弹窗 |
| NodeDetailPanel.vue | 596 | 节点详情侧栏(schema/角色/执行) |
| DebugPage.vue | 563 | 旧版内嵌调试页(孤儿组件,被 DebugWindowPage 取代) |
| PipelinePage.vue | 506 | 流水线工作台窗口页(DAG 编辑) |
| ApiSettings.vue | 488 | API 端点/密钥/模型探测 |
| DebugProbePanel.vue | 481 | 内核决策探针可视化 |
| OnboardingWizard.vue | 466 | 首启引导向导 |
| ResultPreviewStage.vue | 409 | 结果预览与导出 |
| DebugWindowPage.vue | 384 | 调试监视器独立窗口页 |
| BenchmarkPage.vue | 371 | 压测台独立窗口页 |
| SettingsPage.vue | 350 | 设置页 |
| CommandPalette.vue | 342 | Ctrl+P 命令面板 |
| DataManagement.vue | 314 | 存储占用/导出/清理 |
| NotificationCenter.vue | 309 | 通知中心 |
| ToolSelector.vue | 174 | 工具选择器 |
| FilterBar.vue | 178 | 星图过滤栏 |
| JobRoleSelector.vue | 143 | 职业角色选择(孤儿组件,未被挂载) |
| ConstraintConfirmCard.vue | 142 | 风险暂停确认卡片(孤儿组件,职责由 DialogPanel 确认条承担) |
| ZolWidget.vue | 122 | ZOL 阈值可视化 |
| Notification.vue | 64 | 单条通知 |
| StarMap.vue | 90 | 3D 星图容器 |
| RuleReview/(9) | — | 规则审核窗口:RuleReviewPage(105)、RuleList(215)、RuleDetail(353)、RuleEditForm(62)、RuleReviewForm(135)、RuleTestPanel(291)、RuleFeedbackChart(122)、RuleSourceCitation(158)、RuleStatusBadge(59);RuleEditForm 实为只读展示,RuleReviewForm comment 采集未提交 |

**src/composables(2)**:useThreeScene.ts(2,810,Three.js 星图场景全部实现)、useDagEngine.ts(558,DAG 编辑引擎)。

**src/data(4)**:topology.ts(273,125 节点生成)、skillCatalog.ts(515,21 技能)、l2Manifests.ts(465,20 清单+自定义 CRUD)、mcpCatalog.ts(64,5 MCP 目录)。

**src/benchmark(3)**:benchmarkRunner.ts(262,压测执行)、testCases.ts(72,16 用例)、statsTracker.ts(148,成本统计)。

**test/(86)**

| 分组 | 文件:行数 |
|---|---|
| unit/(55) | apiStore 179、commandPaletteSearch 104、componentIntegration 317、configStore 256、constraintFeedback 222、convMemory 153、crossDocValidator 149、dagCheckpoint 52、dataExporter 89、dataImporter 112、debugLog 26、debugStore 66、domainConstraints 244、embedder 111、factGuardV2 92、feedbackStore 105、fileContext 63、hash 51、knowledgeStore 106、l0SkillRouter 204、macroExecutor.util 227、macroExecutor.macro 251、macroExecutor.step 301、macroExecutor.tools 558、macroExecutor.dag 463、mcpStore 207、memoryStore 190、nerExtractor 163、nodeStore 321、notificationStore 179、onboardingManager 92、pipelineExecutor 359、pipelineStore 159、proactiveScheduler 53、promptTranslator 249、resultBeautifier 246、ruleEngine 253、ruleStore 105、secureStore 129、semanticCache 480、sessionStore 144、skillStore 147、smartRouter 532、sseParser 223、storageMonitor 78、strategySelector 498、terminologyMap 39、tokenBudget 369、tokenEstimate 129、tokenPricing 117、toolRetrieval 474、vectorStore 149、workflowLogStore 105、zeroTokenLearning 265、zolWidget 61 |
| 根目录(4) | ipcSecurity 355(VULN-01..18 回归)、dualEngineValidator 476、scheduleOptimizer 387、errorClassifier 167 |
| chaos/(1) | dialogState 564(7 暂停点状态机混沌测试) |
| integration/(1) | macroExecutor.e2e 234(宏执行全链路) |
| e2e/(3,vitest 排除) | launch 116、l0Skill 283、stress 376 |
| edge/(2,CLI) | edge-test 301、multi-model-test 259 |
| benchmark/(11) | run-benchmark 376、run-benchmark-v2 520、run-benchmark-professional 714、test-cases-v2 219、test-cases-professional 378、verify-streaming 56、verify-single 79、generate-benchmark-report.js 603、generate-benchmark-report-zh.js 603、generate-industry-report.js 274、README 59 |
| utils/(4) | mockElectronAPI 192、mockStores 531、mockServices 516、testHelpers 12 |
| utils/fixtures/(5) | topology 165、manifests 83、entities 51、messages 43、index 4 |

### 18.3 阅读覆盖说明

- **本报告覆盖 293 个文件中的全部 293 个**(骨架/electron/kernel/domains/data/benchmark/配置/文档逐文件精读;services、stores、composables、components、test 经子任务全量阅读后由主报告交叉核实;关键数字——白名单数、阈值、节点数、测试数、窗口尺寸、行数——均回溯源码或逐文件实测)。
- 附录 B 行数与 `C:\Users\Administrator\AppData\Local\Temp\deveco\holostarmap-filelist.txt` 逐行对账,总数 293/70,863。
- 唯一新增文件:本报告(docs/ARCHITECTURE.md);未修改任何源码。
- 断言冲突一律以源码仲裁后采信:"锚定=停转"实为冻结 L3 衰减(orbitRadOscAmp=0 是 L1 默认值)、"ChatPanel"实为 DialogPanel、命令面板快捷键实为 Ctrl+P(非 Ctrl+K)、node:* 视觉通道实为三重断裂死线(8.6)、各层行数以逐文件加总为准(kernel 1,126 / services 12,552 / stores 6,760 / src 41,011)。

*报告完。生成于 2026-09-11,基线 commit 以工作区当前状态为准。*
