import type { HoloEventBus } from '@/kernel/bus'
import { useDialogStore } from '@/stores/dialogStore'

export function registerDialogHandlers(bus: HoloEventBus) {
  bus.registerHandler('dialog:confirm-risk', async (payload) => {
    const store = useDialogStore()
    // P0-9：真实等待用户在确认条上裁决（requestRiskConfirm 5 分钟超时按拒绝）；
    // 任何链路异常一律按拒绝返回（fail-closed），绝不放行高危步骤
    try {
      return await store.requestRiskConfirm(payload.actionManifest)
    } catch {
      return false
    }
  })

  bus.registerHandler('dialog:set-mode', (payload) => {
    const store = useDialogStore()
    store.setMode(payload.mode)
  })
}
