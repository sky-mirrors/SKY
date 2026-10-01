import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 2026-10-01（多窗口缓存一致性）：
 * 各渲染进程各持一份 vault 缓存、彼此不可见，导致「A 窗改完 → B 窗用旧快照读-改-写 →
 * A 的改动被覆盖」。实测到知识库删除被主窗旧快照回滚（磁盘一度在 12 与 169 之间反复横跳）。
 *
 * 修复由两半构成，这里各锁定一条不变量：
 *  ① vault.syncKey(ns, key)：先从主进程读回该 key 的真值再更新缓存；
 *     opts.flush 默认为 true —— 必须先落盘再读，否则读到的是未 flush 的旧值，
 *     会把刚做的改动撤销（实测：连删 163 条只生效 4 条）。
 *  ② 订阅 onVaultChanged 时用 { flush:false } —— 被动同步不该把本窗的写推出去。
 */
const originalWindow = globalThis.window

const vaultRead = vi.fn()
const onVaultChanged = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vaultRead.mockReset().mockResolvedValue(null)
  onVaultChanged.mockReset()
  ;(globalThis as any).window = {
    // vault 模块在被导入时会注册 beforeunload/pagehide 的 flush 监听
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: {
      vaultRead,
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([]),
      onVaultChanged
    }
  }
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('vault.syncKey —— 多窗口写前对齐', () => {
  it('从主进程读回该 key 并更新本地缓存', async () => {
    const { vault } = await import('@/vault/index')
    vault.writeCache('knowledge', 'k1', 'OLD')
    vaultRead.mockResolvedValue('NEW')
    await vault.syncKey('knowledge', 'k1')
    expect(vault.readCache('knowledge', 'k1')).toBe('NEW')
  })

  it('默认 flush：先落盘再读（否则读到未 flush 的旧值会撤销改动）', async () => {
    const { vault } = await import('@/vault/index')
    const writeSpy = (globalThis as any).window.electronAPI.vaultWrite
    vault.writeThrough('knowledge', 'k2', 'LOCAL-NEW')
    vaultRead.mockResolvedValue('DISK-AFTER-FLUSH')
    await vault.syncKey('knowledge', 'k2')
    // 若未先 flush，vaultWrite 不会被调用，读到的是旧值
    expect(writeSpy).toHaveBeenCalled()
    expect(vault.readCache('knowledge', 'k2')).toBe('DISK-AFTER-FLUSH')
  })

  it('opts.flush=false：被动同步不推本窗的写', async () => {
    const { vault } = await import('@/vault/index')
    const writeSpy = (globalThis as any).window.electronAPI.vaultWrite
    vault.writeThrough('knowledge', 'k3', 'LOCAL-PENDING')
    writeSpy.mockClear()
    vaultRead.mockResolvedValue('REMOTE-VALUE')
    await vault.syncKey('knowledge', 'k3', { flush: false })
    expect(writeSpy).not.toHaveBeenCalled()
    expect(vault.readCache('knowledge', 'k3')).toBe('REMOTE-VALUE')
  })

  it('主进程返回 null 时不覆盖缓存（避免把有效值抹成空）', async () => {
    const { vault } = await import('@/vault/index')
    vault.writeCache('knowledge', 'k4', 'KEEP-ME')
    vaultRead.mockResolvedValue(null)
    await vault.syncKey('knowledge', 'k4')
    expect(vault.readCache('knowledge', 'k4')).toBe('KEEP-ME')
  })
})

describe('vault 启动订阅 —— 他窗写入广播', () => {
  it('启动时注册 onVaultChanged，收到广播即刷新对应 key', async () => {
    let cb: ((d: { namespace: string; key: string }) => void) | null = null
    onVaultChanged.mockImplementation((fn: typeof cb) => { cb = fn })
    const { vault } = await import('@/vault/index')
    expect(onVaultChanged).toHaveBeenCalled()
    expect(cb).not.toBeNull()

    vault.writeCache('knowledge', 'k5', 'STALE')
    vaultRead.mockResolvedValue('FRESH-FROM-OTHER-WINDOW')
    cb!({ namespace: 'knowledge', key: 'k5' })
    await new Promise(r => setTimeout(r, 0))
    expect(vault.readCache('knowledge', 'k5')).toBe('FRESH-FROM-OTHER-WINDOW')
  })
})
