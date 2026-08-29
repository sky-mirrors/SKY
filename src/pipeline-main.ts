import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PipelinePage from './components/PipelinePage.vue'

const app = createApp(PipelinePage)
const pinia = createPinia()

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
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
      targetStore.$patch(filtered)
    }
  })
}

app.use(pinia)
app.mount('#pipeline-app')
