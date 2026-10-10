# 贡献指南

感谢你对 SKY 的贡献兴趣！

---

## 开发环境

**要求**：
- Node.js >= 18
- npm >= 9
- Git
- Windows（当前打包仅支持 Windows）

**搭建**：

```bash
git clone https://github.com/sky-mirrors/SKY.git
cd SKY
npm install
npm run hooks:install   # 装 pre-push 开源审计钩子（见下「机密与发布审计」）
npm run dev
```

---

## 机密与发布审计

**硬规则：不要把任何真实凭证写进代码**——API key / token / 私钥一律走本机 `secureStore`（`src\services\secureStore.ts`），不进 git。**尤其不要在测试文件里硬编码真密钥**：2026-10-10 就发现过一个 DeepSeek key 随 `test\e2e\*.spec.ts` 进了初始提交，文件后来删了，密钥却仍在公开历史里。

`scripts\oss-audit.mjs` 是发布前 / 出网前的门禁，三道接入：

- **本地 pre-push**（推荐先装）：`npm run hooks:install`。它会在 push 前跑 `--history`，拦住含密钥的提交。急事可 `git push --no-verify` 绕过。
- **CI**：`.github/workflows/ci.yml` 已接入（`fetch-depth: 0`，否则历史扫描失效）。
- **手动**：`npm run audit:oss`。

检出命中时的处置：吊销并轮换该凭证（**唯一根治手段**）；确认可接受后登记进 `scripts\oss-audit-history-whitelist.json`（**只存 sha256，绝不存明文**）。删除文件 ≠ 移除历史——public 仓库一旦推送不可逆。

---

## 分支策略

- `main` — 稳定分支，仅接受 PR 合入
- `feature/*` — 功能开发分支，从 main 拉出
- `fix/*` — 修复分支

---

## 代码规范

### TypeScript

- `"strict": true` — 所有隐式 `any` 和类型不匹配都会导致编译失败
- **禁止** `any`、`unknown`（除非显式允许）
- **禁止** `as` 类型断言
- **禁止** 动态属性访问 `obj[dynamicKey]`
- 对象字面量必须提供显式类型上下文

### 命名

> 2026-10-07：本节示例原先引用的是**已不存在的文件**（`StarMap.vue`、`useThreeScene.ts` —— 3D 星图已于 2026-09-26 移除），
> 且 `文件：kebab-case` 与仓库实际不符（`src/services/*.ts` 实际是 **camelCase**）。以下按磁盘实况更正。

- 组件：PascalCase（`CommandPalette.vue`、`DialogPanel.vue`）
- Composable：`use` 前缀（`useDagEngine.ts`）—— `src/composables/` 目前只有这一个
- Store：`use` 前缀 + `Store` 后缀（`useApiStore`）—— 定义在 `src/stores/*.ts`
- Service / 工具模块：**camelCase**（`l0SkillRouter.ts`、`pipelineExecutor.ts`、`convMemory.ts`）—— 实际风格，非 kebab-case
- 测试：`.spec.ts` 后缀（**不是 `.test.ts`**）—— `test/unit` 下现有 185 个 `.spec.ts`、0 个 `.test.ts`

### Vue 组件

- 使用 `<script setup lang="ts">`
- Props 使用 `defineProps<T>()` 类型声明
- Emits 使用 `defineEmits<T>()`

---

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新功能
fix: 修复 Bug
docs: 文档变更
style: 格式调整（不影响逻辑）
refactor: 重构
test: 测试相关
chore: 构建/工具变更
```

示例：
```
feat: 添加 L2 工具编译清单
fix: 修复流水线窗口置顶状态不同步
docs: 更新 README 截图
```

---

## 测试

```bash
# 运行全部测试
npm test

# 运行覆盖率
npm run test:coverage

# 运行单个测试文件（注意后缀是 .spec.ts，不是 .test.ts）
npx vitest run test/unit/examRunner.spec.ts
```

---

## PR 流程

1. Fork 本仓库
2. 从 `main` 拉出新分支：`git checkout -b feature/your-feature`
3. 开发 + 测试
4. 提交：`git commit -m "feat: your feature description"`
5. 推送：`git push origin feature/your-feature`
6. 创建 Pull Request，填写 PR 模板

### PR 检查项

- [ ] TypeScript strict 编译通过
- [ ] 所有测试通过
- [ ] 新功能有对应测试
- [ ] 无 `any` / `as` 类型断言
- [ ] 提交信息符合 Conventional Commits
