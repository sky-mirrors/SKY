import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vault } from './vault'

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingDebugSyncs: { storeId: string; state: Record<string, unknown> }[] = []
let pendingPipelineSyncs: { storeId: string; state: Record<string, unknown> }[] = []
// P1-36：应用子窗口回传的 store 更新期间抑制本地 $subscribe 转发，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

const DEBUG_SYNC_STORES = ['debug', 'api', 'node']
// P1-38：主→流水线窗口同步的 store 白名单（PipelinePage/ToolSelector 实际消费的 store）
const PIPELINE_SYNC_STORES = ['node', 'pipeline']

function installStoreSync(): ReturnType<typeof createPinia> {
  const pinia = createPinia()
  pinia.use(({ store }) => {
    store.$subscribe((_mutation, state) => {
      if (applyingRemoteUpdate) return
      const entry = { storeId: store.$id, state: JSON.parse(JSON.stringify(state)) }
      if (DEBUG_SYNC_STORES.includes(store.$id)) {
        const existing = pendingDebugSyncs.findIndex(s => s.storeId === store.$id)
        if (existing >= 0) {
          pendingDebugSyncs[existing] = entry
        } else {
          pendingDebugSyncs.push(entry)
        }
      }
      if (PIPELINE_SYNC_STORES.includes(store.$id)) {
        const existing = pendingPipelineSyncs.findIndex(s => s.storeId === store.$id)
        if (existing >= 0) {
          pendingPipelineSyncs[existing] = entry
        } else {
          pendingPipelineSyncs.push(entry)
        }
      }
      if (!syncTimer) {
        syncTimer = setTimeout(() => {
          for (const sync of pendingDebugSyncs) {
            window.electronAPI?.storeSyncToDebug(sync)
          }
          pendingDebugSyncs = []
          for (const sync of pendingPipelineSyncs) {
            window.electronAPI?.storeSyncToPipeline(sync)
          }
          pendingPipelineSyncs = []
          syncTimer = null
        }, 100)
      }
    })
  })

  // P1-36：主窗口此前零处订阅 onStoreApplyUpdate —— 子窗口（流水线/调试/压测/规则审核）的
  // store 编辑回传全部被丢弃，主窗口与子窗口 store 静默分叉。此处补齐 $patch 桥。
  if (window.electronAPI?.onStoreApplyUpdate) {
    window.electronAPI.onStoreApplyUpdate((data: { storeId: string; state: Record<string, unknown> }) => {
      const targetStore = pinia._s.get(data.storeId)
      if (!targetStore) return
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
    })
  }

  return pinia
}

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  app.use(installStoreSync())

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
