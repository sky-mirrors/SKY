#!/usr/bin/env node
/**
 * 真机场景冒烟（scenario smoke）—— 2026-10-07
 *
 * 为什么需要它：`npm test` 是 vitest，`vitest.config.ts:9` 明确 **排除 `test/e2e/**`**；
 * 而 `test/e2e/*.spec.ts`（playwright 真启动 Electron）**没有任何 runner 脚本** ⇒ 长期休眠。
 * （3 个遗留 spec `launch`/`l0Skill`/`stress` 已于 2026-10 删除；现 `test/e2e/` 只剩 3 个由
 *  `npm run verify:*` 驱动的 `.e2e.ts` 独立脚本，同样不在 vitest 收集范围内。）
 * 结果：2671 个用例全绿也说明不了"用户真能用"——unit 里 30 个 spec 还把 electronAPI 打了桩。
 *
 * 本脚本对**正在运行的应用**（CDP :9222）跑真实用户旅程，断言**可观察结果**，失败即非零退出。
 *
 * 前置：应用已用 `npx electron . --remote-debugging-port=9222` 启动。
 * 用法：node scripts/scenario-smoke.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9222)
const sys = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const target = sys.find(t => t.type === 'page' && /out\/renderer\/index\.html/.test(t.url || ''))
if (!target) { console.error(`✗ 找不到应用页面（CDP ${PORT}）。请先启动：npx electron . --remote-debugging-port=${PORT}`); process.exit(2) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const send = (m, p, ms = 60000) => new Promise(res => { const i = ++id; const t = setTimeout(() => { pend.delete(i); res({ __timeout: true }) }, ms); pend.set(i, v => { clearTimeout(t); res(v) }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.__timeout) return 'TIMEOUT'; if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 200); return r.result?.result?.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PINIA = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia`

// 归一状态：reload 让渲染层回到默认（例如「显示系统消息」开关回到默认关）。
// 否则上一次人工/探针留下的 UI 状态会让冒烟结果不可信——冒烟必须从干净态起跑。
await send('Page.reload', {})
// 2026-10-09：原先此处固定 sleep(6000)。实测在挂有大量历史会话的 userData 上不够——
// 26 条消息时 6s 后消息区尚未渲染完，第 0 项断言（.messages .message 须 > 0）失败，
// 并连锁使后续 sendMessage 在应用未就绪时发出，5/5 全红（选择器本身是对的，
// 事后手工查 DOM 可见 7 个 .message / 0 个 .msg-system）。
// 改为条件等待：轮询消息区出现，最多 30s；超时也继续跑，让断言如实报告。
{
  const readyDeadline = Date.now() + 30000
  let ready = false
  while (Date.now() < readyDeadline) {
    await sleep(500)
    const n = await ev(`document.querySelectorAll('.messages .message').length`)
    if (typeof n === 'number' && n > 0) { ready = true; break }
  }
  if (!ready) console.log('⚠ 等待 30s 后消息区仍未渲染出 .message（不中止，交给断言如实报告）')
  else console.log(`· 归一完成：消息区已渲染（耗时 < ${((Date.now() - (readyDeadline - 30000)) / 1000).toFixed(1)}s）`)
}

/** 发一条用户消息并按需裁决暂停点，返回最后一条 assistant 文本 */
async function say(text, { maxWaitMs = 90000 } = {}) {
  await ev(`(()=>{${PINIA}._s.get('dialog').sendMessage(${JSON.stringify(text)});return 1})()`)
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await sleep(2000)
    const s = await ev(`(()=>{const d=${PINIA}._s.get('dialog');return {proc:d.isProcessing,conf:d.awaitingConfirmation,write:!!d.writeConfirmRequest,risk:d.awaitingRiskConfirm,cand:d.awaitingCandidatePick,fact:d.awaitingFactResolution,dag:d.dagPaused,intent:d.awaitingIntentConfirm,slot:d.awaitingSlotFill}})()`)
    if (typeof s === 'string') continue
    const D = `${PINIA}._s.get('dialog')`
    if (s.conf) { await ev(`(()=>{${D}.confirmPlan(false);return 1})()`); continue }
    if (s.write) { await ev(`(()=>{${D}.resolveWriteConfirm('once');return 1})()`); continue }
    if (s.risk) { await ev(`(()=>{${D}.resolveRiskConfirm(true);return 1})()`); continue }
    if (s.cand) { await ev(`(()=>{${D}.pickCandidate(0);return 1})()`); continue }
    if (s.fact) { await ev(`(()=>{${D}.resolveFactConflict(true);return 1})()`); continue }
    if (s.dag) { await ev(`(()=>{${D}.resumeDag();return 1})()`); continue }
    if (s.intent || s.slot) return { text: '', stalled: 'needs-human' }
    if (!s.proc) break
  }
  const last = await ev(`(()=>{const a=(${PINIA}._s.get('dialog').messages||[]).filter(x=>x.role==='assistant'&&x.type==='text');const l=a[a.length-1];return l?String(l.content||''):''})()`)
  return { text: String(last || ''), stalled: '' }
}

// 2026-10-09：前置条件检查。第 1–4 项都要求真实 LLM 调用（路由层回退也需要模型网关就绪），
// 未配置时它们必然失败——但输出会和"功能坏了"长得一模一样（实测：4 项全红、
// 消息里全是「❌ 未配置模型网关」）。此处显式提示，避免把环境问题误读为缺陷。
const apiReady = await ev(`(()=>{try{const a=${PINIA}._s.get('api');return a?!!a.isReady:null}catch{return null}})()`)
if (apiReady === false) {
  console.log('⚠ 模型网关未就绪（api.isReady=false）：第 1–4 项需要真实 LLM 调用，未配置时必然失败。')
  console.log('  请先在应用里配置模型网关（或本地 Ollama）再重跑；以下结果仅供参照，不代表功能缺陷。')
} else if (apiReady === null) {
  console.log('⚠ 无法读取 api store 的就绪状态，前置条件未校验。')
}

const results = []
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

// 0) 启动即默认降噪：系统通知不渲染
{
  const r = await ev(`(()=>{const s=document.querySelectorAll('.messages .msg-system').length;const all=document.querySelectorAll('.messages .message').length;return JSON.stringify({s,all})})()`)
  const o = typeof r === 'string' && r.startsWith('{') ? JSON.parse(r) : { s: -1, all: 0 }
  record('对话区默认不渲染系统通知', o.s === 0 && o.all > 0, `渲染 ${o.all} 条，其中系统通知 ${o.s} 条`)
}

// 1) 列出文件（真实读盘）
let listedFiles = []
{
  const { text, stalled } = await say('列出桌面上所有 .docx 文件')
  const names = (text.match(/[^\s，,、]+\.[A-Za-z0-9]{1,5}/g) || []).filter(n => /\.docx$/i.test(n))
  listedFiles = names
  record('列出文件（真实读盘）', !stalled && names.length > 0 && /docx/i.test(text), `识别到 ${names.length} 个 .docx 文件名`)
}

// 2) 承接上文（依赖对话历史注入）
{
  const { text, stalled } = await say('把刚才那个清单里前三个文件名念给我')
  const hit = listedFiles.slice(0, 3).filter(n => text.includes(n.replace(/^.*[\\/]/, '')))
  record('承接上文（引用上一轮结果）', !stalled && hit.length >= 2, `命中 ${hit.length}/3 个上轮文件名`)
}

// 3) 落盘（真实写文件 + 校验磁盘）
const marker = `smoke-${Date.now()}`
{
  const target = `桌面上的 ${marker}.txt`
  const { stalled } = await say(`帮我把这句话存成${target}：${marker}`)
  await sleep(500)
  const { existsSync, readFileSync } = await import('node:fs')
  const p = `${process.env.USERPROFILE || ''}\\Desktop\\${marker}.txt`
  const ok = existsSync(p) && readFileSync(p, 'utf8').includes(marker)
  record('落盘写文件（校验磁盘真实产物）', !stalled && ok, ok ? `已生成 ${marker}.txt` : `未在桌面找到 ${marker}.txt`)
}

// 4) 同会话记忆（隔 2 轮再问）
{
  const secret = `CODE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  await say(`请记住这个标记：${secret}`)
  await say('随便问一下：2+3 等于几？')
  await say('再随便问：4+5 等于几？')
  const { text } = await say('我刚才让你记住的标记是什么？')
  record('同会话记忆（隔 2 轮仍能回忆起）', text.includes(secret), text.includes(secret) ? '正确回忆' : '未能回忆（可能是模型/路由失败，非必为记忆缺陷）')
}

ws.close()
const failed = results.filter(r => !r.ok)
console.log(`\n===== 冒烟结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) { console.log('失败项：'); for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')) }
process.exit(failed.length ? 1 : 0)
