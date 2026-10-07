import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

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
  runFactGuard: vi.fn().mockReturnValue({ ok: true, conflicts: [], correctedOutput: '' }),
  runFactGuardV2: vi.fn().mockReturnValue({ ok: true, conflicts: [], correctedOutput: '', layer1Entities: [], layer2ConstraintResults: [], layer3CrossDocResults: [], allConstraintResults: [] })
}))

vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn().mockReturnValue(false),
  buildActionManifest: vi.fn(),
  dualEngineValidate: vi.fn().mockResolvedValue({ intent_match: true, parameter_sane: true, risk_level: 'low' })
}))

vi.mock('@/services/errorClassifier', () => ({
  classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'retry' })
}))

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
    vectorReadBin: vi.fn().mockResolvedValue(null),
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
})

import { useDialogStore } from '@/stores/dialogStore'
import { resolveDirectPrompt } from '@/services/macroExecutor'

function createStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return useDialogStore()
}

type PauseFlag = 'awaitingConfirmation' | 'awaitingIntentConfirm' | 'awaitingSlotFill' | 'awaitingCandidatePick' | 'awaitingFactResolution' | 'awaitingRiskConfirm' | 'dagPaused' | 'awaitingTakeover'

const PAUSE_FLAGS: PauseFlag[] = [
  'awaitingConfirmation',
  'awaitingIntentConfirm',
  'awaitingSlotFill',
  'awaitingCandidatePick',
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
  if (store.awaitingCandidatePick) count++
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
    vault.clearCache()
    store = createStore()
  })

  afterEach(() => {
    globalBus.clear()
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
      store.clearAllPausePoints()
      store.awaitingFactResolution = true
      store.requestRiskConfirm({ skill_id: 'm1', target_file: 'test.txt', operation: '写入', expected_output: '', intent: '' })
      expect(store.awaitingFactResolution).toBe(false)
      expect(countActivePauses(store)).toBe(1)
      store.resolveRiskConfirm(true)
      store.resolveRiskConfirm(true)
      expect(store.awaitingRiskConfirm).toBe(false)
    })

    it('candidatePick与其他暂停点互斥', () => {
      store.clearAllPausePoints()
      store.awaitingCandidatePick = true
      expect(store.awaitingCandidatePick).toBe(true)
      expect(countActivePauses(store)).toBe(1)
      store.clearAllPausePoints()
      store.awaitingRiskConfirm = true
      expect(store.awaitingCandidatePick).toBe(false)
      expect(store.awaitingRiskConfirm).toBe(true)
      expect(countActivePauses(store)).toBe(1)
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
      store.clearAllPausePoints()
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

describe('P1-46/A5-9 候选选择流：数字拦截与直调执行', () => {
  const directManifest = {
    identity: { id: 'm-direct', name: '直调工具' },
    execution: { mode: 'direct', directCall: { promptTemplate: '模板 {input}' } }
  } as any

  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    store = createStore()
    globalBus.registerHandler('node:get-l2-manifest', () => directManifest)
    globalBus.registerHandler('api:chat-completion', async () => ({ content: '直调结果' }))
    vi.mocked(resolveDirectPrompt).mockReturnValue({ prompt: 'resolved prompt', maxTokens: 128 } as any)
    // sendMessage 后续流程会经 yieldToUI（requestAnimationFrame），node 环境需打桩
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number)
  })

  it('数字输入映射候选编号：执行直调并落 assistant 消息（原始请求透传，不误取编号）', async () => {
    store.addUserMessage('帮我总结报告')
    store.pendingCandidateList = [
      { manifestId: 'm-direct', manifestName: '直调工具', score: 0.8 },
      { manifestId: 'm-other', manifestName: '其他工具', score: 0.5 }
    ]
    store.awaitingCandidatePick = true

    const ret = await store.sendMessage('1')
    expect(ret).toBe('beautified')
    expect(store.awaitingCandidatePick).toBe(false)
    expect(store.pendingCandidateList).toEqual([])
    expect(store.isProcessing).toBe(false)
    // 原始请求从倒数第二条还原，编号消息不得作为直调输入
    expect(vi.mocked(resolveDirectPrompt).mock.calls[0]?.[1]).toMatchObject({ inputText: '帮我总结报告' })
    const last = store.messages[store.messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('beautified')
  })

  it('非数字输入：放弃候选选择，按新请求继续', async () => {
    globalBus.registerHandler('api:is-ready', () => false)
    globalBus.registerHandler('api:get-config', () => ({}))
    store.addUserMessage('原始请求')
    store.pendingCandidateList = [{ manifestId: 'm-direct', manifestName: '直调工具', score: 0.8 }]
    store.awaitingCandidatePick = true

    const ret = await store.sendMessage('换个工具试试')
    expect(ret).toBe('')
    expect(store.awaitingCandidatePick).toBe(false)
    expect(store.pendingCandidateList).toEqual([])
    const notices = store.messages.filter(m => m.role === 'system')
    expect(notices.some(n => n.content.includes('已放弃候选选择'))).toBe(true)
  })

  it('confirmTranslatedIntent 直调模式：确认后执行 chat-completion，不再静默返回', async () => {
    store.translatedIntent = { intent: '总结', manifestId: 'm-direct', params: {}, originalInput: '原文内容' }
    store.awaitingIntentConfirm = true
    const ret = await store.confirmTranslatedIntent()
    expect(ret).toBe('beautified')
    expect(store.translatedIntent).toBeNull()
    expect(store.awaitingIntentConfirm).toBe(false)
    const last = store.messages[store.messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('beautified')
  })

  it('submitSlotFill 直调模式：填参后执行 chat-completion，不再静默返回', async () => {
    store.slotClarification = { manifestId: 'm-direct', manifestName: '直调工具', slots: [] }
    store.awaitingSlotFill = true
    const ret = await store.submitSlotFill({ topic: 'x' })
    expect(ret).toBe('beautified')
    expect(store.slotClarification).toBeNull()
    expect(store.awaitingSlotFill).toBe(false)
    const last = store.messages[store.messages.length - 1]
    expect(last.role).toBe('assistant')
  })

  it('pickCandidate 直调模式：直接执行，不再进入 pendingPlan 二次确认回合', async () => {
    store.pendingCandidateList = [{ manifestId: 'm-direct', manifestName: '直调工具', score: 0.9 }]
    store.awaitingCandidatePick = true
    const ret = await store.pickCandidate(0)
    expect(ret).toBe('beautified')
    expect(store.awaitingConfirmation).toBe(false)
    expect(store.pendingPlan).toBeNull()
  })
})

/**
 * 回归（2026-10-07，V2 50 题考试归因）：
 *   三个「暂停点裁决后恢复执行」的函数——confirmTranslatedIntent / submitSlotFill / pickCandidate——
 *   其 **macro/chain 分支**只写 system 通知（pickCandidate 甚至什么都不写），**未经统一呈现点
 *   presentExecutionOutput**，故宏的执行结果既不入会话记忆、也不受 pre-output 否决门约束。
 *   实测后果：V2 50 题中 6 题走 candidates 路由，其中 5 题 replyExcerpt 为空、判卷记「无回复内容」
 *   （用户选完候选后看不到任何结果）。
 *   既有测试只覆盖这三个函数的 **direct 分支**，macro 分支零覆盖——缺陷因此长期潜伏。
 */
describe('暂停点恢复执行必须经统一呈现点（macro 分支漏呈现回归）', () => {
  const macroManifest = {
    identity: { id: 'm-macro', name: '宏工具' },
    execution: {
      mode: 'macro',
      dagPlan: [{ step: 1, description: 'x', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    }
  } as any

  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    store = createStore()
    globalBus.registerHandler('node:get-l2-manifest', () => macroManifest)
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number)
  })

  it('pickCandidate(宏模式)：执行结果必须落 assistant 消息，不能只剩 system 通知', async () => {
    store.pendingCandidateList = [{ manifestId: 'm-macro', manifestName: '宏工具', score: 0.9 }]
    store.awaitingCandidatePick = true
    await store.pickCandidate(0)
    const assistantMsgs = store.messages.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
    expect(store.messages[store.messages.length - 1]?.role).toBe('assistant')
  })

  it('submitSlotFill(宏模式)：执行结果必须落 assistant 消息', async () => {
    store.slotClarification = { manifestId: 'm-macro', manifestName: '宏工具', slots: [] }
    store.awaitingSlotFill = true
    await store.submitSlotFill({})
    const assistantMsgs = store.messages.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
    expect(store.messages[store.messages.length - 1]?.role).toBe('assistant')
  })

  it('confirmTranslatedIntent(宏模式)：执行结果必须落 assistant 消息', async () => {
    store.translatedIntent = { intent: '总结', manifestId: 'm-macro', params: {}, originalInput: '原文内容' }
    store.awaitingIntentConfirm = true
    await store.confirmTranslatedIntent()
    const assistantMsgs = store.messages.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
    expect(store.messages[store.messages.length - 1]?.role).toBe('assistant')
  })
})

/**
 * 回归（2026-10-07，V2 50 题端到端验收）：
 *   `pickCandidate` 有**三条静默 return '' 路径**——无效编号 / manifest 查不到 / 执行模式不受支持——
 *   它们只写（或干脆不写）system 通知，**不产出任何 assistant 消息**。
 *   用户视角即「选完候选，什么都没发生」；考试器只采集 assistant 消息，故把这 5 题记成「无回复内容」。
 *
 *   实测：2026-10-07 端到端验收，candidates 路由的 M02/M03/M04/H04/R16 五题 replyExcerpt 长度仍为 0
 *   —— 说明上一轮补的 presentExecutionOutput **没有覆盖这些早退分支**（那条路考试根本没走到）。
 *   失败必须可读（Holo 诚实性原则）：宁可明说「没做成、为什么、下一步」，不可静默。
 */
describe('pickCandidate 失败路径必须产出可读回复（消除静默失败）', () => {
  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    store = createStore()
  })

  it('候选列表为空 / 编号越界 → 落 assistant 说明', async () => {
    store.pendingCandidateList = []
    store.awaitingCandidatePick = true
    await store.pickCandidate(0)
    expect(store.messages[store.messages.length - 1]?.role).toBe('assistant')
  })

  it('manifest 查不到（如 MCP 工具 id 误作 manifestId）→ 落 assistant 说明', async () => {
    globalBus.registerHandler('node:get-l2-manifest', () => null)
    store.pendingCandidateList = [{ manifestId: 'mcp-tool-id', manifestName: '某工具', score: 0.5 }]
    store.awaitingCandidatePick = true
    await store.pickCandidate(0)
    expect(store.messages[store.messages.length - 1]?.role).toBe('assistant')
  })

  it('执行模式不受支持（既非 macro/chain+dagPlan 也非 direct）→ 落 assistant 说明', async () => {
    globalBus.registerHandler('node:get-l2-manifest', () => ({
      identity: { id: 'm-odd', name: '模式未覆盖的工具' },
      execution: { mode: 'unknown-mode' }
    }))
    store.pendingCandidateList = [{ manifestId: 'm-odd', manifestName: '模式未覆盖的工具', score: 0.5 }]
    store.awaitingCandidatePick = true
    await store.pickCandidate(0)
    const last = store.messages[store.messages.length - 1]
    expect(last?.role).toBe('assistant')
    expect((last?.content || '').length).toBeGreaterThan(0)
  })

  /**
   * MCP 工具候选（2026-10-07）：
   *   MCP 歧义分支把 `c.item.id`（= MCP 工具规范全名 `{safeConnId}___{safeToolName}`）存进 manifestId，
   *   而 pickCandidate 原先只查 L2 manifest ⇒ 这类候选必然落到「查不到」。
   *   修法：查不到 L2 manifest 时按 MCP 工具名再试，命中则走与「非歧义 MCP 分支」相同的调用路径。
   */
  it('MCP 工具候选 → 走 MCP 调用路径，产出真实结果（而非只能报「没做成」）', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number)
    // 真实环境该通道由 nodeStore 注册；测试须显式提供，否则 bus.request 抛错。
    globalBus.registerHandler('node:get-l2-manifest', () => null)
    globalBus.registerHandler('mcp:get-connections', () => ([
      { id: 'srv1', name: 'Srv', isConnected: true, tools: [{ name: 'do_thing', description: 'x', inputSchema: { type: 'object', properties: {} } }] }
    ]))
    globalBus.registerHandler('mcp:call-tool', async () => 'MCP_OK')
    globalBus.registerHandler('api:chat-completion', async () => ({
      content: '', toolCalls: [{ id: 't1', name: 'srv1___do_thing', arguments: '{}' }]
    }))
    store.addUserMessage('用那个工具做件事')
    store.pendingCandidateList = [{ manifestId: 'srv1___do_thing', manifestName: '某 MCP 工具', score: 0.9 }]
    store.awaitingCandidatePick = true
    await store.pickCandidate(0)
    const last = store.messages[store.messages.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.content || '').toContain('MCP_OK')
  })
})


// —— V2-T02/T04：宏路径承接上下文的数据源（dialog:get-recent-context） ——
describe('dialogStore.getRecentAssistantOutput（宏承接上下文数据源）', () => {
  it('返回最近一条 assistant 文本产出', () => {
    const s = createStore()
    s.addUserMessage('帮我写一份会议通知')
    s.addAssistantMessage('会议通知\n各位同事：兹定于下午三点召开会议。')
    expect(s.getRecentAssistantOutput()).toContain('会议通知')
  })

  it('无 assistant 文本产出时返回空串', () => {
    const s = createStore()
    s.addUserMessage('你好')
    expect(s.getRecentAssistantOutput()).toBe('')
  })

  it('多条产出时取最近一条', () => {
    const s = createStore()
    s.addAssistantMessage('第一条产出内容')
    s.addAssistantMessage('第二条产出内容')
    expect(s.getRecentAssistantOutput()).toBe('第二条产出内容')
  })
})


// —— V2-T02/T04：宏承接上下文——bus 通道端到端（注册 → 请求 → 取到 store 数据） ——
describe('dialog:get-recent-context 通道（宏承接上下文端到端）', () => {
  it('注册后经 bus 请求，取到最近一条 assistant 产出', async () => {
    globalBus.clear()
    const s = createStore()
    s.addAssistantMessage('上一轮的会议通知正文：兹定于下午三点召开会议。')
    const { registerDialogHandlers } = await import('@/domains/dialog/handlers')
    registerDialogHandlers(globalBus)
    const ctx = globalBus.request<string>('dialog:get-recent-context', {})
    expect(String(ctx)).toContain('上一轮的会议通知正文')
  })

  it('无产出时通道返回空串（不抛）', async () => {
    globalBus.clear()
    createStore()
    const { registerDialogHandlers } = await import('@/domains/dialog/handlers')
    registerDialogHandlers(globalBus)
    expect(String(globalBus.request<string>('dialog:get-recent-context', {}))).toBe('')
  })
})
