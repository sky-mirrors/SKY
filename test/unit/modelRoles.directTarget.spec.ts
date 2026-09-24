import { describe, it, expect } from 'vitest'
import { resolveDirectTarget } from '@/services/modelRoles'

const config = {
  activeProviderId: 'cloud',
  activeModel: 'gpt-4o',
  baseUrl: 'https://cloud.example.com',
  providers: [
    { id: 'cloud', baseUrl: 'https://cloud.example.com', chatFormat: 'openai' },
    { id: 'local-big', baseUrl: 'http://127.0.0.1:11434', chatFormat: 'ollama' },
    { id: 'local-small', baseUrl: 'http://127.0.0.1:11435', chatFormat: 'ollama' },
  ],
}

describe('S-1: 直连分支的目标解析（角色绑定/大模型兜底对 Ollama 目标必须生效）', () => {
  it('tierTarget 指向另一 Ollama provider → 用该 provider 的 baseUrl/chatFormat/model', () => {
    const t = resolveDirectTarget(config, { providerId: 'local-big', model: 'qwen2.5:32b' })
    expect(t.providerId).toBe('local-big')
    expect(t.baseUrl).toBe('http://127.0.0.1:11434')
    expect(t.chatFormat).toBe('ollama')
    expect(t.model).toBe('qwen2.5:32b')
  })

  it('未绑定（tierTarget = active）→ 与旧行为等价', () => {
    const t = resolveDirectTarget(config, { providerId: 'cloud', model: 'gpt-4o' })
    expect(t.providerId).toBe('cloud')
    expect(t.baseUrl).toBe('https://cloud.example.com')
    expect(t.chatFormat).toBe('openai')
    expect(t.model).toBe('gpt-4o')
  })

  it('降级态 → 以降级目标为准且强制 ollama 格式', () => {
    const t = resolveDirectTarget(config, { providerId: 'cloud', model: 'gpt-4o' }, {
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'llama3.2',
    })
    expect(t.baseUrl).toBe('http://127.0.0.1:11434')
    expect(t.model).toBe('llama3.2')
    expect(t.chatFormat).toBe('ollama')
  })

  it('tierTarget.providerId 失效 → 回退 active provider，但保留 tierTarget.model', () => {
    const t = resolveDirectTarget(config, { providerId: 'gone', model: 'qwen2.5:7b' })
    expect(t.providerId).toBe('cloud')
    expect(t.baseUrl).toBe('https://cloud.example.com')
    expect(t.model).toBe('qwen2.5:7b')
  })

  it('去掉 baseUrl 尾部斜杠', () => {
    const c = { ...config, providers: [{ id: 'cloud', baseUrl: 'https://cloud.example.com///', chatFormat: 'openai' }] }
    expect(resolveDirectTarget(c, { providerId: 'cloud', model: 'm' }).baseUrl).toBe('https://cloud.example.com')
  })
})
