# AGENTS.md — SKY 项目约定

> 面向在本仓库工作的 AI 助手与人类贡献者。**改动前先读这一页。**
> 文档状态：复核到 HEAD `9a957e4`。

---

## 一、文档维护（最重要的一条）

**唯一权威文档在 `docs\`，按角度分册。代码改了，直接改对应那一册——不要新建文档。**

| 改了什么 | 更新哪一册 |
|---|---|
| 路由 / 漏斗 / 门值 / 组合意图 / 宏执行 | `docs\20-请求生命周期与路由.md` |
| 模块划分 / 内核 / 插件 / 领域包 | `docs\10-架构与分层.md` |
| 机制上线、停用、发现死代码 | `docs\30-机制台账与边界.md` |
| shell 名单 / 路径校验 / 写门 / FactGuard | `docs\40-安全模型.md` |
| 会话 / 偏好 / 知识检索 / 项目空间 | `docs\50-记忆与上下文.md` |
| 测试规模 / 覆盖边界 / 题库 / smoke | `docs\60-测试与验收.md` |
| 新增术语、关键文件迁移 | `docs\90-术语表与索引.md` |
| 对外口径、README 数字 | `docs\00-总览与口径.md` + `README.md` |

硬性要求：

1. **每条现状断言带锚点**：写 `src\services\xxx.ts:123`，并确保该处真的是你描述的东西。
2. **数字必须实测**：测试用例数、模块计数等，写进文档前先跑命令拿输出。
3. **代码与文档同批提交**：改了带 `file:line` 锚点的模块，同一提交里更新引用它的分册（行号会漂移）。
4. **不要留旧口径**：分册里只保留当前口径，不并列"旧说法 / 新说法"。

历史文档（2026-09 ~ 2026-10 的架构分析、审计、快照、手册）**已从工作树删除**，git 历史完整保留；追溯方法见 `docs\README.md` 的「历史追溯」。

---

## 二、别踩的坑（都是真实踩过的）

| 坑 | 说明 |
|---|---|
| **`npm test` 全绿 ≠ 真机可用** | `vitest.config.ts` 排除了 `test/e2e/**`；30 个 spec 把 `electronAPI` 打桩，真实文件系统与 IPC 边界在单测里是假的。要真机证据跑 `npm run smoke`（需应用已启动并开放 CDP :9222）。 |
| **`routeKind` 区分不出层** | 各层产出的计划 `routeKind` 都是 `plan`；真正的层在 `funnel:routed` 的 `source`。任何按 `routeKind` 做的分层统计都不可靠。 |
| **L3 的 98 个占位不要清** | 那是作者预留位，属项目约定。历史文档里"清理 L3"的建议**已过期**。 |
| **`config\l2_manifests\` 20 个 vs `l2Manifests.ts` 27 条** | 两处计数口径不同（磁盘清单 vs 代码登记），不是 bug，但统计时必须说明用的是哪个。 |
| **兜底路径门值与主路径不同** | `dialogStore` 的旧内联兜底分支里 L0.5 仍硬编码 0.8，与漏斗 gate 的 0.6 不一致。 |
| **`test\unit\apiStore.timerDispose.spec.ts` 的失败** | 仅在本地 Ollama 运行时失败，是环境噪声，不是回归。 |

---

## 三、开发命令

```bash
npm run dev          # electron-vite 开发模式
npm run build        # 构建
npm run typecheck    # tsc -b + vue-tsc（提交前必须绿）
npm test             # vitest 全量（注意：不含 test/e2e）
npm run smoke        # 真机场景冒烟（需先启动应用 + CDP）
npm run package:win  # 打 Windows 便携版（→ dist\SKY <version>.exe；需能访问 GitHub 下载打包工具）
npx vitest run test/unit/xxx.spec.ts   # 单跑一个 spec
```

覆盖率门槛：lines/functions/statements 40%、branches 30%，**只统计 `src/services/**` 与 `src/stores/**`**。

---

## 四、代码规范（摘要）

- TypeScript `strict: true`；禁止 `any`、`as` 断言、动态属性访问 `obj[dynamicKey]`
- 组件 PascalCase；composable `use` 前缀；store `use` + `Store` 后缀；**service / 工具模块 camelCase**（如 `l0SkillRouter.ts`）
- 测试文件后缀 **`.spec.ts`**（不是 `.test.ts`），放 `test\unit\`
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:`）
- 详见 CONTRIBUTING.md

---

## 五、文档索引

- 入口：[docs\README.md](docs/README.md)
- 分册：`docs\00` 总览 / `10` 架构 / `20` 路由 / `30` 机制台账 / `40` 安全 / `50` 记忆 / `60` 测试与验收 / `90` 术语与索引
- 规范：L2工具编译标准V1.0.md、SECURITY.md
- 证据：历次验收成绩单（已移出仓库，需要时从 git 历史取回）
