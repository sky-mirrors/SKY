// P0-B（A3 修复批）：LLM 调用超时统一阶梯。
//
// 背景（验收考试执行类失败 7/18 题）：全仓 4 处独立超时阶梯（apiStore 非流式/流式、
// ipc-handlers 非流式/流式）均为 15s/45s/75s/120s 四档，按 CPU 后端实测
// （qwen2.5:3b 纯 CPU ~10 tok/s，156-in/2-out nano 调用即需 ~6s，512 token 满额需 ~51s）
// 结构性不可行——macro nano 档 8s 阶梯基本 abort 一切，唯一幸存路径是直连 15s 档
// （Q13 因此成为首考唯一通过题）。macroExecutor 另有独立 STEP_TIMEOUT_MS 阶梯遮蔽
// apiStore 阶梯（其中 2 档实为死代码）。
//
// 本模块为唯一定义点：
// - tierTimeoutFor(maxTokens, scale)：≤512→60s；≤4096→150s；≤8192→240s；else 300s；
//   绝对上限 600s（scale 可让慢机整体放大，经 UserConfig.llmTimeoutScale 暴露到设置页）
//
// 注意：本模块被渲染进程（apiStore）与主进程（electron/ipc-handlers）同时引用，
// 不得 import 任何 Pinia store / vault —— scale 一律由调用方显式传入。

export const LLM_TIMEOUT_ABSOLUTE_CAP_MS = 600000

/**
 * 按 maxTokens 档位给出超时毫秒数（CPU 校准值）。
 * 校准依据：~10 tok/s 生成 + prompt 处理；512 档满额 ~51s + 余量；8192 档 ~13.6min → 240s
 * 意味着 8192 档在 CPU 上满额不可达，超时主要用于兜底挂死而非等满额。
 */
export function tierTimeoutFor(maxTokens: number, scale: number = 1): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const base =
    maxTokens <= 512 ? 60000 :
    maxTokens <= 4096 ? 150000 :
    maxTokens <= 8192 ? 240000 :
    300000
  return Math.min(Math.round(base * safeScale), LLM_TIMEOUT_ABSOLUTE_CAP_MS)
}

/**
 * 带 TimeoutError 理由的超时 signal（AbortSignal.timeout 原生即为 TimeoutError DOMException，
 * 但无自定义消息；本助手补上 "LLM timeout after Nms" 文案，供 errorClassifier 确定性归类，
 * 不再落入 unknown → 触发额外 LLM 分类调用的雪上加霜路径）。
 * dispose 在请求完成后调用可清理挂起的计时器（不调用也无害，只是信号晚些才落地）。
 */
export function timeoutSignalWithReason(ms: number, label: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`${label} timeout after ${ms}ms`, 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  }
}
