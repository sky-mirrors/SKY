export interface MABArm {
  name: string
  alpha: number
  beta: number
  pulls: number
  rewards: number
}

export interface MABBandit {
  id: string
  arms: Map<string, MABArm>
  minPullsBeforeExploit: number
}

export interface MABBanditStats {
  banditId: string
  arms: { name: string; alpha: number; beta: number; expected: number; pulls: number }[]
}

const MAB_STORAGE_KEY = 'holo-mab-state'

const BANDIT_CONFIGS: { id: string; arms: string[]; minPulls: number }[] = [
  {
    id: 'rewrite_strategy',
    arms: ['none', 'keyword_extract', 'llm_rewrite', 'both'],
    minPulls: 5
  },
  {
    id: 'disambig_strategy',
    arms: ['show_candidates', 'llm_pick', 'ask_clarify', 'fallback_l1'],
    minPulls: 5
  }
]

const _bandits = new Map<string, MABBandit>()

function initBandit(id: string, armNames: string[], minPulls: number): MABBandit {
  const arms = new Map<string, MABArm>()
  for (const name of armNames) {
    arms.set(name, { name, alpha: 1, beta: 1, pulls: 0, rewards: 0 })
  }
  return { id, arms, minPullsBeforeExploit: minPulls }
}

function ensureBandit(banditId: string): MABBandit {
  let bandit = _bandits.get(banditId)
  if (!bandit) {
    const config = BANDIT_CONFIGS.find(c => c.id === banditId)
    if (!config) throw new Error(`Unknown bandit: ${banditId}`)
    bandit = initBandit(config.id, config.arms, config.minPulls)
    _bandits.set(banditId, bandit)
  }
  return bandit
}

function sampleBeta(alpha: number, beta: number): number {
  const gammaAlpha = sampleGamma(alpha)
  const gammaBeta = sampleGamma(beta)
  const sum = gammaAlpha + gammaBeta
  return sum > 0 ? gammaAlpha / sum : 0.5
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random()
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number
    let v: number
    do {
      x = randn()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function randn(): number {
  const u1 = Math.random()
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2)
}

export function selectArm(banditId: string): string {
  const bandit = ensureBandit(banditId)

  const totalPulls = Array.from(bandit.arms.values()).reduce((s, a) => s + a.pulls, 0)
  if (totalPulls < bandit.minPullsBeforeExploit * bandit.arms.size) {
    const unexplored = Array.from(bandit.arms.values()).filter(a => a.pulls < bandit.minPullsBeforeExploit)
    if (unexplored.length > 0) {
      const chosen = unexplored[Math.floor(Math.random() * unexplored.length)]
      chosen.pulls++
      return chosen.name
    }
  }

  let bestArm = ''
  let bestSample = -Infinity
  for (const arm of bandit.arms.values()) {
    const sample = sampleBeta(arm.alpha, arm.beta)
    if (sample > bestSample) {
      bestSample = sample
      bestArm = arm.name
    }
  }
  const chosen = bandit.arms.get(bestArm)!
  chosen.pulls++
  return bestArm
}

export function updateArm(banditId: string, armName: string, reward: number): void {
  const bandit = ensureBandit(banditId)
  const arm = bandit.arms.get(armName)
  if (!arm) {
    console.warn(`[MAB] Unknown arm "${armName}" for bandit "${banditId}"`)
    return
  }
  const clampedReward = Math.max(0, Math.min(1, reward))
  arm.alpha += clampedReward
  arm.beta += (1 - clampedReward)
  arm.rewards += clampedReward
  saveToStorage()
  console.log(`[MAB] updateArm(${banditId}, ${armName}, reward=${clampedReward.toFixed(2)}) → α=${arm.alpha.toFixed(2)} β=${arm.beta.toFixed(2)} E=${(arm.alpha / (arm.alpha + arm.beta)).toFixed(3)}`)
}

export function computeMABReward(action: string): number {
  switch (action) {
    case 'thumbs_up': return 1.0
    case 'thumbs_down': return 0.0
    case 'undo': return 0.2
    case 'used': return 0.7
    case 'ignored': return 0.3
    default: return 0.5
  }
}

export function getStats(banditId: string): MABBanditStats {
  const bandit = ensureBandit(banditId)
  return {
    banditId,
    arms: Array.from(bandit.arms.values()).map(a => ({
      name: a.name,
      alpha: a.alpha,
      beta: a.beta,
      expected: a.alpha / (a.alpha + a.beta),
      pulls: a.pulls
    }))
  }
}

export function saveToStorage(): void {
  try {
    const data: Record<string, { arms: { name: string; alpha: number; beta: number; pulls: number; rewards: number }[] }> = {}
    for (const [id, bandit] of _bandits) {
      data[id] = {
        arms: Array.from(bandit.arms.values()).map(a => ({
          name: a.name,
          alpha: a.alpha,
          beta: a.beta,
          pulls: a.pulls,
          rewards: a.rewards
        }))
      }
    }
    localStorage.setItem(MAB_STORAGE_KEY, JSON.stringify(data))
  } catch { /* ignore */ }
}

export function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(MAB_STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as Record<string, { arms: { name: string; alpha: number; beta: number; pulls: number; rewards: number }[] }>
    for (const [id, banditData] of Object.entries(data)) {
      const config = BANDIT_CONFIGS.find(c => c.id === id)
      if (!config) continue
      const bandit = initBandit(id, config.arms, config.minPulls)
      for (const armData of banditData.arms) {
        const arm = bandit.arms.get(armData.name)
        if (arm) {
          arm.alpha = armData.alpha
          arm.beta = armData.beta
          arm.pulls = armData.pulls
          arm.rewards = armData.rewards
        }
      }
      _bandits.set(id, bandit)
    }
  } catch { /* ignore */ }
  console.log('[MAB] State loaded from storage')
}

export function resetBandit(banditId: string): void {
  const config = BANDIT_CONFIGS.find(c => c.id === banditId)
  if (!config) return
  const bandit = initBandit(config.id, config.arms, config.minPulls)
  _bandits.set(banditId, bandit)
  saveToStorage()
}

loadFromStorage()
