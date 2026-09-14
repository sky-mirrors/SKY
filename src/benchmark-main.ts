import { createApp } from 'vue'
import { createPinia } from 'pinia'
import BenchmarkPage from './components/BenchmarkPage.vue'

const app = createApp(BenchmarkPage)
const pinia = createPinia()

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []
// P1-36：应用远端 store 更新期间抑制本地 $subscribe 回传，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
    if (applyingRemoteUpdate) return
    const entry = { storeId: store.$id, state: JSON.parse(JSON.stringify(state)) }
    const existing = pendingSyncs.findIndex(s => s.storeId === store.$id)
    if (existing >= 0) {
      pendingSyncs[existing] = entry
    } else {
      pendingSyncs.push(entry)
    }
    if (!syncTimer) {
      syncTimer = setTimeout(() => {
        for (const sync of pendingSyncs) {
          window.electronAPI?.storeSyncToMain(sync)
        }
        pendingSyncs = []
        syncTimer = null
      }, 100)
    }
  })
})

if (window.electronAPI?.onStoreApplyUpdate) {
  window.electronAPI.onStoreApplyUpdate((data: { storeId: string; state: Record<string, unknown> }) => {
    const targetStore = pinia._s.get(data.storeId)
    if (targetStore) {
      const allowedKeys = Object.keys(targetStore.$state)
      const filtered: Record<string, unknown> = {}
      for (const k of allowedKeys) {
        if (k in data.state) filtered[k] = data.state[k]
      }
      applyingRemoteUpdate = true
      try {
        targetStore.$patch(filtered)
      } finally {
        applyingRemoteUpdate = false
      }
    }
  })
}

app.use(pinia)
app.mount('#benchmark-app')
