<template>
  <div class="wb-shell">
    <div class="wb-main">
      <WorkbenchNav @open-api-settings="$emit('openApiSettings')" />
      <div class="wb-center">
        <DialogPanel
          docked
          @open-mcp="$emit('openMcp')"
          @camera-fly-to="$emit('cameraFlyTo', $event)"
          @open-preview="$emit('openPreview', $event)"
        />
      </div>
      <RuntimePanel />
    </div>
    <StatusBar />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import WorkbenchNav from './WorkbenchNav.vue'
import RuntimePanel from './RuntimePanel.vue'
import StatusBar from './StatusBar.vue'
import DialogPanel from '@/components/DialogPanel.vue'
import { useHotplugStore } from '@/stores/hotplugStore'
import { useSoakStore } from '@/stores/soakStore'
import type { DialogMessage } from '@/models'

defineEmits<{
  openMcp: []
  cameraFlyTo: [nodeId: string]
  openPreview: [msg: DialogMessage]
  openApiSettings: []
}>()

const hotplugStore = useHotplugStore()
const soakStore = useSoakStore()

onMounted(() => {
  // 幂等：订阅 kernelRegistry/packLoader/funnel 总线事件 + 单例快照
  hotplugStore.init()
  // A6：浸泡验证数据管道（未启用 shadow 时零订阅，幂等）
  soakStore.init()
})
</script>

<style scoped>
.wb-shell {
  position: fixed;
  left: 0;
  right: 0;
  top: 28px;
  bottom: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: #050510;
}

.wb-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.wb-center {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

:root[data-theme='light'] .wb-shell { background: #eef1f8; }
:root[data-theme='green'] .wb-shell { background: #0a140a; }
</style>
