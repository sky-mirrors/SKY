import { createApp } from 'vue'
import { createPinia } from 'pinia'
import DebugWindowPage from './components/DebugWindowPage.vue'

const app = createApp(DebugWindowPage)
const pinia = createPinia()

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
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
      targetStore.$patch(filtered)
    }
  })
}

app.use(pinia)
app.mount('#debug-app')

if (window.electronAPI?.ipcRendererSend) {
  window.electronAPI.ipcRendererSend('debug:ready')
}
