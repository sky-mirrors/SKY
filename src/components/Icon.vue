<template>
  <svg
    class="sky-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-if="name === 'star'" d="M12 3l2.6 6.3L21 10l-5 4.3L17.5 21 12 17.3 6.5 21 8 14.3 3 10l6.4-.7z" />
    <path v-else-if="name === 'cpu'" d="M6 6h12v12H6z M9 9h6v6H9z M9 4v2 M15 4v2 M9 18v2 M15 18v2 M4 9h2 M4 15h2 M18 9h2 M18 15h2" />
    <path v-else-if="name === 'pipeline'" d="M6 4v5a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v3 M6 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3 M18 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" />
    <path v-else-if="name === 'book'" d="M4 5h5a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4z M20 5h-5a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h5z" />
    <path v-else-if="name === 'package'" d="M3 8l9-5 9 5-9 5-9-5z M3 8v8l9 5 9-5V8 M12 13v8" />
    <path v-else-if="name === 'chat'" d="M4 5h16v11H9l-5 4V5z" />
    <path v-else-if="name === 'bell'" d="M6 16v-6a6 6 0 0 1 12 0v6l2 2H4l2-2z M10 20a2 2 0 0 0 4 0" />
    <path v-else-if="name === 'settings'" d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v2.5 M12 19.5V22 M2 12h2.5 M19.5 12H22 M5 5l1.8 1.8 M17.2 17.2L19 19 M19 5l-1.8 1.8 M6.8 17.2L5 19" />
    <path v-else-if="name === 'sun'" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M19 5l-1.5 1.5 M6.5 17.5L5 19" />
    <path v-else-if="name === 'moon'" d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z" />
    <path v-else-if="name === 'leaf'" d="M20 4C10 4 4 8 4 16c0 2 1 4 2 4 8 0 14-6 14-16z M6.5 17.5C10 14 14 10 18 8" />
  </svg>
</template>

<script lang="ts">
export type IconName =
  | 'star' | 'cpu' | 'pipeline' | 'book' | 'package'
  | 'chat' | 'bell' | 'settings' | 'sun' | 'moon' | 'leaf'
</script>

<script setup lang="ts">
/**
 * SKY 线性图标集（内联 SVG）。
 *
 * 为什么自建而不是引图标库：本机 `npm`/`npx` 受环境 shim 阻塞、装不了新依赖；
 * 且全仓原本 0 个图标 SVG、图标全靠 emoji（颜色不可控、与暗色主题割裂）。
 * 这里用 currentColor + 统一描边，图标随文字色/主题自动适配。
 *
 * 用法：<Icon name="cpu" :size="16" />
 */
withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 })
</script>

<style scoped>
.sky-icon {
  display: inline-block;
  vertical-align: -0.15em;
  flex: none;
}
</style>
