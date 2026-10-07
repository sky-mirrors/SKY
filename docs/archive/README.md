# docs/archive —— 历史文档归档

**归档时间**：2026-10-07 · 归档时 HEAD：`f9d4490`

这里的 **23 份文档**是项目从 2026-09 到 2026-10 迭代过程中累积的内部文档（合计约 765 KB）。
它们**已被 `docs/HoloStarmap-OVERVIEW-ground-truth.md` 取代**，仅作历史留存，**不要作为现状依据**。

## 为什么要归档

这些文档**系统性滞后于代码**，且多处互相矛盾。2026-10-07 的复核实测到（详见对外总览 §0）：

| 文档称 | 实测 |
|---|---|
| L0.5 过门阈值 `l05Pass = 0.8` | **0.6**（`src/kernel/funnel.ts:36`） |
| FactGuard「只取正文前 5000 字」 | 已改**全文分段抽取**（`src/services/factGuard.ts:47-63`） |
| shell 白名单 19 条 / 危险模式 77 条 | **12 / 82** |
| 测试 1685 用例 / 100% 通过 | **2653 用例** |
| legal 有 7 条 evaluator | **16 个** |

另有：三份「快照」互相覆盖（后者作废前者）、`LIFECYCLE-GAPS` 的条目状态与自身归档表打架、
`AUDIT-RECONCILIATION` 在同一文件内对 P0-2 与 A2-10 给出矛盾结论、`MODEL-CAPABILITY-LEDGER-DESIGN`
是**未实施**的设计稿（其要新建的两个服务文件不存在）。

## 内容索引

| 文档 | 它是什么 |
|---|---|
| `ARCHITECTURE.md` / `ARCHITECTURE-SUMMARY.md` | 架构分析（**星图时代**，其 UI/依赖章节已作废：`useThreeScene` 与 `three` 依赖均已移除） |
| `AUDIT-REPORT-2026-09.md` / `AUDIT-RECONCILIATION-2026-09.md` | 213 项审计与对账（**自相矛盾，不可当现状依据**） |
| `HOTPLUG-ARCHITECTURE.md` | 双热插拔规格书 M1–M20（自述为**评审稿 + 实施修订记录**） |
| `MECHANISM-BOUNDARIES.md` / `最新口径.md` | 20 个机制的边界与可用性判定（快照） |
| `MECHANISM-DORMANCY-2026-09-26.md` / `MECHANISM-ROT-AUDIT-2026-09-25.md` | 机制休眠/腐化扫描 |
| `REQUEST-LIFECYCLE.md` / `LIFECYCLE-GAPS.md` / `CORE-ANALYSIS.md` | 请求生命线与缺口清单 |
| `2026.9.24 / 9.26 / 9.27最新快照.md` | 三份递进快照（后者作废前者） |
| `MODEL-CAPABILITY-LEDGER-DESIGN.md` | 模型能力账本设计（**未实施**） |
| `EXAM-RUNBOOK.md` / `SOAK-RUNBOOK.md` | 考试 / 浸泡执行手册 |
| `知识沉淀-匹配度与RaaP.md` / `漏斗前四层盘点与L1补齐.md` / `领域包-现状评审与待填清单.md` | 专题盘点 |
| `HOLO-OVERVIEW.md` | 早期产品总览 |

## 未归档（仍在 `docs/` 下，属证据与脚本）

- `docs/exam-reports/` —— **验收考试成绩单**（实测证据，对外总览 §10 引用它）
- `docs/exam-fixtures/` —— 考试素材重建脚本

## 注意

- 这里的文档**含代码读不出来的上下文**（当时的取舍理由、失败案例、排查与踩坑记录）——
  这也是它们**没有被删除、而是归档**的原因。需要追溯"当初为什么这么决定"时，来这里是合理的。
- 但**任何"当前状态"的断言都必须回代码复核**（`grep` / `read_file`），不要照抄。
