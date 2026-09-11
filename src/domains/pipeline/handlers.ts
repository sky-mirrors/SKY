import type { HoloEventBus } from '@/kernel/bus'
import { usePipelineStore } from '@/stores/pipelineStore'

export function registerPipelineHandlers(bus: HoloEventBus) {
  bus.registerHandler('pipeline:list', () => {
    const store = usePipelineStore()
    return store.pipelines
  })

  bus.registerHandler('pipeline:start', async (payload) => {
    const store = usePipelineStore()
    return store.startPipeline(payload.pipelineId, payload.onProgress)
  })
}
