<template>
  <div ref="containerRef" class="starmap-container"></div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useThreeScene } from '@/composables/useThreeScene'
import { useNodeStore } from '@/domains/node'
import { useConfigStore } from '@/domains/config'

const props = defineProps<{
  panelWidth?: number
}>()

const containerRef = ref<HTMLDivElement>()
const { init, dispose, onResize, startOnboarding, setDegradedVisuals, rebuildNode, spawnStarLogAsteroid, triggerStarLogReturn, setThemeBackground, flyToNode, resetCamera, hoveredNodeInfo } = useThreeScene(containerRef)
const nodeStore = useNodeStore()
const configStore = useConfigStore()

const emit = defineEmits<{
  nodeClick: [nodeId: string, ctrlKey: boolean]
  nodeHover: [nodeId: string | null]
  dragStart: [nodeId: string]
  dragEnd: [fromId: string, toId: string]
  ready: [api: { startOnboarding: () => void; setDegradedVisuals: (v: boolean) => void; rebuildNode: (id: string) => void; spawnStarLogAsteroid: (entryId: string, toolName: string) => void; triggerStarLogReturn: (entryId: string) => void; flyToNode: (nodeId: string) => void; resetCamera: () => void; hoveredNodeInfo: typeof hoveredNodeInfo }]
}>()

watch(() => nodeStore.interaction.selectedNodeId, (id) => {
  if (id) emit('nodeClick', id, !!nodeStore.interaction.ctrlKey)
})

watch(() => nodeStore.interaction.hoveredNodeId, (id) => {
  emit('nodeHover', id)
})

watch(() => nodeStore.interaction.onboardingPhase, (phase) => {
  if (phase === 'exploding') {
    setTimeout(() => {
      configStore.markFirstLaunchDone()
    }, 2000)
  }
})

watch(() => configStore.theme, (theme) => {
  setThemeBackground(theme)
})

watch(() => props.panelWidth, async () => {
  await nextTick()
  onResize()
}, { immediate: true })

let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  init()
  emit('ready', { startOnboarding, setDegradedVisuals, rebuildNode, spawnStarLogAsteroid, triggerStarLogReturn, flyToNode, resetCamera, hoveredNodeInfo })

  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      onResize()
    })
    resizeObserver.observe(containerRef.value)
  }

  if (configStore.isFirstLaunch) {
    setTimeout(() => {
      startOnboarding()
    }, 800)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  dispose()
})
</script>

<style scoped>
.starmap-container {
  position: fixed;
  top: 0;
  left: var(--dialog-panel-width, 460px);
  width: calc(100vw - var(--dialog-panel-width, 460px));
  height: 100vh;
  background: #050510;
  z-index: 0;
}
</style>
