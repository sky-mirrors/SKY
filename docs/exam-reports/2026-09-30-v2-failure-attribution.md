# V2 首考失败归因（2026-09-30）

> 起因：用户假设「零干预率和交付率降低的原因可能是工具覆盖率不高和理解问题有问题」。
> 方法：以 `docs/exam-reports/2026-09-30-v2-first.json` 的原始字段（`judgeNote` / `replyExcerpt`
> / `hardAssertPassed` / `interventions`）逐题归因，再回源码定位机制。
> 结论：**两个假设都只对了一半**，且真正的大头在一处可定位的机制缺陷上。

## 一句话结论

V2 的 32 题失败**不是两类原因，而是五类**；其中最大的一块不是模型能力，而是
**产物核验只登记 3 类工具的产物**，导致它误报「未产生任何文件产物」并把模型带偏。

## 归因分布（32 题失败）

| 类别 | 题数 | 代表题 | 说明 |
|---|---|---|---|
| A 产物位置/格式不符 | ~7 | R01 M06 H01 S03 | 要求存 `out` 却存 `docs`/`media`、要 PPT 给了 docx、要 `test.bat` 给了 `test.bat.docx` |
| B 输出质量/未完成 | ~5 | R09 R10 R11 H02 | 只输出内部工具调用链 JSON、没排版、答到一半断了 |
| C 多轮不承接 | ~4 | T01 T02 T04 T05 | 题干已给路径却再索要、被纠正后不改口、答非所问 |
| D 幻觉/假称完成 | ~3 | E07 S04 R14 | 虚构列出不存在目录的文件、声称已复制实被拒 |
| E 系统侧噪声/故障 | ~6 | R04 R16 E10 M02/M04 | 见下节——含确凿的误报 |
| F 判卷可疑 | ~2 | R14 R02 | R14 判「疑似编造」但返回体形似真实 httpbin 响应；R02 硬断言 false 而回复说有产物 |

（分类按主因归类，边界题只计一次；A/B/C/D 合计约 19 题，E/F 约 8 题。）

## 确凿缺陷：产物核验的副作用记录只覆盖 3 类工具

**机制链**（全部 file:line 可回读）：

1. `src/services/macroExecutor.ts:1003-1010` —— `onSideEffect` 的调用总共只有三处：
   `shell_exec`（且仅匹配 `writeFileSync('...')` 字面量）、`file_write`、`create_docx`。
2. `src/services/deliverableCheck.ts:197-232` —— `conformanceCheck(userInput, producedArtifacts)`
   在 `producedArtifacts` 为空时直接返回：
   `「用户要求生成「X」，但本次执行未产生任何文件产物。」`
3. `src/services/deliverableCheck.ts:271` —— 该判定被渲染成注入文本：
   `⚠️ 产物核验：…本次执行未达成用户要求的产物，请如实向用户说明，不得宣称任务已完成。`

**但题库实际在用的产出型工具，多数不在登记名单里**：
`file_move`（`src/services/l0SkillRouter.ts:661`）、`file_copy`（`:692`）、
`image_process`（`:861`）、`media_process`、`create_directory`、`doc_extract` 等。

**实测吻合**：产物核验注入命中 6 题、其中 5 题失败。
`V2-R04`（重命名）是**确凿误报**——它的回复同时包含
「本次执行未产生任何文件产物」与「已重命名/移动: C:\…\notes-renamed.md」，
正是「核验说没产物 + 模型自述做了」两个来源打架，判卷据此判「自相矛盾」。
用 `file_move` 产出的文件从未进入 `producedArtifacts`，一查便知。

> 这就是用户假设 1 的**精确形态**：不是「模型没有工具可用」，而是
> **「核验器不认这些工具的产物」**。两者都会压低交付率，但修法完全不同。

## 假设 2「理解问题」的准确说法是「遵循性」

模型**听得懂**要做什么，但在三件事上不严谨：
- **位置**：R01 把 docx 存 `docs\` 而非要求的 `out\`；R05 把 `v2-newdir` 建到 Desktop 而非 `out\`；
  M06 把压缩视频写成 `media\clip-out.mp4` 而非 `out\`。（**同一模式出现 3 次**，值得当成一条独立问题）
- **格式**：H01 要 PPT 给了 docx；S03 要 `.bat` 给了 `test.bat.docx`。
- **多轮**：T01 题干明明给了 `docs` 路径却再向用户索要；T02 被纠正后仍输出发布会通知。

所以「理解问题」成立，但**更该叫「指令遵循不严」**——它指向提示词/输出契约，而不是模型听不懂话。

## 「零干预率低」的真因：路由落在 plan 层，与工具覆盖率无关

`interventions` 的来源是监考订阅的 `dialog:pause-acquired` 事件。本轮看护日志显示，
V2 触发的 **25 次确认条几乎全是 `plan-confirm-bar`**（计划确认），V1 的 13 次亦然。

含义：**绝大多数题被路由进了 plan 层**，而 plan 层必定弹确认 ⇒ 零干预率必然低。
这跟「模型有没有工具」没有因果关系，与 `docs/ARCHITECTURE-SUMMARY.md:185` 早已记录的
「六层漏斗在验收考试中 18 题 routeKind 全部落到 plan、L1 层近乎死层」是同一件事。

**另需注意口径**：本轮零干预率（V2 18% / V1 52.9%）是「考官逐条及时裁决」下测得的，
裁决次数直接等于暂停点数；跨轮比较必须口径一致。

## 若要动手，建议的优先级

1. **补 `onSideEffect` 的工具覆盖**（改动最小、收益最直接）——把 `file_move` / `file_copy` /
   `image_process` / `media_process` / `create_directory` 纳入登记，或改为「凡声明产出型工具
   即登记其输出路径」。改完应有回归测试：`file_move` 后 `producedArtifacts` 非空 ⇒
   不再误报「未产生任何文件产物」。
2. **降低 plan 层占比**（影响零干预率的主因，但属路由行为，动它要谨慎）。
3. **位置遵循**（3 次同型）——值得看成提示词/输出契约问题单独处理。

**本文只做归因，未改任何代码。**

---

## 修复记录（2026-09-30，本次）

已按上面优先级 ① 落地：

- 新增纯函数 `extractProducedArtifacts(tool, result, args)`（`src/services/macroExecutor.ts` 末尾）——
  从**工具返回值**抽产物路径。之所以必须看返回值：各工具来源不同——`file_move`/`file_copy`
  在「→ to」、`file_convert` 在「已生成 PDF: <path>」、`image_process` 在「<path>（WxH, …）」。
- `executeStep` 的副作用登记改为调用它（原先是两处 `step.tool === …` 字符串匹配，只覆盖
  `file_write`/`create_docx`）⇒ `producedArtifacts` 现在看得见这些工具的产物，
  `conformanceCheck` 不再误报「未产生任何文件产物」。
- 只读/纯生成工具（`read_file` / `list_directory` / `llm_generate`）仍返回空数组，不凭空造产物。

验证：`test/unit/producedArtifacts.spec.ts` 8 条（先 RED 后 GREEN；覆盖 file_move / file_copy /
file_convert / image_process / file_write，以及「失败返回值不产出路径」「只读工具不登记」）；
全量 **179 文件 / 2501 测试通过**；`tsc -b tsconfig.node.json --force && tsc --noEmit` 0 错。

**未修**（保持原状）：
- 优先级 ②「位置遵循」（R01 / R05 / M06 同型 3 次）——属输出契约/提示词层面。
- 优先级 ③「plan 层占比高」（零干预率低的主因）——动路由要谨慎。

**附带发现（环境敏感测试）**：`test/unit/apiStore.timerDispose.spec.ts` 的第三条用例
（「API not ready 应抛异常」）在 **Ollama 运行时必然超时失败**，停掉即通过（本次做了判据实验：
停前 1 failed / 停后 3 passed）。原因是 `providerChain` 会探测本地端口，探测成功后守卫路径
不再抛异常。**跑全量前若开着 Ollama，这一个失败是环境噪声，不是回归**——但反过来说，
该文件缺少对「本地 provider 存在」这一前提的隔离，值得单独修。

---

## 重跑记录与一处归因修正（2026-09-30 晚）

**本轮改动**（`353ecb1` + `46f4109`）：
① `macroExecutor` 的产物副作用登记覆盖所有产出型工具（修「未产生任何文件产物」误报）；
② `fileTaskSystemPrompt` 补三段约束：【输出位置】【格式不具备时】【输出形态】。

**重跑结果**（同环境同素材，成绩单 `docs/exam-reports/2026-09-30-v2-retest.json`）：

| 指标 | 首考 | 重跑 | 变化 |
|---|---|---|---|
| 可交付率 | 36.7% | **38.8%** | +2.1pp（线 80%，仍未过） |
| 零干预率 | 18.0% | **22.4%** | +4.4pp（线 60%，仍未过） |
| 平均耗时 | 31.5s | 30.1s | −1.4s |
| 判卷错误 | 1 | 0 | −1 |
| 失败题数 | 32 | 31 | −1 |

修好 5 题（M02 / M04 / H04 / R14 / E10），退步 4 题（R07 / E03 / S01 / E08）。
**净变化仅 1 题，落在 LLM 采样波动区间内**——据此不能宣称改动有效。
退步那 4 题首考都是过的，形态上也看不出与本次改动相关（R07 是大纲被截断、
S01 是工具异常未如实说明），更像采样抖动。改动 ① 的效果也没能在本轮体现：
R04（首考的误报典型）这轮仍挂。

**归因修正（重要）**：本文前面把「位置错 3 次同型」归为**遵循性/提示词**问题，
**归错了层**。重跑后 R01 / R05 / M06 三道位置题**依然全挂**，且三者回复都是
工具返回值的直接回显（`docx文件已创建: …\docs\notes.docx`、`目录已创建: …\Desktop\v2-newdir`、
`已处理 1 个：…\media\clip-out.mp4`），说明**模型没有参与决定输出路径**。真正的位置来自：

```
src/services/l0SkillRouter.ts:314
  const outputPath = `${baseName}.${effectiveTarget}`
```

`baseName` 是**源文件路径去扩展名**，于是产物必然落在**源文件同目录**——题目写的
「存到 out 下」从未进入这个计算。**这是路由层的参数计算问题，不是提示词问题**；
加 prompt 约束对它无效。加【输出位置】那一段本身不算错（对真正走 LLM 决策的路径有效），
但它**治不了这三题**。

**教训**：把失败归到某一层之前，先验证**那一层是否有权决定那个行为**。
本次「位置错」与提示词类失败（如 M02 的格式诚实）在失败现象上相似，分层却不同。

**下一步的正确修法（本轮未做）**：让 `l0SkillRouter` 的 outputPath 计算识别用户输入里的
目标目录（「存到 X 下」「放到 Y 文件夹」），有则用它，无则退回源目录/桌面。
改完需重跑验证——且届时若同时改动多处，仍会面临同样的归因困难。
