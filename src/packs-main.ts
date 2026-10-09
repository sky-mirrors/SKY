import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PackEditor from './components/packs/PackEditor.vue'
import './styles/tokens.css'

/**
 * 领域包编辑器独立窗口入口（2026-10）。
 *
 * 与 knowledge-main.ts 的差异：本窗**不需要**跨渲染进程的 store 镜像协议——
 * 它的数据源是磁盘上的用户包文件（经 `electronAPI.userPack*` 这组专用 IPC 读写），
 * 不依赖主窗内存态，因此省掉整套 subscribe/patch 同步，减少出错面。
 *
 * 仍然挂 Pinia：组件里会用到 notificationStore 之类的轻状态（如"已保存"提示），
 * 且与主窗保持同一套依赖前提。
 */
const app = createApp(PackEditor)
app.use(createPinia())
app.mount('#packs-app')
