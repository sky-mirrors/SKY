import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vault } from './vault'

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingSyncs: { storeId: string; state: Record<string, unknown> }[] = []

function installDebugSync(): ReturnType<typeof createPinia> {
  const pinia = createPinia()
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
  return pinia
}

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  app.use(installDebugSync())

  // P0-7：vault 同步必须先于任何 store 实例化（app.mount 会触发组件树 setup → store 状态初始化读缓存）。
  // 若同步在 mount 之后，所有加载器读到空缓存，initOrLoad 会用默认值 writeThrough 不可逆覆盖磁盘全部历史数据。
  try {
    await vault.syncFromVault()
  } catch (err) {
    console.error('[vault] 冷启动同步失败，store 将以空缓存启动:', err)
  }

  app.mount('#app')

  const loader = document.getElementById('initLoader')
  if (loader) {
    loader.classList.add('fade')
    setTimeout(() => loader.remove(), 600)
  }
}

void bootstrap()
