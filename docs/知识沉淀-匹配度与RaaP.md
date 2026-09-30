# 知识沉淀：匹配度公式与 RaaP（2026-09-30）

> 用途：这些是在本仓**实战验证过**的可复用结论，供后续会话直接引用，避免重复排查。
> 每条格式：**结论 → 证据（file:line / 复现步骤）**。未验证的一律不写。

---

## 1. 「分母是关键词表长度」是一个跨层系统性缺陷（本仓已出现三处）

**结论**：用 `命中数 / 关键词表长度` 当作"匹配度"，会让**表越长越难命中**。固定门值下长表永远过不了门，等价于该能力失效。正确做法是**归一化分母**：`min(表长, 3)`（以 3 词为满分基准；3 词及以下的表行为完全不变）。

**本仓三处实例（均已修）**：

| 层 | 函数 | 原式 | 症状（实测） |
|---|---|---|---|
| L0.5 | `l0SkillRouter.tryL05QuickMatch` 的 `hitRatio` | `命中/表长`，且内层硬门 `conf ≥ 0.8` | 12 个典型输入只命中 1 个（~8%） |
| L1 | `l0SkillRouter.checkL1Capability` 的 `conf` | `min(命中/表长×2, 0.9)` | 8 词表 `l1-model-gateway` 单命中仅 0.25，普通请求全过不了门 |
| L2 | `toolRetrieval.keywordMatchScoreGeneric` 的 `score` | `命中/表长` | 6 词表命中 1 个 = 0.1667、11 词表 = 0.0909，**全部低于门控中信号线 0.3** |

**关键教训**：修 L0.5 时没意识到这是**模式**而非个案，导致 L1/L2 又各自重新发现一遍。**下次遇到"匹配/召回类分数异常低"，第一件事是看分母是不是表长。**

**验证**：`test/unit/l05QuickMatch.spec.ts`、`test/unit/l1Routing.spec.ts`、`test/unit/toolRetrieval.spec.ts`（后者的「表长不再惩罚覆盖广度」已实测**回滚分母即变红**）。

---

## 2. 自适应阈值的采样池只在「命中分支」记录 → 幸存者偏差

**结论**：`computeDynamicThreshold` 依赖历史分数池算阈值。若 `recordScore` **只在命中分支调用**，池里只进"通过的"高分，p50/p95 偏高 ⇒ **阈值越用越严**（正反馈：越拒绝越难通过）。采样点必须在**决策之前**。

**证据**：`src/services/toolRetrieval.ts` 的 `recordScore` 调用位置；回归测试 `test/unit/toolRetrieval.spec.ts` 的**源码级接线断言**（2 空格缩进=决策前 vs 4 空格=分支内）。

**附带**：该池（`_kwScoreHistory`/`_vecScoreHistory`）与 G-13「指纹缓存重启即失忆」同型——现已落盘 `tool / raap-score-history`，每 10 次记录写一次（节流）。

---

## 3. 源码级接线断言：能证伪普通单测覆盖不到的东西

**结论**：改动若是「调用位置 / 缩进 / 顺序」这类**结构性**的，行为级单测往往证伪不了（函数本身没变）。此时用 `readFileSync` 读源码**按行精确比对**。

**陷阱**：Windows 行尾是 **CRLF**，断言里**不能**用 `"a\nb"` 字面量拼接（永远匹配不上）——要 `split(/\r?\n/)` 后按行比。

**证据**：`test/unit/toolRetrieval.spec.ts`（本会话新增，实测把缩进改回 4 空格即红）；既有先例 `test/unit/l1Capabilities.spec.ts` 的 `readFileSync` + `toContain` 接线断言。

**自检纪律**：写完任何回归测试都要自问「**把修复回滚，它会红吗**」。本会话有一次写的两条测试**证伪不了**目标修复（测的是函数本身而非调用位置），发现后补了源码级断言。

---

## 4. 嵌入模型 ≠ 本地 LLM —— 别把两者混为一谈

**结论**：本仓 L2 检索的**向量**来自 `transformers.js` 的 `Xenova/all-MiniLM-L6-v2`（**嵌入模型**，需联网下载 / 有本地缓存）；而 `qwen2.5:3b` 是**生成**模型（Ollama，`src/services/ollamaProvider.ts`），承担生成与工具调用。`src/services/embedder.ts:41` **不接 Ollama** ⇒ **两者角色不同、不能互替**。

**由此暴露的架构观察（未改）**：本地化程度不一致——LLM 走本地 Ollama（离线可用），而 L2 检索所需的嵌入模型却要联网下载。**离线环境下 L2 向量侧失效、退化为纯关键词匹配**（关键词侧已修，可独立工作）。若产品要承诺"本地优先/离线可用"，嵌入模型需一并离线化。

**证据**：`src/services/embedder.ts:41` vs `src/services/ollamaProvider.ts`；实测 `~/.cache/huggingface` 为空（8K 仅目录）、下载被 `unable to verify the first certificate` 阻断。验证入口：`test/integration/l2ProductionCoverage.spec.ts`（不可用时明确 skip 并打印原因，**跳过 ≠ 通过**）。

---

## 5. 本工作区的环境事实（会反复咬人）

**结论**：工作区根 `C:\Users\Administrator` **不是 git 仓库**，实际项目在 `Desktop\HoloStarmap`。`run_tests` 与 `deliver_task` 会被钉在会话根而失败（分别报 `Missing script: "test"` 与 `fatal: not a git repository`）。

**做法**：验证与提交一律用 `bash` 先 `cd` 到项目根；`deliver_task` 的 `learned` 参数在本工作区**不可用**，知识沉淀改走项目内文件。

**证据**：本会话 `run_tests` exit=1 而 `bash npx vitest` 成功（176 files / 2469 passed）；`deliver_task` 两次报 `not a git repository`。

---

## 6. commit message 里别出现半角双引号

**结论**：message 里写 `"xxx"` 会**提前闭合** shell 的双引号，导致 `git commit` 静默失败（EXIT=1 但 HEAD 未动、改动停在 staged，极易误判为"已提交"）。

**做法**：用 heredoc + `git commit -F`。

**证据**：本会话一次 commit 报 `/usr/bin/bash: line 1: =: No such file or directory`，`git log` 未增加，`git status` 显示改动仍 staged。
