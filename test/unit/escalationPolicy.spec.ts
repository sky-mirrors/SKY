// 小模型兜底策略（2026-09-23 用户需求）：
//   「小模型跑确定性工作，大模型兜底；没有大模型时也要能只用小模型工作，
//     但小模型解决不了的问题必须诚实陈述。」
//
// 三个策略点：①小档失败/拒答 + 已绑大档 → 升级兜底；②无大档 → 不升级且诚实陈述；
// ③已达大档 → 不再升级（防死循环）并诚实陈述。
import { describe, it, expect } from 'vitest'
import {
  detectUnsolvable,
  resolveEscalationTarget,
  buildHonestNotice,
  type EscalationConfig
} from '@/services/escalationPolicy'

const cfg: EscalationConfig = {
  activeProviderId: 'p-ollama',
  activeModel: 'qwen2.5:3b',
  providers: [
    { id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }] },
    { id: 'p-cloud', models: [{ id: 'deepseek-v4-pro' }] }
  ],
  tierModels: {
    nano: { providerId: 'p-ollama', model: 'qwen2.5:3b' },
    mini: { providerId: 'p-ollama', model: 'qwen2.5:3b' },
    standard: { providerId: 'p-cloud', model: 'deepseek-v4-pro' },
    pro: { providerId: 'p-cloud', model: 'deepseek-v4-pro' }
  }
}

describe('detectUnsolvable：识别"小模型做不了"', () => {
  it('识别常见拒答/能力声明（取自真实考试文本）', () => {
    expect(detectUnsolvable('我目前无法直接创建或生成PDF文件，因为我是一个基于文本的AI助手')).toBe(true)
    expect(detectUnsolvable('我无法直接在你的电脑上操作文件，但我可以指导你')).toBe(true)
    expect(detectUnsolvable('抱歉，我不能访问你的本地文件系统')).toBe(true)
  })

  it('识别真实运行中的其它措辞（实测漏判过，补上）', () => {
    // 真实回复原话（13:5x / 14:0x 两次实测）——此前因「我」与「无法」之间有间隔而漏判
    expect(detectUnsolvable('我做不到——无法直接控制你本机的蓝牙或代你配对耳机。手动操作（Windows）：设置 → 蓝牙和设备')).toBe(true)
    expect(detectUnsolvable('做不到。我不能直接访问或操作你的电脑硬件、摄像头、麦克风、文件等。')).toBe(true)
    expect(detectUnsolvable('我无法直接访问或操控你的本机外设，不能替你打开蓝牙、配对新设备，也不会假装已完成。')).toBe(true)
  })

  it('解释性文字不误判（避免给正常回答乱加"未完成"）', () => {
    expect(detectUnsolvable('如果无法连接，请检查网络设置后重试。')).toBe(false)
    expect(detectUnsolvable('该操作用户未授权，因此不能执行；请先在设置里开启权限。')).toBe(false)
  })

  it('正常可交付回答不误判', () => {
    expect(detectUnsolvable('张三的报销总金额是3,970元。')).toBe(false)
    expect(detectUnsolvable('会议纪要：一、项目进度；二、风险；三、下周计划')).toBe(false)
  })
})

describe('resolveEscalationTarget：小档 → 大档兜底', () => {
  it('当前为小档且大档已绑定 → 返回大档目标', () => {
    expect(resolveEscalationTarget(cfg, 'mini')).toEqual({ providerId: 'p-cloud', model: 'deepseek-v4-pro' })
  })

  it('未绑定大档（仅有小模型）→ null，保持小模型可用', () => {
    const smallOnly: EscalationConfig = {
      activeProviderId: 'p-ollama',
      activeModel: 'qwen2.5:3b',
      providers: [{ id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }] }],
      tierModels: { nano: { providerId: 'p-ollama', model: 'qwen2.5:3b' } }
    }
    expect(resolveEscalationTarget(smallOnly, 'mini')).toBeNull()
  })

  it('当前已是大档 → null（不升级，防死循环）', () => {
    expect(resolveEscalationTarget(cfg, 'pro')).toBeNull()
  })

  it('大档绑定指向已删除的 provider → null（不空转）', () => {
    const broken: EscalationConfig = {
      ...cfg,
      providers: [{ id: 'p-ollama', models: [{ id: 'qwen2.5:3b' }] }]
    }
    expect(resolveEscalationTarget(broken, 'mini')).toBeNull()
  })
})

describe('buildHonestNotice：做不了就诚实陈述', () => {
  it('有兜底但大模型也没成 → 说明已尝试大模型且仍未完成', () => {
    const n = buildHonestNotice('both-failed')
    expect(n).toContain('已尝试')
    expect(n).toMatch(/未完成|无法完成/)
  })

  it('仅有小模型 → 明确说明未配置大模型、该任务超出小模型能力', () => {
    const n = buildHonestNotice('small-only')
    expect(n).toMatch(/未配置|没有/)
    expect(n).toMatch(/超出|能力/)
    expect(n).toMatch(/未完成|无法完成/)
  })
})
