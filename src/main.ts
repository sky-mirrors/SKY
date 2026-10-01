import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vault } from './vault'
import { serializeStoreState, filterPatchForStore } from './services/storeSync'

let syncTimer: ReturnType<typeof setTimeout> | null = null
let pendingDebugSyncs: { storeId: string; state: Record<string, unknown> }[] = []
let pendingPipelineSyncs: { storeId: string; state: Record<string, unknown> }[] = []
let pendingKnowledgeSyncs: { storeId: string; state: Record<string, unknown> }[] = []
// P1-36：应用子窗口回传的 store 更新期间抑制本地 $subscribe 转发，防止主窗↔子窗同步回环
let applyingRemoteUpdate = false

const DEBUG_SYNC_STORES = ['debug', 'api', 'node']
// P1-38：主→流水线窗口同步的 store 白名单（PipelinePage/ToolSelector 实际消费的 store）
const PIPELINE_SYNC_STORES = ['node', 'pipeline']
// 2026-10-01 主→知识库窗口同步的 store 白名单：knowledge/memory 是知识库面板的展示源，
// dialog 供「对话引用」tab。增量广播 + 打开时另由 pushKnowledgeSnapshot 推一次全量。
const KNOWLEDGE_SYNC_STORES = ['knowledge', 'memory', 'dialog']

function installStoreSync(): ReturnType<typeof createPinia> {
  const pinia = createPinia()
  pinia.use(({ store }) => {
    store.$subscribe((_mutation, state) => {
      if (applyingRemoteUpdate) return
      const entry = { storeId: store.$id, state: serializeStoreState(state as Record<string, unknown>) }
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
      if (KNOWLEDGE_SYNC_STORES.includes(store.$id)) {
        const existing = pendingKnowledgeSyncs.findIndex(s => s.storeId === store.$id)
        if (existing >= 0) {
          pendingKnowledgeSyncs[existing] = entry
        } else {
          pendingKnowledgeSyncs.push(entry)
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
          for (const sync of pendingKnowledgeSyncs) {
            window.electronAPI?.storeSyncToKnowledge(sync)
          }
          pendingKnowledgeSyncs = []
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
      // D-13：Map 信封还原/丢弃，防止 nodeVisualEvents 等 Map 状态被覆盖成普通对象
      const filtered = filterPatchForStore(targetStore.$state as Record<string, unknown>, data.state)
      applyingRemoteUpdate = true
      try {
        targetStore.$patch(filtered)
      } finally {
        applyingRemoteUpdate = false
      }
    })
  }

  // 2026-10-01 知识库窗挂载后请求全量快照：知识库数据是静态的，不像 debug 窗那样
  // 靠后续增量自发对齐，故这里一次性把白名单 store 的当前态推过去
  window.electronAPI?.onKnowledgePushSnapshot?.(() => {
    for (const id of KNOWLEDGE_SYNC_STORES) {
      const target = pinia._s.get(id)
      if (!target) continue
      window.electronAPI?.storeSyncToKnowledge?.({
        storeId: id,
        state: serializeStoreState(target.$state as Record<string, unknown>)
      })
    }
  })

  return pinia
}

// #1（P0-7 残留收窄）：sync 失败若继续 mount，store 会以空缓存初始化，
// 默认值 writeThrough 将不可逆覆盖磁盘全部历史数据——必须 fail-fast 拒绝挂载，
// 并向用户展示可见错误（而非仅 console.error）
function showVaultFatalError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('[vault] 冷启动同步失败，拒绝挂载应用:', err)
  const loader = document.getElementById('initLoader')
  if (loader) loader.remove()
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#050510;color:#e8eaf0;font-family:system-ui,sans-serif;padding:32px;text-align:center;z-index:99999'
  const title = document.createElement('h2')
  title.textContent = '数据存储同步失败，应用已停止启动'
  title.style.cssText = 'margin:0;font-size:18px;font-weight:600'
  const detail = document.createElement('pre')
  detail.textContent = msg
  detail.style.cssText = 'max-width:640px;margin:0;white-space:pre-wrap;word-break:break-all;color:#9aa3b2;font-size:12px'
  const hint = document.createElement('p')
  hint.textContent = '为防止空缓存覆盖磁盘数据，已拒绝启动。请检查数据目录后重启应用；若持续出现，可从备份恢复。'
  hint.style.cssText = 'margin:0;max-width:480px;color:#c8cede;font-size:13px;line-height:1.6'
  overlay.appendChild(title)
  overlay.appendChild(detail)
  overlay.appendChild(hint)
  document.body.appendChild(overlay)
}

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  app.use(installStoreSync())

  // P0-7：vault 同步必须先于任何 store 实例化（app.mount 会触发组件树 setup → store 状态初始化读缓存）。
  // 若同步在 mount 之后，所有加载器读到空缓存，initOrLoad 会用默认值 writeThrough 不可逆覆盖磁盘全部历史数据。
  try {
    await vault.syncFromVault()
  } catch (err) {
    showVaultFatalError(err)
    return
  }

  app.mount('#app')

  const loader = document.getElementById('initLoader')
  if (loader) {
    loader.classList.add('fade')
    setTimeout(() => loader.remove(), 600)
  }
}

void bootstrap()
