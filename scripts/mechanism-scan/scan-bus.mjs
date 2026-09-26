#!/usr/bin/env node
// 机制体检 · 总线普查 + 死监听复核（可复跑资产；口径与已知误报源见同目录 README.md）
//
// 普查（**仅生产** src+electron）：globalBus/bus 的 emit|request|requestAsync('chan') 对 registerHandler|on('chan')
//   A. 有发射、无监听（死发射）
//   B. 有监听、无发射（死监听候选）
// 复核（B 的每个频道，在 src+electron+**test** 里找调用方）：按**完整带引号字符串**找出现行，
//   排除注册行（registerHandler(/on(）与注释行 → DEAD / CALLED。
//   test/ 只进复核（找调用方），**不进普查**——否则 bus.spec 等的假频道会污染候选表。
//
// 用法：node scripts/mechanism-scan/scan-bus.mjs [--out <path>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')
const ELECTRON = path.join(ROOT, 'electron')
const TEST = path.join(ROOT, 'test')
const outArgIdx = process.argv.indexOf('--out')
const OUT = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : path.join(ROOT, '.rivet-scan-bus.txt')

// 关键：`(?<![\w$])(?:globalBus|bus)\.` 同时覆盖 `globalBus.emit`、`bus.emit`、`this.bus.emit`
// （旧版 `(?<![\w.])bus\.` 把 `this.bus.emit` 排除 → kernel:*/pack:* 被误判为死监听）；
// `(?:<[^>]*>)?` 覆盖 `request<T>('chan')`（旧版漏类型参数 → 14 个误报）。
const EMIT = /(?<![\w$])(?:globalBus|bus)\.(?:emit|request|requestAsync)(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/
const LISTEN = /(?:\.registerHandler|(?<![\w$])(?:globalBus|bus)\.on)(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/

function collect(roots) {
  const files = new Map()
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(ts|vue)$/.test(entry.name)) continue
      const p = path.join(entry.parentPath ?? entry.path, entry.name)
      try { files.set(p, fs.readFileSync(p, 'utf8')) } catch { /* skip */ }
    }
  }
  return files
}

const prodFiles = collect([SRC, ELECTRON])
const allFiles = collect([SRC, ELECTRON, TEST])
const short = p => path.relative(ROOT, p).replace(/\\/g, '/')

const emitSites = new Map(), listenSites = new Map()
const add = (map, ch, p, i) => { if (!map.has(ch)) map.set(ch, []); map.get(ch).push([p, i]) }
for (const [p, text] of prodFiles) {
  text.split('\n').forEach((line, idx) => {
    const s = line.trim()
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return
    const e = EMIT.exec(line); if (e) add(emitSites, e[1], p, idx + 1)
    const l = LISTEN.exec(line); if (l) add(listenSites, l[1], p, idx + 1)
  })
}
const emitOnly = [...emitSites.keys()].filter(c => !listenSites.has(c)).sort()
const listenOnly = [...listenSites.keys()].filter(c => !emitSites.has(c)).sort()

const lines = []
lines.push(`=== A. 有发射、无监听（死发射）: ${emitOnly.length} ===`)
for (const c of emitOnly) lines.push(`  ${c.padEnd(46)} x${emitSites.get(c).length}  ${short(emitSites.get(c)[0][0])}:${emitSites.get(c)[0][1]}`)
lines.push('')
lines.push(`=== B. 有监听、无发射（死监听候选）: ${listenOnly.length}，逐项复核如下 ===`)
let dead = 0
for (const ch of listenOnly) {
  const quoted = new RegExp(`['"\`]${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`)   // 完整字符串字面量（避免 'config:set' 命中 'config:set-job-role'）
  const hits = []
  for (const [p, text] of allFiles) {
    text.split('\n').forEach((line, idx) => {
      if (!quoted.test(line)) return
      const s = line.trim()
      if (/\.registerHandler\s*\(|\.on\s*\(/.test(s)) return
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return
      hits.push(`${short(p)}:${idx + 1}: ${s.slice(0, 120)}`)
    })
  }
  if (hits.length === 0) dead++
  lines.push(`  ${ch.padEnd(46)} ${hits.length === 0 ? 'DEAD(仅注册，无调用方)' : `CALLED x${hits.length}`}`)
  for (const h of hits.slice(0, 2)) lines.push('      ' + h)
}
lines.push('')
lines.push(`totals(生产) : emit_channels=${emitSites.size} listen_channels=${listenSites.size} | 死监听候选 ${listenOnly.length} 中 DEAD=${dead} / 误判=${listenOnly.length - dead}`)

fs.writeFileSync(OUT, lines.join('\n'))
console.log(`written ${OUT}`)
console.log(`emit_only=${emitOnly.length} listen_only=${listenOnly.length} DEAD=${dead} false-positive=${listenOnly.length - dead}`)
