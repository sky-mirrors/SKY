# HoloStarmap

**全息星图企业级智能工具集成控制台 — 125节点太空拓扑交互界面**

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/sky-mirrors/HoloStarmap) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![TypeScript Strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Tests](https://img.shields.io/badge/tests-442%2F442-brightgreen.svg)](TEST_REPORT.md)

<!-- 截图待补充 -->
<!-- ![HoloStarmap 3D Star Map](docs/screenshot.png) -->

---

## 简介

HoloStarmap 是一款企业级智能工具集成控制台，基于 Electron + Vue 3 + Three.js 构建，以 125 节点太空拓扑 3D 可视化界面为核心交互范式，实现了从自然语言输入到多步骤自动化执行的全链路工具调度。

**核心价值观**：安全 + 本地优先、省 Tokens 为第一优先级、错误 > 多执行一步。

---

## 核心特性

- 🌌 **3D 太空拓扑可视化** — 125 个工具节点（1 L0 + 6 L1 + 20 L2 + 98 L3）以恒星/行星/星尘形态分布在三维立方体中，鼠标悬浮高亮、Ctrl 多选、拖拽组建流水线
- ⚡ **零 Token 路由** — L0 规则引擎（7 条规则）命中即跳过 RaaP 直接执行，L0.5 关键词快速匹配（置信度 >= 0.8），执行指纹缓存复用历史结果，规则引擎 fallback 零 Token 替代 LLM
- 🔗 **DAG 流水线引擎** — 拓扑排序、检查点断点续跑、并行组调度、数据流校验，支持 serial/parallel 两种模式
- 🛡️ **双引擎安全审计** — 规则引擎 + LLM 双重验证 Shell 写操作，77 条危险模式黑名单 + 6 条可信签名白名单
- 🔍 **FactGuard 事实校验** — 自动检测金额/日期/百分比/合同编号/人名五类实体，轻微差异自动修正，严重冲突阻断输出
- 🪟 **多窗口协同** — 主窗口（星图+对话+预览）+ 流水线窗口（DAG 编辑器）+ 调试窗口（Probe 探针），Pinia 状态实时同步

---

## 架构概览

### 四层工具拓扑

| 层级 | 数量 | 分布 | 角色 |
|------|------|------|------|
| L0 用户本体 | 1 | 原点 (0,0,0) | 自然语言输入中心 |
| L1 基础工具 | 6 | 半径 2.5 六方向 | 知识库投喂员 / 模型网关 / 任务翻译官 / 流水线搭建台 / 工作区记忆体 / 结果美化师 |
| L2 场景工具 | 20 | 棱心+角心（缩放 3.0） | 财报解读 / 合同审查 / 简历初筛 / 销售提案 / 周报草稿 等，按职能角色分配 |
| L3 社区工具 | 98 | 黄金角球面（半径 5.0） | SEO优化 / 舆情监控 / 发票OCR / 情感分析 等，社区热度排序+衰减 |

### 数据流

```
用户输入 → [L0规则路由] → [L0.5快速匹配] → [L1能力检测] → [RaaP规划] → [双引擎审计] → DAG执行 → [FactGuard] → 结果美化 → 预览台
              ↓ 命中            ↓ 命中         ↓ 命中        ↓ 缓存命中    ↓ 缓存命中              ↓ 规则命中
            0 tokens        单步执行       直调L1工具      跳过审计     复用结果              0 tokens
```

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9
- Windows（当前仅支持 Windows 打包）

### 开发

```bash
git clone https://github.com/sky-mirrors/HoloStarmap.git
cd holostarmap
npm install
npm run dev
```

### 打包

```bash
npx electron-vite build
npx electron-builder --win portable
# 输出: dist/HoloStarmap 0.1.0.exe
```

---

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Vue | 3.5 |
| 状态管理 | Pinia | 2.2 |
| 3D 引擎 | Three.js | 0.170 |
| 桌面框架 | Electron | 33.x |
| 构建工具 | electron-vite + electron-builder | - |
| 类型系统 | TypeScript (strict) | ES2020 |
| 文档处理 | docx / xlsx / pdf-parse / mammoth | 9.7 / 0.18 / 2.4 / 1.12 |
| 向量嵌入 | @xenova/transformers | 2.17 |
| 安全清洗 | DOMPurify | 3.4 |
| 编码检测 | jschardet + iconv-lite | 3.1 + 0.7 |
| 测试框架 | Vitest | 3.x |

---

## 项目结构

```
holostarmap/
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 入口：窗口管理 + IPC 调度
│   ├── ipc-handlers.ts          # IPC 路由（文件/Shell/HTTP/MCP/密钥）
│   ├── shell-security.ts        # Shell 安全引擎（77 条黑名单 + 6 条白名单）
│   ├── mcp-manager.ts           # MCP 子进程管理器
│   ├── window-manager.ts        # 多窗口创建 + 全局快捷键
│   ├── preload.ts               # contextBridge 暴露 electronAPI
│   └── types.d.ts               # Electron API 类型定义
├── src/                         # 渲染进程（Vue 3）
│   ├── main.ts                  # Vue 应用入口 + Pinia 初始化
│   ├── App.vue                  # 根组件：星图/预览切换 + 快捷键
│   ├── models/index.ts          # 全局类型定义（815 行）
│   ├── components/              # 14 个 Vue 组件
│   │   ├── StarMap.vue          # 3D 星图容器
│   │   ├── DialogPanel.vue      # 对话面板 + 工具调用
│   │   ├── ResultPreviewStage.vue # 结果预览台（分块编辑）
│   │   ├── FilterBar.vue        # 层级/角色/搜索过滤
│   │   ├── NodeDetailPanel.vue  # 节点详情侧边栏
│   │   ├── PipelinePage.vue     # DAG 流水线编辑器
│   │   └── ...
│   ├── composables/             # Vue Composables
│   │   ├── useThreeScene.ts     # Three.js 场景管理（相机/射线/选择）
│   │   └── useDagEngine.ts      # DAG 执行引擎 Hook
│   ├── services/                # 核心业务逻辑（13 个）
│   │   ├── l0SkillRouter.ts     # L0 规则路由 + L0.5 快速匹配
│   │   ├── pipelineExecutor.ts  # DAG 执行器 + 检查点
│   │   ├── scheduleOptimizer.ts # 执行指纹缓存 + 自动编译 + 模型分层
│   │   ├── mabOptimizer.ts      # 多臂赌博优化器（Thompson 采样）
│   │   ├── ruleEngine.ts        # 规则引擎（10 种运算符）
│   │   ├── dualEngineValidator.ts # 双引擎安全审计
│   │   ├── factGuard.ts         # 事实一致性校验（5 类实体）
│   │   ├── promptTranslator.ts  # Prompt 编译 + 消歧缓存
│   │   ├── knowledgeBase.ts     # 混合检索（向量/关键词/伪向量）
│   │   ├── embedder.ts          # 本地 Embedding + 余弦相似度
│   │   ├── macroExecutor.ts     # L2 宏执行器
│   │   ├── proactiveScheduler.ts # 主动调度预生成
│   │   └── ...
│   ├── stores/                  # Pinia 状态仓库（13 个）
│   ├── data/                    # 静态数据
│   │   ├── topology.ts          # 125 节点拓扑生成（黄金角球面算法）
│   │   ├── skillCatalog.ts      # 技能市场目录
│   │   ├── mcpCatalog.ts        # MCP 服务器目录
│   │   └── l2Manifests.ts       # L2 工具编译清单
│   └── env.d.ts                 # 环境类型声明
├── test/                        # 测试目录
│   ├── unit/                    # 单元测试
│   ├── integration/             # 集成测试
│   ├── e2e/                     # 端到端测试
│   ├── chaos/                   # 混沌测试
│   └── utils/                   # 测试工具
├── config/                      # 配置
│   └── l2_manifests/            # L2 Manifest JSON 配置
├── resources/                   # 应用资源
│   ├── icon.ico
│   └── icon.png
├── 集成工具设计.txt              # 原始设计文档
├── L2工具编译标准V1.0.md         # L2 编译规范
├── TEST_REPORT.md               # 测试验收报告
├── electron.vite.config.ts      # 构建配置
├── vitest.config.ts             # 测试配置
├── tsconfig.json                # TypeScript 配置
└── package.json                 # 项目元数据
```

---

## Token 优化机制

| 机制 | 命中时节省 | 触发条件 |
|------|-----------|---------|
| L0 规则路由 | 100%（跳过 RaaP） | 7 条规则模式匹配 |
| L0.5 快速匹配 | 跳过多步规划 | 关键词命中 + 置信 >= 0.8 |
| 执行指纹缓存 | 100%（复用结果） | 相同输入指纹 + 相同 manifest |
| 规则引擎 fallback | 100%（替代 LLM） | LLM 不可用 + 规则命中 |
| 双引擎审计缓存 | 500-2000 tokens/次 | 24h 内重复审计 |
| FactGuard 自动修正 | 避免重新生成 | 轻微事实差异 |
| 消歧缓存 | 跳过 LLM 消歧 | 1h 内相同查询+候选 |
| 模型分层 | 按 maxTokens 分配 | nano(512)/mini(1024)/standard(4096)/pro(8192) |
| 主动调度预生成 | 用户到达时 0 消耗 | 时间/行为规则触发 |
| 流水线检查点 | 已完成步骤复用 | 断点续跑时 |

---

## 安全体系

### Shell 安全引擎
- **白名单**：19 条安全命令前缀（npm install / ls / dir / cat / echo 等）
- **黑名单**：77 条危险模式正则（child_process / net / http / eval / rm -rf / powershell 等）
- **信任签名**：6 条 node -e 可信 require（docx / xlsx / pdf-parse / mammoth / archiver / marked）
- **写路径白名单**：仅允许写入 Desktop / Documents 目录
- **超时分层**：快速 10s / 标准 60s / 重型 120s / 绝对上限 180s

### 双引擎安全审计
- **规则引擎**：检测写操作 / 高风险删除命令，提取目标文件路径
- **LLM 引擎**：评估意图匹配 + 参数合理性 + 风险等级
- **缓存**：24h TTL，最大 500 条，命中跳过 LLM 审计

### FactGuard 事实校验
- **5 类实体**：金额（差异 > 10% 严重）、日期（差异 > 3 天严重）、百分比、合同编号（任何不匹配严重）、人名
- **自动修正**：轻微差异替换原始文本（零 Token）
- **幻觉检测**：输出中出现源文档不存在的实体

---

## 测试

| 指标 | 数值 |
|------|------|
| 测试文件数 | 15 |
| 总用例数 | 442 |
| 通过率 | **100%** |
| 发现并修复 Bug | 3 |

详见 [TEST_REPORT.md](TEST_REPORT.md)。

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [集成工具设计.txt](集成工具设计.txt) | 原始设计文档（3D 星图视觉+交互规范+岗位技能包策略） |
| [L2工具编译标准V1.0.md](L2工具编译标准V1.0.md) | L2 层工具编译规范（Manifest 类型定义 + 执行模式 + 参数映射） |
| [TEST_REPORT.md](TEST_REPORT.md) | 测试验收报告 |

---

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建、代码规范和 PR 流程。

---

## License

[MIT](LICENSE)
