import { createApp } from 'vue'
import { createPinia } from 'pinia'
import DevConsole from './components/dev/DevConsole.vue'
import { serializeStoreState, filterPatchForStore } from './services/storeSync'

/**
 * 2026-10-01 开发者端（合并窗口）入口。
 *
 * 与 debug-main / benchmark-main / rule-review-main 同一套跨渲染进程 store 镜像协议：
 * Electron 各窗口是独立渲染进程、各有独立 Pinia，**不能**直接共享主窗内存态；
 * 只能由各窗把变更经 `storeSyncToMain` 上报，主窗再经 `onStoreApplyUpdate` 单向下发。
 * 合并窗口只是把三个页面放进同一个渲染进程，协议不变——但只保留一份，避免三份订阅打架。
 * `applyingRemoteUpdate` 抑制下发期间的本地回传，防止主窗↔本窗同步回环（P1-36）。
 */
const app = createApp(DevConsole)
const pinia = createPinia()

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []
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
app.mount('#dev-app')
