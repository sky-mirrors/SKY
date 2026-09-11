import type { HoloEventBus } from '@/kernel/bus'
import { useDialogStore } from '@/stores/dialogStore'

export function registerDialogHandlers(bus: HoloEventBus) {
  bus.registerHandler('dialog:confirm-risk', async (payload) => {
    const store = useDialogStore()
    return store.awaitingRiskConfirm
  })

  bus.registerHandler('dialog:set-mode', (payload) => {
    const store = useDialogStore()
    store.setMode(payload.mode)
  })
}
