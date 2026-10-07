# 领域包（Domain Pack）设计与待填清单

> **按代码取证**，不引用旧文档结论。生成时间：2026-10-07 · HEAD `b9b2411`
> ⚠️ 先纠正一个口径：「领域包设计还没着手做」**与代码不符**——schema、加载器、DSL、生命周期、以及 legal/finance 的实际内容**都已存在**（见 §1）。

---

## 1. 现状（真实覆盖率，按 `find`/`wc` 实测）

| 包 | 文件数 | `pack.json` | `boundary/constraints.json` | `boundary/evaluators/*.ts` | `execution/manifests.json` | `knowledge/` |
|---|---|---|---|---|---|---|
| finance | **5** | ✅ 384 B | ✅ **6 836 B** | ✅ **2 个**（invoice-amount-match / large-transaction-flag） | ✅ 547 B | ❌ 无 |
| hr | **3** | ✅ 380 B | ❌ **无** | ❌ 无 | ✅ 558 B | ✅ `hr-terms.json`（唯一一份） |
| legal | **19** | ✅ 380 B | ✅ **74 566 B** | ✅ **11 个** | ✅ 423 B | ❌ 无 |

legal 的 11 个 evaluator（代码级逃生舱，非声明式）覆盖：
`labor-annual-leave` / `labor-collective-contract` / `labor-contract-probation-limit` /
`labor-dispatch-ratio` / `labor-training-service-period` /
`corporate-shareholder-rights` / `dispute-arbitration-agreement` / `dispute-limitation-check` /
`ip-copyright-ownership` / `ip-patent-employee-reward` / `ip-trademark-registration`

**结论**：不是"没做"，而是**覆盖不均**——legal 厚、finance 中、hr 薄；且 `knowledge/` 几乎没有内容。

---

## 2. 已具备的机制（可直接复用，不必新造）

| 能力 | 位置 | 说明 |
|---|---|---|
| 包 schema | `src/host/pack/types.ts` | `PackManifest` / `PackConstraint` / `ConstraintTrigger` / `ConstraintAction` / `PackExecution` / `PackSource` |
| 约束 DSL 编译 | `src/host/pack/dsl.ts` | `validatePackConstraint()`（schema 校验）、`compilePackConstraint()`（编译为运行时 `DomainConstraint`） |
| 四阶段挂载 | `src/host/pack/loader.ts` | `manifest → knowledge → boundary → execution`；`mountPack` / `unmountPack` / `reloadPack` |
| 领域→包归因 | `src/host/packRuntime.ts` | `getPackIdForDomain` / `getPackIdForManifest` / `getWeight`（用于 pack 级隔离与卸载失效） |
| 钩子桥 | `src/host/packHookBridge.ts` | 把包的 advisory / veto / override 接到六层漏斗 |
| 生命周期事件 | `types.ts` `PackLifecycleEvent` | `pack:mounted` / `pack:mount-failed` / `pack:unmounted` / `pack:reloaded` |
| 逃生舱 | `PackEvaluatorModule` | 声明式表达不了的用代码写 `check(context)` |

**触发语义**（`ConstraintTrigger`，已实现）：`keywords` / `allKeywords` / `excludeKeywords` /
`keywordGroups`（组间 AND、组内 OR）/ `entities`（实体计数）/ `numericCapture`（数值阈值）。
**动作**（`ConstraintAction`）：`severity` / `messageTemplate` / `requireHumanReview` / `humanJudgmentPrompt`。

---

## 3. 缺口（按对"能被别人用"的重要性排序）

1. **hr 内容缺失**：只有 `manifests.json`（558 B）与一份术语表，无约束。
2. **knowledge 覆盖几乎为零**：只有 `hr-terms.json`。包的"领域知识"拿不出手，等于没有领域能力。
3. **第三方包的信任与分发未设计**（开源后的核心问题）：
   - 一个社区 pack 可挂 `override` 钩子到任意层 —— **等于能改写路由与执行**。当前 `loader` 只做 schema/冲突校验，**没有可信度分级**。
   - 没有签名/来源校验，没有"只读 vs 可覆写"的能力声明。
4. **版本兼容只到 `minHostVersion`**：包与宿主的不兼容组合没有矩阵说明。
5. **无包级验收口径**：`examCasesV2` 是全局题库，没有"某包挂载后领域题是否变好"的度量。

---

## 4. 设计规范（建议，待你裁决）

### 4.1 包目录职责（沿用现有约定）

```
<pack>/pack.json                      # 元信息（id/name/version/domain/priority/weight/capabilities）
<pack>/boundary/constraints.json      # 声明式边界规则（DSL，可被第三方编写）
<pack>/boundary/evaluators/*.ts       # 代码逃生舱（默认不开放给第三方，理由见 §5）
<pack>/knowledge/*.{json,md}          # 领域知识（随包挂载进检索库）
<pack>/execution/manifests.json       # 该包自带的 L2 工具 manifest（挂载即接入路由）
```

### 4.2 约束编写约定（声明式优先）

- **能用 DSL 表达的，一律不写代码**：DSL 可校验、可展示、第三方可安全编写；代码逃生舱引入执行风险。
- 每条约束必须带 `testCases`（`PackConstraint.testCases` 已要求）——**没有测试用例的约束不得入库**。
- `severity` 与 `requireHumanReview` 的取舍：能用"提示 + 人工复核"解决的，不用"阻断"。

### 4.3 安全边界（开源前必须定，最关键的待裁决项）

建议按**能力分级**约束第三方包：

| 级别 | 允许 | 不允许 |
|---|---|---|
| L1 知识/术语 | 提供 knowledge、terminology、routing.domainBias | 任何钩子 |
| L2 声明式边界 | L1 + constraints.json（advisory / pre-output veto） | 代码 evaluator、pre-execute override |
| L3 可信包 | L2 + evaluators、pre-execute 能力 | 默认不授予 |

**理由**：`override` 能改路由与执行、`pre-execute veto` 能拦下计划；把这些默认开放给任意下载的包，等于把控制权交给包作者。

### 4.4 建议新增的包级验收

给每个包加一组"领域题"（挂在全局题库之外、按包启用），报告里加 `byPack` 维度——**否则无法回答"装了这个包到底有没有变好"**。

---

## 5. 每域待填清单（建议最小可交付）

| 包 | 建议覆盖 | 现状 |
|---|---|---|
| **hr** | 试用期上限、竞业限制、加班/工时合规、年假折算、裁员补偿（N/N+1）、社保基数 | ❌ 仅 manifest（**优先补**） |
| **finance** | 三表勾稽、现金流预警、应收账龄、税负率异常、费用报销合规 | ⚠️ 有 6.8KB 约束，**建议逐条补 testCases 并核对严重度** |
| **legal** | 劳动（已有 5 项）、公司治理、争议、知识产权（已有 6 项） | ✅ 最厚（74.5KB + 11 evaluator），建议补 knowledge |

---

## 6. 待你裁决

1. **第三方包的能力分级**（§4.3）——是否采纳"默认不授予 evaluator / pre-execute"？
2. **hr 包是否优先补齐**（我建议是：它是三个包里内容最空、而需求最普遍的）。
3. **包级验收口径**（§4.4）是否要做（会给 exam 报告加一个维度）。
4. **`knowledge/` 的内容来源**：由你提供领域材料，还是由包作者写？

---

## 附：本文件的可信度声明

- §1 的字节数/文件数来自 `find` + `wc -c` 实测；`hr/constraints.json` 的存在性**未确认**（标 ❓）。
- §2 的机制清单来自 `src/host/pack/*.ts` 的导出与注释，**已读原文**。
- §3–§6 是**设计建议**，不是既有事实。
