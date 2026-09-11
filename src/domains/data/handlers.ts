import type { HoloEventBus } from '@/kernel/bus'
import { calculateUsage, getTotalUsedMB } from '@/services/storageMonitor'
import { buildExportData, exportToZip } from '@/services/dataExporter'

export function registerDataHandlers(bus: HoloEventBus) {
  bus.registerHandler('data:storage-breakdown', () => {
    return calculateUsage()
  })

  bus.registerHandler('data:storage-total', () => {
    return getTotalUsedMB()
  })

  bus.registerHandler('data:export', async (payload) => {
    const data = buildExportData(payload.items)
    await exportToZip(payload.items)
    return data
  })
}
