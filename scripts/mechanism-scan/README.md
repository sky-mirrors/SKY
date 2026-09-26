# 机制体检扫描（可复跑资产）

把「已实现但没接线 / 没上屏」的机制扫出来。产物是**判定清单**，不是门禁——动手前按 `file:line` 复核。

```bash
node scripts/mechanism-scan/scan-dormant.mjs     # 休眠模块 + 死导出三分
node scripts/mechanism-scan/scan-bus.mjs         # 总线普查 + 死监听复核
# 可选 --out <path>；默认写仓库根的 .rivet-scan-*.txt（已 gitignore）
```

## scan-dormant.mjs

- **A. 休眠模块**：`src/{services,stores,composables}` 下的 `.ts` 在 `src` 内**零 importer**。
  引用判定**同时计静态 `from '…'` 与动态 `import('…')`**——漏掉动态 import 会把 `imageRenameByDate` / `deliverableCheck` / `sessionMemoryContext` 误报为休眠。
- **B. 死导出三分**（定义于全 `src` 的 `export function|const|let|class`，名字 ≥4）：
  - `truly-dead`：其它 `src`、`test`、本文件自用**三者皆无** → 真死
  - `unwired-tested`：无其它 `src` 引用、**本文件也不自用**、但 `test` 有引用 → 休眠候选（有测试、生产零调用）
  - `internal-only`：**仅本文件自用** → 机制在跑，只是 `export` 冗余
  - 注意顺序：**先判「本文件自用」**——自用即说明机制在跑，不该算休眠候选。

## scan-bus.mjs

- **普查**（仅生产 `src`+`electron`）：`globalBus/bus` 的 `emit|request|requestAsync('chan')` 对 `registerHandler|on('chan')`。
  - `A. 死发射` = 有 emit 无 on；`B. 死监听候选` = 有 on 无 emit。
- **复核**（每个候选，在 `src`+`electron`+`test` 里找调用方）：按**完整带引号字符串**找出现行，排除注册行与注释行 → `DEAD` / `CALLED`。

### 三个必须记住的误报源（都是踩过的坑）

1. **`this.bus.emit(...)` 与类型参数**：正则要覆盖 `(?<![\w$])(?:globalBus|bus)\.` 与 `(?:<[^>]*>)?`。
   旧版 `(?<![\w.])bus\.` 把 `this.bus.emit` 排除（→ `kernel:*`/`pack:*` 假死），漏 `request<T>('chan')`（→ 14 个假死）。
2. **裸子串匹配**：`config:set` 会命中 `config:set-job-role`、`data:export` 会命中 `data:exportZip`。必须按**带引号的完整字符串**匹配。
3. **注释行**：注释里提到频道名会把 `knowledge:get-groups` 误判为已接。
4. **`test/` 只进复核、不进普查**：`bus.spec` 等注册的假频道（`x` / `kept` / `my-channel`）会污染候选表。
5. **变量频道名**：`this.bus.emit(e.type, e)`（`PackLoader`）、`globalBus.emit(AUDIT_CHANNEL, …)` 这类字面量扫不到 →
   `pack:*` / `debug:constraint-feedback` 会一直留在「候选」里，复核阶段靠别处的字面量（类型联合 / 常量定义）才判为已接。

## 最近一次结论（2026-09-26）

- 休眠模块 **0**（`knowledgeMigration` 已接入启动）。
- 死导出：`truly-dead=11`（多为 `kernel/clusters/*` 的**模块形状契约**成员，属「该裁」非「该删」）、`unwired-tested≈51`、`internal-only≈66`。
- 死发射 **9**（8 个星图 `node:*` + `llm-degraded` 扩展点）。
- 死监听：候选 25 → **DEAD 20 / 误判 5**；20 个都是**薄薄一层 bus 门面（包 store 方法）而消费方直接调 store** ⇒ 门面闲置（已裁决**保留域处理层**）。

明细与讨论见 [`../../docs/MECHANISM-DORMANCY-2026-09-26.md`](../../docs/MECHANISM-DORMANCY-2026-09-26.md)。
