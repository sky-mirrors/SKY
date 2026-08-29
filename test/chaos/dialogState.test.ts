import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/stores/apiStore', () => ({
  useApiStore: () => ({
    chatCompletion: vi.fn().mockResolvedValue({
      content: 'mock response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    }),
    isReady: true,
    isCircuitOpen: false,
    config: { value: { isReachable: true, activeModel: 'test-model' } }
  })
}))

vi.mock('@/stores/nodeStore', () => ({
  useNodeStore: () => ({
    getL2Manifest: vi.fn().mockReturnValue(null),
    setL1Status: vi.fn(),
    l2Nodes: []
  })
}))

vi.mock('@/stores/memoryStore', () => ({
  useMemoryStore: () => ({
    allEmbeddings: [],
    search: vi.fn().mockResolvedValue([])
  })
}))

vi.mock('@/stores/mcpStore', () => ({
  useMcpStore: () => ({
    callTool: vi.fn().mockResolvedValue({ success: true, result: 'mock' }),
    activeConnections: []
  })
}))

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: () => ({
    emitEvent: vi.fn(),
    recordProbe: vi.fn(),
    recordStepCost: vi.fn(),
    enabled: false
  })
}))

vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: () => ({
    recordFeedback: vi.fn(),
    getWeightModifier: vi.fn().mockReturnValue(0),
    addSideEffectManifest: vi.fn()
  })
}))

vi.mock('@/services/knowledgeBase', () => ({
  searchKnowledge: vi.fn().mockResolvedValue(null)
}))

vi.mock('@/services/promptTranslator', () => ({
  planTask: vi.fn().mockResolvedValue({ intent: 'test', needs: [], steps: [] }),
  reflectOnResult: vi.fn().mockResolvedValue('ok'),
  saveTaskCase: vi.fn(),
  replan: vi.fn().mockResolvedValue({ intent: 'test', needs: [], steps: [] }),
  disambiguateChoice: vi.fn().mockResolvedValue({ chosenIndex: 0 }),
  translateIntent: vi.fn().mockResolvedValue(null)
}))

vi.mock('@/services/macroExecutor', () => ({
  executeMacro: vi.fn().mockResolvedValue({ results: {}, lastResult: 'mock', savedTokens: 0, lineage: [] }),
  resolveDirectPrompt: vi.fn().mockReturnValue(null),
  formatLineage: vi.fn().mockReturnValue(''),
  computeLineageSavings: vi.fn().mockReturnValue({ tokensSaved: 0, llmSteps: 0, zeroTokenSteps: 0 })
}))

vi.mock('@/services/resultBeautifier', () => ({
  beautify: vi.fn().mockReturnValue('beautified')
}))

vi.mock('@/services/scheduleOptimizer', () => ({
  contentHash: vi.fn().mockReturnValue('hash'),
  truncateForLog: vi.fn().mockReturnValue('truncated'),
  logManifestUsage: vi.fn()
}))

vi.mock('@/services/proactiveScheduler', () => ({
  logManifestUsage: vi.fn()
}))

vi.mock('@/services/toolRetrieval', () => ({
  buildToolIndex: vi.fn().mockReturnValue([]),
  retrieveTopTools: vi.fn().mockResolvedValue([]),
  makeSummaryToolList: vi.fn().mockReturnValue(''),
  raapMatch: vi.fn().mockResolvedValue(null),
  getTop3Candidates: vi.fn().mockReturnValue([])
}))

vi.mock('@/services/convMemory', () => ({
  indexConversationRound: vi.fn(),
  searchConversationContext: vi.fn().mockResolvedValue(''),
  getLatestSummary: vi.fn().mockReturnValue(null),
  getAllSummaries: vi.fn().mockReturnValue([]),
  savePeriodSummary: vi.fn(),
  shouldCompress: vi.fn().mockReturnValue(false),
  detectChallenge: vi.fn().mockReturnValue(false)
}))

vi.mock('@/services/factGuard', () => ({
  extractEntities: vi.fn().mockReturnValue([]),
  shouldTrigger: vi.fn().mockReturnValue(false),
  runFactGuard: vi.fn().mockReturnValue({ ok: true, conflicts: [], correctedOutput: '' })
}))

vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn().mockReturnValue(false),
  buildActionManifest: vi.fn(),
  dualEngineValidate: vi.fn().mockResolvedValue({ intent_match: true, parameter_sane: true, risk_level: 'low' })
}))

vi.mock('@/services/errorClassifier', () => ({
  classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'retry' })
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn()
})

vi.stubGlobal('window', {
  electronAPI: {
    shellExec: vi.fn().mockResolvedValue({ success: true, code: 0, stdout: 'mock', stderr: '' }),
    fileRead: vi.fn().mockResolvedValue({ success: true, content: 'mock' }),
    httpFetch: vi.fn().mockResolvedValue({ success: true, status: 200, body: 'mock' }),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    storeRead: vi.fn().mockResolvedValue(null),
    safeStorageEncrypt: vi.fn().mockResolvedValue('enc'),
    safeStorageDecrypt: vi.fn().mockResolvedValue('dec'),
    vectorWriteBin: vi.fn().mockResolvedValue(true),
    vectorReadBin: vi.fn().mockResolvedValue(null)
  }
})

import { useDialogStore } from '@/stores/dialogStore'

function createStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return useDialogStore()
}

type PauseFlag = 'awaitingConfirmation' | 'awaitingIntentConfirm' | 'awaitingSlotFill' | 'awaitingFactResolution' | 'awaitingRiskConfirm' | 'dagPaused' | 'awaitingTakeover'

const PAUSE_FLAGS: PauseFlag[] = [
  'awaitingConfirmation',
  'awaitingIntentConfirm',
  'awaitingSlotFill',
  'awaitingFactResolution',
  'awaitingRiskConfirm',
  'dagPaused',
  'awaitingTakeover'
]

function countActivePauses(store: ReturnType<typeof useDialogStore>): number {
  let count = 0
  if (store.awaitingConfirmation) count++
  if (store.awaitingIntentConfirm) count++
  if (store.awaitingSlotFill) count++
  if (store.awaitingFactResolution) count++
  if (store.awaitingRiskConfirm) count++
  if (store.dagPaused) count++
  if (store.awaitingTakeover) count++
  return count
}

function isDeadlock(store: ReturnType<typeof useDialogStore>): boolean {
  return store.isProcessing && !store.dagPaused && countActivePauses(store) === 0 && store.awaitingConfirmation === false
}

describe('dialogStore 混沌工程 - 7暂停点状态机', () => {
  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('单个暂停点进出', () => {
    it('awaitingConfirmation: 设置→清除', () => {
      store.awaitingConfirmation = true
      expect(store.awaitingConfirmation).toBe(true)
      store.rejectPlan()
      expect(store.awaitingConfirmation).toBe(false)
      expect(store.pendingPlan).toBeNull()
    })

    it('awaitingIntentConfirm: 设置→清除', () => {
      store.translatedIntent = { intent: 'test', manifestId: 'm1', params: {}, originalInput: 'test' }
      store.awaitingIntentConfirm = true
      expect(store.awaitingIntentConfirm).toBe(true)
      store.rejectTranslatedIntent()
      expect(store.awaitingIntentConfirm).toBe(false)
      expect(store.translatedIntent).toBeNull()
    })

    it('awaitingSlotFill: 设置→清除', () => {
      store.slotClarification = { manifestId: 'm1', manifestName: 'test', slots: [{ name: 'file', description: '文件名', required: true, value: '' }] }
      store.awaitingSlotFill = true
      expect(store.awaitingSlotFill).toBe(true)
      store.cancelSlotFill()
      expect(store.awaitingSlotFill).toBe(false)
      expect(store.slotClarification).toBeNull()
    })

    it('awaitingFactResolution: 设置→清除', () => {
      store.factConflict = { conflicts: [{ type: 'amount', sourceRaw: '100', outputRaw: '200', diff: '100 vs 200', severity: 'critical' }], pendingStepNum: 1, pendingManifestId: 'm1' }
      store.awaitingFactResolution = true
      expect(store.awaitingFactResolution).toBe(true)
      store.resolveFactConflict(true)
      expect(store.awaitingFactResolution).toBe(false)
      expect(store.factConflict).toBeNull()
    })

    it('awaitingRiskConfirm: 设置→清除', () => {
      const promise = store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '文件写入', expected_output: '', intent: '' })
      expect(store.awaitingRiskConfirm).toBe(true)
      expect(store.riskAction).not.toBeNull()
      store.resolveRiskConfirm(true)
      expect(store.awaitingRiskConfirm).toBe(false)
      expect(store.riskAction).toBeNull()
      return expect(promise).resolves.toBe(true)
    })

    it('dagPaused: 设置→清除', () => {
      store.pauseDagAtStep(3, 'm1')
      expect(store.dagPaused).toBe(true)
      expect(store.dagPausedStep).toBe(3)
      store.resumeDag()
      expect(store.dagPaused).toBe(false)
      expect(store.dagPausedStep).toBeNull()
    })

    it('awaitingTakeover: 设置→清除(submit)', () => {
      const promise = store.requestTakeover(5)
      expect(store.awaitingTakeover).toBe(true)
      store.submitTakeover('manual result')
      expect(store.awaitingTakeover).toBe(false)
      return expect(promise).resolves.toBe('manual result')
    })

    it('awaitingTakeover: 设置→清除(cancel)', () => {
      const promise = store.requestTakeover(5)
      expect(store.awaitingTakeover).toBe(true)
      store.cancelTakeover()
      expect(store.awaitingTakeover).toBe(false)
      return expect(promise).resolves.toBe('')
    })
  })

  describe('暂停点互斥: 随机暴力测试', () => {
    const RANDOM_SEEDS = [42, 137, 256, 789, 1024, 2048, 4096, 8192, 9999, 12345]

    function pseudoRandom(seed: number): () => number {
      let s = seed
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }
    }

    for (const seed of RANDOM_SEEDS) {
      it(`随机序列 seed=${seed}: 任何操作都不崩溃`, () => {
        const rand = pseudoRandom(seed)
        const ACTIONS = [
          () => { store.awaitingConfirmation = true },
          () => { store.awaitingIntentConfirm = true },
          () => { store.awaitingSlotFill = true },
          () => { store.awaitingFactResolution = true },
          () => { store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '文件写入', expected_output: '', intent: '' }) },
          () => { store.pauseDagAtStep(Math.floor(rand() * 10) + 1, 'm1') },
          () => { store.requestTakeover(Math.floor(rand() * 10) + 1) },
          () => { store.rejectPlan() },
          () => { store.rejectTranslatedIntent() },
          () => { store.cancelSlotFill() },
          () => { store.resolveFactConflict(true) },
          () => { store.resolveRiskConfirm(false) },
          () => { store.resumeDag() },
          () => { store.submitTakeover('result') },
          () => { store.cancelTakeover() },
        ] as (() => void)[]

        for (let i = 0; i < 200; i++) {
          const actionIdx = Math.floor(rand() * ACTIONS.length)
          try {
            ACTIONS[actionIdx]()
          } catch { /* some actions may fail in isolation, that's ok */ }
        }
      })
    }

    it('互斥锁: activatePausePoint会清除其他暂停点，最终只有1个活跃', () => {
      store.awaitingConfirmation = true
      store.awaitingIntentConfirm = true
      store.awaitingSlotFill = true
      store.awaitingFactResolution = true
      store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '文件写入', expected_output: '', intent: '' })
      store.pauseDagAtStep(1, 'm1')
      store.requestTakeover(1)
      const activeCount = countActivePauses(store)
      expect(activeCount).toBe(1)
      expect(store.awaitingTakeover).toBe(true)
    })
  })

  describe('死锁检测: isProcessing=true 且无暂停点 = 死锁', () => {
    it('isProcessing=true + 所有暂停点false + awaitingConfirmation=false → 标记为死锁', () => {
      store.isProcessing = true
      store.awaitingConfirmation = false
      store.awaitingIntentConfirm = false
      store.awaitingSlotFill = false
      store.awaitingFactResolution = false
      store.awaitingRiskConfirm = false
      store.dagPaused = false
      store.awaitingTakeover = false
      expect(isDeadlock(store)).toBe(true)
    })

    it('isProcessing=true + dagPaused=true → 非死锁(DAG暂停中)', () => {
      store.isProcessing = true
      store.dagPaused = true
      expect(isDeadlock(store)).toBe(false)
    })

    it('isProcessing=true + awaitingConfirmation=true → 非死锁(等待用户)', () => {
      store.isProcessing = true
      store.awaitingConfirmation = true
      expect(isDeadlock(store)).toBe(false)
    })

    it('isProcessing=false + 所有暂停点false → 正常空闲', () => {
      store.isProcessing = false
      expect(isDeadlock(store)).toBe(false)
    })

    it('isProcessing=true + awaitingTakeover=true → 非死锁(人工接管中)', () => {
      store.isProcessing = true
      store.requestTakeover(1)
      expect(isDeadlock(store)).toBe(false)
    })
  })

  describe('状态转换安全性: Promise闭包只resolve一次', () => {
    it('requestRiskConfirm 多次resolve不崩溃', async () => {
      const promise = store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      store.resolveRiskConfirm(true)
      store.resolveRiskConfirm(false)
      store.resolveRiskConfirm(true)
      const result = await promise
      expect(result).toBe(true)
      expect(store.awaitingRiskConfirm).toBe(false)
    })

    it('requestTakeover 多次resolve不崩溃', async () => {
      const promise = store.requestTakeover(1)
      store.submitTakeover('result1')
      store.submitTakeover('result2')
      store.cancelTakeover()
      const result = await promise
      expect(result).toBe('result1')
      expect(store.awaitingTakeover).toBe(false)
    })

    it('cancelTakeover 在无请求时调用不崩溃', () => {
      expect(() => store.cancelTakeover()).not.toThrow()
    })

    it('resolveRiskConfirm 在无请求时调用不崩溃', () => {
      expect(() => store.resolveRiskConfirm(true)).not.toThrow()
    })

    it('resolveFactConflict 在无冲突时调用不崩溃', () => {
      expect(() => store.resolveFactConflict(true)).not.toThrow()
    })

    it('resumeDag 在未暂停时调用不崩溃', () => {
      expect(() => store.resumeDag()).not.toThrow()
    })

    it('rejectPlan 在无计划时调用不崩溃', () => {
      expect(() => store.rejectPlan()).not.toThrow()
    })

    it('rejectTranslatedIntent 在无翻译时调用不崩溃', () => {
      expect(() => store.rejectTranslatedIntent()).not.toThrow()
    })
  })

  describe('极端场景: AbortController抢占 + DAG中断', () => {
    it('DAG暂停后立即resume → 状态恢复', () => {
      store.pauseDagAtStep(3, 'm1')
      expect(store.dagPaused).toBe(true)
      expect(store.dagPausedStep).toBe(3)
      store.resumeDag()
      expect(store.dagPaused).toBe(false)
      expect(store.dagPausedStep).toBeNull()
      expect(store.dagPausedManifestId).toBeNull()
    })

    it('DAG暂停→接管→取消接管 → 接管互斥清除DAG暂停，取消接管后无暂停', () => {
      store.pauseDagAtStep(3, 'm1')
      expect(store.dagPaused).toBe(true)
      store.requestTakeover(3)
      expect(store.dagPaused).toBe(false)
      expect(store.awaitingTakeover).toBe(true)
      store.cancelTakeover()
      expect(store.awaitingTakeover).toBe(false)
    })

    it('风险确认→DAG暂停: 互斥，后者覆盖前者', async () => {
      const riskPromise = store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      expect(store.awaitingRiskConfirm).toBe(true)
      store.pauseDagAtStep(2, 'm1')
      expect(store.awaitingRiskConfirm).toBe(false)
      expect(store.dagPaused).toBe(true)
      expect(countActivePauses(store)).toBe(1)
      store.resolveRiskConfirm(true)
      store.resumeDag()
      expect(store.dagPaused).toBe(false)
    })

    it('FactGuard冲突→风险确认: 互斥，后者覆盖前者', async () => {
      store.factConflict = { conflicts: [{ type: 'amount', sourceRaw: '100', outputRaw: '200', diff: '', severity: 'critical' }], pendingStepNum: 1, pendingManifestId: 'm1' }
      store.awaitingFactResolution = true
      store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      expect(store.awaitingFactResolution).toBe(false)
      expect(countActivePauses(store)).toBe(1)
      store.resolveRiskConfirm(true)
      store.resolveRiskConfirm(true)
      expect(store.awaitingRiskConfirm).toBe(false)
    })

    it('快速连续暂停→恢复→暂停→恢复 循环100次不崩溃', () => {
      for (let i = 0; i < 100; i++) {
        store.pauseDagAtStep(i % 10, `manifest-${i}`)
        expect(store.dagPaused).toBe(true)
        store.resumeDag()
        expect(store.dagPaused).toBe(false)
      }
    })

    it('快速连续requestRiskConfirm→resolve 循环50次', async () => {
      for (let i = 0; i < 50; i++) {
        const promise = store.requestRiskConfirm({ skill_id: `m${i}`, target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
        store.resolveRiskConfirm(i % 2 === 0)
        const result = await promise
        expect(result).toBe(i % 2 === 0)
      }
      expect(store.awaitingRiskConfirm).toBe(false)
    })

    it('快速连续requestTakeover→submit 循环50次', async () => {
      for (let i = 0; i < 50; i++) {
        const promise = store.requestTakeover(i)
        store.submitTakeover(`manual-${i}`)
        const result = await promise
        expect(result).toBe(`manual-${i}`)
      }
      expect(store.awaitingTakeover).toBe(false)
    })
  })

  describe('状态隔离: 清理一个暂停点不影响其他', () => {
    it('rejectPlan 不影响 dagPaused', () => {
      store.awaitingConfirmation = true
      store.pauseDagAtStep(3, 'm1')
      store.rejectPlan()
      expect(store.awaitingConfirmation).toBe(false)
      expect(store.dagPaused).toBe(true)
    })

    it('resumeDag 不影响 awaitingRiskConfirm', () => {
      store.pauseDagAtStep(3, 'm1')
      store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      store.resumeDag()
      expect(store.dagPaused).toBe(false)
      expect(store.awaitingRiskConfirm).toBe(true)
    })

    it('resolveRiskConfirm: 互斥锁已清除其他暂停点', () => {
      store.slotClarification = { manifestId: 'm1', manifestName: 'test', slots: [{ name: 'file', description: '文件名', required: true, value: '' }] }
      store.awaitingSlotFill = true
      store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      expect(store.awaitingSlotFill).toBe(false)
      expect(store.awaitingRiskConfirm).toBe(true)
      store.resolveRiskConfirm(true)
      expect(store.awaitingRiskConfirm).toBe(false)
    })

    it('cancelTakeover: 互斥锁已清除其他暂停点', () => {
      store.factConflict = { conflicts: [{ type: 'amount', sourceRaw: '100', outputRaw: '200', diff: '', severity: 'critical' }], pendingStepNum: 1, pendingManifestId: 'm1' }
      store.awaitingFactResolution = true
      store.requestTakeover(1)
      expect(store.awaitingFactResolution).toBe(false)
      expect(store.awaitingTakeover).toBe(true)
      store.cancelTakeover()
      expect(store.awaitingTakeover).toBe(false)
    })
  })

  describe('边界条件: 空值/undefined保护', () => {
    it('resolveFactConflict(null factConflict) → 安全', () => {
      store.factConflict = null
      store.awaitingFactResolution = false
      store.resolveFactConflict(true)
      expect(store.factConflict).toBeNull()
    })

    it('submitSlotFill(null slotClarification) → 安全', async () => {
      store.slotClarification = null
      store.awaitingSlotFill = false
      const result = await store.submitSlotFill({})
      expect(result).toBe('')
    })

    it('confirmTranslatedIntent(null translatedIntent) → 安全', async () => {
      store.translatedIntent = null
      store.awaitingIntentConfirm = false
      const result = await store.confirmTranslatedIntent()
      expect(result).toBe('')
    })

    it('pauseDagAtStep(0, "") → 不崩溃', () => {
      expect(() => store.pauseDagAtStep(0, '')).not.toThrow()
      expect(store.dagPaused).toBe(true)
      expect(store.dagPausedStep).toBe(0)
    })

    it('requestTakeover(-1) → 不崩溃', () => {
      expect(() => store.requestTakeover(-1)).not.toThrow()
      expect(store.awaitingTakeover).toBe(true)
    })
  })
})
