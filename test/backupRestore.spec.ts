import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateBackupDir, planRestoreTargets, applyRestore } from '@electron/backupRestore'

function mkroot(): string {
  return mkdtempSync(join(tmpdir(), 'holo-restore-'))
}
function write(p: string, content = 'x') {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

describe('E-4: 备份恢复工具（validateBackupDir / planRestoreTargets / applyRestore）', () => {
  const roots: string[] = []
  const newRoot = () => {
    const r = mkroot()
    roots.push(r)
    return r
  }
  afterEach(() => {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    roots.length = 0
  })

  describe('validateBackupDir', () => {
    it('store 目录接受 json/bin（含子目录）', () => {
      const d = newRoot()
      write(join(d, 'a.json'))
      write(join(d, 'vectors', 'v.bin'))
      expect(validateBackupDir(d, ['json', 'bin']).files).toBe(2)
    })

    it('vault 目录接受 db/db-wal/db-shm（WAL 三件套）', () => {
      const d = newRoot()
      write(join(d, 'default.db'))
      write(join(d, 'default.db-wal'))
      write(join(d, 'default.db-shm'))
      expect(validateBackupDir(d, ['db', 'db-wal', 'db-shm']).files).toBe(3)
    })

    it('不支持的类型 → 抛错', () => {
      const d = newRoot()
      write(join(d, 'evil.exe'))
      expect(() => validateBackupDir(d, ['json', 'bin'])).toThrow()
    })

    it('超过文件数上限 → 抛错', () => {
      const d = newRoot()
      for (let i = 0; i < 5; i++) write(join(d, `f${i}.json`))
      expect(() => validateBackupDir(d, ['json', 'bin'], { maxFiles: 3 })).toThrow()
    })
  })

  describe('planRestoreTargets', () => {
    const dirs = { storeDir: join('L', 'store'), vaultsDir: join('L', 'vaults'), knowledgeDir: join('L', 'knowledge') }

    it('仅 store → 只规划 store', () => {
      const tmp = newRoot()
      write(join(tmp, 'store', 'a.json'))
      expect(planRestoreTargets(tmp, dirs).map(t => t.kind)).toEqual(['store'])
    })

    it('store + vaults + knowledge → 三个目标（顺序 store→vaults→knowledge）', () => {
      const tmp = newRoot()
      write(join(tmp, 'store', 'a.json'))
      write(join(tmp, 'vaults', 'default.db'))
      write(join(tmp, 'knowledge', 'e.json'))
      expect(planRestoreTargets(tmp, dirs).map(t => t.kind)).toEqual(['store', 'vaults', 'knowledge'])
    })
  })

  describe('applyRestore', () => {
    it('交换 live 目录、保留快照，且 vaults 交换前触发 beforeSwap', () => {
      const base = newRoot()
      const live = join(base, 'vaults')
      mkdirSync(live, { recursive: true })
      writeFileSync(join(live, 'old.db'), 'old')
      const staged = join(base, 'staged-vaults')
      mkdirSync(staged, { recursive: true })
      writeFileSync(join(staged, 'new.db'), 'new')

      const calls: string[] = []
      const snaps = applyRestore([{ kind: 'vaults', live, staged }], 123, (k) => calls.push(k))

      expect(calls).toEqual(['vaults'])
      expect(readFileSync(join(live, 'new.db'), 'utf8')).toBe('new')
      expect(existsSync(join(live, 'old.db'))).toBe(false)
      expect(readFileSync(join(snaps[0], 'old.db'), 'utf8')).toBe('old')
    })

    it('任一目标校验失败 → 不动任何 live 目录（全量校验先行）', () => {
      const base = newRoot()
      const live1 = join(base, 'store')
      mkdirSync(live1, { recursive: true })
      writeFileSync(join(live1, 'keep.json'), 'k')
      const staged1 = join(base, 's1')
      mkdirSync(staged1, { recursive: true })
      writeFileSync(join(staged1, 'a.json'), 'a')
      const live2 = join(base, 'knowledge')
      mkdirSync(live2, { recursive: true })
      writeFileSync(join(live2, 'keep2.json'), 'k2')
      const staged2 = join(base, 's2')
      mkdirSync(staged2, { recursive: true })
      writeFileSync(join(staged2, 'evil.exe'), 'e') // 非法扩展名

      expect(() =>
        applyRestore([
          { kind: 'store', live: live1, staged: staged1 },
          { kind: 'knowledge', live: live2, staged: staged2 },
        ], 7)
      ).toThrow()

      // 两个 live 目录都保持原样
      expect(readFileSync(join(live1, 'keep.json'), 'utf8')).toBe('k')
      expect(readFileSync(join(live2, 'keep2.json'), 'utf8')).toBe('k2')
    })
  })
})
