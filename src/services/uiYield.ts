/**
 * yieldToUI：把控制权交还渲染层，让 Vue 有机会重绘/响应。
 *
 * 原实现只等 requestAnimationFrame —— 但浏览器/Electron 在**窗口隐藏或遮挡**
 * （document.hidden === true）时 rAF 不触发，`await yieldToUI()` 会**永久挂起**：
 * dialogStore.sendMessage 的每个 `await yieldToUI()` 都卡住 → 路由永不开始 →
 * 验收考试与普通对话整体卡死。这是此前反复出现的"Q1/Q2/Q18 卡死"的确诊根因。
 */
export function yieldToUI(): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    requestAnimationFrame(() => setTimeout(done, 0))
    // 兜底：窗口隐藏/遮挡时 rAF 不触发（document.hidden === true），必须保证有界返回——
    // 否则 sendMessage 的每个 await yieldToUI() 永久挂起、整条管线卡死（考试 Q1/Q2/Q18 卡死根因）。
    setTimeout(done, 50)
  })
}
