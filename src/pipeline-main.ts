import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PipelinePage from './components/PipelinePage.vue'
import { serializeStoreState, filterPatchForStore } from './services/storeSync'

const app = createApp(PipelinePage)
const pinia = createPinia()

// P1-36：应用远端 store 更新期间抑制本地 $subscribe 回传，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
    if (applyingRemoteUpdate) return
    window.electronAPI?.storeSyncToMain({
      storeId: store.$id,
      // D-13：Map 序列化信封化（JSON.stringify(Map) 会丢成 {}）
      state: serializeStoreState(state as Record<string, unknown>)
    })
  })
})

if (window.electronAPI?.onStoreApplyUpdate) {
  window.electronAPI.onStoreApplyUpdate((data: { storeId: string; state: Record<string, unknown> }) => {
    const targetStore = pinia._s.get(data.storeId)
    if (targetStore) {
      // D-13：Map 信封还原/丢弃，防止 Map 状态被覆盖成普通对象
      const filtered = filterPatchForStore(targetStore.$state as Record<string, unknown>, data.state)
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
