import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PipelinePage from './components/PipelinePage.vue'

const app = createApp(PipelinePage)
const pinia = createPinia()

// P1-36：应用远端 store 更新期间抑制本地 $subscribe 回传，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
    if (applyingRemoteUpdate) return
    window.electronAPI?.storeSyncToMain({
      storeId: store.$id,
      state: JSON.parse(JSON.stringify(state))
    })
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
app.mount('#pipeline-app')
