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
└── photos\               # Q15：若干 jpg 图片（EXIF 含拍摄日期更佳；无 EXIF 时按文件修改日期也算合理执行）
```

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
