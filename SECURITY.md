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

## 报告漏洞

如需报告安全漏洞，请开一个带 `security` 标签的 [GitHub Issue](https://github.com/sky-mirrors/SKY/issues)。
