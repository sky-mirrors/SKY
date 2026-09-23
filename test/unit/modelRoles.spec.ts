// 模型协同（2026-09-23 用户纠正后的设计）：
//   「大模型兜底、小模型辅助」= 同一次任务里分工协同，**不是**按难度二选一。
//   主模型（大）= 掌舵：理解、规划、最终产出、兜底；
//   辅助模型（小）= 打下手：分类、抽取、命名、语言/意图规范化等确定性小活。
//
// 判定方式：按「调用标识(callerId/taskType)」分派角色——无需改动各调用点。
import { describe, it, expect } from 'vitest'
import { resolveRole, resolveRoleTarget, type RoleConfig } from '@/services/modelRoles'

const cfg: RoleConfig = {
  activeProviderId: 'p-cloud',
  activeModel: 'deepseek-v4-pro',
  providers: [
    { id: 'p-cloud', models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] },
    { id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }] }
  ],
  roleModels: {
    main: { providerId: 'p-cloud', model: 'deepseek-v4-pro' },
    aux: { providerId: 'p-cloud', model: 'deepseek-flash' }
  }
}

describe('resolveRole：谁干什么活', () => {
  it('辅助型调用 → aux（分类/抽取/校验/语言与意图规范化）', () => {
    expect(resolveRole('l0SkillRouter_filename')).toBe('aux')
    expect(resolveRole('errorClassifier')).toBe('aux')
    expect(resolveRole('dualEngineValidator')).toBe('aux')
    expect(resolveRole('promptTranslator_intent')).toBe('aux')
    expect(resolveRole(undefined, 'classify')).toBe('aux')
  })

  it('主线调用 → main（主对话与宏的实际产出）', () => {
    expect(resolveRole(undefined)).toBe('main')          // 主对话
    expect(resolveRole('macro:direct')).toBe('main')
    expect(resolveRole('macro_directCall')).toBe('main')
  })
})

describe('resolveRoleTarget：按角色选模型（大模型为主，小模型辅助）', () => {
  it('main → 大模型；aux → 小模型（协同，而非二选一）', () => {
    expect(resolveRoleTarget(cfg, 'main')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
    expect(resolveRoleTarget(cfg, 'aux')).toEqual({ providerId: 'p-cloud', model: 'deepseek-flash' })
  })

  it('未配置辅助模型 → 回退主模型（保证可用；不因缺小模型而失败）', () => {
    const noAux: RoleConfig = { ...cfg, roleModels: { main: cfg.roleModels!.main } }
    expect(resolveRoleTarget(noAux, 'aux')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
  })

  it('未配置主模型 → 回退 activeModel（老配置零迁移）', () => {
    expect(resolveRoleTarget({ ...cfg, roleModels: undefined }, 'main'))
      .toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
  })

  it('绑定指向已删除的 provider/model → 回退 activeModel（不空转）', () => {
    const broken: RoleConfig = {
      ...cfg,
      providers: [{ id: 'p-cloud', models: [{ id: 'deepseek-v4-pro' }] }],
      roleModels: { main: { providerId: 'p-gone', model: 'x' }, aux: { providerId: 'p-cloud', model: 'removed' } }
    }
    expect(resolveRoleTarget(broken, 'main')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
    expect(resolveRoleTarget(broken, 'aux')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
  })
})
