// P1-36：pinia._s 是内部 store 注册表（pinia 无公开的按 id 取 store API），
// 跨窗口 store 同步桥（src/main.ts 与四个子窗口入口）统一依赖它做 $patch。
// 模块增强必须写在模块文件中（env.d.ts 是全局脚本，declare module 在那里会整体遮蔽 pinia）。
import 'pinia'

declare module 'pinia' {
  interface Pinia {
    /** 内部 store 注册表（createPinia 运行时实际存在，类型上未公开） */
    _s: Map<string, { $state: Record<string, unknown>; $patch: (partialState: Record<string, unknown>) => void }>
  }
}
