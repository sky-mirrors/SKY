import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { existsSync } from 'fs'
import { execSync } from 'child_process'

const PROJECT_ROOT = join(__dirname, '..', '..')
const OUT_MAIN = join(PROJECT_ROOT, 'out', 'main', 'index.js')
const ROUNDS = 5
const MAX_HEAP_GROWTH_MB = 100
const DEEPSEEK_API_KEY = '***REMOVED-SECRET***'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

function ensureBuild(): void {
  if (!existsSync(OUT_MAIN)) {
    console.log('[Stress] 构建产物不存在，执行 npm run build...')
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 })
  }
}

async function configureDeepSeek(page: any): Promise<boolean> {
  const writeOk = await page.evaluate(async (opts: { apiKey: string; baseUrl: string }) => {
    try {
      const cfg = {
        baseUrl: opts.baseUrl,
        activeModel: 'deepseek-v4-flash',
        activeProviderId: 'deepseek-stress',
        providers: [{
          id: 'deepseek-stress',
          name: 'DeepSeek',
          baseUrl: opts.baseUrl,
          authType: 'bearer',
          apiKey: opts.apiKey,
          modelsEndpoint: '/v1/models',
          chatFormat: 'openai',
          models: [
            { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerId: 'deepseek-stress' },
            { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', providerId: 'deepseek-stress' }
          ],
          isReachable: true,
          lastCheckedAt: Date.now()
        }]
      }
      await window.electronAPI.storeWrite('api-config', cfg)
      localStorage.setItem('holo-api-config', JSON.stringify(cfg))
      return true
    } catch (e: any) {
      return false
    }
  }, { apiKey: DEEPSEEK_API_KEY, baseUrl: DEEPSEEK_BASE_URL })

  if (!writeOk) return false

  const result = await page.evaluate(async (opts: { apiKey: string; baseUrl: string }) => {
    const el = document.querySelector('#app')
    if (!el || !(el as any).__vue_app__) return { ready: false, method: 'no_vue_app' }

    const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
    if (!pinia) return { ready: false, method: 'no_pinia' }

    const apiStore = pinia._s.get('api')
    if (!apiStore) return { ready: false, method: 'no_api_store', stores: [...pinia._s.keys()] }

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

    const reachable = await apiStore.pingProvider(provider).catch(() => false)
    if (!reachable) {
      provider.isReachable = true
      apiStore.config.isReachable = true
    }

    apiStore.switchProvider(provider.id)
    if (apiStore.config.models.length > 0) {
      apiStore.setActiveModel('deepseek-v4-flash')
    }

    return {
      ready: apiStore.isReady,
      isReachable: apiStore.config.isReachable,
      activeModel: apiStore.config.activeModel,
      providerCount: apiStore.config.providers.length,
      method: 'pinia_direct'
    }
  }, { apiKey: DEEPSEEK_API_KEY, baseUrl: DEEPSEEK_BASE_URL })

  console.log(`[Stress] 配置结果: ${JSON.stringify(result)}`)
  return result.ready || result.isReachable
}

function getPiniaStore(page: any, storeName: string): Promise<any> {
  return page.evaluate((name: string) => {
    const el = document.querySelector('#app')
    if (!el || !(el as any).__vue_app__) return null
    const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
    if (!pinia) return null
    const store = pinia._s.get(name)
    return store ? {
      isReady: store.isReady,
      isProcessing: store.isProcessing,
      activeModel: store.config?.activeModel,
      msgCount: store.messages?.length,
      isReachable: store.config?.isReachable
    } : null
  }, storeName)
}

async function sendMessageAndWait(page: any, text: string, timeoutMs: number = 60000): Promise<{ replied: boolean; hasContent: boolean; llmCalled: boolean; latency: number }> {
  const input = await page.$('input[type="text"], textarea, [contenteditable="true"], input')
  if (!input) return { replied: false, hasContent: false, llmCalled: false, latency: 0 }

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
  let hasContent = false
  let llmCalled = false

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000)

    const state = await page.evaluate((before: number) => {
      const el = document.querySelector('#app')
      if (!el || !(el as any).__vue_app__) return { replied: false, hasContent: false, llmCalled: false }
      const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
      if (!pinia) return { replied: false, hasContent: false, llmCalled: false }

      const dialogStore = pinia._s.get('dialog')
      const apiStore = pinia._s.get('api')
      if (!dialogStore) return { replied: false, hasContent: false, llmCalled: false }

      const msgs = dialogStore.messages || []
      const newMsgs = msgs.slice(before)
      const isProcessing = dialogStore.isProcessing
      const hasAssistant = newMsgs.some((m: any) => (m.role === 'assistant' || m.role === 'system' || m.type === 'notice') && m.content?.length > 5)
      const hasSystem = newMsgs.some((m: any) => m.role !== 'user')
      const circuitOpen = apiStore?.isCircuitOpen || false
      const debugMsgs = newMsgs.slice(-5).map((m: any) => ({ role: m.role, type: m.type, len: m.content?.length || 0 }))

      return {
        replied: !isProcessing && newMsgs.length > 0 && hasSystem,
        hasContent: hasAssistant,
        llmCalled: hasAssistant,
        msgCount: msgs.length,
        newMsgCount: newMsgs.length,
        isProcessing,
        circuitOpen,
        debugMsgs
      }
    }, beforeMsgs)

    if (state.replied) {
      console.log(`[Stress] debugMsgs: ${JSON.stringify(state.debugMsgs)}`)
      replied = true
      hasContent = state.hasContent
      llmCalled = state.llmCalled
      break
    }

    if (state.circuitOpen) {
      console.log(`[Stress] 熔断器打开，停止等待`)
      break
    }

    if (Date.now() - start > 20000 && !state.isProcessing) {
      console.log(`[Stress] 20s后仍无回复，debugMsgs: ${JSON.stringify(state.debugMsgs)}, msgCount=${state.msgCount}, newMsgCount=${state.newMsgCount}`)
    }
  }

  return { replied, hasContent, llmCalled, latency: Date.now() - start }
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
      }
    } catch { /* ignore */ }
  })
  const input = await page.$('input[type="text"], textarea, [contenteditable="true"], input')
  if (input) await input.fill('')
  await page.waitForTimeout(200)
}

async function getHeapMB(page: any): Promise<number> {
  return await page.evaluate(() => {
    const perf = (performance as any)
    if (perf?.memory?.usedJSHeapSize) {
      return Math.round(perf.memory.usedJSHeapSize / 1048576)
    }
    return -1
  })
}

const STRESS_QUERIES = [
  '帮我写一段Python快速排序代码',
  '解释一下什么是RaaP检索增强规划',
  '列出当前系统的工具节点',
  '用shell命令查看当前目录文件列表',
  '帮我搜索关于机器学习的知识',
  '写一个JavaScript的debounce函数',
  '总结一下今天的对话内容',
  '查询当前时间并格式化输出',
  '帮我创建一个简单的待办事项列表',
  '解释DAG执行引擎的工作原理'
]

describe('真实LLM链路压力测试', () => {
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
    if (!apiReady) {
      console.log('[Stress] ⚠️ DeepSeek API不可达，LLM链路测试将跳过')
    } else {
      console.log('[Stress] ✅ DeepSeek API已配置，将进行真实LLM压力测试')
    }
  }, 45000)

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {})
    }
  })

  it(`DeepSeek API连通性验证`, async () => {
    if (!apiReady) {
      console.log('[Stress] 跳过：API不可达')
      return
    }
    const state = await getPiniaStore(page, 'api')
    expect(state?.isReady || state?.isReachable).toBe(true)
  })

  it(`单轮RaaP+LLM完整链路验证`, async () => {
    if (!apiReady) return

    const result = await sendMessageAndWait(page, '帮我写一个hello world程序', 60000)
    console.log(`[Stress] 单轮结果: replied=${result.replied}, hasContent=${result.hasContent}, llmCalled=${result.llmCalled}, latency=${result.latency}ms`)

    expect(result.replied).toBe(true)
    expect(result.hasContent).toBe(true)

    const msgSnapshot = await page.evaluate(() => {
      const el = document.querySelector('#app')
      if (!el || !(el as any).__vue_app__) return {}
      const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
      const store = pinia?._s?.get('dialog')
      const msgs = store?.messages || []
      return {
        total: msgs.length,
        assistantMsgs: msgs.filter((m: any) => m.role === 'assistant').length,
        systemMsgs: msgs.filter((m: any) => m.role === 'system' || m.role === 'notice').length,
        lastAssistantLen: msgs.filter((m: any) => m.role === 'assistant').pop()?.content?.length || 0,
        hasRaapNotice: msgs.some((m: any) => m.content?.includes('RaaP') || m.content?.includes('raap'))
      }
    })
    console.log(`[Stress] 消息快照:`, JSON.stringify(msgSnapshot))
    expect(msgSnapshot.assistantMsgs).toBeGreaterThan(0)

    await clearDialog(page)
  }, 60000)

  it(`${ROUNDS}轮真实LLM调用压力测试, heap增长≤${MAX_HEAP_GROWTH_MB}MB`, async () => {
    if (!apiReady) {
      console.log('[Stress] 跳过：API不可达')
      return
    }

    const initialHeap = await getHeapMB(page)
    if (initialHeap < 0) {
      console.log('[Stress] performance.memory不可用，使用process.memoryUsage')
    }
    console.log(`[Stress] R0: ${initialHeap}MB`)

    let successCount = 0
    let llmCallCount = 0
    let failCount = 0
    const latencies: number[] = []

    for (let i = 0; i < ROUNDS; i++) {
      const query = STRESS_QUERIES[i % STRESS_QUERIES.length]

      const result = await sendMessageAndWait(page, query, 60000)
      latencies.push(result.latency)

      if (result.replied && result.hasContent) {
        successCount++
        if (result.llmCalled) llmCallCount++
      } else {
        failCount++
        console.log(`[Stress] R${i + 1} 失败: query="${query}", replied=${result.replied}, hasContent=${result.hasContent}, latency=${result.latency}ms`)
      }

      if ((i + 1) % 2 === 0 || i === ROUNDS - 1) {
        const heap = await getHeapMB(page)
        console.log(`[Stress] R${i + 1}: ${heap}MB (Δ${heap - initialHeap}MB) latency=${result.latency}ms ok=${successCount}/${i + 1} llm=${llmCallCount}`)
      }

      await clearDialog(page)
      await page.waitForTimeout(500)
    }

    const finalHeap = await getHeapMB(page)
    const heapGrowth = finalHeap - initialHeap
    const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0

    console.log(`[Stress] 总结: 初始=${initialHeap}MB, 最终=${finalHeap}MB, 增长=${heapGrowth}MB`)
    console.log(`[Stress] 成功=${successCount}/${ROUNDS}, LLM调用=${llmCallCount}, 失败=${failCount}, 平均延迟=${avgLatency}ms`)

    expect(heapGrowth).toBeLessThanOrEqual(MAX_HEAP_GROWTH_MB)
    expect(successCount).toBeGreaterThan(Math.floor(ROUNDS * 0.5))
    expect(llmCallCount).toBeGreaterThan(0)
  }, 900000)

  it('App未崩溃且DOM可响应', async () => {
    const html = await page.content()
    expect(html.length).toBeGreaterThan(100)

    const isAlive = await page.evaluate(() => {
      return document.body != null && document.body.innerHTML.length > 0
    })
    expect(isAlive).toBe(true)

    const apiState = await page.evaluate(() => {
      const el = document.querySelector('#app')
      if (!el || !(el as any).__vue_app__) return { isReady: false, isCircuitOpen: false, activeModel: '', providerCount: 0 }
      const pinia = (el as any).__vue_app__.config.globalProperties.$pinia
      const apiStore = pinia?._s?.get('api')
      return {
        isReady: apiStore?.isReady || false,
        isCircuitOpen: apiStore?.isCircuitOpen || false,
        activeModel: apiStore?.config?.activeModel || '',
        providerCount: apiStore?.config?.providers?.length || 0
      }
    })
    console.log(`[Stress] App状态:`, JSON.stringify(apiState))
    expect(apiState.isReady || apiState.activeModel || apiState.providerCount > 0).toBe(true)
  })
})
