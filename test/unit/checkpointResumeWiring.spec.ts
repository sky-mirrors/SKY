import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { vault } from '@/vault'

/**
 * 机制体检（2026-09-25）：dagCheckpoint 的**读侧**两头零消费者——
 *   · getIncompleteCheckpoints（=resume 候选查询）无人调用 ⇒ 用户看不到"哪些任务可恢复"；
 *   · pruneExpired（24h 过期回收）无人调用 ⇒ 过期检查点只能靠 saveCheckpoint 的 MAX=20 上限顺带淘汰。
 * 写侧（saveCheckpoint/getCheckpoint）与 resume 本身是活的（macroExecutor / DialogPanel），
 * 故这是"resume 半接"。「接」= ① 启动时 pruneExpired；② 检查点列表用 getIncompleteCheckpoints 标出可恢复。
 * 本文件把这两条接线钉成契约，并用行为断言固定"可恢复"的判定口径（UI 徽标依赖它）。
 */
vi.mock('@/vault', () => ({
  vault: {
    list: vi.fn(async () => []),
    read: vi.fn(async () => null),
    readCache: vi.fn(() => null),
    writeThrough: vi.fn()
  }
}))

const HOUR = 60 * 60 * 1000

describe('dagCheckpoint resume 读侧行为（UI 徽标依赖的口径）', () => {
  beforeEach(() => {
    vi.mocked(vault.read).mockReset()
  })

  it('getIncompleteCheckpoints 只留未完成且未过期；pruneExpired 清掉过期项', async () => {
    const now = Date.now()
    vi.mocked(vault.read).mockResolvedValue(JSON.stringify([
      { id: 'cp-incomplete', manifestId: 'm', completedResults: { 1: 'x' }, failedSteps: [], skipSteps: [], totalSteps: 3, createdAt: now, updatedAt: now },
      { id: 'cp-done', manifestId: 'm', completedResults: { 1: 'x', 2: 'y', 3: 'z' }, failedSteps: [], skipSteps: [], totalSteps: 3, createdAt: now, updatedAt: now },
      { id: 'cp-expired', manifestId: 'm', completedResults: { 1: 'x' }, failedSteps: [], skipSteps: [], totalSteps: 3, createdAt: now - 30 * HOUR, updatedAt: now - 30 * HOUR }
    ]) as unknown as string)

    const { getIncompleteCheckpoints, pruneExpired, getAllCheckpoints } = await import('@/services/dagCheckpoint')

    expect((await getIncompleteCheckpoints()).map(c => c.id)).toEqual(['cp-incomplete'])
    expect(await pruneExpired()).toBe(1)
    expect((await getAllCheckpoints()).map(c => c.id).sort()).toEqual(['cp-done', 'cp-incomplete'])
  })
})

describe('resume 读侧接线（启动清理 + 列表标可恢复）', () => {
  it('App.vue 启动时调用 pruneExpired', () => {
    const src = readFileSync(join(process.cwd(), 'src/App.vue'), 'utf-8')
    expect(src, '不调用 pruneExpired 时，过期检查点无处回收（读侧半接）').toContain('pruneExpired')
  })

  it('DialogPanel 用 getIncompleteCheckpoints 标出可恢复检查点', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DialogPanel.vue'), 'utf-8')
    expect(src, '不用 getIncompleteCheckpoints 时，用户看不到哪些任务可恢复').toContain('getIncompleteCheckpoints')
  })
})
