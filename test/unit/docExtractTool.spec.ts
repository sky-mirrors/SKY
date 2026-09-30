import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * doc_extract / file_copy 分派测试（2026-09-30）
 *
 * 两个 2026-09-30 新增的原生工具：doc_extract 走主进程 doc:extractFromPath（按路径提取
 * pdf/docx/xlsx/xls 文本），file_copy 走主进程 file:copy。本文件锁两条链路的成功与失败语义。
 *
 * mock 面参照 macroExecutor.tools.spec.ts 的既有基建；writeGate 直接桩掉（授权门本身
 * 由 writeGate 的既有用例覆盖，不是本文件的被测对象）。
 */

const mockDebugStore = { enabled: false, emitEvent: vi.fn(), recordProbe: vi.fn(), registerAbortController: vi.fn(), clearAbortController: vi.fn() }
const mockDialogStore = {
  dagPaused: false, dagPausedStep: null as number | null, awaitingTakeover: false, takeoverStepNum: null as number | null,
  addSystemNotice: vi.fn(), requestRiskConfirm: vi.fn().mockResolvedValue(true), requestTakeover: vi.fn().mockResolvedValue('t'),
  clearAllPausePoints: vi.fn(), awaitingRiskConfirm: false, riskAction: null
}
const mockFeedbackStore = { addSideEffectManifest: vi.fn(), recordFeedback: vi.fn(), getWeightModifier: vi.fn().mockReturnValue(0) }

vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => mockDebugStore) }))
vi.mock('@/stores/dialogStore', () => ({ useDialogStore: vi.fn(() => mockDialogStore) }))
vi.mock('@/stores/feedbackStore', () => ({ useFeedbackStore: vi.fn(() => mockFeedbackStore), computeQueryFingerprint: vi.fn().mockReturnValue('fp') }))
vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn().mockReturnValue(false), buildActionManifest: vi.fn().mockReturnValue({}),
  dualEngineValidate: vi.fn().mockResolvedValue({ intent_match: true, parameter_sane: true, risk_level: 'low' }), isPathUnsafe: vi.fn().mockReturnValue(false)
}))
vi.mock('@/services/errorClassifier', () => ({ classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'abort', fixHint: '' }) }))
vi.mock('@/services/factGuard', () => ({
  extractEntities: vi.fn().mockReturnValue([]), extractEntitiesAll: vi.fn().mockReturnValue([]),
  shouldTrigger: vi.fn().mockReturnValue(false),
  runFactGuardV2: vi.fn().mockReturnValue({ ok: true, conflicts: [], hallucinatedEntities: [], severity: 'ok', correctedOutput: null, summary: 'ok' })
}))
vi.mock('@/services/ruleEngine', () => ({ runRuleEngine: vi.fn().mockReturnValue({ matched: false, output: '' }), buildRuleContext: vi.fn().mockReturnValue({}) }))
vi.mock('@/services/dagCheckpoint', () => ({ saveCheckpoint: vi.fn(), removeCheckpoint: vi.fn(), getCheckpoint: vi.fn().mockResolvedValue(null), createCheckpointId: vi.fn().mockReturnValue('cp') }))
vi.mock('@/services/secureStore', () => ({ storeGet: vi.fn().mockResolvedValue(null), storeSet: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/services/writeGate', () => ({ requestWriteApproval: vi.fn().mockResolvedValue(true) }))

import { callToolDirectWithTier } from '@/services/macroExecutor'

let docExtractFromPath: ReturnType<typeof vi.fn>
let fileCopy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  docExtractFromPath = vi.fn().mockResolvedValue({ success: true, text: '提取到的正文' })
  fileCopy = vi.fn().mockResolvedValue({ success: true, from: 'C:\\a.txt', to: 'C:\\b.txt' })
  ;(globalThis as any).window = {
    electronAPI: {
      platform: 'win32',
      docExtractFromPath,
      fileCopy,
      storeRead: vi.fn().mockResolvedValue(null),
      storeWrite: vi.fn().mockResolvedValue(undefined),
      resolvePath: vi.fn().mockResolvedValue('C:\\Users\\Test')
    }
  }
})

describe('callToolDirectWithTier · doc_extract（2026-09-30 新增）', () => {
  it('成功：返回主进程提取的正文', async () => {
    const out = await callToolDirectWithTier('doc_extract', { path: 'C:\\docs\\a.pdf' })
    expect(out).toBe('提取到的正文')
    expect(docExtractFromPath).toHaveBeenCalledWith('C:\\docs\\a.pdf')
  })

  it('主进程返回失败 → 抛错（不静默返回空）', async () => {
    docExtractFromPath.mockResolvedValue({ success: false, error: '解析失败: bad pdf' })
    await expect(callToolDirectWithTier('doc_extract', { path: 'C:\\docs\\bad.pdf' }))
      .rejects.toThrow('解析失败')
  })

  it('缺路径 → 抛错', async () => {
    await expect(callToolDirectWithTier('doc_extract', {}))
      .rejects.toThrow('missing path')
  })
})

describe('callToolDirectWithTier · file_copy（2026-09-30 新增）', () => {
  it('成功：返回 from → to', async () => {
    const out = await callToolDirectWithTier('file_copy', { from: 'C:\\a.txt', to: 'C:\\b.txt' })
    expect(out).toContain('已复制')
    expect(fileCopy).toHaveBeenCalledWith({ from: 'C:\\a.txt', to: 'C:\\b.txt' })
  })

  it('主进程返回失败 → 抛错', async () => {
    fileCopy.mockResolvedValue({ success: false, error: '目标路径被安全策略拒绝' })
    await expect(callToolDirectWithTier('file_copy', { from: 'C:\\a.txt', to: 'C:\\Windows\\x' }))
      .rejects.toThrow('安全策略')
  })
})
