import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdit, editFileOnDisk, EDIT_MAX_FILE_BYTES } from '@electron/fileEdit'

/**
 * 精确编辑（2026-10-07 可用性补强 Wave 1）
 *
 * 动机：常驻原生工具集此前**只有 `file_write`（整文件覆盖）**，没有局部替换——
 * 改一个函数要把整个文件重打一遍，长文件必然截断/丢内容。这是 holo 相比通用编码 agent
 * 最硬的能力缺口（"改完自己验证"的回路物理走不通）。
 *
 * 设计（与主流 agent 同口径，误改风险最低）：**唯一子串匹配**——
 * oldString 出现 0 次 → 失败（未找到）；>1 次且未传 replaceAll → 失败（不唯一，要求补上下文）。
 */
describe('fileEdit · 精确编辑（唯一子串匹配）', () => {
  describe('applyEdit（纯逻辑，不碰磁盘）', () => {
    it('唯一命中 → 只改那一处', () => {
      const r = applyEdit('const a = 1\nconst b = 2\n', 'const a = 1', 'const a = 9')
      expect(r.ok).toBe(true)
      expect(r.replaced).toBe(1)
      expect(r.content).toContain('const a = 9')
      expect(r.content).toContain('const b = 2')
    })

    it('未找到 → 失败且不改内容', () => {
      const r = applyEdit('abc', 'zzz', 'yyy')
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('未找到')
      expect(r.content).toBeUndefined()
    })

    it('出现 2 次且未传 replaceAll → 失败（不唯一）', () => {
      const r = applyEdit('x\nx\n', 'x', 'y')
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('不唯一')
    })

    it('replaceAll → 改所有出现处并报出条数', () => {
      const r = applyEdit('x\nx\n', 'x', 'y', true)
      expect(r.ok).toBe(true)
      expect(r.replaced).toBe(2)
      expect(r.content).toBe('y\ny\n')
    })

    it('oldString 为空 → 失败（不做"在所有位置插入"这种歧义操作）', () => {
      const r = applyEdit('abc', '', 'X')
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('不能为空')
    })
  })

  describe('editFileOnDisk（读→替换→写回）', () => {
    let dir: string
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'holo-edit-')) })
    afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

    it('真实落盘往返：改后磁盘内容确为替换结果', () => {
      const f = join(dir, 'a.txt')
      writeFileSync(f, 'hello world\n', 'utf-8')
      const r = editFileOnDisk(f, 'world', 'holo')
      expect(r.ok).toBe(true)
      expect(r.replaced).toBe(1)
      expect(readFileSync(f, 'utf-8')).toBe('hello holo\n')
    })

    it('不唯一时**不落盘**（fail-closed：磁盘内容保持原样）', () => {
      const f = join(dir, 'b.txt')
      writeFileSync(f, 'dup\ndup\n', 'utf-8')
      const r = editFileOnDisk(f, 'dup', 'x')
      expect(r.ok).toBe(false)
      expect(readFileSync(f, 'utf-8')).toBe('dup\ndup\n')
    })

    it('文件不存在 → 失败不抛', () => {
      const r = editFileOnDisk(join(dir, 'nope.txt'), 'a', 'b')
      expect(r.ok).toBe(false)
    })

    it('超过上限的文件拒绝编辑', () => {
      expect(EDIT_MAX_FILE_BYTES).toBeGreaterThan(0)
      expect(EDIT_MAX_FILE_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024)
    })
  })
})
