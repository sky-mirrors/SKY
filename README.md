# SKY

**本地优先的 AI 工具控制台 · 实验性技术预览** —— 在桌面应用里路由、校验并执行 LLM 辅助任务，把路由决策及其开销**摊开给人看**，而不是藏起来。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Tests](https://img.shields.io/badge/tests-211%20spec%20files-blue.svg)](docs/60-测试与验收.md)

> 🌐 **语言**：本文件为中文版（主）。英文原文见 README.en.md。

> ## ⚠️ 先读这一段
>
> 这是一个**技术预览，不是产品**。公开出来是为了让这些想法可以被阅读、被运行、被质疑——**不是因为它已经完成**。
>
> - **不承诺稳定性**。接口、数据格式、路由管线都会在提交之间变化，用户数据没有迁移路径。
> - **不承诺支持**。Issue 会看，但没有 SLA、没有路线图承诺、没有值守的维护者。
> - **只有 Windows 是测过的目标平台**。开发模式跨平台可用；打包仅限 Windows，未在 macOS / Linux 上验证过。
> - **你需要自备 LLM API 密钥**。没有密钥时，应用只回退到确定性的规则层。
> - **它能在你的机器上写文件、执行 shell 命令**——这正是它存在的意义。护栏写在[安全模型](#安全模型)里，且刻意保守；但在把它指向你在乎的东西之前，请先读完。
> - **权威文档在 `docs/`**（中文分册）。本 README 是中文入口；英文版见 README.en.md。

---

## 它是什么

一个桌面应用（Electron + Vue 3），接收自然语言请求，并在**花掉 token 之前**就决定**能多便宜地把它答完**：

1. 内置规则就能处理？→ 确定性计划，**0 token**
2. 这个请求以前见过？→ 执行指纹 / 语义缓存命中
3. 关键词能以高置信度命中某个已知宏？→ 单步执行
4. 以上都不行 → LLM 辅助的匹配、规划与执行

每一次路由决策都会被记录下来并在 UI 中可见（哪一层接下了请求、花了多少、产出了什么）。**这种可见性才是这个项目真正的论点**：大多数 AI 工具把路由决策藏起来，而隐藏的路由正是 token 与信任同时泄漏的地方。

## 状态——评估前先读

状态按机制逐条记录在 [`docs/30-机制台账与边界.md`](docs/30-机制台账与边界.md)（「机制台账」），判定规则是：**只有生产调用路径能走到，才算「活」**。

| 区域 | 状态 |
|---|---|
| L0 / L0.5 / L1 规则路由 | **活** —— 见[路由层](#路由层) |
| L2 检索 + 宏执行 | **活** |
| L3 LLM 仲裁 | **活**，但仅当 ≥2 个候选通过筛选时才调用 |
| L4 探索式规划 | **活** |
| 双引擎安全审计、FactGuard、写门 | **活** —— fail-closed |
| 执行指纹缓存、语义缓存 | **活** |
| 竞争 EMA（M16） | **半活** —— 已实现，但默认关闭，生产环境该分支不触发 |
| 消费者上下文截断 | **半活** —— `standard` 档仍只传约 800 字 |
| **技能目录的 DAG 执行** | **未接线** —— 见[能力层](#能力层领域包--技能--mcp-服务) |
| **技能对 MCP store 的覆盖** | **不完整** —— 21 个声明的 server 里有 16 个不在 store 中 |

如果本表的说法与台账冲突，**以台账为准**——它带 `file:line` 锚点。

## 快速开始

```bash
git clone https://github.com/sky-mirrors/SKY.git
cd SKY
npm install
npm run dev
```

环境要求：**Node.js ≥ 18**、**npm ≥ 9**。

### 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | electron-vite 开发模式（带 HMR） |
| `npm run build` | 构建主进程 / preload / 渲染层到 `out/` |
| `npm run typecheck` | `tsc -b` + `vue-tsc --noEmit` —— **必须绿** |
| `npm test` | Vitest，211 个 spec 文件（不含 `test/e2e/**`） |
| `npm run smoke` | 真机旅程冒烟 —— 需要应用已启动并开放 CDP |
| `npm run smoke:window-controls` | 真机检查每个副窗的最小化 / 关闭是否真的生效 |
| `npm run package:win` | Windows 便携版构建 → `dist/SKY <version>.exe` |
| `npm run verify:pdf` / `:image` / `:media` | 文档 / 图像 / 媒体管线的独立 Electron e2e 脚本 |

> **`npm test` 全绿 ≠ 应用可用。** 有 30 个 spec 把 `electronAPI` 打了桩，真实文件系统与 IPC 边界在单测里是模拟的。要关于「真东西」的证据，请用 `npm run smoke` 或 `npm run smoke:window-controls`——两者都通过 CDP 驱动一个正在运行的实例。详见 [`docs/60-测试与验收.md`](docs/60-测试与验收.md)。

### 预构建产物

打 `vX.Y.Z` 标签会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：测试 → 构建 → 便携 EXE → **挂到 draft release** 供发布前审阅。

> 打包会从 GitHub 下载辅助二进制（winCodeSign / NSIS）。受限网络下设置
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 架构

```
输入 → [L0 规则] → [L0.5 关键词] → [L2 清单/缓存] → [L3 LLM] → [L4 探索]
         ↓ 命中        ↓ 命中            ↓ 命中          ↓ 未命中
      确定性计划     单步计划         缓存结果    完整 LLM 规划
                                                          ↓
                                                [双引擎安全审计]
                                                          ↓
                                                    [DAG 执行]
                                                          ↓
                                                   [FactGuard 核验]
                                                          ↓
                                                        结果
```

### 路由层

| 层 | 规模 | 是什么 |
|---|---|---|
| L0 | **12 条规则** | 内置规则表，首中即出（`src/services/l0SkillRouter.ts`） |
| L0.5 | — | 单步清单的关键词快配（门 0.6） |
| L1 | **6** | 单节点能力直调 |
| L2 | **20 个清单** | 场景宏（`config/l2_manifests/`），由 `src/services/toolRetrieval.ts` 匹配 |
| L3 | **98 个占位** | 作者预留的社区槽位——**有意保留**，见台账 |
| L4 | — | 探索式规划（计划不需要 shell 时自动执行） |

门值与置信度公式在 [`docs/20-请求生命周期与路由.md`](docs/20-请求生命周期与路由.md)，那里带代码锚点引用，本文不重复。

## 能力层：领域包 / 技能 / MCP 服务

三个容易混淆、深度也不同的东西：

| | 领域包 | 技能 | MCP 服务 |
|---|---|---|---|
| **是什么** | 领域知识 + 约束 + 执行，挂进每一层路由 | 一份预编排的 DAG 模板 + 声明它需要哪个 MCP server | 外部工具服务，以子进程方式拉起 |
| **能走到路由吗** | **能** —— 在 L0/L0.5/L1/L2/L3/L4 挂载，另有一票否决门 | **不能** —— 目前没有执行侧消费者 | **能** —— L2 命中会产出 `mcp-direct` 调用 |
| **谁执行它** | 领域包运行时 + 约束引擎 | 目前无人 | 主进程管理器 → `mcpStore.callTool` |
| **存放位置** | `{userData}/holostarmap-packs`（内置包单独分发） | vault 键 `holo-skills` | vault 键 `holo-mcp-connections` |

**两条诚实的说明——因为这类东西通常是 README 会藏起来的：**

1. **安装技能不会执行任何东西。** 目录条目带着 `nodes`/`edges`，但没有任何东西把它们喂给 DAG 引擎（`useDagEngine` 只服务管线画布），而 `createSkillFromWorkflow` 没有调用方。今天技能只是一个「发现 + 一键安装」的面板；真正的执行路径是 MCP。
2. **21 个技能里有 16 个声明的 MCP server 是 store 不提供的**（store 只有 5 个）。安装处理器拿声明的 id 去 store 里查，查不到时**静默什么都不做**——不安装、不提示。技能数据本身已经带了完整的 `mcpCommand`/`mcpArgs`，也就是说兜底方案在数据里是现成的，只是查找路径没有用它。

## 安全模型

**fail-closed**：如果某项检查无法得出「安全」的结论，就阻断该动作。

- **shell 白名单**：**12** 个安全命令前缀（`electron/shell-security.ts` → `SHELL_ALLOWED_COMMANDS`）
- **危险模式黑名单**：**77** 条正则（`NODE_E_DANGEROUS_PATTERNS`），外加经审核的 `node -e` 签名
- **MCP 解释器**：允许 5 个（`npx` / `node` / `python3` / `python` / `uvx`）
- **写路径守卫**：写入限制在桌面 / 文档 / 下载目录；`node -e` 的写目标会被解析成绝对路径再检查，阻断 `..` 穿越与可执行扩展名
- **双引擎审计**：规则引擎 + LLM 引擎；任一判定失败即阻断命令，并带 24 小时缓存，重复命令不重复付费
- **写操作审批**：写类工具走三态审批（拒绝 / 一次 / 总是）。**没有授权 = 拒绝。**
- **FactGuard**：输出中的数字、日期、百分比、合同编号与名称会与来源比对；轻微漂移就地修正，凭空编造的实体直接阻断

细节与威胁边界：[`docs/40-安全模型.md`](docs/40-安全模型.md) 与 SECURITY.md。

## 验证

以下数据于 **2026-10-09** 在本仓库实测，命令见下表——**不是从旧 README 抄来的**。

| 检查项 | 结果 |
|---|---|
| `npm test` | **2671 个用例** —— **2670 通过 / 1 失败**，211 个 spec 文件，约 8.7 s |
| 已知噪声 | `test/unit/apiStore.timerDispose.spec.ts` **仅在本地 Ollama 运行时**失败——环境相关，不是回归 |
| `npm run typecheck` | `tsc -b` + `vue-tsc` 干净 |
| `npm run smoke:window-controls` | **35/35** —— 七个副窗全部：按钮渲染出来、`-webkit-app-region: drag` 生效、最小化真的最小化、关闭真的关闭 |
| `node scripts/oss-audit.mjs` | 对每个被跟踪文件做密钥 / 本机路径 / 凭据扫描；`--fix` 会脱敏本机特有路径 |

覆盖率门槛：lines/functions/statements 40%、branches 30%——**只统计 `src/services` + `src/stores`**，所以这个数字不能描述整个代码库。实测总覆盖率 72.74%（详见 [`docs/60-测试与验收.md`](docs/60-测试与验收.md)）。

### 验收考试（自评，缺陷一并列）

仓库自带一套验收考试（V1 18 题、V2 50 题）。历史成绩单已移出仓库——需要时从 git 历史取回。最近一次 V2 运行：**可交付率 0.28**，零干预率 0.64，平均每题 15.0 s。

这个数字很低，而**故意印在这里**：考试刻意的比「答没答上来」更严——它要求在磁盘上产出真实产物，并检查那个产物，而不是回复文本。**不要把上面的路由层表格当成准确率声明。**

## 项目结构

```
SKY/
├── electron/                 # 主进程（33 个模块）
│   ├── main.ts               # 入口：窗口、单实例锁、IPC 分发
│   ├── ipc-handlers.ts       # IPC 路由（文件 / shell / 文档 / 图像 / 媒体 / MCP / vault）
│   ├── shell-security.ts     # shell 引擎（12 条白名单前缀、77 条危险模式）
│   ├── pathValidator.ts      # 读写路径校验
│   ├── mcp-manager.ts        # MCP 子进程生命周期
│   ├── window-manager.ts     # 七个副窗，全部无边框
│   └── preload.ts            # contextBridge 暴露面（121 个键）
├── src/                      # 渲染层（Vue 3）
│   ├── kernel/               # 漏斗编排、钩子、簇、总线
│   ├── kernels/              # 内核插件（default / lite）
│   ├── host/                 # 热插拔宿主（插件 / 领域包）
│   ├── domains/              # 总线通道注册点
│   ├── packs/                # 内置领域包（finance / geotech / legal）
│   ├── services/             # 核心逻辑（72 个模块）
│   ├── stores/               # Pinia store（18 个）
│   ├── components/           # Vue 组件（32 个）
│   ├── exam/                 # 验收考试（V1 18 + V2 50 题）
│   └── data/                 # 静态数据（清单、技能/MCP 目录、遗留拓扑）
├── test/                     # 211 个 spec 文件 + 3 个独立 e2e 脚本
├── config/l2_manifests/      # 20 个 L2 清单 JSON
├── scripts/                  # 冒烟 / 审计 / 报告生成器
└── docs/                     # 权威文档（中文分册）
```

## 已知限制

大致按「咬到你的可能性」排序：

1. **打包仅限 Windows**，其他平台未测。
2. **技能 DAG 不执行**——今天安装技能只是一个目录操作。
3. **16/21 的技能→MCP 依赖静默解析为空**（见上文）。
4. **四个 preload API 没有 UI 入口**（`backupList`、`appHealth`、`knowledgeListEntries`、`mcpGetStatus`）——有能力，没有门。
5. **自定义无边框窗口需要逐窗维护拖拽区与控制按钮**；它们是手工维护的，曾有一个窗口漏掉这些直到真机检查才发现。那个检查现在是 `npm run smoke:window-controls`，但它只断言按钮行为——**窗口拖拽本身靠手工验证，没有自动化**（合成鼠标事件驱动不了原生窗口移动）。
6. **考试成绩偏低**（最近一次 V2 可交付率 0.28）。
7. **遗留的 `src/data/topology.ts`**（125 个节点）是已移除的 3D 星图 UI 留下的数据。它不是对界面的描述；旧版 README 曾暗示相反。
8. **存在半活机制**（竞争 EMA、消费者上下文截断）——已实现但默认不触发。台账里有标记。

## 文档

`docs/` 是权威文档集，中文，一册一主题，每条现状断言都带 `file:line` 锚点并对照代码核过。

| 分册 | 内容 |
|---|---|
| [00-总览与口径](docs/00-总览与口径.md) | 这是什么，以及那些**已不再成立**的说法 |
| [10-架构与分层](docs/10-架构与分层.md) | 进程模型、漏斗装配、热插拔、领域包 |
| [20-请求生命周期与路由](docs/20-请求生命周期与路由.md) | 请求生命周期、门值、置信度公式 |
| [30-机制台账与边界](docs/30-机制台账与边界.md) | 每条机制的状态、缺口清单、边界 |
| [40-安全模型](docs/40-安全模型.md) | shell 引擎、路径校验、写审批、FactGuard |
| [50-记忆与上下文](docs/50-记忆与上下文.md) | 记住了什么、每个请求注入了什么 |
| [60-测试与验收](docs/60-测试与验收.md) | 测试边界、真机冒烟、考试系统 |
| [90-术语表与索引](docs/90-术语表与索引.md) | 术语表与文件索引 |
| [95-技术债与路线图](docs/95-技术债与路线图.md) | 技术债与路线图 |

**项目规则**：代码改动 → 同一提交里更新对应的那一册。历史文档已从工作树删除，需要时从 git 历史取回（见 [docs/README](docs/README.md)）。

## 参与贡献

欢迎 Issue 与 PR —— 环境搭建、代码规范（`strict` TypeScript、禁 `any`、禁类型断言）、`.spec.ts` 约定与 PR 流程见 CONTRIBUTING.md。

## 许可

[Apache-2.0](LICENSE)。第三方组件列在 NOTICE。

## 免责声明

**按原样**提供，不附带任何形式的担保。这个预览版可以读取、写入、移动、删除文件，也可以在运行它的机器上执行 shell 命令，随之而来的是显而易见的风险。请只拿你可以承受丢失的数据来试。
