import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { evictFingerprintMock } = vi.hoisted(() => ({ evictFingerprintMock: vi.fn() }))

vi.mock('@/services/scheduleOptimizer', () => ({
  evictFingerprint: evictFingerprintMock
}))

import {
  extractRequestedArtifact,
  statCandidates,
  conformanceCheck,
  applyDeliverableGate
} from '@/services/deliverableCheck'

const originalWindow = globalThis.window

function mockShellExec(stdout: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ stdout })
  ;(globalThis as any).window = { electronAPI: { shellExec: fn } }
  return fn
}

beforeEach(() => {
  evictFingerprintMock.mockClear()
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('extractRequestedArtifact', () => {
  it('纯问答/开放式生成类输入返回null（无命名产物）', () => {
    expect(extractRequestedArtifact('帮我整理一份会议纪要')).toBeNull()
    expect(extractRequestedArtifact('把下面这段话翻译成英文：你好世界')).toBeNull()
    expect(extractRequestedArtifact('分析一下这份财报的风险')).toBeNull()
    expect(extractRequestedArtifact('')).toBeNull()
  })

  it('读文件类输入返回null（只有源路径，无产出动词）', () => {
    expect(extractRequestedArtifact('帮我看一下 C:\\Users\\test\\报告.docx 里写了什么')).toBeNull()
  })

  it('复考Q3/Q18句式：转格式+同文件夹+指定文件名 → 完整目标路径', () => {
    const r = extractRequestedArtifact('把 C:\\Users\\Administrator\\Desktop\\HoloExam\\项目周报.docx 转成 PDF 格式，输出到同一个文件夹里，文件名叫 项目周报.pdf')
    expect(r).not.toBeNull()
    expect(r!.fileName).toBe('项目周报.pdf')
    expect(r!.dir).toBe('C:\\Users\\Administrator\\Desktop\\HoloExam')
    expect(r!.path).toBe('C:\\Users\\Administrator\\Desktop\\HoloExam\\项目周报.pdf')
  })

  it('转格式无显式文件名 → 由源文件名+新扩展名推断', () => {
    const r = extractRequestedArtifact('把 C:\\Users\\test\\采购合同.docx 转成 pdf')
    expect(r).not.toBeNull()
    expect(r!.fileName).toBe('采购合同.pdf')
    expect(r!.sourcePath).toBe('C:\\Users\\test\\采购合同.docx')
  })

  it('转格式无源文件 → 返回null（无法解析目标名）', () => {
    expect(extractRequestedArtifact('帮我转成pdf')).toBeNull()
  })

  it('桌面新建文件 → ~DESKTOP 哨兵目录', () => {
    const r = extractRequestedArtifact('在桌面新建一个测试.txt')
    expect(r).not.toBeNull()
    expect(r!.fileName).toBe('测试.txt')
    expect(r!.dir).toBe('~DESKTOP')
  })

  it('新建文件未指明位置 → 目录为null（闸门靠产物名称比对）', () => {
    const r = extractRequestedArtifact('新建一个测试.txt')
    expect(r).not.toBeNull()
    expect(r!.fileName).toBe('测试.txt')
    expect(r!.dir).toBeNull()
  })

  it('显式保存目录', () => {
    const r = extractRequestedArtifact('把总结保存到 C:\\Users\\test\\out 目录，文件名叫 总结.md')
    expect(r).not.toBeNull()
    expect(r!.fileName).toBe('总结.md')
    expect(r!.dir).toBe('C:\\Users\\test\\out')
    expect(r!.path).toBe('C:\\Users\\test\\out\\总结.md')
  })
})

describe('statCandidates', () => {
  it('优先返回非空命中', async () => {
    mockShellExec('STATHIT:0:C:\\a\\空.txt\nSTATHIT:1024:C:\\a\\实.txt\nSTATDONE')
    const hit = await statCandidates(['C:\\a\\空.txt', 'C:\\a\\实.txt'])
    expect(hit).toEqual({ path: 'C:\\a\\实.txt', size: 1024 })
  })

  it('全部为0字节时返回首个命中', async () => {
    mockShellExec('STATHIT:0:C:\\a\\空.txt\nSTATDONE')
    const hit = await statCandidates(['C:\\a\\空.txt'])
    expect(hit).toEqual({ path: 'C:\\a\\空.txt', size: 0 })
  })

  it('全部不存在返回null（探测已运行）', async () => {
    mockShellExec('STATDONE')
    expect(await statCandidates(['C:\\missing.txt'])).toBeNull()
  })

  it('~DESKTOP 前缀交由探测脚本展开', async () => {
    const fn = mockShellExec('STATHIT:5:C:\\Users\\Test\\Desktop\\x.txt\nSTATDONE')
    await statCandidates(['~DESKTOP\\x.txt'])
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('~DESKTOP')
    }))
  })

  it('无electronAPI返回undefined（fail-open）', async () => {
    ;(globalThis as any).window = {}
    expect(await statCandidates(['C:\\a.txt'])).toBeUndefined()
  })

  it('探测抛异常返回undefined（fail-open）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('probe failed'))
    ;(globalThis as any).window = { electronAPI: { shellExec: fn } }
    expect(await statCandidates(['C:\\a.txt'])).toBeUndefined()
  })

  it('空路径列表返回undefined', async () => {
    expect(await statCandidates([])).toBeUndefined()
  })
})

describe('conformanceCheck', () => {
  it('无命名产物 → skip（零开销直通）', async () => {
    mockShellExec('STATDONE')
    const r = await conformanceCheck('帮我总结这段话', [])
    expect(r.status).toBe('skip')
  })

  it('目标文件存在且非空 → ok', async () => {
    mockShellExec('STATHIT:2048:C:\\out\\项目周报.pdf\nSTATDONE')
    const r = await conformanceCheck('把 C:\\src\\项目周报.docx 转成 PDF 保存到 C:\\out，文件名叫 项目周报.pdf', [])
    expect(r.status).toBe('ok')
  })

  it('目标文件存在但0字节 → mismatch（空文件假完成）', async () => {
    mockShellExec('STATHIT:0:C:\\Users\\test\\out\\测试.txt\nSTATDONE')
    const r = await conformanceCheck('把笔记保存到 C:\\Users\\test\\out 目录，文件名叫 测试.txt', [])
    expect(r.status).toBe('mismatch')
    expect(r.detail).toContain('空文件')
  })

  it('目标不存在且无产物记录 → no-artifact', async () => {
    mockShellExec('STATDONE')
    const r = await conformanceCheck('把 C:\\src\\项目周报.docx 转成 PDF 格式，输出到同一个文件夹里，文件名叫 项目周报.pdf', [])
    expect(r.status).toBe('no-artifact')
    expect(r.detail).toContain('项目周报.pdf')
  })

  it('产物名称与要求不符 → no-artifact 列出实际产物（Q14病理）', async () => {
    mockShellExec('STATDONE')
    const r = await conformanceCheck('把 C:\\src\\采购合同.docx 转成 PDF 格式，输出到同一个文件夹里，文件名叫 采购合同.pdf', ['C:\\Users\\Administrator\\Desktop\\新建文档.docx'])
    expect(r.status).toBe('no-artifact')
    expect(r.detail).toContain('新建文档.docx')
    expect(r.detail).toContain('采购合同.pdf')
  })

  it('产物路径命中要求名称且非空 → ok（候选含产物路径）', async () => {
    mockShellExec('STATHIT:100:C:\\src\\项目周报.pdf\nSTATDONE')
    const r = await conformanceCheck('把 C:\\src\\项目周报.docx 转成 PDF 格式，输出到同一个文件夹里，文件名叫 项目周报.pdf', ['C:\\src\\项目周报.pdf'])
    expect(r.status).toBe('ok')
  })

  it('探测不可用 → skip（fail-open 不指控）', async () => {
    ;(globalThis as any).window = {}
    const r = await conformanceCheck('把总结保存到 C:\\out，文件名叫 测试.txt', [])
    expect(r.status).toBe('skip')
  })

  it('无候选路径且无产物 → no-artifact（进程内证据，无需探测）', async () => {
    ;(globalThis as any).window = {}
    const r = await conformanceCheck('新建一个测试.txt', [])
    expect(r.status).toBe('no-artifact')
    expect(r.detail).toContain('测试.txt')
  })
})

describe('applyDeliverableGate', () => {
  it('核验通过时原样返回且不清指纹', async () => {
    mockShellExec('STATHIT:2048:C:\\out\\项目周报.pdf\nSTATDONE')
    const out = await applyDeliverableGate('把 C:\\src\\项目周报.docx 转成 PDF 保存到 C:\\out，文件名叫 项目周报.pdf', [], '文件已保存: 项目周报.pdf', 'm1', 'fp1')
    expect(out).toBe('文件已保存: 项目周报.pdf')
    expect(evictFingerprintMock).not.toHaveBeenCalled()
  })

  it('skip输入原样返回', async () => {
    mockShellExec('STATDONE')
    const out = await applyDeliverableGate('帮我总结这段话', [], '总结内容', 'm1', 'fp1')
    expect(out).toBe('总结内容')
    expect(evictFingerprintMock).not.toHaveBeenCalled()
  })

  it('产物缺失时前置核验事实 + 清指纹（防假成功重放）', async () => {
    mockShellExec('STATDONE')
    const out = await applyDeliverableGate('把 C:\\src\\项目周报.docx 转成 PDF 格式，输出到同一个文件夹里，文件名叫 项目周报.pdf', [], '文件已保存: 项目周报.pdf', 'm1', 'fp1')
    expect(out).not.toBe('文件已保存: 项目周报.pdf')
    expect(out.startsWith('⚠️ 产物核验')).toBe(true)
    expect(out).toContain('文件已保存: 项目周报.pdf')
    expect(out).toContain('不得宣称任务已完成')
    expect(evictFingerprintMock).toHaveBeenCalledWith('m1', 'fp1')
  })

  it('空manifestId跳过清指纹（L0原生路径无指纹库）', async () => {
    mockShellExec('STATDONE')
    await applyDeliverableGate('新建一个测试.txt', [], '文件已写入: 测试.txt', '', '')
    expect(evictFingerprintMock).not.toHaveBeenCalled()
  })

  it('conformanceCheck抛异常时fail-open原样返回', async () => {
    const fn = vi.fn().mockResolvedValue({ stdout: 'STATHIT:not-a-number:garbage' })
    ;(globalThis as any).window = { electronAPI: { shellExec: fn } }
    const out = await applyDeliverableGate('新建一个测试.txt', [], '原始结果', 'm1', 'fp1')
    expect(typeof out).toBe('string')
  })
})
