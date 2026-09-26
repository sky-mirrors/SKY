#!/usr/bin/env node
// 机制体检 · 休眠扫描（可复跑资产；口径与已知误报源见同目录 README.md）
//
// 找两类「实现了但没接线/没上屏」的信号：
//   A. 休眠模块：src/{services,stores,composables} 下的 .ts **在 src 内零 importer**（静态 from 与动态 import() 都算）
//   B. 死导出三分（定义于全 src 的 export function|const|let|class，名字 ≥4）：
//        - truly-dead    ：其它 src 文件、test、本文件自用三者皆无 → 真死
//        - unwired-tested：无其它 src 引用、本文件也不自用、但 test 有引用 → 休眠候选（有测试、生产零调用）
//        - internal-only ：仅本文件自用（机制在跑，export 冗余）
//
// 用法：node scripts/mechanism-scan/scan-dormant.mjs [--out <path>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')
const TEST = path.join(ROOT, 'test')
const outArgIdx = process.argv.indexOf('--out')
const OUT = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : path.join(ROOT, '.rivet-scan-dormant.txt')

function walk(root, exts) {
  const out = new Map()
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!exts.some(e => entry.name.endsWith(e))) continue
    const p = path.join(entry.parentPath ?? entry.path, entry.name)
    try { out.set(p, fs.readFileSync(p, 'utf8')) } catch { /* skip unreadable */ }
  }
  return out
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const srcText = walk(SRC, ['.ts', '.vue'])
const testText = walk(TEST, ['.ts', '.vue'])

// 静态 from '...' + 动态 import('...') 都算引用（漏动态 import 会把 imageRenameByDate 等误报为休眠）
function importSpecs(text) {
  const specs = []
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.push(m[1].replace(/\\/g, '/'))
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1].replace(/\\/g, '/'))
  return specs
}
const specRe = base => new RegExp('(^|/)' + esc(base) + '$')
const hitImport = (text, re) => importSpecs(text).some(s => re.test(s.replace(/\.ts$/, '')))

// ---- A. 休眠模块（只扫 services/stores/composables 下的扁平 .ts）----
const svcCands = []
for (const sub of ['services', 'stores', 'composables']) {
  const d = path.join(SRC, sub)
  if (!fs.existsSync(d)) continue
  for (const fn of fs.readdirSync(d)) if (fn.endsWith('.ts')) svcCands.push(path.join(d, fn))
}
const dormant = []
for (const c of svcCands) {
  const re = specRe(path.basename(c, '.ts'))
  const impSrc = [...srcText].filter(([p, t]) => p !== c && hitImport(t, re)).length
  const impTest = [...testText].filter(([, t]) => hitImport(t, re)).length
  if (impSrc === 0) dormant.push([path.relative(SRC, c).replace(/\\/g, '/'), impTest])
}

// ---- B. 死导出三分（全 src）----
const DEF = /^\s*export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
const buckets = { 'truly-dead': [], 'unwired-tested': [], 'internal-only': [] }
for (const [p, text] of srcText) {
  if (!p.endsWith('.ts')) continue
  for (const m of text.matchAll(DEF)) {
    const name = m[1]
    if (name.length < 4) continue
    const pat = new RegExp('\\b' + esc(name) + '\\b')
    // 计数必须用**全局**正则：非全局 re 的 String.match 只返回首个匹配（长度恒 1），
    // 会让「同文件自用」恒判 false、把 internal-only 全错分进另外两桶。
    const same = (text.match(new RegExp('\\b' + esc(name) + '\\b', 'g')) || []).length > 1
    if ([...srcText].some(([q, t]) => q !== p && pat.test(t))) continue
    const inTest = [...testText].some(([, t]) => pat.test(t))
    const line = text.slice(0, m.index).split('\n').length
    const rec = `${path.relative(SRC, p).replace(/\\/g, '/')}:${line}  ${name}`
    if (same) buckets['internal-only'].push(rec)
    else if (inTest) buckets['unwired-tested'].push(rec)
    else buckets['truly-dead'].push(rec)
  }
}

const lines = []
lines.push(`=== A. 休眠模块（src 内零 importer）: ${dormant.length} ===`)
for (const [f, nt] of dormant.sort((a, b) => a[1] - b[1])) lines.push(`  ${f}  (test-importers=${nt})`)
lines.push('')
for (const [k, label] of [['truly-dead', '真死'], ['unwired-tested', '未接但被测'], ['internal-only', '仅自用']]) {
  lines.push(`=== B. 死导出 ${k}（${label}）: ${buckets[k].length} ===`)
  for (const r of buckets[k].sort()) lines.push('  ' + r)
  lines.push('')
}
fs.writeFileSync(OUT, lines.join('\n'))
console.log(`written ${OUT}`)
console.log(`dormant=${dormant.length} truly-dead=${buckets['truly-dead'].length} unwired-tested=${buckets['unwired-tested'].length} internal-only=${buckets['internal-only'].length}`)
