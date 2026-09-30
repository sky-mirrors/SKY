# 验收考试执行手册（EXAM 批交付）

> 配套规格：[ACCEPTANCE-SPEC.md](./ACCEPTANCE-SPEC.md)（及格线 v1 定死：可交付 ≥80% / 零干预 ≥60% / 平均耗时 <2min）。
> 考试器：`src/exam/examRunner.ts`，题库 `src/exam/examCases.ts`，入口在工作台 RuntimePanel「验收考试」卡。

## 一、开考前准备

1. **确认模型就绪**：Ollama serve 已启动（`ollama serve`），qwen2.5:3b 可用（或按当时浸泡配置的模型）。
2. **准备桌面素材**（仅 4 题依赖，不就位则跳过并从分母剔除，成绩单如实注明）：

```
C:\Users\Administrator\Desktop\HoloExam\
├── 项目周报.docx          # Q3：转 PDF 源文件（任意内容 docx）
├── 采购合同.docx          # Q18：转 PDF 源文件（任意内容 docx）
├── 张三报销单.txt         # Q16：内容含金额明细——机票 2100 元 + 住宿 1450 元 + 出租车 420 元（合计 3970 元）
├── photos\               # Q15：**每轮开考前必须复位**（见下方复位命令）
└── photos_backup\        # Q15 的规范素材源（img0..img3.jpg，各自保留原始 mtime）
```

**每轮开考前复位 `photos\`（必须，别省）**：Q15 会把图片改名成 `YYYYMMDD-NN.jpg` 并**留在原目录**——若不清空就直接 `cp` 拷回，历次改名结果会**逐轮累积**（目录混入 `20191207-08.jpg` 等残留），既污染 Q15 的目录硬断言（`^\\d{8}-\\d{2}\\.(jpg|jpeg|png)# 验收考试执行手册（EXAM 批交付）

> 配套规格：[ACCEPTANCE-SPEC.md](./ACCEPTANCE-SPEC.md)（及格线 v1 定死：可交付 ≥80% / 零干预 ≥60% / 平均耗时 <2min）。
> 考试器：`src/exam/examRunner.ts`，题库 `src/exam/examCases.ts`，入口在工作台 RuntimePanel「验收考试」卡。

## 一、开考前准备

1. **确认模型就绪**：Ollama serve 已启动（`ollama serve`），qwen2.5:3b 可用（或按当时浸泡配置的模型）。
 要求**目录内每个文件**都匹配），也让清单失真。复位命令（Git Bash；`cp -p` 保留原始 mtime，日期才有区分度）：

```bash
rm -f /c/Users/Administrator/Desktop/HoloExam/photos/* \
  && cp -p /c/Users/Administrator/Desktop/HoloExam/photos_backup/img*.jpg \
           /c/Users/Administrator/Desktop/HoloExam/photos/
```

复位后 `photos\` 应**恰好**为 `img0.jpg img1.jpg img2.jpg img3.jpg`（img0 属一个较新日期、img1..img3 同为另一较早日期，用以验证「同日按序号」）。**判据取 ≥2 轮**时，每轮开考前都要复位一次。

3. **勾选「桌面考试素材已就位」**（RuntimePanel 考试卡内），或保持不勾让 4 题跳过。
4. **准备 40~60 分钟不被打断的时间**：18 题串行执行，单题超时上限 5 分钟。

## 二、考试中纪律

- **不要在对话框手动输入**——每题一条消息由考试器发送，手动输入会污染监考归因窗口。
- **暂停点正常裁决**：出现计划确认/风险确认/槽位填充时，在确认条上正常点击——每次暂停点计入该题「干预次数」（零干预率的分母来源）。裁决要及时，单题计时含裁决时间。
- 出现意外（跑偏、死循环）可点「中止考试」：已完成题目仍计入成绩单。

## 三、成绩单

- 导出位置：`Desktop\HoloStarmap\exam-report.json`（RuntimePanel 卡内「导出成绩单」）。
- 字段：每题 status / durationMs / interventions / routeKind / hardAssertPassed / judgeVerdict / failureStage / traceId / totalTokens；汇总 deliverableRate / zeroInterventionRate / avgDurationMs 对照及格线。
- **判卷结合制**：硬断言（数值/关键信息/文件存在/目录模式，`examCases.ts` 逐题预置）+ 模型判卷（`EXAM_JUDGE_PROMPT_V1`，版本化）；每轮抽 20% 人工复核校准判卷误判率（人工动作，抽样清单从成绩单 questions 随机取 4 题）。
- 失败幕（routing/planning/execution/output）为**启发式归因**（路由→计划→执行→输出顺序判定），人工复核时修正。

## 四、决策记录（EXAM 批设计裁决，2026-09-20）

1. **exam 隔离 ≠ benchmark 隔离**：语义缓存/预算/ZOL 三面隔离（`isLearningIsolated`，apiStore），但 **record-cost 照常记账**——监考归因依赖 traceId 成本流，实现「学习回路不污染、记账正常、行为等价真实使用」（ACCEPTANCE-SPEC 考试器约束第 4 条）。
2. **taskType 通道**：主路径 LLM 调用只带 traceId，`sendMessage` 加 `opts.taskType='exam'` → traceId 注册进 examRegistry（`src/exam/examRegistry.ts`）→ apiStore 反查。判卷调用直接带 `taskType: 'exam'`。
3. **指纹缓存不隔离**（偏离规格中"实例级指纹缓存 P1-33 模式"的明文，理由记录在案）：考试=真实使用形态，每题单次执行，指纹库参与恰是真实行为，隔离反而让成绩失真（隐藏缓存命中路径）；污染面仅 autoCompile 统计 +1/题，可接受。若复考发现缓存命中干扰成绩，再上隔离。
4. **完成检测用状态轮询**（isProcessing + 暂停态稳定窗 + 超时兜底）：`sendMessage` 各分支恒 fire-and-forget，无可靠完成事件；超时后系统仍忙则排水等待，排水失败中止考试（避免带着在途执行发下一题污染归因）。
5. **顺手修复 G-17**：流式两处 `recordOutcome` 原缺隔离守卫（benchmark 泄漏 ZOL 的潜伏缺口，exam 流量必经），见 LIFECYCLE-GAPS.md。

## 五、活儿集与外科手术题（runner 外，手工执行）

- **活儿集（5~10 题）**：从用户手头真实待办的活儿中征集，逐题在对话框正常执行，按成绩单同字段（可交付/耗时/干预/traceId）手工记录，与固定集**分开报告**。
- **手术题（G-16 专测）**：
  - 重复任务题 ×2：同类活儿（会议纪要、表格汇总）隔场做两次，对比第二次干预数应下降——不降即坐实跨会话失忆；
  - 偏好题 ×1：记忆面板手动设「输出要简洁」→ 执行周报任务 → 行为应变即记忆活，不变即坐实死存储。
- 手术题结果决定 G-16 修复排序（LIFECYCLE-GAPS.md 既定结论）。

## 六、复考注记（A3 修复批后，2026-09-21）

- **非首考基线**：A3 批（P0-A RaaP 误路由门控 / P0-B 超时统一阶梯 / P0-C 会话归属+偏好注入）修复后复考。**指纹缓存已污染**（首考 18 题已入指纹库，P1-33 不隔离决策维持），语义缓存/ZOL/预算仍隔离——缓存命中可能使复考耗时偏低，deliverableRate 为主对照项，耗时项仅供参考。
- **复考期间禁切 🛠/🌌 模式**：EXAM-1 未修（考试器状态仍寄生于 RuntimePanel，模式切换孤儿化）。
- **代码加载**：复考须重启应用（新 bundle 生效）+ Ollama 模型预热（应用不传 keep_alive，5 分钟无调用即卸载；预热法：发一条 128 token 小请求确认响应正常）。
- **手术题预期变化**（P0-C 落地后）：
  - 重复任务题：仍不预期干预数下降（隐式蒸馏未实现，仅显式偏好注入已落地）；
  - 偏好题：记忆面板设「输出要简洁」→ 周报任务行为应变即 P0-C 生效（apiStore.chatCompletion 注入 `[用户偏好]` 前缀）；
  - 会话切换题（新增，验 F-1）：发送长任务后立刻切换会话 → 响应应落入原会话而非新会话。
- **报告标注**：成绩单与手术题报告须注明「非首考基线（A3 修复后复考，指纹缓存已污染）」。

## 七、复考执行记录（2026-09-21 已完成）

- **执行**：10:48:44 开考，18 题全部真实执行（无语义缓存命中——exam 流量 G-17 隔离学习回路，指纹污染失真未发生，耗时数据诚实），10:58:41 收卷，全程 9.9 分钟。
- **成绩**：可交付率 44.4%（8/18，线 80% ✗）、零干预率 72.2%（线 60% ✓）、平均耗时 25.8s（线 120s ✓）——仍 NO-GO，但较首考 5.6% 提升 8 倍；路由误投 8→0、超时 abort 7→0，剩余失败全为模型能力问题。明细见 `../exam-report.json` 与 `LIFECYCLE-GAPS.md` 复考对照表。
- **手术题 4/4**（`../surgical-report-reexam.json`）：偏好注入 PASS（106 token 简洁周报 vs 隔离对照 670 token 冗长）、会话归属 PASS（响应落原会话/新会话零污染/持久化落地）、重复任务×2 = 第二次语义缓存命中 2s 秒回（非隐式蒸馏，符合 G-16 范围声明）。
- **新发现 EXAM-6**：考试器完成后 UI 冻结显示「执行中」（progress 普通对象绕过 Vue 响应性），需点面板内其他响应式控件（如「导出浸泡报告」）强制重渲染才能刷出成绩单；成绩单仅存内存，刷新/切模式即丢。已入册 LIFECYCLE-GAPS.md，与 EXAM-1 同批修。
- **事故记录**：首考成绩单被复考导出覆盖（同路径 exam-report.json），首考关键指标以 LIFECYCLE-GAPS.md 与 surgical-report.json 存档为准。

## 八、V2 扩展题库（50 题，2026-09-30 接入）

> 出处：`src/exam/examCasesV2.ts`。与 V1（18 题）**并存、互补，不替代**——V1 仍是
> ACCEPTANCE-SPEC v1.0 的对照基线，历轮成绩可比性依赖它。入口在工作台 RuntimePanel
> 考试卡的「题库」下拉（缺省 V1）。

### 8.1 素材清单

在 §一 的 V1 素材之外，V2 另需下列素材——不就位则 25 处 `requiresFixture` 题被跳过
并从分母剔除（成绩单会如实注明跳过数，但那样的分数不代表 V2 真实水平）：

```
C:\Users\Administrator\Desktop\HoloExam\
├── docs\                 # 新增
│   ├── notes.md          # 多题共用：转 docx/xlsx/pdf、复制、列 md、多轮改写（含小标题）
│   ├── sample.docx       # R02：docx → txt
│   ├── data.xlsx         # R13：xlsx → csv（3 行销售数据）
│   ├── expense.txt       # R16：报销合规检查（含 2480 元超限且未附发票的条目）
│   └── empty.txt         # E08：空文件，必须恰为 0 字节
├── media\                # 新增
│   └── clip.mp4          # 4 秒、含音视频轨：M03 抽音轨 / M04 取第 2 秒画面 / M06 crf 压缩
├── out\                  # 新增：产物落盘目录（空目录即可）
└── photos\
    └── sample.jpg        # 新增（640×480）：M01 缩到 200 宽转 webp / M05 压缩质量 60
```

素材可用仓库内脚本重建：`node docs/exam-fixtures/make-fixtures.cjs`（幂等，只写上述路径）。

### 8.2 每轮开考前的复位（V2 同样必须）

V2 的 photos/media 题会把产物留在**源目录**，与 V1 Q15 的目录断言冲突，故每轮前复位：

```bash
# 跑 V1 前：photos 必须是 img0..img3.jpg（Q15 要求目录内**每个**文件都匹配 ^\d{8}-\d{2}\.
# 故此时不能有 sample.jpg）：
rm -f /c/Users/Administrator/Desktop/HoloExam/photos/* \
  && cp -p /c/Users/Administrator/Desktop/HoloExam/photos_backup/img*.jpg \
           /c/Users/Administrator/Desktop/HoloExam/photos/

# 跑 V2 前：photos 需含 sample.jpg（img0..img3 可留，均为图片，不碍 M05）：
rm -f /c/Users/Administrator/Desktop/HoloExam/photos/* \
  && cp -p /c/Users/Administrator/Desktop/HoloExam/photos_backup/img*.jpg \
           /c/Users/Administrator/Desktop/HoloExam/photos/ \
  && cp -p /c/Users/Administrator/Desktop/HoloExam/photos_backup/sample.jpg \
           /c/Users/Administrator/Desktop/HoloExam/photos/

# 两册都建议清空 out\ 与 media\ 的产物：
rm -rf /c/Users/Administrator/Desktop/HoloExam/out/*
rm -f  /c/Users/Administrator/Desktop/HoloExam/media/clip.mp3 \
       /c/Users/Administrator/Desktop/HoloExam/media/*.png \
       /c/Users/Administrator/Desktop/HoloExam/media/*.jpg
```

> **交叉污染（重要）**：V2 的 M01/M05 往 `photos\` 写产物，M03/M04 往 `media\` 写产物；
> 而 V1 Q15 要求 `photos\` 内全部匹配改名模式。**两套题库必须分轮跑**，跑完 V2 想跑 V1 时
> 必须执行上面的 V1 复位，否则 Q15 会因残留 `sample.jpg` / `.webp` 而判假。

### 8.3 断言口径：dirPattern 的 mode

`dirPattern` 由 `examRunner.ts` 的 `dirMatches` 执行，其脚本对目录内文件名做**量词**判定：

| mode | 语义 | 用在何处 |
|---|---|---|
| `every`（缺省） | 目录内**每个**文件都必须匹配模式 | V1 Q15：改名后目录内应全为新名，残留 `img0.jpg` 即判假 |
| `some` | 目录内**存在**匹配文件即算 | V2 产物类断言：源文件与产物共存是常态 |

V2 中 **R05/M01/M03/M04/M06** 显式用 `some`；**M05 保持 `every`**——若把 M05 也改成
`some`，源文件 `sample.jpg` 本身即匹配 `\.(jpg|jpeg|webp|png)$`，断言会**恒真**、丧失鉴别力。

给 V2 增改断言时先自问一句：**源文件本身能匹配该模式吗？**
- 能匹配 ⇒ 用 `some` 会恒真（等于没断言）
- 源文件与产物必然共存 ⇒ 用 `every` 会恒假（等于必挂）

### 8.4 规模与耗时

| 册别 | 题数 | 依赖素材的题 | 预估耗时 |
|---|---|---|---|
| V1 固定集 | 18 | 4 | 约 40 分钟（见 §一） |
| V2 扩展集 | 50 | 25 | 约 110 分钟（按题数线性外推，仅供排期参考） |

及格线口径（可交付 ≥80% / 零干预 ≥60% / 平均耗时 <2min）按 §三 同口径套用，但
**V2 的成绩不与 V1 的历史成绩直接对比**——两册题目构成不同。
