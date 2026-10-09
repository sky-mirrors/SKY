import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import {
  createExamRunner,
  createDefaultExamDeps,
  type ExamProgress,
  type ExamReport,
  type ExamRunner
} from '@/exam/examRunner'
import { EXAM_CASES, type ExamCase } from '@/exam/examCases'
import { EXAM_CASES_V2 } from '@/exam/examCasesV2'
import { vault } from '@/vault'

/** 题库册别：V1 固定回归集（18 题，ACCEPTANCE-SPEC v1.0 基线）/ V2 扩展集（50 题）。 */
export type ExamCaseSet = 'v1' | 'v2'

const casesBySet: Record<ExamCaseSet, ExamCase[]> = {
  v1: EXAM_CASES,
  v2: EXAM_CASES_V2
}

/** 题库册别元信息（UI 用）。estMinutes 由 V1 的 18 题 ≈ 40 分钟线性外推，仅作提示。 */
export const EXAM_CASE_SETS: readonly { id: ExamCaseSet; label: string; count: number; estMinutes: number }[] = [
  { id: 'v1', label: 'V1 固定集', count: EXAM_CASES.length, estMinutes: 40 },
  { id: 'v2', label: 'V2 扩展集', count: EXAM_CASES_V2.length, estMinutes: 110 }
]

const EXAM_NS = 'exam'
const EXAM_REPORT_KEY = 'holo-exam-report'

function emptyProgress(): ExamProgress {
  return {
    phase: 'idle',
    current: 0,
    total: 0,
    currentLabel: '',
    currentStatus: '',
    report: null,
    errorMessage: ''
  }
}

/**
 * EXAM-1 + EXAM-6 修复：
 * - 考试状态（progress/runner）从 RuntimePanel 组件实例迁入 Pinia store——
 *   模式切换卸载组件不再孤儿化 runner，成绩单不再被内存扣押；
 * - progress 为 reactive 代理并注入 runner——闭包内改写直接触发 UI 重渲染，
 *   消除「完成后 UI 冻结在执行中」的 EXAM-6 病理；
 * - 完成即落盘：run 收口（done/cancelled/error 均返回 report）后立即写 vault，
 *   刷新/重启后从 vault 恢复上次成绩单，导出按钮持续可用。
 */
export const useExamStore = defineStore('exam', () => {
  const progress = reactive<ExamProgress>(emptyProgress())
  const runner = ref<ExamRunner | null>(null)
  const fixtureReady = ref(false)
  /** 本次/下次开考用的题库册别（默认 V1，保持历轮 18 题成绩的可比性）。 */
  const activeCaseSet = ref<ExamCaseSet>('v1')
  const lastPersistedAt = ref(0)
  const persistError = ref('')

  const hasRunner = computed(() => runner.value !== null)

  async function persistReport(report: ExamReport): Promise<void> {
    try {
      await vault.write(EXAM_NS, EXAM_REPORT_KEY, JSON.stringify(report))
      lastPersistedAt.value = Date.now()
      persistError.value = ''
    } catch (e) {
      // 落盘失败不覆盖内存成绩单，仅记录——导出按钮仍可用（Desktop fileWrite 路径）
      persistError.value = e instanceof Error ? e.message : String(e)
    }
  }

  function restoreFromVault(): void {
    if (progress.phase !== 'idle' || progress.report) return
    try {
      const raw = vault.readCache(EXAM_NS, EXAM_REPORT_KEY)
      if (!raw) return
      const report = JSON.parse(raw) as ExamReport
      if (!report || !report.summary || !Array.isArray(report.questions)) return
      progress.report = report
      progress.phase = 'done'
      progress.total = report.questions.length
      progress.current = report.questions.length
      progress.currentLabel = ''
      progress.currentStatus = `上次考试（${new Date(report.finishedAt).toLocaleString('zh-CN')}）`
    } catch { /* 损坏数据忽略，保持 idle */ }
  }

  function startExam(fixture: boolean, caseSet: ExamCaseSet = activeCaseSet.value): void {
    if (progress.phase === 'running') return
    fixtureReady.value = fixture
    activeCaseSet.value = caseSet
    const r = createExamRunner(createDefaultExamDeps(), { progress })
    runner.value = r
    void r.run({ fixtureReady: fixture, cases: casesBySet[caseSet] })
      .then(report => {
        // 完成即落盘：done / cancelled / error 三态均带 report（run 内部已收口 phase）
        if (report) void persistReport(report)
      })
      .catch(err => {
        // run 内部已收口 phase=error；此处仅防御意外逃逸异常
        progress.phase = 'error'
        progress.errorMessage = err instanceof Error ? err.message : String(err)
      })
  }

  function cancel(): void {
    runner.value?.cancel()
  }

  async function exportReport(): Promise<string | null> {
    if (runner.value) return runner.value.exportReport()
    // runner 已不存在（如热重载）：退化为直接从 progress.report 落 Desktop 文件
    const report = progress.report
    if (!report) return null
    try {
      const api = (window as unknown as {
        electronAPI?: {
          resolvePath?: (p: string) => Promise<string>
          fileWrite?: (args: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>
        }
      }).electronAPI
      const home = await api?.resolvePath?.('%USERPROFILE%')
      if (!home || !api?.fileWrite) return null
      const filePath = `${home}\\Desktop\\SKY\\exam-report.json`
      const result = await api.fileWrite({ filePath, content: JSON.stringify(report, null, 2) })
      return result.success ? filePath : null
    } catch {
      return null
    }
  }

  // store 实例化时恢复上次成绩单（vault 同步屏障在 App 启动序列中先于 store 实例化）
  restoreFromVault()

  return {
    progress,
    hasRunner,
    activeCaseSet,
    fixtureReady,
    lastPersistedAt,
    persistError,
    startExam,
    cancel,
    exportReport,
    persistReport,
    restoreFromVault
  }
})
