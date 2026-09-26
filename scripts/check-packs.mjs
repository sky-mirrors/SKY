#!/usr/bin/env node
/**
 * 领域包校验器（只读：不改任何文件）
 *
 * 为什么需要：`src/host/pack/loader.ts:28` 的加载是**事务式**的——任一层失败即整包回滚，
 * 而失败只体现为运行时 `pack <id> 挂载失败` 的一条 console.warn。手工写包时"写坏一个文件
 * ⇒ 整个包静默不挂载"，很难当场发现。本脚本把校验提前到写盘后立刻可跑。
 *
 * 规则来源（镜像自源码，若源码漂移本脚本会 WARN 提醒）：
 *   - manifest 规则：`src/host/pack/loader.ts` 的 `validateManifest`（:54 起）
 *   - HOOK_LAYERS：`src/host/types.ts:17`
 *   - VETO_GATES：`src/host/pack/loader.ts:33`
 *   - 分层文件 glob：`src/host/pack/loader.ts:121-124`
 *
 * 用法：
 *   node scripts/check-packs.mjs             # 只 gate「文件形状/可解析」——填包过程中安全
 *   node scripts/check-packs.mjs --strict    # 额外 gate「三层是否填满」（用户 2026-09-27 裁定：该填满）
 *   node scripts/check-packs.mjs --dir=test/fixtures/pack-check   # 校验任意目录（自测用）
 *
 * 自测（证明本脚本不是恒绿）：
 *   node scripts/check-packs.mjs --dir=test/fixtures/pack-check   # 应报 7 个形状错误、退出码 1
 *   node scripts/check-packs.mjs                                  # 真包应 0 错误、退出码 0
 *
 * 退出码：0 = 无形状错误；1 = 有形状错误（或 --strict 下三层未填满）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// --dir=<相对或绝对路径>：校验指定目录而非 src/packs（供自测/离线包用）
const dirArg = process.argv.find(a => a.startsWith('--dir='))
const PACKS_DIR = dirArg ? join(ROOT, dirArg.slice('--dir='.length)) : join(ROOT, 'src', 'packs')
const STRICT = process.argv.includes('--strict')

// ── 镜像常量（与源码同值；下方 selfCheckMirrors 会核对） ────────────────────────
const HOOK_LAYERS = ['L0', 'L0.5', 'L1', 'L2', 'L3', 'L4', 'boundary']
const VETO_GATES = ['pre-execute', 'pre-output']
const HOOK_TIERS = ['advisory', 'veto', 'override']
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/

const errors = []
const todos = []

function err(msg) { errors.push(msg) }
function todo(msg) { todos.push(msg) }

/** 从源码行里抽出所有 'xxx' 字面量，用于核对镜像常量是否漂移 */
function quotedOnLine(file, lineNo) {
  const line = readFileSync(join(ROOT, file), 'utf8').split('\n')[lineNo - 1] ?? ''
  return [...line.matchAll(/'([^']+)'/g)].map(m => m[1])
}

function selfCheckMirrors() {
  const drift = []
  const layers = quotedOnLine('src/host/types.ts', 17)
  if (layers.join(',') !== HOOK_LAYERS.join(',')) drift.push(`HOOK_LAYERS: 源码=[${layers}] 脚本=[${HOOK_LAYERS}]`)
  const gates = quotedOnLine('src/host/pack/loader.ts', 33)
  if (gates.join(',') !== VETO_GATES.join(',')) drift.push(`VETO_GATES: 源码=[${gates}] 脚本=[${VETO_GATES}]`)
  for (const d of drift) console.warn(`⚠️  镜像常量已漂移（脚本可能过时，请核对源码）：${d}`)
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function checkManifest(packId, path) {
  if (!existsSync(path)) { err(`${packId}: 缺 pack.json`); return }
  const r = readJson(path)
  if (!r.ok) { err(`${packId}/pack.json: JSON 解析失败 — ${r.error}`); return }
  const m = r.value
  if (!m || typeof m !== 'object' || Array.isArray(m)) { err(`${packId}/pack.json: 必须是对象`); return }
  if (m.id !== packId) err(`${packId}/pack.json#/id: '${String(m.id)}' 与目录名不一致`)
  if (typeof m.id === 'string' && !PLUGIN_ID_RE.test(m.id)) err(`${packId}/pack.json#/id: 不匹配 ${PLUGIN_ID_RE}`)
  if (typeof m.name !== 'string' || !m.name) err(`${packId}/pack.json#/name: 必须是非空字符串`)
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) err(`${packId}/pack.json#/version: 必须是 semver`)
  if (typeof m.domain !== 'string' || !m.domain) err(`${packId}/pack.json#/domain: 必须是非空字符串`)
  if (m.capabilities === undefined) {
    err(`${packId}/pack.json#/capabilities: 必填`)
  } else if (!m.capabilities || typeof m.capabilities !== 'object' || Array.isArray(m.capabilities)) {
    err(`${packId}/pack.json#/capabilities: 必须是对象`)
  } else {
    const caps = m.capabilities
    if (caps.priority !== undefined && typeof caps.priority !== 'number') err(`${packId}: capabilities.priority 必须是 number`)
    if (caps.weight !== undefined && typeof caps.weight !== 'number') err(`${packId}: capabilities.weight 必须是 number`)
    const hooks = caps.hooks
    if (hooks !== undefined) {
      if (!hooks || typeof hooks !== 'object') { err(`${packId}: capabilities.hooks 必须是对象`) }
      else for (const [tier, layers] of Object.entries(hooks)) {
        if (!HOOK_TIERS.includes(tier)) { err(`${packId}: capabilities.hooks/${tier} 未知档位`); continue }
        if (!Array.isArray(layers)) { err(`${packId}: capabilities.hooks/${tier} 必须是数组`); continue }
        const legal = tier === 'veto' ? VETO_GATES : HOOK_LAYERS.filter(l => l !== 'boundary')
        for (const l of layers) if (!legal.includes(String(l))) err(`${packId}: capabilities.hooks/${tier} 未知层 '${String(l)}'`)
      }
    }
  }
}

function listFiles(dir, filter) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir).filter(filter)
}

function checkLayer(packId, name, dir) {
  const files = listFiles(dir, f => !f.startsWith('.'))
  if (files.length === 0) { todo(`${packId}: 缺「${name}」层（${dir.replace(ROOT + '/', '')}/ 为空或不存在）`); return false }
  return true
}

function checkKnowledge(packId, dir) {
  const files = listFiles(dir, f => f.endsWith('.json'))
  for (const f of files) {
    const r = readJson(join(dir, f))
    if (!r.ok) { err(`${packId}/knowledge/${f}: JSON 解析失败 — ${r.error}`); continue }
    const v = r.value
    if (!v || typeof v !== 'object') { err(`${packId}/knowledge/${f}: 必须是对象`); continue }
    if (typeof v.filename !== 'string' || !v.filename) err(`${packId}/knowledge/${f}#/filename: 必须是非空字符串`)
    if (typeof v.text !== 'string' || !v.text) err(`${packId}/knowledge/${f}#/text: 必须是非空字符串`)
  }
}

function checkBoundary(packId, dir) {
  const cPath = join(dir, 'constraints.json')
  if (existsSync(cPath)) {
    const r = readJson(cPath)
    if (!r.ok) err(`${packId}/boundary/constraints.json: JSON 解析失败 — ${r.error}`)
    else if (!Array.isArray(r.value)) err(`${packId}/boundary/constraints.json: 必须是数组`)
    else r.value.forEach((c, i) => {
      for (const k of ['id', 'category', 'description', 'severity']) {
        if (typeof c?.[k] !== 'string' || !c[k]) err(`${packId}/boundary/constraints.json[${i}]#/${k}: 缺失或非字符串`)
      }
    })
  } else {
    todo(`${packId}: 缺 boundary/constraints.json`)
  }
  const evDir = join(dir, 'evaluators')
  for (const f of listFiles(evDir, f => f.endsWith('.ts'))) {
    const src = readFileSync(join(evDir, f), 'utf8')
    if (!/export\s+const\s+check\b/.test(src)) err(`${packId}/boundary/evaluators/${f}: 未导出 \`check\``)
  }
}

function checkExecution(packId, dir) {
  const files = listFiles(dir, f => f.endsWith('.json'))
  for (const f of files) {
    const r = readJson(join(dir, f))
    if (!r.ok) { err(`${packId}/execution/${f}: JSON 解析失败 — ${r.error}`); continue }
    if (!Array.isArray(r.value)) { err(`${packId}/execution/${f}: 必须是数组`); continue }
    r.value.forEach((e, i) => {
      const id = e?.identity
      if (!id || typeof id !== 'object') { err(`${packId}/execution/${f}[${i}]: 缺 identity`); return }
      for (const k of ['id', 'name', 'version']) {
        if (typeof id[k] !== 'string' || !id[k]) err(`${packId}/execution/${f}[${i}]#/identity/${k}: 缺失或非字符串`)
      }
    })
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
selfCheckMirrors()

if (!existsSync(PACKS_DIR)) {
  console.error(`✗ 找不到包目录：${PACKS_DIR}`)
  process.exit(1)
}

const packs = readdirSync(PACKS_DIR).filter(d => statSync(join(PACKS_DIR, d)).isDirectory()).sort()
if (packs.length === 0) { console.error('✗ src/packs 下没有任何包'); process.exit(1) }

const summary = []
for (const id of packs) {
  const dir = join(PACKS_DIR, id)
  const before = errors.length
  checkManifest(id, join(dir, 'pack.json'))
  const hasK = checkLayer(id, '知识 knowledge', join(dir, 'knowledge'))
  const hasB = checkLayer(id, '边界 boundary', join(dir, 'boundary'))
  const hasE = checkLayer(id, '执行 execution', join(dir, 'execution'))
  if (hasK) checkKnowledge(id, join(dir, 'knowledge'))
  if (hasB) checkBoundary(id, join(dir, 'boundary'))
  if (hasE) checkExecution(id, join(dir, 'execution'))
  summary.push({ id, layers: { 知识: hasK, 边界: hasB, 执行: hasE }, bad: errors.length - before })
}

console.log('\n领域包校验（只读）\n')
for (const s of summary) {
  const L = Object.entries(s.layers).map(([k, v]) => `${v ? '✅' : '○'} ${k}`).join('  ')
  console.log(`  ${s.bad === 0 ? '✓' : '✗'} ${s.id.padEnd(9)} ${L}${s.bad ? `   ← ${s.bad} 个形状错误` : ''}`)
}

if (todos.length) {
  console.log('\n待填（不计入退出码；用户 2026-09-27 裁定「领域包该填满三层」）：')
  for (const t of todos) console.log(`  ○ ${t}`)
}
if (errors.length) {
  console.log('\n形状错误（会致整包回滚，必须先修）：')
  for (const e of errors) console.log(`  ✗ ${e}`)
}

const strictFail = STRICT && todos.length > 0
console.log(`\n结果：${errors.length} 个形状错误 / ${todos.length} 项待填${STRICT ? '（--strict）' : ''}`)
process.exit(errors.length > 0 || strictFail ? 1 : 0)
