#!/usr/bin/env node
/**
 * 副窗窗口控制真机冒烟（领域包编辑器窗）—— 2026-10-09
 *
 * 为什么需要它：窗口控制通道是**只有真机才暴露**的缺陷面。静态契约测试
 * （`test/unit/ipcContract.spec.ts`）能证明 preload 暴露了键、main 注册了通道，却
 * **证明不了**「点下去窗口真的最小化 / 真的关闭」——而这正是 2026-10 那次缺陷的形态：
 * main 侧注册了 `packs:window:*`（`electron/main.ts:175-180`）、preload 一个键都没暴露、
 * 窗内也没有按钮，而该窗是 `frame:false` 无边框窗（`electron/window-manager.ts:332`）⇒
 * UI 内既关不掉也移不动。vitest 全绿 + typecheck 全绿，缺陷照样存在。
 *
 * 覆盖范围：**只覆盖 packs 窗**（本次真实修复的那一窗）。其余六窗的窗口控制目前只有静态
 * 契约覆盖（`test/unit/ipcContract.spec.ts` 的「副窗窗口控制」组）。
 *
 * 前置：SKY 应用已启动并开放 CDP（`electron . --remote-debugging-port=<PORT>`）。
 * **注意：本脚本会在你正在运行的应用上真实开窗、最小化、关窗**（关的是它自己开的 packs 窗，
 * 不碰主窗）。
 *
 * 用法：
 *   node scripts/packs-window-smoke.mjs                    # 默认 CDP 9333（本仓真机实例端口）
 *   CDP_PORT=9222 node scripts/packs-window-smoke.mjs      # 与 scripts/scenario-smoke.mjs 同端口时
 *   node scripts/packs-window-smoke.mjs --out=.rivet/design/packs.png
 *
 * 断言（全部是可观察结果，不是「函数存在」）：
 *   1. 主窗能发出开窗请求，packs 窗出现
 *   2. 窗内渲染出 3 个控制按钮（─ □ ✕）
 *   3. preload 三个 packsWindow* 键可调用
 *   4. 标题栏是 drag 区、按钮组是 no-drag
 *   5. 点「最小化」→ 页面可见性转 hidden（窗口真的最小化）
 *   6. 点「关闭」→ CDP target 消失（窗口真的销毁）
 *
 * 退出码：0 = 全通过；1 = 有失败断言；2 = 找不到主窗（应用未启动 / CDP 端口不对）
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9333)
const BASE = `http://127.0.0.1:${PORT}`
const outArg = process.argv.find((a) => a.startsWith('--out='))
const OUT = join(ROOT, outArg ? outArg.slice('--out='.length) : '.rivet/design/packs-window.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listPages = async () => {
  try {
    return (await (await fetch(`${BASE}/json/list`)).json()).filter((t) => t.type === 'page')
  } catch {
    return []
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')) })
  const pend = new Map()
  let id = 0
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}, ms = 30000) => new Promise((res) => {
    const i = ++id
    const t = setTimeout(() => { pend.delete(i); res({ __timeout: true }) }, ms)
    pend.set(i, (v) => { clearTimeout(t); res(v) })
    try { ws.send(JSON.stringify({ id: i, method, params })) } catch { clearTimeout(t); pend.delete(i); res({ __timeout: true }) }
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.__timeout) return 'TIMEOUT'
    if (r.result?.exceptionDetails) return 'EXC: ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 200)
    return r.result?.result?.value
  }
  return { ws, send, ev }
}

const results = []
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

// ── 1) 主窗：请求打开领域包编辑器
const main = (await listPages()).find((t) => /out\/renderer\/index\.html/.test(t.url))
if (!main) {
  console.error(`✗ 找不到 SKY 主窗（CDP ${PORT}）。请先启动：npx electron . --remote-debugging-port=${PORT}`)
  process.exit(2)
}
const M = await connect(main.webSocketDebuggerUrl)
const opened = await M.ev(`(()=>{ if (typeof window.electronAPI?.openPackEditorWindow !== 'function') return 'NO_API'; window.electronAPI.openPackEditorWindow(); return 'SENT' })()`)
rec('主窗 openPackEditorWindow 可用且已发出', opened === 'SENT', String(opened))
M.ws.close()

// ── 2) 等 packs 窗出现
let packs = null
for (let i = 0; i < 25; i++) {
  await sleep(400)
  packs = (await listPages()).find((t) => /out\/renderer\/packs\.html/.test(t.url))
  if (packs) break
}
if (!packs) { console.error('✗ packs 窗未出现（open:packs-window 无响应）'); process.exit(1) }
console.log(`  · packs 窗已打开：${packs.title}`)

const P = await connect(packs.webSocketDebuggerUrl)
await sleep(1200) // 等 Vue 挂载 + onMounted 的 userPackList 回填

const raw = await P.ev(`(() => {
  const g = (el, prop) => el ? (getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue(prop)) : null
  const btns = [...document.querySelectorAll('.pe-tb-btn')]
  const api = {}
  for (const k of ['packsWindowMinimize', 'packsWindowMaximize', 'packsWindowClose']) api[k] = typeof window.electronAPI?.[k]
  return JSON.stringify({
    btnCount: btns.length,
    btns: btns.map(b => (b.textContent || '').trim() + '|' + (b.title || '')),
    headDrag: g(document.querySelector('.pe-head'), '-webkit-app-region'),
    actionsDrag: g(document.querySelector('.pe-tb-actions'), '-webkit-app-region'),
    api
  })
})()`)
let o = {}
try { o = JSON.parse(raw) } catch { o = { raw: String(raw).slice(0, 160) } }

rec('packs 窗渲染出 3 个窗口控制按钮', o.btnCount === 3, `btnCount=${o.btnCount} [${(o.btns || []).join(', ')}]`)
rec('preload 暴露三个 packsWindow* API', o.api?.packsWindowMinimize === 'function' && o.api?.packsWindowMaximize === 'function' && o.api?.packsWindowClose === 'function', JSON.stringify(o.api))
rec('标题栏是拖拽区、按钮组是 no-drag', String(o.headDrag) === 'drag' && String(o.actionsDrag) === 'no-drag', `head=${o.headDrag} actions=${o.actionsDrag}`)

// ── 3) 截图（关窗之前）
const shot = await P.send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
  rec('截图落盘', true, OUT.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
} else {
  rec('截图落盘', false, 'captureScreenshot 无数据')
}

// ── 4) 点「最小化」→ 窗口真的最小化（可观察：页面可见性转 hidden）
await P.ev(`document.querySelectorAll('.pe-tb-btn')[0].click()`)
await sleep(1000)
const vis = await P.ev(`document.visibilityState + '/' + document.hidden`)
rec('点最小化 → 窗口真的最小化', String(vis).startsWith('hidden'), `visibilityState=${vis}`)

// ── 5) 点「关闭」→ 窗口真的关闭（CDP target 消失）
await P.ev(`document.querySelectorAll('.pe-tb-btn')[2].click()`)
let gone = false
for (let i = 0; i < 20; i++) {
  await sleep(300)
  if (!(await listPages()).some((t) => /packs\.html/.test(t.url))) { gone = true; break }
}
rec('点关闭 → 窗口真的关闭', gone, gone ? 'CDP target 已消失' : '窗口仍在')

try { P.ws.close() } catch { /* 已随窗口销毁 */ }

const failed = results.filter((r) => !r.ok)
console.log(`\n===== packs 窗窗口控制真机冒烟：${results.length - failed.length}/${results.length} 通过 =====`)
for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
process.exit(failed.length ? 1 : 0)
