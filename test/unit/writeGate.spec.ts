// O10 写类工具授权边界的单测（2026-09-22 用户裁决 B）。
// 关键不变量：默认 fail-closed——无授权/读取失败/未表态一律不放行写操作；
// 读类工具不受约束；授权按工具分别记录且可撤销。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WRITE_TOOLS,
  WRITE_TOOL_LABELS,
  isWriteTool,
  loadWriteGrants,
  isWriteToolGranted,
  grantWriteTool,
  revokeWriteGrant,
  resetWriteGrantCache,
  describeWriteTarget
} from '@/services/writeGate'

const originalWindow = globalThis.window
let storeReadFn: ReturnType<typeof vi.fn>
let storeWriteFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  resetWriteGrantCache()
  storeReadFn = vi.fn().mockResolvedValue(null)
  storeWriteFn = vi.fn().mockResolvedValue(true)
  ;(globalThis as any).window = {
    electronAPI: { storeRead: storeReadFn, storeWrite: storeWriteFn }
  }
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
  resetWriteGrantCache()
})

describe('O10：写类工具判定', () => {
  it('file_write / file_move / create_docx 属写类；read_file / list_directory / shell_exec 不属', () => {
    expect(isWriteTool('file_write')).toBe(true)
    expect(isWriteTool('file_move')).toBe(true)
    expect(isWriteTool('create_docx')).toBe(true)
    // 读保持恒可用——不受本边界约束
    expect(isWriteTool('read_file')).toBe(false)
    expect(isWriteTool('list_directory')).toBe(false)
    // shell_exec 由 executeStep 的 risk_level==='high' 通道把关，不重复纳入
    expect(isWriteTool('shell_exec')).toBe(false)
  })

  it('WRITE_TOOLS 与 WRITE_TOOL_LABELS 一一对应（确认条文案不缺项）', () => {
    for (const t of WRITE_TOOLS) {
      expect(WRITE_TOOL_LABELS[t]).toBeTruthy()
    }
    expect(Object.keys(WRITE_TOOL_LABELS).sort()).toEqual([...WRITE_TOOLS].sort())
  })
})

describe('O10：授权读写（fail-closed）', () => {
  it('无持久化授权 ⇒ 写类未授权，读类恒为已授权', async () => {
    expect(await isWriteToolGranted('file_write')).toBe(false)
    expect(await isWriteToolGranted('file_move')).toBe(false)
    expect(await isWriteToolGranted('read_file')).toBe(true)
    expect(await isWriteToolGranted('list_directory')).toBe(true)
  })

  it('storeRead 抛错 ⇒ 视为无授权（绝不因读取失败而放行）', async () => {
    storeReadFn.mockRejectedValueOnce(new Error('ipc down'))
    expect(await isWriteToolGranted('file_write')).toBe(false)
    expect(await loadWriteGrants()).toEqual({})
  })

  it('持久化里只有 true 才计数（脏值 false/字符串一律忽略）', async () => {
    storeReadFn.mockResolvedValueOnce({ file_write: true, file_move: false, create_docx: 'yes' } as unknown)
    expect(await isWriteToolGranted('file_write')).toBe(true)
    expect(await isWriteToolGranted('file_move')).toBe(false)
    expect(await isWriteToolGranted('create_docx')).toBe(false)
  })

  it('「始终允许」⇒ 持久化并按工具分别生效（不波及其它写类工具）', async () => {
    await grantWriteTool('file_move')

    expect(storeWriteFn).toHaveBeenCalledWith('write-tool-grants', { file_move: true })
    expect(await isWriteToolGranted('file_move')).toBe(true)
    expect(await isWriteToolGranted('file_write')).toBe(false)
  })

  it('写盘失败 ⇒ 本次会话内存态仍生效（不阻塞用户，只是下次启动需重新授权）', async () => {
    storeWriteFn.mockRejectedValueOnce(new Error('disk full'))
    await grantWriteTool('file_write')
    expect(await isWriteToolGranted('file_write')).toBe(true)
  })

  it('撤销单个：只清该工具；撤销全部：清空', async () => {
    await grantWriteTool('file_write')
    await grantWriteTool('file_move')

    await revokeWriteGrant('file_write')
    expect(await isWriteToolGranted('file_write')).toBe(false)
    expect(await isWriteToolGranted('file_move')).toBe(true)

    await revokeWriteGrant()
    expect(await isWriteToolGranted('file_move')).toBe(false)
  })

  it('已授权后不再重复读盘（内存缓存命中）', async () => {
    await isWriteToolGranted('file_write')
    const callsAfterFirst = storeReadFn.mock.calls.length
    await isWriteToolGranted('file_write')
    expect(storeReadFn.mock.calls.length).toBe(callsAfterFirst)
  })
})

describe('O10：确认条展示的目标描述', () => {
  it('file_move 渲染为 源 → 目标', () => {
    expect(describeWriteTarget('file_move', { from: 'C:\\a\\1.jpg', to: 'C:\\a\\2.jpg' }))
      .toBe('C:\\a\\1.jpg → C:\\a\\2.jpg')
  })

  it('file_write 取 filePath/path', () => {
    expect(describeWriteTarget('file_write', { filePath: 'C:\\a\\out.txt' })).toBe('C:\\a\\out.txt')
    expect(describeWriteTarget('file_write', { path: 'C:\\a\\out.txt' })).toBe('C:\\a\\out.txt')
  })

  it('缺参数时给占位而非 undefined（确认条不能显示空白）', () => {
    expect(describeWriteTarget('file_write', {})).toBe('(未提供路径)')
    expect(describeWriteTarget('file_move', {})).toBe('(未提供路径)')
  })
})
