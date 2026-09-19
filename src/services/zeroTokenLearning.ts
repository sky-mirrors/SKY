export interface ZOLConfig {
  adjustWindow: number
  adjustSampleSize: number
  adjustStep: number
  adjustClamp: number
  maxHistory: number
}

export const DEFAULT_ZOL_CONFIG: ZOLConfig = {
  adjustWindow: 20,
  adjustSampleSize: 50,
  adjustStep: 0.05,
  adjustClamp: 0.30,
  maxHistory: 500,
}

export interface ZOLOutcome {
  decisionPoint: string
  selectedStrategy: string
  // G-4 拆分：'overkill' 是预算效率信号（执行成功但档位过高），不是执行失败。
  // successRate 只统计 success/(success+failure)；overkillRate 单独计算，
  // 阈值调整按 overkillRate 驱动——行为与原"overkill 伪造 failure"等价，语义诚实
  outcome: 'success' | 'failure' | 'overkill'
  timestamp: number
  contextSnapshot: Record<string, number>
}

export interface ZOLState<T extends Record<string, number>> {
  thresholds: T
  outcomeCount: number
  recentSuccessRate: number
  overkillRate: number
}

export type ZOLAdjustFn<T extends Record<string, number>> = (
  thresholds: T,
  successRate: number,
  defaults: Readonly<T>,
  config: Readonly<ZOLConfig>,
  overkillRate: number,
) => void

export function clampThreshold(current: number, defaultVal: number, clampRange: number): number {
  const hi = defaultVal * (1 + clampRange)
  const lo = defaultVal * (1 - clampRange)
  return Math.max(lo, Math.min(hi, current))
}

import { vault } from '@/vault'

export class ZeroTokenLearner<T extends Record<string, number>> {
  private thresholds: T
  private readonly defaultThresholds: Readonly<T>
  private outcomes: ZOLOutcome[]
  private readonly config: Readonly<ZOLConfig>
  private readonly storageKey: string
  private readonly decisionPoint: string
  private readonly adjustFn: ZOLAdjustFn<T>
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(params: {
    decisionPoint: string
    defaultThresholds: T
    adjustFn: ZOLAdjustFn<T>
    config?: Partial<ZOLConfig>
    storageKey: string
    migrationKeys?: string[]
  }) {
    this.decisionPoint = params.decisionPoint
    this.defaultThresholds = { ...params.defaultThresholds }
    this.thresholds = { ...params.defaultThresholds }
    this.config = { ...DEFAULT_ZOL_CONFIG, ...params.config }
    this.storageKey = params.storageKey
    this.adjustFn = params.adjustFn
    this.outcomes = []
    this.loadState(params.migrationKeys)
  }

  getThresholds(): Readonly<T> {
    return this.thresholds
  }

  recordOutcome(strategy: string, outcome: 'success' | 'failure' | 'overkill', contextSnapshot?: Record<string, number>): void {
    this.outcomes.push({
      decisionPoint: this.decisionPoint,
      selectedStrategy: strategy,
      outcome,
      timestamp: Date.now(),
      contextSnapshot: contextSnapshot ?? {},
    })
    if (this.outcomes.length > this.config.maxHistory) {
      this.outcomes.splice(0, this.outcomes.length - this.config.maxHistory)
    }
    if (this.outcomes.length % this.config.adjustWindow === 0) {
      this.adjustThresholds()
    }
    this.scheduleSave()
  }

  getState(): ZOLState<T> {
    const recent = this.recentOutcomes()
    const rated = recent.filter(o => o.outcome === 'success' || o.outcome === 'failure')
    const successRate = rated.length > 0
      ? rated.filter(o => o.outcome === 'success').length / rated.length
      : 0.5
    const overkillRate = recent.length > 0
      ? recent.filter(o => o.outcome === 'overkill').length / recent.length
      : 0
    return {
      thresholds: { ...this.thresholds },
      outcomeCount: this.outcomes.length,
      recentSuccessRate: successRate,
      overkillRate,
    }
  }

  reset(): void {
    this.thresholds = { ...this.defaultThresholds }
    this.outcomes = []
    this.scheduleSave()
  }

  forceAdjust(): void {
    this.adjustThresholds()
  }

  private recentOutcomes(): ZOLOutcome[] {
    return this.outcomes
      .filter(o => o.decisionPoint === this.decisionPoint)
      .slice(-this.config.adjustSampleSize)
  }

  private adjustThresholds(): void {
    const recent = this.recentOutcomes()
    if (recent.length < this.config.adjustWindow) return

    const rated = recent.filter(o => o.outcome === 'success' || o.outcome === 'failure')
    const successRate = rated.length > 0
      ? rated.filter(o => o.outcome === 'success').length / rated.length
      : 0.5
    const overkillRate = recent.filter(o => o.outcome === 'overkill').length / recent.length
    this.adjustFn(this.thresholds, successRate, this.defaultThresholds, this.config, overkillRate)
    this.clampAllThresholds()
  }

  private clampAllThresholds(): void {
    for (const key of Object.keys(this.defaultThresholds) as (keyof T)[]) {
      const defaultVal = this.defaultThresholds[key]
      const current = this.thresholds[key]
      if (defaultVal !== undefined && current !== undefined) {
        const hi = defaultVal * (1 + this.config.adjustClamp)
        const lo = defaultVal * (1 - this.config.adjustClamp)
        this.thresholds[key] = Math.max(lo, Math.min(hi, current)) as T[keyof T]
      }
    }
  }

  private loadState(migrationKeys?: string[]): void {
    try {
      const raw = vault.readCache('zol', this.storageKey)
      if (raw) {
        const state = JSON.parse(raw) as { thresholds?: Partial<T>; outcomes?: ZOLOutcome[] }
        if (state.thresholds) {
          this.thresholds = { ...this.defaultThresholds, ...state.thresholds }
        }
        if (state.outcomes) {
          this.outcomes = state.outcomes.slice(-this.config.maxHistory)
        }
      }
    } catch {
      // corrupted → use defaults
    }
    if (migrationKeys) {
      for (const key of migrationKeys) {
        try { vault.delete('zol', key).catch(() => {}) } catch { /* ignore */ }
      }
    }
  }

  async initFromVault(): Promise<void> {
    try {
      const raw = await vault.read('zol', this.storageKey)
      if (raw) {
        const state = JSON.parse(raw) as { thresholds?: Partial<T>; outcomes?: ZOLOutcome[] }
        if (state.thresholds) {
          this.thresholds = { ...this.defaultThresholds, ...state.thresholds }
        }
        if (state.outcomes) {
          this.outcomes = state.outcomes.slice(-this.config.maxHistory)
        }
      }
    } catch {
      // corrupted → use defaults
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      vault.writeThrough('zol', this.storageKey, JSON.stringify({
        thresholds: this.thresholds,
        outcomes: this.outcomes,
      }))
      this.saveTimer = null
    }, 1000)
  }
}
