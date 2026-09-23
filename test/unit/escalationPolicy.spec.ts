// 模型协同（2026-09-23 用户纠正后）：
//   「大模型兜底、小模型辅助」——辅助（小模型）做不了 → 交给主模型（大模型）兜底；
//   无主模型可兜底、或兜底也没成 → 诚实陈述「未完成」。
import { describe, it, expect } from 'vitest'
import {
  detectUnsolvable,
  resolveEscalationTarget,
  buildHonestNotice,
  type EscalationConfig
} from '@/services/escalationPolicy'

const cfg: EscalationConfig = {
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

describe('detectUnsolvable：识别"做不了"', () => {
  it('识别常见拒答/能力声明（取自真实运行文本）', () => {
    expect(detectUnsolvable('我目前无法直接创建或生成PDF文件，因为我是一个基于文本的AI助手')).toBe(true)
    expect(detectUnsolvable('我无法直接在你的电脑上操作文件，但我可以指导你')).toBe(true)
    expect(detectUnsolvable('抱歉，我不能访问你的本地文件系统')).toBe(true)
  })

  it('识别真实运行中的其它措辞（实测漏判过，补上）', () => {
    expect(detectUnsolvable('我做不到——无法直接控制你本机的蓝牙或代你配对耳机。手动操作（Windows）：设置 → 蓝牙和设备')).toBe(true)
    expect(detectUnsolvable('做不到。我不能直接访问或操作你的电脑硬件、摄像头、麦克风、文件等。')).toBe(true)
    expect(detectUnsolvable('我无法直接访问或操控你的本机外设，不能替你打开蓝牙、配对新设备，也不会假装已完成。')).toBe(true)
  })

  it('解释性文字不误判（避免给正常回答乱加"未完成"）', () => {
    expect(detectUnsolvable('如果无法连接，请检查网络设置后重试。')).toBe(false)
    expect(detectUnsolvable('该操作用户未授权，因此不能执行；请先在设置里开启权限。')).toBe(false)
  })
})

describe('resolveEscalationTarget：辅助做不了 → 主模型兜底', () => {
  it('当前是辅助角色且已绑定主模型 → 返回主模型目标', () => {
    expect(resolveEscalationTarget(cfg, 'aux')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
  })

  it('当前已是主模型 → null（无处可升，防死循环）', () => {
    expect(resolveEscalationTarget(cfg, 'main')).toBeNull()
  })

  it('未绑定主模型（只有小模型可用）→ null，保持可用', () => {
    const auxOnly: EscalationConfig = { ...cfg, roleModels: { aux: cfg.roleModels!.aux! } }
    expect(resolveEscalationTarget(auxOnly, 'aux')).toBeNull()
  })

  it('主模型绑定指向已删除的 provider → null（不空转）', () => {
    const broken: EscalationConfig = {
      ...cfg,
      providers: [{ id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }] }]
    }
    expect(resolveEscalationTarget(broken, 'aux')).toBeNull()
  })
})

describe('buildHonestNotice：做不了就诚实陈述', () => {
  it('有兜底但主模型也没成 → 说明已尝试大模型且仍未完成', () => {
    const n = buildHonestNotice('both-failed')
    expect(n).toContain('已尝试')
    expect(n).toMatch(/未完成|无法完成/)
  })

  it('仅有小模型 → 明确说明未配置大模型、该任务超出其能力', () => {
    const n = buildHonestNotice('small-only')
    expect(n).toMatch(/未配置|没有/)
    expect(n).toMatch(/超出|能力/)
    expect(n).toMatch(/未完成|无法完成/)
  })
})
