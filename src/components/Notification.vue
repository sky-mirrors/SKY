<template>
  <transition name="notification-slide">
    <div class="notification" v-if="visible">
      {{ message }}
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const visible = ref(false)
const message = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

function show(msg: string, duration: number = 3000) {
  message.value = msg
  visible.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { visible.value = false }, duration)
}

function hide() {
  visible.value = false
  if (timer) clearTimeout(timer)
}

defineExpose({ show, hide })
</script>

<style scoped>
.notification {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 10px 20px;
  background: rgba(10, 20, 40, 0.85);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #a0c0e8;
  font-size: 13px;
  z-index: 1500;
  backdrop-filter: blur(8px);
  max-width: 320px;
}

.notification-slide-enter-active {
  transition: all 0.3s ease;
}

.notification-slide-leave-active {
  transition: all 0.3s ease;
}

.notification-slide-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.notification-slide-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
