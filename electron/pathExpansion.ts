/**
 * F-8 修复：路径模板展开（`%USERPROFILE%` / `%HOME%` → 用户主目录）。
 *
 * 为什么单独成模块：各 `file:*` / `doc:convertToPdf` handler 都注册在
 * `ipc-handlers.ts` 的 `setupIpc` 闭包内、依赖 electron 的 `ipcMain`，单测拿不到
 * （同 `./fileListing.ts` 头注的约定）。展开本身是纯字符串逻辑，抽成叶子实现即可断言。
 *
 * 背景（2026-09-27 亲验，快照 §十二）：展开此前只存在于渲染层
 * `src/services/macroExecutor.ts:130` 的局部 `resolveFilePath`，且全仓 10 处调用
 * **全在 macroExecutor.ts**——主对话路径（`src/stores/dialogStore.ts:613`）把
 * `%USERPROFILE%\...` 字面量直接透传给 `file:read`，主进程按字面量 `resolve()`，
 * 落在一个名为 `%USERPROFILE%` 的目录上 ⇒「文件不存在」。影响面是主对话路径上的
 * **整组原生文件工具**，不止 `read_file`（Q16 实测失败即此因）。
 *
 * 展开只做替换、不做放行判定：调用方仍须在展开后过 `validatePath` /
 * `validateReadPath` / `validateWritePath`，安全边界不变（模板拼路径遍历照样被拒）。
 */
export function expandPathTemplate(input: string, home: string): string {
  if (typeof input !== 'string' || input.length === 0) return input
  // 全局替换：同一模板出现多次也全部展开（原 env:resolvePath 只替首次）
  return input.replace(/%USERPROFILE%/g, home).replace(/%HOME%/g, home)
}
