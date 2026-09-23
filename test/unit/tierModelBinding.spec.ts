// 双模型并存：档位→provider+model 解析（2026-09-23 用户需求）
//
// 背景：原先请求只读单一 activeModel（apiStore 的 ipcArgs），档位 MODEL_TIER_CONFIG 不切换真实模型（G-7）。
// 本测试钉住解析的三条分支：绑定命中 / 绑定失效回退 / 无绑定回退。
import { describe, it, expect } from 'vitest'
import { resolveTierTarget, type TierBindingConfig } from '@/services/tierModelBinding'

const base: TierBindingConfig = {
  activeProviderId: 'p-ollama',
  activeModel: 'qwen2.5:3b',
  providers: [
    { id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }, { id: 'qwen2.5:7b' }] },
    { id: 'p-cloud', models: [{ id: 'deepseek-chat' }] }
  ]
}

describe('resolveTierTarget：档位 → provider+model', () => {
  it('无绑定 → 回退 activeProviderId + activeModel（向后兼容）', () => {
    expect(resolveTierTarget(base, 'standard')).toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
    expect(resolveTierTarget({ ...base, tierModels: null }, 'pro')).toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
  })

  it('小档绑本地、大档绑云 → 两个模型同时可用（核心需求）', () => {
    const cfg: TierBindingConfig = {
      ...base,
      tierModels: {
        nano: { providerId: 'p-ollama', model: 'qwen2.5:3b' },
        mini: { providerId: 'p-ollama', model: 'qwen2.5:3b' },
        standard: { providerId: 'p-cloud', model: 'deepseek-chat' },
        pro: { providerId: 'p-cloud', model: 'deepseek-chat' }
      }
    }
    expect(resolveTierTarget(cfg, 'mini')).toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
    expect(resolveTierTarget(cfg, 'pro')).toEqual({ providerId: 'p-cloud', model: 'deepseek-chat' })
    // 未绑定的档位仍走单值回退，不影响既有行为
    expect(resolveTierTarget({ ...cfg, tierModels: { pro: { providerId: 'p-cloud', model: 'deepseek-chat' } } }, 'nano'))
      .toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
  })

  it('绑定指向已删除的 provider/model → 回退单值（不抛错、不空转）', () => {
    expect(resolveTierTarget({ ...base, tierModels: { pro: { providerId: 'p-gone', model: 'x' } } }, 'pro'))
      .toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
    expect(resolveTierTarget({ ...base, tierModels: { pro: { providerId: 'p-cloud', model: 'removed' } } }, 'pro'))
      .toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
  })

  it('空绑定字段视为未绑定', () => {
    expect(resolveTierTarget({ ...base, tierModels: { pro: { providerId: '', model: '' } } }, 'pro'))
      .toEqual({ providerId: 'p-ollama', model: 'qwen2.5:3b' })
  })
})
