<template>
  <div class="wb-statusbar">
    <div class="wb-sb-group">
      <!-- 2026-10-01 UI 分端：内核名 / 探针 / funnel 状态都属开发者向，已移出用户端状态栏。
           此处只留用户能理解的：已挂载领域包数。内核与 funnel 状态见导航「开发者」区与调试中心。 -->
      <span class="wb-sb-item" title="已挂载 pack">
        📦 {{ hotplugStore.mountedPackIds.length }}/{{ hotplugStore.allPackIds.length }}
      </span>
      <!-- 2026-10-01 UI 分端：funnel 主路径是「新六层漏斗 vs 旧内联实现」的灰度回滚开关
           （dialogStore.ts:906），属开发者向——从用户端状态栏移出，开关本身在导航「开发者」区。 -->
    </div>
    <div class="wb-sb-group">
      <span v-if="l1Working.length > 0" class="wb-sb-item" :title="l1Working.map(n => n.name).join('、')">
        <span class="wb-sb-dot working"></span>{{ l1Working.length }} 个 L1 运行中
      </span>
      <span v-else-if="nodeStore.dagChainState.active" class="wb-sb-item">
        <span class="wb-sb-dot working"></span>DAG 执行中（{{ dagDoneCount }}/{{ nodeStore.dagChainState.steps.length }}）
      </span>
      <span v-else class="wb-sb-item dim">L1 空闲</span>
    </div>
    <div class="wb-sb-group">
      <!-- 2026-10-01 UI 分端：探针计数属开发者向，移出用户端状态栏（调试中心在导航「开发者」区） -->
      <span class="wb-sb-item" :title="apiStore.isCircuitOpen ? 'API 熔断器已开启——点击重置' : 'API 熔断器正常'">
        <template v-if="apiStore.isCircuitOpen">
          <button class="wb-sb-circuit" @click="apiStore.resetCircuitBreaker()">⚠ 熔断 · 点击重置</button>
        </template>
        <template v-else>
          <span class="wb-sb-dot" :class="apiStore.isReady ? 'ok' : 'bad'"></span>{{ apiStore.config.activeModel || '未配置模型' }}
        </template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useHotplugStore } from '@/stores/hotplugStore'

const nodeStore = useNodeStore()
const apiStore = useApiStore()
const hotplugStore = useHotplugStore()

const l1Working = computed(() => {
  const busy: Array<{ id: string; name: string }> = []
  for (const node of nodeStore.l1Nodes) {
    const status = nodeStore.l1WorkStatus[node.id]
    if (status === 'working' || status === 'long_running' || status === 'error') {
      busy.push({ id: node.id, name: node.name })
    }
  }
  return busy
})

const dagDoneCount = computed(() => {
  return nodeStore.dagChainState.steps.filter(s => s.status === 'done' || s.status === 'reuse' || s.status === 'skip').length
})
</script>

<style scoped>
.wb-statusbar {
  --sb-bg: rgba(5, 8, 16, 0.95);
  --sb-border: rgba(80, 160, 255, 0.1);
  --sb-text: #8a99b3;
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: var(--sb-bg);
  border-top: 1px solid var(--sb-border);
  font-size: 10px;
  color: var(--sb-text);
  user-select: none;
}
.wb-sb-group { display: flex; align-items: center; gap: 14px; min-width: 0; }
.wb-sb-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.wb-sb-item.dim { opacity: 0.55; }
.wb-sb-ok { color: #5ec98a; }
.wb-sb-bad { color: #e0a860; }
.wb-sb-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.wb-sb-dot.ok { background: #5ec98a; }
.wb-sb-dot.warn { background: #e0b450; }
.wb-sb-dot.bad { background: #e06a6a; }
.wb-sb-dot.working { background: #6db3ff; animation: wb-sb-pulse 1s infinite; }
@keyframes wb-sb-pulse { 50% { opacity: 0.35; } }
.wb-sb-circuit {
  background: rgba(224, 106, 106, 0.12);
  border: 1px solid rgba(224, 106, 106, 0.3);
  color: #e06a6a;
  font-size: 10px;
  border-radius: 4px;
  padding: 0 6px;
  cursor: pointer;
}
.wb-sb-circuit:hover { background: rgba(224, 106, 106, 0.2); }

:root[data-theme='light'] .wb-statusbar {
  --sb-bg: rgba(238, 241, 248, 0.95);
  --sb-border: rgba(0, 0, 0, 0.08);
  --sb-text: #5a6375;
}
:root[data-theme='green'] .wb-statusbar {
  --sb-bg: rgba(18, 30, 18, 0.95);
  --sb-border: rgba(80, 160, 80, 0.15);
  --sb-text: #7a9a7a;
}
</style>
