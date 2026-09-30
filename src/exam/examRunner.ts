// EXAM-4：验收考试器（ACCEPTANCE-SPEC.md「考试器实现约束」）。
// 走真实主路径：发题经 dialogStore.sendMessage（opts.taskType='exam' 注册 traceId），
// 监考靠 bus 事件聚合（dialog:pause-acquired 干预计数 / funnel:routed 路径 /
// debug:record-cost token 归因），判卷结合制：逐题硬断言 + EXAM_JUDGE_PROMPT_V1 模型判卷。
// 完成检测用 isProcessing+暂停态轮询稳定窗（sendMessage 恒 fire-and-forget，不可 await 语义）。

import { globalBus } from '@/kernel/bus'
import { useDialogStore } from '@/stores/dialogStore'
import { useApiStore } from '@/stores/apiStore'
import { clearExamTraces } from './examRegistry'
import { EXAM_CASES, type ExamCase, type ExamAssertion, type ExamCategory } from './examCases'

export const EXAM_JUDGE_PROMPT_VERSION = 'EXAM_JUDGE_PROMPT_V1'

export const EXAM_JUDGE_PROMPT_V1 = `你是验收考试的判卷员。下面给出用户的任务要求（考题）和助手的最终回答。请判断这份回答能否作为工作成果直接交付给用户。
判定标准：任务是否完成、内容是否正确、结构是否清晰、是否包含占位符/报错信息/未完成的痕迹、文件操作类任务是否明确说明产物位置。
判卷提示：{JUDGE_HINT}
只输出 JSON，不要输出其他内容：{"deliverable": true} 或 {"deliverable": false, "note": "一句话理由"}

【考题】
{QUESTION}

【助手回答】
{REPLY}`

// ACCEPTANCE-SPEC 及格线 v1（2026-09-19 定死）
export const EXAM_PASS_LINES = {
  deliverableRate: 0.8,
  zeroInterventionRate: 0.6,
  avgDurationMs: 120000
} as const

export interface ExamQuestionResult {
  id: string
  title: string
  category: ExamCategory
  status: 'done' | 'skipped-fixture' | 'timeout' | 'error' | 'cancelled'
  durationMs: number
  interventions: number
  routeKind: string
  hardAssertPassed: boolean | null
  hardAssertNote: string
  judgeVerdict: 'deliverable' | 'not-deliverable' | 'judge-error' | 'skipped' | null
  judgeNote: string
  failureStage: 'routing' | 'planning' | 'execution' | 'output' | null
  traceId: string
  replyExcerpt: string
  totalTokens: number
}

export interface ExamReport {
  spec: string
  judgePromptVersion: string
  startedAt: number
  finishedAt: number
  passLines: { deliverableRate: number; zeroInterventionRate: number; avgDurationMs: number }
  summary: {
    total: number
    graded: number
    skippedFixture: number
    deliverable: number
    deliverableRate: number
    zeroIntervention: number
    zeroInterventionRate: number
    avgDurationMs: number
    totalTokens: number
    /** X-1：判卷失败题数（判卷基建失败，非能力失败）——单列，不并入可交付率分母 */
    judgeErrors: number
    /** X-1：可判题数（graded − judgeErrors），可交付率的分母 */
    judgeable: number
  }
  questions: ExamQuestionResult[]
  notes: string[]
}

export interface ExamRunnerDeps {
  sendMessage(content: string, isQueuedReplay: boolean, opts?: { taskType?: 'exam' }): Promise<string>
  getState(): { isProcessing: boolean; paused: boolean; traceId: string; messages: { role: string; content: string; timestamp: number }[] }
  judge(userPrompt: string): Promise<string>
  fileExists(path: string): Promise<boolean | null>
  dirMatches(dir: string, pattern: string): Promise<boolean | null>
}

export interface ExamRunOptions {
  fixtureReady?: boolean
  timeoutMsPerQuestion?: number
  /** 测试注入用：轮询间隔与稳定窗（默认 1000/4000） */
  pollMs?: number
  graceMs?: number
  cases?: ExamCase[]
}

export interface ExamProgress {
  phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  current: number
  total: number
  currentLabel: string
  currentStatus: string
  report: ExamReport | null
  errorMessage: string
}

export interface ExamRunner {
  progress: ExamProgress
  run(options?: ExamRunOptions): Promise<ExamReport | null>
  cancel(): void
  exportReport(): Promise<string | null>
}

export interface CreateExamRunnerOptions {
  /**
   * EXAM-6：注入外部 progress 对象（须为 reactive 代理）——runner 闭包内
   * 直接改写该对象，绕过组件 ref 深层代理的 EXAM-6 病理即被消除；
   * 同时供 Pinia store 持有（EXAM-1：模式切换孤儿化修复）。
   */
  progress?: ExamProgress
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// 数值提取：兼容千分位逗号与中文"万"单位（0.09万 → 900），供 number 断言匹配
export function extractNumbers(text: string): number[] {
  const out: number[] = []
  const stripped = text.replace(/(-?\d[\d,]*(?:\.\d+)?)万/g, (_s: string, num: string) => {
    out.push(parseFloat(num.replace(/,/g, '')) * 10000)
    return ' '
  })
  const plain = /-?\d[\d,]*(?:\.\d+)?/g
  let p: RegExpExecArray | null
  while ((p = plain.exec(stripped)) !== null) {
    out.push(parseFloat(p[0].replace(/,/g, '')))
  }
  return out
}

export function parseJudgeReply(reply: string): { deliverable: boolean; note: string } | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(reply.slice(start, end + 1)) as { deliverable?: unknown; note?: unknown }
    if (typeof obj.deliverable !== 'boolean') return null
    return { deliverable: obj.deliverable, note: typeof obj.note === 'string' ? obj.note : '' }
  } catch {
    return null
  }
}

// 默认依赖：真实主路径（dialogStore 发题 / apiStore 判卷 / shellExec 文件断言）
export function createDefaultExamDeps(): ExamRunnerDeps {
  const dialogStore = useDialogStore()
  const apiStore = useApiStore()
  return {
    sendMessage: (content, queued, opts) => dialogStore.sendMessage(content, queued, opts),
    getState: () => ({
      isProcessing: dialogStore.isProcessing,
      paused: dialogStore.awaitingConfirmation || dialogStore.awaitingIntentConfirm || dialogStore.awaitingSlotFill
        || dialogStore.awaitingCandidatePick || dialogStore.awaitingFactResolution || dialogStore.awaitingRiskConfirm
        || dialogStore.dagPaused || dialogStore.awaitingTakeover,
      traceId: dialogStore.activeTraceId,
      messages: dialogStore.messages.map(msg => ({ role: msg.role, content: msg.content || '', timestamp: msg.timestamp }))
    }),
    judge: async (userPrompt) => {
      // 判卷调用同为 exam 流量（taskType 隔离学习回路，record-cost 照常归因）
      const r = await apiStore.chatCompletion(
        [{ role: 'user', content: userPrompt }], false, undefined, undefined, undefined,
        { taskType: 'exam' }
      )
      return r.content
    },
    fileExists: async (path) => {
      try {
        const api = (window as unknown as { electronAPI?: { shellExec?: (args: { command: string }) => Promise<{ stdout?: string }> } }).electronAPI
        if (!api?.shellExec) return null
        const script = "const fs=require('fs');console.log(fs.existsSync(process.argv[1])?'EXAM_YES':'EXAM_NO')"
        const result = await api.shellExec({ command: `node -e "${script}" "${path}"` })
        const out = String(result.stdout || '')
        if (out.includes('EXAM_YES')) return true
        if (out.includes('EXAM_NO')) return false
        return null
      } catch {
        return null
      }
    },
    dirMatches: async (dir, pattern) => {
      try {
        const api = (window as unknown as { electronAPI?: { shellExec?: (args: { command: string }) => Promise<{ stdout?: string }> } }).electronAPI
        if (!api?.shellExec) return null
        const script = "const fs=require('fs');const f=fs.readdirSync(process.argv[1]);const re=new RegExp(process.argv[2],'i');console.log(f.length>0&&f.every(x=>re.test(x))?'EXAM_YES':'EXAM_NO')"
        const result = await api.shellExec({ command: `node -e "${script}" "${dir}" "${pattern}"` })
        const out = String(result.stdout || '')
        if (out.includes('EXAM_YES')) return true
        if (out.includes('EXAM_NO')) return false
        return null
      } catch {
        return null
      }
    }
  }
}

interface QuestionWindow {
  active: boolean
  interventions: number
  routeKind: string
  totalTokens: number
  traceId: string
}

export function createExamRunner(deps: ExamRunnerDeps, options?: CreateExamRunnerOptions): ExamRunner {
  const progress: ExamProgress = options?.progress ?? {
    phase: 'idle',
    current: 0,
    total: 0,
    currentLabel: '',
    currentStatus: '',
    report: null,
    errorMessage: ''
  }

  let cancelled = false
  let win: QuestionWindow = { active: false, interventions: 0, routeKind: '', totalTokens: 0, traceId: '' }

  async function runHardAssertions(c: ExamCase, reply: string): Promise<{ passed: boolean | null; note: string }> {
    if (c.assertions.length === 0) return { passed: null, note: '' }
    const failures: string[] = []
    let sawPass = false
    let allInconclusive = true
    for (const a of c.assertions) {
      const r = await runSingleAssertion(a, reply)
      if (r === true) { sawPass = true; allInconclusive = false }
      else if (r === false) { allInconclusive = false; failures.push(describeAssertion(a)) }
    }
    if (failures.length > 0) return { passed: false, note: failures.join('；') }
    if (allInconclusive && !sawPass) return { passed: null, note: '' }
    return { passed: true, note: '' }
  }

  async function runSingleAssertion(a: ExamAssertion, reply: string): Promise<boolean | null> {
    if (a.kind === 'number') {
      const tolerance = a.tolerance ?? 0
      const nums = extractNumbers(reply)
      if (nums.length === 0) return false
      return nums.some(n => Math.abs(n - a.expected) <= tolerance)
    }
    if (a.kind === 'contains') {
      return a.needles.length > 0 && a.needles.every(n => reply.includes(n))
    }
    if (a.kind === 'fileExists') {
      return deps.fileExists(a.path)
    }
    if (a.kind === 'dirPattern') {
      return deps.dirMatches(a.dir, a.pattern)
    }
    if (a.kind === 'notContains') {
      // 2026-09-30：负向硬断言——回复里**不得**出现这些串（用于假完成/编造类负例）。
      // 全部不出现才算通过；任一出现即失败。
      return a.needles.every(n => !reply.includes(n))
    }
    return null
  }

  function describeAssertion(a: ExamAssertion): string {
    if (a.kind === 'number') return `数值断言未命中（期望 ${a.expected}${a.tolerance ? `±${a.tolerance}` : ''}）`
    if (a.kind === 'contains') return `关键信息缺失（${a.needles.join('/')}）`
    if (a.kind === 'fileExists') return `预期文件不存在（${a.path}）`
    if (a.kind === 'notContains') return `出现不应出现的内容（${a.needles.join('/')}）`
    return `目录命名模式不匹配（${a.dir}）`
  }

  function inferFailureStage(q: ExamQuestionResult): ExamQuestionResult['failureStage'] {
    if (q.judgeVerdict === 'deliverable' && q.hardAssertPassed !== false) return null
    // 启发式归因（顺序判定）：报告 notes 已声明，人工复核时修正
    if (!q.routeKind || q.routeKind === 'exception') return 'routing'
    if (q.interventions > 0) return 'planning'
    if (!q.replyExcerpt) return 'execution'
    return 'output'
  }

  async function runQuestion(c: ExamCase, timing: { timeoutMs: number; pollMs: number; graceMs: number }): Promise<ExamQuestionResult> {
    const start = Date.now()
    const baseline = deps.getState().messages.length
    win = { active: true, interventions: 0, routeKind: '', totalTokens: 0, traceId: '' }

    // 发题（2026-09-30 V2 多轮）：首轮 `prompt` + 可选 `followUps`，逐条发送、每轮各自等完成。
    // `followUps` 缺省时 turns 只有一条 —— 单轮题的行为与 V1 逐字节等价。
    const { timeoutMs, pollMs, graceMs } = timing
    const turns = [c.prompt, ...(c.followUps ?? [])]

    /** 等一轮完成：isProcessing=false 且无暂停点、稳定 graceMs 视为完成；超时兜底 + 排水。 */
    const waitTurn = async (): Promise<void> => {
      const tStart = Date.now()
      let stableSince = 0
      for (;;) {
        if (cancelled) break
        if (Date.now() - tStart >= timeoutMs) break
        await sleep(pollMs)
        const s = deps.getState()
        if (s.isProcessing || s.paused) { stableSince = 0; continue }
        if (stableSince === 0) { stableSince = Date.now(); continue }
        if (Date.now() - stableSince >= graceMs) break
      }
      // 超时但系统仍忙：排水等待（避免带着在途执行发下一轮/下一题，污染归因窗口）
      const s = deps.getState()
      if ((s.isProcessing || s.paused) && !cancelled) {
        const drainDeadline = Date.now() + timeoutMs
        while (Date.now() < drainDeadline) {
          await sleep(pollMs)
          const d = deps.getState()
          if (!d.isProcessing && !d.paused) break
        }
        const d = deps.getState()
        if (d.isProcessing || d.paused) {
          throw new Error(`题目 ${c.id} 超时后系统仍在执行，中止考试以免污染后续题目归因`)
        }
      }
    }

    // fire-and-forget 发送（sendMessage 各分支恒 return ''，完成靠状态轮询判定）
    for (let ti = 0; ti < turns.length; ti++) {
      void deps.sendMessage(turns[ti], false, { taskType: 'exam' }).catch(() => {})
      await waitTurn()
      if (cancelled) break
    }

    const finalState = deps.getState()
    const wallMs = Date.now() - start
    win.active = false

    // 回复提取：基线之后的 assistant 消息。
    // 单轮题取**最后一条**（与 V1 行为一致）；多轮题**合并所有轮次**——断言与判卷提示
    // 可能针对任一回合（如"纠正后应改口"要看后续回合有没有改）。
    const newMessages = finalState.messages.slice(baseline)
    const assistantMsgs = newMessages.filter(m => m.role === 'assistant')
    const reply = (c.followUps && c.followUps.length > 0)
      ? assistantMsgs.map(m => m.content).join('\n')
      : (assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '')

    // 超时判定：排水后系统必已空闲——超时且无回复记 timeout（慢而有效的交付
    // 记 done，耗时进入平均耗时指标，诚实体现慢）
    const status: ExamQuestionResult['status'] = cancelled
      ? 'cancelled'
      : (wallMs >= timeoutMs && !reply ? 'timeout' : 'done')

    const q: ExamQuestionResult = {
      id: c.id,
      title: c.title,
      category: c.category,
      status,
      durationMs: wallMs,
      interventions: win.interventions,
      routeKind: win.routeKind,
      hardAssertPassed: null,
      hardAssertNote: '',
      judgeVerdict: null,
      judgeNote: '',
      failureStage: null,
      traceId: win.traceId || finalState.traceId,
      replyExcerpt: reply.slice(0, 500),
      totalTokens: win.totalTokens
    }

    if (status !== 'done') return q

    // 硬断言
    const hard = await runHardAssertions(c, reply)
    q.hardAssertPassed = hard.passed
    q.hardAssertNote = hard.note

    // 模型判卷
    if (!reply) {
      q.judgeVerdict = 'not-deliverable'
      q.judgeNote = '无回复内容'
    } else {
      const judgePrompt = EXAM_JUDGE_PROMPT_V1
        .replace('{JUDGE_HINT}', c.judgeHint)
        .replace('{QUESTION}', c.prompt)
        .replace('{REPLY}', reply)
      try {
        const judgeReply = await deps.judge(judgePrompt)
        const parsed = parseJudgeReply(judgeReply)
        if (parsed) {
          q.judgeVerdict = parsed.deliverable ? 'deliverable' : 'not-deliverable'
          q.judgeNote = parsed.note
        } else {
          q.judgeVerdict = 'judge-error'
          q.judgeNote = '判卷输出无法解析'
        }
      } catch (e) {
        q.judgeVerdict = 'judge-error'
        q.judgeNote = `判卷调用失败：${e instanceof Error ? e.message : String(e)}`
      }
    }

    return q
  }

  async function run(options?: ExamRunOptions): Promise<ExamReport | null> {
    if (progress.phase === 'running') return null
    const fixtureReady = options?.fixtureReady ?? false
    const timing = {
      timeoutMs: options?.timeoutMsPerQuestion ?? 5 * 60_000,
      pollMs: options?.pollMs ?? 1000,
      graceMs: options?.graceMs ?? 4000
    }
    const cases = options?.cases ?? EXAM_CASES

    cancelled = false
    clearExamTraces()
    const startedAt = Date.now()
    progress.phase = 'running'
    progress.current = 0
    progress.total = cases.length
    progress.report = null
    progress.errorMessage = ''

    // 监考订阅（EXAM-2 / H-1 G-8 traceId 归因）
    const offPause = globalBus.on('dialog:pause-acquired', (payload: { point?: string; traceId?: string; ts?: number }) => {
      if (win.active) win.interventions++
    })
    const offRouted = globalBus.on('funnel:routed', (payload: { kind?: string; traceId?: string }) => {
      if (win.active && payload.kind) win.routeKind = payload.kind
      if (win.active && payload.traceId) win.traceId = payload.traceId
    })
    const offCost = globalBus.on('debug:record-cost', (payload: { totalTokens?: number; traceId?: string }) => {
      if (win.active) win.totalTokens += payload.totalTokens ?? 0
    })

    const results: ExamQuestionResult[] = []
    const notes: string[] = []
    let runError = ''

    try {
      for (let i = 0; i < cases.length; i++) {
        if (cancelled) break
        const c = cases[i]
        progress.current = i + 1
        progress.currentLabel = `${c.id} ${c.title}`

        if (c.requiresFixture && !fixtureReady) {
          progress.currentStatus = '跳过（素材未就位）'
          results.push({
            id: c.id, title: c.title, category: c.category, status: 'skipped-fixture',
            durationMs: 0, interventions: 0, routeKind: '', hardAssertPassed: null, hardAssertNote: '',
            judgeVerdict: 'skipped', judgeNote: '桌面考试素材未就位，跳过（EXAM-RUNBOOK.md 素材清单）',
            failureStage: null, traceId: '', replyExcerpt: '', totalTokens: 0
          })
          continue
        }

        progress.currentStatus = '执行中…'
        try {
          const q = await runQuestion(c, timing)
          progress.currentStatus = q.status === 'done'
            ? `${q.judgeVerdict === 'deliverable' && q.hardAssertPassed !== false ? '可交付' : '未达标'}（干预 ${q.interventions} 次，${Math.round(q.durationMs / 1000)}s）`
            : q.status
          results.push(q)
        } catch (e) {
          runError = e instanceof Error ? e.message : String(e)
          break
        }
      }
    } finally {
      offPause()
      offRouted()
      offCost()
      clearExamTraces()
    }

    const finishedAt = Date.now()
    const graded = results.filter(r => r.status === 'done')
    // X-1：判卷失败（judge-error）是判卷基建失败，不是能力失败——计入可交付率分母会让一次
    // provider 配置事故把成绩单打成 0（快照 X-1 引用的那份 8 题 judge-error 报告即此形态）。
    // 单列出来并从分母剔除，同时保留 graded 供耗时/干预计数（那些指标反映的是执行而非判卷）。
    const judgeErrors = graded.filter(r => r.judgeVerdict === 'judge-error')
    const judgeable = graded.filter(r => r.judgeVerdict !== 'judge-error')
    const deliverable = judgeable.filter(r => r.judgeVerdict === 'deliverable' && r.hardAssertPassed !== false)
    const zeroIntervention = graded.filter(r => r.interventions === 0)
    const skippedFixture = results.filter(r => r.status === 'skipped-fixture')

    if (skippedFixture.length > 0) {
      notes.push(`素材依赖题跳过：${skippedFixture.map(r => r.id).join('、')}（不计入分母，见 EXAM-RUNBOOK.md）`)
    }
    if (judgeErrors.length > 0) {
      notes.push(`判卷失败题单列：${judgeErrors.map(r => r.id).join('、')}（共 ${judgeErrors.length} 题，属判卷基建失败而非能力失败）——已从可交付率分母剔除，本轮可交付率以 ${judgeable.length} 道可判题为分母`)
    }
    notes.push('exam 流量隔离学习回路（语义缓存/预算/ZOL 不污染），record-cost 照常记账（EXAM-1）')
    notes.push('指纹缓存未隔离：考试=真实使用形态，每题单次执行，指纹参与为真实行为（EXAM 决策记录）')
    notes.push('失败幕为启发式归因（路由→计划→执行→输出 顺序判定），人工复核时修正')
    notes.push('活儿集与手术题不在本 runner 内，按 EXAM-RUNBOOK.md 手工执行、单独报告')

    for (const r of results) {
      if (r.status === 'done') r.failureStage = inferFailureStage(r)
    }

    const report: ExamReport = {
      spec: 'ACCEPTANCE-SPEC v1.0',
      judgePromptVersion: EXAM_JUDGE_PROMPT_VERSION,
      startedAt,
      finishedAt,
      passLines: { ...EXAM_PASS_LINES },
      summary: {
        total: results.length,
        graded: graded.length,
        skippedFixture: skippedFixture.length,
        deliverable: deliverable.length,
        deliverableRate: judgeable.length > 0 ? deliverable.length / judgeable.length : 0,
        zeroIntervention: zeroIntervention.length,
        zeroInterventionRate: graded.length > 0 ? zeroIntervention.length / graded.length : 0,
        avgDurationMs: graded.length > 0 ? Math.round(graded.reduce((s, r) => s + r.durationMs, 0) / graded.length) : 0,
        totalTokens: results.reduce((s, r) => s + r.totalTokens, 0),
        judgeErrors: judgeErrors.length,
        judgeable: judgeable.length
      },
      questions: results,
      notes
    }

    progress.report = report
    if (runError) {
      progress.phase = 'error'
      progress.errorMessage = runError
    } else if (cancelled) {
      progress.phase = 'cancelled'
    } else {
      progress.phase = 'done'
    }
    return report
  }

  function cancel(): void {
    cancelled = true
    win.active = false
  }

  async function exportReport(): Promise<string | null> {
    const report = progress.report
    if (!report) return null
    try {
      const api = (window as unknown as { electronAPI?: { resolvePath?: (p: string) => Promise<string>; fileWrite?: (args: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }> } }).electronAPI
      const home = await api?.resolvePath?.('%USERPROFILE%')
      if (!home || !api?.fileWrite) return null
      const filePath = `${home}\\Desktop\\HoloStarmap\\exam-report.json`
      const result = await api.fileWrite({ filePath, content: JSON.stringify(report, null, 2) })
      return result.success ? filePath : null
    } catch {
      return null
    }
  }

  return { progress, run, cancel, exportReport }
}
