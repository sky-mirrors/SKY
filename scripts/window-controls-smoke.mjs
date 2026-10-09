#!/usr/bin/env node
/**
 * 副窗窗口控制真机冒烟（七个副窗）—— 2026-10-09
 *
 * 为什么需要它：窗口控制是**只有真机才暴露**的缺陷面。静态契约测试
 * （`test/unit/ipcContract.spec.ts`）能证明 preload 暴露了键、main 注册了通道，却
 * **证明不了**「点下去窗口真的最小化 / 真的关闭」——而这正是 2026-10 那次缺陷的形态：
 * main 侧注册了 `packs:window:*`（`electron/main.ts:175-180`）、preload 一个键都没暴露、
 * 窗内也没有按钮，而该窗是 `frame:false` 无边框窗（`electron/window-manager.ts:332`）⇒
 * UI 内既关不掉也移不动。当时 vitest 全绿 + typecheck 全绿，缺陷照样存在。
 *
 * 「七窗同构」是**假设**，不是事实——本脚本就是去证伪它的：逐窗开一次、点最小化、点关闭。
 *
 * 前置：SKY 应用已启动并开放 CDP（`electron . --remote-debugging-port=<PORT>`）。
 * **注意：会在你正在运行的应用上真实开窗 / 最小化 / 关窗。** 只处置**本脚本自己新开的**窗：
 * 若某窗此前已打开，直接跳过不碰（避免关掉你用着的窗）。
 *
 * 用法：
 *   node scripts/window-controls-smoke.mjs                    # 默认 CDP 9333
 *   CDP_PORT=9222 node scripts/window-controls-smoke.mjs      # 与 scripts/scenario-smoke.mjs 同端口
 *   node scripts/window-controls-smoke.mjs --only=packs,dev   # 只跑指定窗
 *   node scripts/window-controls-smoke.mjs --shots            # 每窗落一张截图到 .rivet/design/
 *
 * 每窗四项断言（都是可观察结果，不是「函数存在」）：
 *   1. 窗内渲染出窗口控制按钮（含最小化 ─ 与关闭 ✕）
 *   2. 标题栏 `-webkit-app-region: drag` 真的生效
 *   3. 点最小化 → 页面可见性转 hidden（窗口真的最小化）
 *   4. 点关闭 → CDP target 消失（窗口真的销毁）
 *
 * 退出码：0 = 全通过；1 = 有失败断言；2 = 找不到主窗（应用未启动 / CDP 端口不对）
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9333)
const BASE = `http://127.0.0.1:${PORT}`
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null
const SHOTS = process.argv.includes('--shots')
const SHOT_DIR = join(ROOT, '.rivet/design')

/** 七个副窗入口。header/btn/close 取自各组件的模板类名；dev 窗用 .dev-tb-btn 是因为
 *  它内嵌三页，`.tb-btn` 会命中被 CSS 隐藏的内嵌页按钮（DOM 仍在）。 */
const WINDOWS = [
  { id: 'packs', name: '领域包编辑器', open: 'openPackEditorWindow', api: 'packsWindow', html: 'packs.html', header: '.pe-head', btn: '.pe-tb-btn', close: '.pe-tb-close' },
  { id: 'pipeline', name: '流水线工作台', open: 'openPipelineWindow', api: 'pipelineWindow', html: 'pipeline.html', header: '.title-bar', btn: '.tb-btn', close: '.tb-close' },
  { id: 'debug', name: '调试监视器', open: 'openDebugWindow', api: 'debugWindow', html: 'debug.html', header: '.debug-titlebar', btn: '.tb-btn', close: '.tb-close' },
  { id: 'benchmark', name: 'Token 优化压测台', open: 'openBenchmarkWindow', api: 'benchmarkWindow', html: 'benchmark.html', header: '.bm-titlebar', btn: '.tb-btn', close: '.tb-close' },
  { id: 'rule-review', name: '规则审核', open: 'openRuleReviewWindow', api: 'ruleReviewWindow', html: 'rule-review.html', header: '.page-header', btn: '.tb-btn', close: '.tb-close' },
  { id: 'knowledge', name: '知识库', open: 'openKnowledgeWindow', api: 'knowledgeWindow', html: 'knowledge.html', header: '.km-titlebar', btn: '.km-tb-btn', close: '.km-tb-close' },
  { id: 'dev', name: '开发者端', open: 'openDevWindow', api: 'devWindow', html: 'dev.html', header: '.dev-titlebar', btn: '.dev-tb-btn', close: '.dev-tb-close' }
]

/** 最小化/最大化按钮的字形在各窗**不统一**（2026-10-09 实测）：packs / pipeline / rule-review /
 *  knowledge / dev 用 `─`(U+2500) + `□`(U+25A1)；debug / benchmark 用 `—`(U+2014) + `☐`(U+2610)，
 *  且这两窗的 min/max 按钮**没有 title 属性** ⇒ 只能按字形集合识别，不能硬编码单一字符
 *  （按单字符写会误判成「按钮没渲染」，进而漏掉真实的按钮缺失）。 */
const MIN_CHARS = ['─', '—', '－', '-']
const MAX_CHARS = ['□', '☐', '▢']

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
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

const main = (await listPages()).find((t) => /out\/renderer\/index\.html/.test(t.url))
if (!main) {
  console.error(`✗ 找不到 SKY 主窗（CDP ${PORT}）。请先启动：npx electron . --remote-debugging-port=${PORT}`)
  process.exit(2)
}
const M = await connect(main.webSocketDebuggerUrl)
console.log(`副窗窗口控制真机冒烟 · CDP ${PORT} · ${(ONLY ? WINDOWS.filter((w) => ONLY.includes(w.id)) : WINDOWS).length} 窗\n`)

for (const w of WINDOWS) {
  if (ONLY && !ONLY.includes(w.id)) continue

  const before = new Set((await listPages()).map((t) => t.url))
  const sent = await M.ev(`(()=>{ if (typeof window.electronAPI?.['${w.open}'] !== 'function') return 'NO_API'; window.electronAPI['${w.open}'](); return 'SENT' })()`)
  if (sent !== 'SENT') { rec(`${w.name}：发出开窗请求`, false, String(sent)); continue }

  let page = null
  for (let i = 0; i < 25; i++) {
    await sleep(400)
    page = (await listPages()).find((t) => t.url.includes(w.html) && !before.has(t.url))
    if (page) break
  }
  if (!page) {
    const preexisting = (await listPages()).some((t) => t.url.includes(w.html))
    rec(`${w.name}：开窗`, false, preexisting ? '该窗此前已打开 —— 跳过（不关你在用的窗）' : `${w.html} 未出现`)
    continue
  }

  const P = await connect(page.webSocketDebuggerUrl)
  await sleep(1500) // 等 Vue 挂载

  const raw = await P.ev(`(() => {
    const g = (el) => el ? (getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('-webkit-app-region')) : null
    const btns = [...document.querySelectorAll(${JSON.stringify(w.btn)})]
    const txt = (b) => (b.textContent || '').trim()
    return JSON.stringify({
      btnCount: btns.length,
      hasMin: btns.some(b => ${JSON.stringify(MIN_CHARS)}.includes(txt(b))),
      hasMax: btns.some(b => ${JSON.stringify(MAX_CHARS)}.includes(txt(b))),
      hasClose: !!document.querySelector(${JSON.stringify(w.close)}),
      headerDrag: g(document.querySelector(${JSON.stringify(w.header)})),
      apiMin: typeof window.electronAPI?.['${w.api}Minimize'],
      apiClose: typeof window.electronAPI?.['${w.api}Close']
    })
  })()`)
  let o = {}
  try { o = JSON.parse(raw) } catch { o = { raw: String(raw).slice(0, 160) } }

  const buttonsOk = o.hasMin && o.hasMax && o.hasClose
  rec(`${w.name}：渲染出 ─ / □ / ✕ 三个控制按钮`, buttonsOk, `共 ${o.btnCount} 个按钮 min=${o.hasMin} max=${o.hasMax} close=${o.hasClose}`)
  rec(`${w.name}：preload 暴露 ${w.api}Minimize/Close`, o.apiMin === 'function' && o.apiClose === 'function', `min=${o.apiMin} close=${o.apiClose}`)
  rec(`${w.name}：标题栏 drag 区生效`, String(o.headerDrag) === 'drag', `${w.header} = ${o.headerDrag}`)

  if (SHOTS) {
    const shot = await P.send('Page.captureScreenshot', { format: 'png' })
    if (shot?.result?.data) {
      mkdirSync(SHOT_DIR, { recursive: true })
      const f = join(SHOT_DIR, `win-${w.id}.png`)
      writeFileSync(f, Buffer.from(shot.result.data, 'base64'))
      console.log(`    · 截图 → ${f.replace(ROOT, '').replace(/^[\\/]/, '')}`)
    }
  }

  // 点最小化 → 窗口真的最小化
  await P.ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(w.btn)})].find(x => ${JSON.stringify(MIN_CHARS)}.includes((x.textContent||'').trim())); if (b) b.click(); return 1 })()`)
  await sleep(1000)
  const vis = await P.ev(`document.visibilityState + '/' + document.hidden`)
  rec(`${w.name}：点最小化 → 窗口真的最小化`, String(vis).startsWith('hidden'), `visibilityState=${vis}`)

  // 点关闭 → 窗口真的关闭
  await P.ev(`(() => { const b = document.querySelector(${JSON.stringify(w.close)}); if (b) b.click(); return 1 })()`)
  let gone = false
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    if (!(await listPages()).some((t) => t.url.includes(w.html))) { gone = true; break }
  }
  rec(`${w.name}：点关闭 → 窗口真的关闭`, gone, gone ? 'target 已消失' : '窗口仍在')
  try { P.ws.close() } catch { /* 已随窗口销毁 */ }
  console.log('')
}

M.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`===== 副窗窗口控制真机冒烟：${results.length - failed.length}/${results.length} 通过 =====`)
for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
process.exit(failed.length ? 1 : 0)
