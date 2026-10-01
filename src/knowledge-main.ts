import { createApp } from 'vue'
import { createPinia } from 'pinia'
import KnowledgeManager from './components/knowledge/KnowledgeManager.vue'
import { serializeStoreState, filterPatchForStore } from './services/storeSync'
import { vault } from './vault'

/**
 * 2026-10-01 知识库独立窗口入口。
 *
 * 与 dev-main / debug-main / benchmark-main 同一套跨渲染进程 store 镜像协议：
 * Electron 各窗口是独立渲染进程、各有独立 Pinia，**不能**直接共享主窗内存态；
 * 只能由各窗把变更经 `storeSyncToMain` 上报，主窗再经 `onStoreApplyUpdate` 单向下发。
 *
 * 与 dev 窗的差异：dev 窗的数据流是主窗持续产生的（打开后下一次变更即对齐），
 * 而知识库数据是静态的（用户上传的文件/分组），不会自发变更——因此本窗挂载后
 * **主动请求一次主窗全量快照**（knowledgeRequestSnapshot → 主窗 pushKnowledgeSnapshot），
 * 否则打开瞬间会看到空列表。
 *
 * 另注：本窗**不做** memoryStore.loadFromStorage()——它会因本窗 configStore 未载入
 * 而误判 restoreSessionMemory=false，进而清空主窗会话记忆（详见 KnowledgeManager.vue）。
 * `applyingRemoteUpdate` 抑制下发期间的本地回传，防止主窗↔本窗同步回环（P1-36）。
 */
const app = createApp(KnowledgeManager)
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

async function bootstrap(): Promise<void> {
  app.use(pinia)
  // 独立窗口：先把磁盘态同步进本窗 vault 缓存，供上传/搜索时读写（本窗不拉 store，
  // 权威态由主窗快照下发）
  try {
    await vault.syncFromVault()
  } catch (err) {
    console.error('[knowledge-window] vault 同步失败:', err)
  }
  app.mount('#knowledge-app')
  // 挂载完成、镜像监听已就位后再请主窗推全量快照
  window.electronAPI?.knowledgeRequestSnapshot?.()
}

void bootstrap()
