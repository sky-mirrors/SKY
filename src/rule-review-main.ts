import { createApp } from 'vue'
import './styles/tokens.css'
import { createPinia } from 'pinia'
import RuleReviewPage from './components/RuleReview/RuleReviewPage.vue'
import { serializeStoreState, filterPatchForStore } from './services/storeSync'

const app = createApp(RuleReviewPage)
const pinia = createPinia()

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []
// P1-36：应用远端 store 更新期间抑制本地 $subscribe 回传，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

pinia.use(({ store }) => {
  store.$subscribe((_mutation, state) => {
    if (applyingRemoteUpdate) return
    const entry = { storeId: store.$id, state: serializeStoreState(state as Record<string, unknown>) }
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
      // D-13：Map 信封还原/丢弃
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
app.mount('#rule-review-app')
