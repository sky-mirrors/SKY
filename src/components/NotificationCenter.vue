<template>
  <transition name="nc-slide">
    <div class="notification-center" v-if="visible">
      <div class="nc-header">
        <span class="nc-title">通知中心</span>
        <span class="nc-badge" v-if="notificationStore.unreadCount > 0">{{ notificationStore.unreadCount }}</span>
        <div class="nc-header-actions">
          <button class="nc-btn" @click="notificationStore.markAllRead()" v-if="notificationStore.unreadCount > 0">全部已读</button>
          <button class="nc-btn" @click="notificationStore.clearAll()" v-if="notificationStore.notifications.length > 0">清空</button>
          <button class="nc-btn nc-close-btn" @click="close">✕</button>
        </div>
      </div>
      <div class="nc-tabs">
        <button class="nc-tab" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
        <button class="nc-tab" :class="{ active: filter === 'unread' }" @click="filter = 'unread'">未读</button>
        <button class="nc-tab" :class="{ active: filter === 'high' }" @click="filter = 'high'">高优先</button>
      </div>
      <div class="nc-list">
        <div
          v-for="n in filteredNotifications"
          :key="n.id"
          class="nc-item"
          :class="{ unread: !n.read, [n.priority]: true }"
          @click="onClickItem(n)"
        >
          <span class="nc-priority-dot" :class="n.priority"></span>
          <div class="nc-item-body">
            <div class="nc-item-top">
              <span class="nc-item-title">{{ n.title }}</span>
              <span class="nc-item-time">{{ formatTime(n.timestamp) }}</span>
            </div>
            <div class="nc-item-msg">{{ n.message }}</div>
            <div class="nc-item-actions" v-if="n.actions.length > 0">
              <button
                v-for="(a, ai) in n.actions"
                :key="ai"
                class="nc-action-btn"
                @click.stop="a.handler()"
              >{{ a.label }}</button>
            </div>
          </div>
        </div>
        <div class="nc-empty" v-if="filteredNotifications.length === 0">
          <span>{{ filter === 'unread' ? '没有未读通知' : filter === 'high' ? '没有高优先通知' : '暂无通知' }}</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useNotificationStore } from '@/domains/app'
import { Notification } from '@/models'

const notificationStore = useNotificationStore()
const visible = ref(false)
const filter = ref<'all' | 'unread' | 'high'>('all')

const filteredNotifications = computed(() => {
  const list = notificationStore.activeNotifications
  switch (filter.value) {
    case 'unread': return list.filter(n => !n.read)
    case 'high': return list.filter(n => n.priority === 'high')
    default: return list
  }
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function onClickItem(n: Notification) {
  if (!n.read) notificationStore.markRead(n.id)
}

function open() {
  visible.value = true
  notificationStore.processAutoRead()
  notificationStore.expireOld()
}

function close() {
  visible.value = false
}

defineExpose({ open, close })
</script>

<style scoped>
.notification-center {
  position: fixed;
  top: 28px;
  right: 0;
  width: 340px;
  height: calc(100vh - 28px);
  background: rgba(8, 14, 28, 0.95);
  border-left: 1px solid rgba(100, 180, 255, 0.15);
  z-index: 2500;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(12px);
}

.nc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.1);
}

.nc-title {
  font-size: 14px;
  font-weight: 600;
  color: #c0d8f0;
}

.nc-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 80, 80, 0.7);
  color: #fff;
  font-weight: 700;
}

.nc-header-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.nc-btn {
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid rgba(100, 180, 255, 0.15);
  background: rgba(100, 180, 255, 0.08);
  color: #88bbff;
  font-size: 11px;
  cursor: pointer;
}

.nc-btn:hover {
  background: rgba(100, 180, 255, 0.2);
}

.nc-close-btn {
  border-color: rgba(255, 80, 80, 0.3);
  color: #ff8888;
}

.nc-close-btn:hover {
  background: rgba(255, 60, 60, 0.15);
}

.nc-tabs {
  display: flex;
  gap: 0;
  padding: 0 16px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
}

.nc-tab {
  padding: 8px 14px;
  border: none;
  background: none;
  color: rgba(130, 170, 220, 0.5);
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.nc-tab.active {
  color: #88bbff;
  border-bottom-color: #88bbff;
}

.nc-tab:hover {
  color: #a0ccff;
}

.nc-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.nc-item {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.1s;
  border-left: 3px solid transparent;
}

.nc-item:hover {
  background: rgba(100, 180, 255, 0.06);
}

.nc-item.unread {
  background: rgba(100, 180, 255, 0.04);
}

.nc-item.unread.high {
  border-left-color: #ff4444;
}

.nc-item.unread.medium {
  border-left-color: #ffaa44;
}

.nc-item.unread.low {
  border-left-color: #44aaff;
}

.nc-priority-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}

.nc-priority-dot.high {
  background: #ff4444;
  box-shadow: 0 0 4px rgba(255, 68, 68, 0.5);
}

.nc-priority-dot.medium {
  background: #ffaa44;
}

.nc-priority-dot.low {
  background: #44aaff;
}

.nc-item-body {
  flex: 1;
  min-width: 0;
}

.nc-item-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.nc-item-title {
  font-size: 12px;
  font-weight: 500;
  color: #c0d8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc-item-time {
  font-size: 10px;
  color: rgba(130, 170, 220, 0.35);
  flex-shrink: 0;
}

.nc-item-msg {
  font-size: 11px;
  color: rgba(160, 190, 230, 0.6);
  line-height: 1.4;
}

.nc-item-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.nc-action-btn {
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid rgba(100, 180, 255, 0.2);
  background: rgba(100, 180, 255, 0.1);
  color: #88bbff;
  font-size: 11px;
  cursor: pointer;
}

.nc-action-btn:hover {
  background: rgba(100, 180, 255, 0.25);
}

.nc-empty {
  padding: 40px 16px;
  text-align: center;
  color: rgba(130, 170, 220, 0.3);
  font-size: 13px;
}

.nc-slide-enter-active { transition: transform 0.2s ease; }
.nc-slide-leave-active { transition: transform 0.15s ease; }
.nc-slide-enter-from, .nc-slide-leave-to { transform: translateX(100%); }
</style>
