import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

const app = createApp(App)
const pinia = createPinia()

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
    if (!['debug', 'api', 'node'].includes(store.$id)) return
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
          window.electronAPI?.storeSyncToDebug(sync)
        }
        pendingSyncs = []
        syncTimer = null
      }, 100)
    }
  })
})

app.use(pinia)
app.mount('#app')

const loader = document.getElementById('initLoader')
if (loader) {
  loader.classList.add('fade')
  setTimeout(() => loader.remove(), 600)
}
