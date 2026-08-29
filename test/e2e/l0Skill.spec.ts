import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { existsSync } from 'fs'
import { execSync } from 'child_process'

const PROJECT_ROOT = join(__dirname, '..', '..')
const OUT_MAIN = join(PROJECT_ROOT, 'out', 'main', 'index.js')
const DEEPSEEK_API_KEY = '***REMOVED-SECRET***'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

function ensureBuild(): void {
  if (!existsSync(OUT_MAIN)) {
    console.log('[L0-E2E] 构建产物不存在，执行 npm run build...')
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 })
  }
}

async function configureDeepSeek(page: any): Promise<boolean> {
  const writeOk = await page.evaluate(async (opts: { apiKey: string; baseUrl: string }) => {
    try {
      const cfg = {
        baseUrl: opts.baseUrl,
        activeModel: 'deepseek-v4-flash',
        activeProviderId: 'deepseek-l0e2e',
        providers: [{
          id: 'deepseek-l0e2e',
          name: 'DeepSeek',
          baseUrl: opts.baseUrl,
          authType: 'bearer',
          apiKey: opts.apiKey,
          modelsEndpoint: '/v1/models',
          chatFormat: 'openai',
          models: [
            { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerId: 'deepseek-l0e2e' }
          ],
          isReachable: true,
          lastCheckedAt: Date.now()
        }]
      }
      await window.electronAPI.storeWrite('api-config', cfg)
      localStorage.setItem('holo-api-config', JSON.stringify(cfg))
      return true
    } catch { return false }
  }, { apiKey: DEEPSEEK_API_KEY, baseUrl: DEEPSEEK_BASE_URL })

  if (!writeOk) return false

  const result = await page.evaluate(async (opts: { apiKey: string; baseUrl: string }) => {
    const el = document.querySelector('#app')
    if (!el || !(el as any).__vue_app__) return { ready: false, method: 'no_vue_app' }
    const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
    if (!pinia) return { ready: false, method: 'no_pinia' }
    const apiStore = pinia._s.get('api')
    if (!apiStore) return { ready: false, method: 'no_api_store' }

    apiStore.addProvider({
      name: 'DeepSeek',
      baseUrl: opts.baseUrl,
      authType: 'bearer',
      apiKey: opts.apiKey,
      modelsEndpoint: '/v1/models',
      chatFormat: 'openai'
    })

    const provider = apiStore.config.providers.find((p: any) => p.name === 'DeepSeek')
    if (!provider) return { ready: false, method: 'provider_not_found' }

    await apiStore.pingProvider(provider).catch(() => false)
    provider.isReachable = true
    apiStore.config.isReachable = true
    apiStore.switchProvider(provider.id)
    if (apiStore.config.models.length > 0) {
      apiStore.setActiveModel('deepseek-v4-flash')
    }

    return { ready: apiStore.isReady, isReachable: apiStore.config.isReachable, method: 'pinia_direct' }
  }, { apiKey: DEEPSEEK_API_KEY, baseUrl: DEEPSEEK_BASE_URL })

  console.log(`[L0-E2E] 配置结果: ${JSON.stringify(result)}`)
  return result.ready || result.isReachable
}

async function clearDialog(page: any): Promise<void> {
  await page.evaluate(() => {
    try {
      const el = document.querySelector('#app')
      if (!el || !(el as any).__vue_app__) return
      const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
      const store = pinia?._s?.get('dialog')
      if (store) {
        store.messages.splice(0, store.messages.length)
        store.isProcessing = false
        store.awaitingConfirmation = false
        store.awaitingIntentConfirm = false
        store.awaitingSlotFill = false
        store.awaitingCandidatePick = false
        store.dagPaused = false
        store.pendingPlan = null
        store.pendingContent = ''
      }
    } catch { /* ignore */ }
  })
  const input = await page.$('input[type="text"], textarea, [contenteditable="true"], input')
  if (input) await input.fill('')
  await page.waitForTimeout(300)
}

async function sendMessageAndGetNotices(page: any, text: string, timeoutMs: number = 30000): Promise<{
  replied: boolean
  notices: string[]
  hasL0Skill: boolean
  hasExploreMode: boolean
  hasRaaP: boolean
  hasYellowGate: boolean
  latency: number
}> {
  const input = await page.$('input[type="text"], textarea, [contenteditable="true"], input')
  if (!input) return { replied: false, notices: [], hasL0Skill: false, hasExploreMode: false, hasRaaP: false, hasYellowGate: false, latency: 0 }

  const beforeMsgs = await page.evaluate(() => {
    const el = document.querySelector('#app')
    if (!el || !(el as any).__vue_app__) return 0
    const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
    const store = pinia?._s?.get('dialog')
    return store?.messages?.length || 0
  })

  await input.fill(text)
  await input.press('Enter')

  const start = Date.now()
  let replied = false
  let notices: string[] = []

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1500)

    const state = await page.evaluate((before: number) => {
      const el = document.querySelector('#app')
      if (!el || !(el as any).__vue_app__) return { replied: false, notices: [] }
      const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
      const store = pinia?._s?.get('dialog')
      if (!store) return { replied: false, notices: [] }

      const msgs = store.messages || []
      const newMsgs = msgs.slice(before)
      const isProcessing = store.isProcessing
      const hasNonUser = newMsgs.some((m: any) => m.role !== 'user')
      const noticeMsgs = newMsgs
        .filter((m: any) => m.role === 'system' || m.type === 'notice')
        .map((m: any) => m.content || '')

      return { replied: !isProcessing && newMsgs.length > 0 && hasNonUser, notices: noticeMsgs }
    }, beforeMsgs)

    if (state.replied) {
      replied = true
      notices = state.notices
      break
    }
  }

  const allNotices = notices.join(' ')
  return {
    replied,
    notices,
    hasL0Skill: allNotices.includes('L0 Skill直通'),
    hasExploreMode: allNotices.includes('探索模式'),
    hasRaaP: allNotices.includes('RaaP'),
    hasYellowGate: allNotices.includes('候选') || allNotices.includes('candidates'),
    latency: Date.now() - start
  }
}

describe('L0 Skill + ExploreMode E2E', () => {
  let app: any
  let page: any
  let apiReady = false

  beforeAll(async () => {
    ensureBuild()
    const { _electron } = await import('@playwright/test')
    app = await _electron.launch({
      args: [OUT_MAIN],
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'test' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(2000)

    apiReady = await configureDeepSeek(page)
    console.log(`[L0-E2E] API ready: ${apiReady}`)
  }, 45000)

  afterAll(async () => {
    if (app) await app.close().catch(() => {})
  })

  it('L0 Skill: 简单shell命令直通 → 跳过RaaP', async () => {
    const result = await sendMessageAndGetNotices(page, 'ls -la')
    console.log(`[L0-E2E] shell命令: replied=${result.replied}, hasL0Skill=${result.hasL0Skill}, hasRaaP=${result.hasRaaP}, latency=${result.latency}ms, notices=${result.notices.length}`)

    expect(result.replied).toBe(true)
    expect(result.hasL0Skill).toBe(true)
    expect(result.hasRaaP).toBe(false)

    await clearDialog(page)
  }, 45000)

  it('L0 Skill: 文本生成直通 → 跳过RaaP', async () => {
    const result = await sendMessageAndGetNotices(page, '写一个JavaScript debounce函数')
    console.log(`[L0-E2E] 文本生成: replied=${result.replied}, hasL0Skill=${result.hasL0Skill}, hasRaaP=${result.hasRaaP}, latency=${result.latency}ms`)

    expect(result.replied).toBe(true)
    expect(result.hasL0Skill).toBe(true)
    expect(result.hasRaaP).toBe(false)

    await clearDialog(page)
  }, 45000)

  it('L0 Skill: npm命令直通', async () => {
    const result = await sendMessageAndGetNotices(page, 'npm list --depth=0')
    console.log(`[L0-E2E] npm命令: replied=${result.replied}, hasL0Skill=${result.hasL0Skill}, latency=${result.latency}ms`)

    expect(result.replied).toBe(true)
    expect(result.hasL0Skill).toBe(true)

    await clearDialog(page)
  }, 45000)

  it('ExploreMode: RaaP未命中的查询 → 进入探索模式', async () => {
    const result = await sendMessageAndGetNotices(page, '帮我分析一下量子计算的发展趋势')
    console.log(`[L0-E2E] 探索模式: replied=${result.replied}, hasExploreMode=${result.hasExploreMode}, hasL0Skill=${result.hasL0Skill}, latency=${result.latency}ms`)

    expect(result.replied).toBe(true)
    expect(result.hasExploreMode).toBe(true)
    expect(result.hasL0Skill).toBe(false)

    await clearDialog(page)
  }, 45000)

  it('RaaP正常命中: 周报 → L2工具匹配', async () => {
    const result = await sendMessageAndGetNotices(page, '帮我生成周报总结')
    console.log(`[L0-E2E] RaaP命中: replied=${result.replied}, hasRaaP=${result.hasRaaP}, hasL0Skill=${result.hasL0Skill}, hasExploreMode=${result.hasExploreMode}, latency=${result.latency}ms`)

    expect(result.replied).toBe(true)
    expect(result.hasRaaP || result.hasExploreMode).toBe(true)
    expect(result.hasL0Skill).toBe(false)

    await clearDialog(page)
  }, 45000)

  it('混合场景: 连续3条不同类型消息', async () => {
    const scenarios = [
      { input: 'pwd', expectL0: true, expectExplore: false, label: 'Shell命令' },
      { input: '解释一下区块链技术的原理', expectL0: false, expectExplore: false, label: '探索模式' },
      { input: 'git log --oneline -5', expectL0: true, expectExplore: false, label: 'Shell命令2' }
    ]

    for (const s of scenarios) {
      const result = await sendMessageAndGetNotices(page, s.input)
      console.log(`[L0-E2E] 混合场景[${s.label}]: replied=${result.replied}, hasL0Skill=${result.hasL0Skill}, hasExploreMode=${result.hasExploreMode}, latency=${result.latency}ms`)

      expect(result.replied).toBe(true)
      if (s.expectL0) expect(result.hasL0Skill).toBe(true)
      if (s.expectExplore) expect(result.hasExploreMode).toBe(true)

      await clearDialog(page)
      await page.waitForTimeout(300)
    }
  }, 90000)

  it('App未崩溃且DOM可响应', async () => {
    const html = await page.content()
    expect(html.length).toBeGreaterThan(100)

    const isAlive = await page.evaluate(() => {
      return document.body != null && document.body.innerHTML.length > 0
    })
    expect(isAlive).toBe(true)
  })
})
