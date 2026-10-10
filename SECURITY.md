# 安全策略

## 已知漏洞

以 `npm audit` 于 **2026-10-09** 实测（SKY `0.1.0`）。

| 范围 | 数量 | 分布 |
|---|---|---|
| **生产依赖**（会打进安装包） | **19** | 1 critical · 11 high · 6 moderate · 1 low |
| 仅开发依赖（从不随包分发） | 10 | 2 critical（`vitest` / `tinypool`）· 2 high · 6 moderate |

> `npm audit` 的总数（29）把仅开发依赖的告警也算进去了。**只有那 19 条生产依赖会影响用户下载到的东西**——开发依赖是构建期工具，永远不会进入打包后的 EXE。

## 修复计划

| 动作 | 优先级 | 工作量 |
|---|---|---|
| 升级 Electron 33.x → 44.x（含 `@electron-toolkit` 5.x） | 高——可清掉多条 High | 约 4–8 小时 + 全量回归 |
| 评估 / 替换 `extract-zip` | 高——直接依赖，上游无补丁 | 约 2 小时 |
| 重新评估 `xlsx` 0.20.3（判断是否仍需要迁移） | 中 | 约 1 小时调研 |
| 跟踪上游 `protobufjs` / `sharp` / `@xenova` 的修复 | 持续 | — |
| 每次发布前用 `npm audit --omit=dev` 重新生成本表 | 持续 | 几分钟 |

## 凭证与机密

**政策**：本仓库**不携带任何真实凭证**。API key / token / 私钥一律经本机 `secureStore`（`src\services\secureStore.ts`）保存，不进代码、不进 git。

### 已披露事件（2026-10-10 全历史审计）

`test\e2e\l0Skill.spec.ts` 与 `test\e2e\stress.spec.ts` 曾在**初始提交**里硬编码一个 DeepSeek API key（形如 `sk-` + 32 位十六进制，值在此脱敏）。

| 维度 | 状态 |
|---|---|
| 当前工作树 | **不含**该密钥 |
| `origin/main` 最新树 | **不含**该密钥（两个文件已于 `d1b63a9` 删除） |
| 公开 git 历史 | **仍含**——提交 `1242e96`、`a3f03fa`，且被 tag `v0.1.0` 引用 |

**处置**：**持有者应立即在 DeepSeek 控制台吊销并轮换该密钥**——这是唯一根治手段。

历史清洗（`git filter-repo` + force push）**不能**回收已被 fork / 镜像 / 爬取的对象，会打断所有现存克隆，故**不作为主要缓解措施**；其收益在密钥轮换后归零。删除文件 ≠ 移除历史：**任何"已移出仓库"的内容，只要进过公开提交，就仍是公开的**。

### 防回归

`scripts\oss-audit.mjs` 在 **CI**（`.github/workflows/ci.yml`）与 **pre-push** 两处运行，覆盖三类：

1. 当前跟踪文件的密钥 / 私钥块 / 已知 token 形态（规则 A、B）
2. 含本机用户名的绝对路径（规则 C1，`--fix` 可脱敏）
3. **git 全历史 blob 内容**里的密钥形态（`--history`，规则 H）——即本次事件漏检的那一类

> 历史扫描的存在意义：规则 A/B 只扫**当前跟踪文件**，删掉文件就扫不到了；而泄漏恰恰发生在**已删除文件的历史版本**里。`--history` 是补这个盲区的。

## 报告漏洞

如需报告安全漏洞，请开一个带 `security` 标签的 [GitHub Issue](https://github.com/sky-mirrors/SKY/issues)。
