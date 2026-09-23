import { L2ToolManifest, L2DagStep, ProbeSnapshot, ProbeSource, DagCheckpoint } from '@/models'
import { globalBus } from '@/kernel/bus'
import { extractEntities, shouldTrigger, runFactGuardV2, type FactGuardV2Result } from './factGuard'
import { route as smartRoute, getHistoricalTokenAvg } from '@/services/smartRouter'
import {
  compilePrompt,
  fillCompiledPrompt,
  computeInputFingerprint,
  findCachedExecution,
  saveExecutionFingerprint,
  computeStepOutputHash,
  findDirtySteps,
  getTierConfig,
  computeStepPlan,
  computeParallelGroups,
  formatStepPlanVisualization,
  isManifestAutoCompiled,
  simulateDataFlow
} from './scheduleOptimizer'
import { runRuleEngine, buildRuleContext } from './ruleEngine'
import type { RuleEngineResult } from './ruleEngine'
import { saveCheckpoint, removeCheckpoint, getCheckpoint, createCheckpointId } from './dagCheckpoint'
import { debugLog } from '@/services/debugLog'
import { useWorkflowLogStore } from '@/stores/workflowLogStore'
import { SIDE_EFFECT_TOOLS, NO_CACHE_REUSE_TOOLS, needsDualEngineValidation, isMcpToolName, normalizeToolName } from './toolRegistry'
import { NATIVE_TOOL_DEFS } from './nativeTools'

// P0-B2：删除按 tier 冻结的默认 STEP_TIMEOUT_MS 阶梯（nano 8s 在 CPU 后端基本 abort 一切，
// 且遮蔽 apiStore 统一阶梯使其 2 档沦为死代码；stepTimeout 按初始 tier 冻结、降级重试不重算）。
// 无显式 timeoutMs override 时不武装本地计时器，超时完全交给 apiStore 统一阶梯
// （tierTimeoutFor，fetchSignal 已桥接 externalSignal）；有 override 时本地计时器带 TimeoutError 理由。

const TIER_DOWNGRADE: Record<string, string> = {
  pro: 'standard',
  standard: 'mini',
  mini: 'nano',
  nano: 'rule'
}

const compiledPromptCache = new Map<string, ReturnType<typeof compilePrompt>>()

function probeStep(
  manifestId: string,
  stepNum: number,
  toolName: string,
  source: ProbeSource,
  sourceDetail: string,
  inputSnapshot: Record<string, unknown>,
  outputSnapshot: string,
  durationMs: number,
  extra?: Partial<Pick<ProbeSnapshot, 'modelTier' | 'modelParams' | 'ruleId' | 'cacheFingerprint' | 'errorStack' | 'tokenUsage'>>,
  traceId?: string
) {
  // P1-39：get-step-cost 请求与探针发布分离——请求失败（无 handler）不再吞掉整个探针
  let tokenUsage: NonNullable<ProbeSnapshot['tokenUsage']> | undefined
  try {
    const stepCost = globalBus.request<{ promptTokens: number; completionTokens: number; estimatedCostCny: number } | undefined>('debug:get-step-cost', { stepNum })
    if (stepCost) {
      tokenUsage = {
        promptTokens: stepCost.promptTokens,
        completionTokens: stepCost.completionTokens,
        totalTokens: stepCost.promptTokens + stepCost.completionTokens,
        estimatedCostCny: stepCost.estimatedCostCny
      }
    }
  } catch { /* 可选链路：step-cost 不可用不影响探针 */ }
  try {
    // #2 收尾：traceId 参数化传播（原模块级全局并发下串号）
    const snapshot: ProbeSnapshot = {
      id: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stepNum,
      manifestId,
      source,
      sourceDetail,
      toolName,
      inputSnapshot,
      outputSnapshot: outputSnapshot.substring(0, 2000),
      timestamp: Date.now(),
      durationMs,
      tokenUsage,
      ...(traceId ? { traceId } : {}),
      ...extra
    }
    // P1-39：payload 须为 { snapshot } 包装——bridge 只认 payload.snapshot，旧扁平结构两分支均不命中
    globalBus.emit('debug:log-probe', { snapshot })
  } catch { /* non-critical */ }
}

function sourceForTool(toolName: string): ProbeSource {
  if (toolName === 'llm_generate') return 'llm'
  if (toolName === 'shell_exec') return 'shell'
  if (toolName === 'read_file') return 'read_file'
  if (toolName === 'file_write') return 'rule'
  if (toolName === 'create_directory') return 'rule'
  if (toolName === 'create_docx') return 'rule'
  if (toolName === 'http_request') return 'shell'
  if (toolName === 'knowledge_search') return 'knowledge'
  if (toolName.includes('___')) return 'mcp'
  return 'mcp'
}

function getCompiledPrompt(template: string) {
  const existing = compiledPromptCache.get(template)
  if (existing) return existing
  const compiled = compilePrompt(template)
  compiledPromptCache.set(template, compiled)
  return compiled
}

export async function callToolDirectWithTier(
  fullName: string,
  args: Record<string, unknown>,
  modelTier?: string,
  timeoutMs?: number,
  externalSignal?: AbortSignal,
  stepResults?: Record<number, string>,
  userInput?: { inputText?: string },
  traceId?: string
): Promise<string> {
  const isWin = window.electronAPI?.platform === 'win32'
  const defaultHome = isWin ? 'C:\\Users\\Default' : '/home/user'
  // P1-17：计划生成器/历史清单可能携带别名（file_read/directory_tree 等），dispatch 前统一归一化
  fullName = normalizeToolName(fullName)

  async function resolveFilePath(p: string): Promise<string> {
    if (p.includes('%USERPROFILE%')) {
      const resolved = await window.electronAPI?.resolvePath('%USERPROFILE%') || defaultHome
      p = p.replace('%USERPROFILE%', resolved)
    }
    if (p.includes('%HOME%')) {
      const resolved = await window.electronAPI?.resolvePath('%HOME%') || defaultHome
      p = p.replace('%HOME%', resolved)
    }
    return p
  }

  if (fullName === 'file_write') {
    if (!window.electronAPI?.fileWrite) throw new Error('file_write not available')
    const filePath = await resolveFilePath(String(args.filePath || args.path || ''))
    if (!filePath) throw new Error('file_write: missing filePath')
    const result = await window.electronAPI.fileWrite({
      filePath,
      content: String(args.content || ''),
      encoding: args.encoding ? String(args.encoding) as BufferEncoding : undefined
    })
    if (result.success) {
      // P1-D2：空内容写入也返回 success（ipc 层不拦截），此处如实标注，
      // 防止 LLM 摘要转述"已写入"掩盖空产物假完成
      const written = String(args.content || '')
      return written.trim()
        ? `文件已写入: ${result.path}`
        : `文件已写入: ${result.path}（⚠️ 空文件：未写入任何内容）`
    }
    throw new Error(result.error || 'file_write failed')
  }

  // 2026-09-24：重命名/移动（对应主进程 file:move）。shell 白名单不含 ren/move（shell-security.ts:4），
  // 故不走 shell_exec；且返回值带上 from→to，便于上游如实报告"改成了什么名字"。
  if (fullName === 'file_move') {
    if (!window.electronAPI?.fileMove) throw new Error('file_move not available')
    const from = await resolveFilePath(String(args.from || args.path || args.source || ''))
    if (!from) throw new Error('file_move: missing from')
    const to = await resolveFilePath(String(args.to || args.target || args.newPath || ''))
    if (!to) throw new Error('file_move: missing to')
    const result = await window.electronAPI.fileMove({ from, to })
    if (result.success) return `已重命名/移动: ${result.from} → ${result.to}`
    throw new Error(result.error || 'file_move failed')
  }

  if (fullName === 'create_directory') {
    if (!window.electronAPI?.createDirectory) throw new Error('create_directory not available')
    const dirPath = await resolveFilePath(String(args.path || args.dirPath || ''))
    if (!dirPath) throw new Error('create_directory: missing path')
    const result = await window.electronAPI.createDirectory(dirPath)
    if (result.success) return `目录已创建: ${result.path}`
    throw new Error(result.error || 'create_directory failed')
  }

  if (fullName === 'create_docx') {
    if (!window.electronAPI?.createDocx) throw new Error('create_docx not available')
    const filePath = await resolveFilePath(String(args.filePath || args.path || ''))
    if (!filePath) throw new Error('create_docx: missing filePath')
    const result = await window.electronAPI.createDocx({
      filePath,
      content: args.content ? String(args.content) : undefined,
      title: args.title ? String(args.title) : undefined
    })
    if (result.success) {
      // P1-D2：无标题无内容的 docx 同样如实标注（ipc 层空内容也返回 success）
      const docxBody = args.content ? String(args.content) : ''
      const docxTitle = args.title ? String(args.title) : ''
      return (docxBody.trim() || docxTitle.trim())
        ? `docx文件已创建: ${result.path}`
        : `docx文件已创建: ${result.path}（⚠️ 空文档：无标题无内容）`
    }
    throw new Error(result.error || 'create_docx failed')
  }

  if (fullName === 'shell_exec') {
    if (!window.electronAPI?.shellExec) throw new Error('shell_exec not available')
    const env: Record<string, string> = {}
    if (userInput?.inputText) env['USER_INPUT'] = userInput.inputText.substring(0, 8000)
    if (args.env_content) env['CONTENT'] = String(args.env_content).substring(0, 8000)
    if (args.env_output_path) env['OUTPUT_PATH'] = String(args.env_output_path)
    if (stepResults) {
      for (const [sNum, sResult] of Object.entries(stepResults)) {
        env[`STEP_${sNum}_RESULT`] = sResult.substring(0, 8000)
      }
      if (Object.keys(stepResults).length > 0) {
        const lastKey = Object.keys(stepResults).sort((a, b) => Number(b) - Number(a))[0]
        env['ANALYSIS'] = stepResults[Number(lastKey)].substring(0, 8000)
      }
    }
    const result = await window.electronAPI.shellExec({
      command: String(args.command || ''),
      cwd: args.cwd ? String(args.cwd) : undefined,
      timeout: timeoutMs || Number(args.timeout) || 60000,
      env
    })
    if (result.success) {
      const cmd = String(args.command || '')
        try {
          globalBus.emit('debug:log-event', { level: 'info', tag: 'shell', message: `[shell_exec] 成功 exit=0 | stdout=${(result.stdout || '').substring(0, 200)}`, data: result.stdout })
          if (result.stderr) globalBus.emit('debug:log-event', { level: 'warn', tag: 'shell', message: `[shell_exec] stderr: ${result.stderr.substring(0, 200)}`, data: result.stderr })
        } catch { /* ignore */ }
      const desktopFileMatch = cmd.match(/writeFileSync\([^)]*Desktop[^)]*\\\\([^'"]+)/) || cmd.match(/writeFileSync\([^)]*Desktop[^)]*\/([^'"]+)/) || cmd.match(/writeFileSync\([^)]*Desktop[^)]*\\([^'"]+)/)
      if (desktopFileMatch) {
        const expectedFileName = desktopFileMatch[1].replace(/['"]/g, '')
        // P1-31：核验脚本三重死修复——
        // 1) debugLog 在 node -e 里未定义，首次调用即抛 ReferenceError，核验永远失败；
        // 2) HOME_DIR 伪造为 'C:\Users\Default'（不存在的兜底目录）恒 FILE_MISSING；
        // 3) shellExec 子进程 env 已合并主进程 process.env（见 ipc-handlers A-03），
        //    USERPROFILE/HOME 天然是真实用户目录，无需任何 HOME_DIR
        const checkCmd = `node -e "const fs=require('fs');const p=require('path');const home=process.env.USERPROFILE||process.env.HOME||'C:\\\\Users\\\\Administrator';const fp=p.join(home,'Desktop',process.env.EXPECTED_FILE||'');let sz=-1;try{sz=fs.statSync(fp).size}catch(e){}console.log(sz<0?'FILE_MISSING:'+fp:(sz>0?'FILE_EXISTS:':'FILE_EMPTY:')+fp)"`
        try {
          const checkResult = await window.electronAPI.shellExec({
            command: checkCmd,
            timeout: 5000,
            env: {
              EXPECTED_FILE: expectedFileName
            }
          })
          if (checkResult.stdout.includes('FILE_EXISTS')) {
            return `文件已保存: ${expectedFileName}`
          }
          // P1-D2：存在性之外加非空核验——0 字节产物即假完成，如实标注
          if (checkResult.stdout.includes('FILE_EMPTY')) {
            return `⚠️ 命令执行成功但产物为空文件（0 字节）: ${expectedFileName}。原始输出: ${result.stdout || '(无输出)'}`
          }
          return `⚠️ 命令执行成功但文件未找到: ${expectedFileName}。原始输出: ${result.stdout || '(无输出)'}`
        } catch {
          return result.stdout || '(命令执行成功，无输出)'
        }
      }
      return result.stdout || '(命令执行成功，无输出)'
    }
    try {
      globalBus.emit('debug:log-event', { level: 'error', tag: 'shell', message: `[shell_exec] 失败 exit=${result.code}`, data: result.stderr })
    } catch { /* ignore */ }
    return `命令执行失败(exit code ${result.code}): ${result.stderr || result.stdout || '未知错误'}`
  }

  if (fullName === 'read_file') {
    if (!window.electronAPI?.fileRead) throw new Error('read_file not available')
    // B1-fix：路径须展开 %USERPROFILE%/%HOME%（与 list_directory 同口径）——
    // 此前直接透传字面量，导致 {{step_N_top_files}} 产出的「%USERPROFILE%\...\文件」读取失败
    // （考试 Q16 实测「步骤2失败：文件不存在」即此因）。
    const path = await resolveFilePath(String(args.path || args.file_path || ''))
    if (!path) throw new Error('read_file: missing path')
    const result = await window.electronAPI.fileRead(path, 200000)
    if (result.success && result.content) {
      const header = result.isBinary ? '' : `[文件: ${path}, 大小: ${result.size}字节]\n`
      return header + result.content
    }
    throw new Error(`${result.error || 'read_file failed'}（路径：${path}）`)
  }

  if (fullName === 'http_request') {
    if (!window.electronAPI?.httpFetch) throw new Error('http_request not available')
    const url = String(args.url || '')
    if (!url) throw new Error('http_request: missing url')
    const result = await window.electronAPI.httpFetch({
      url,
      method: String(args.method || 'GET'),
      headers: args.headers as Record<string, string> | undefined,
      body: args.body ? String(args.body) : undefined,
      timeout: Number(args.timeout) || 30000
    })
    if (result.success) {
      return `[HTTP ${result.status}] ${result.body || '(空响应)'}`
    }
    throw new Error(result.error || `HTTP请求失败: ${result.status}`)
  }

  if (fullName === 'llm_generate') {
    const prompt = String(args.prompt || args.input || '')
    if (!prompt) throw new Error('llm_generate: missing prompt')

    let tier: string
    if (!modelTier) {
      const routingDecision = smartRoute({
        text: prompt,
        taskType: 'llm_generate',
        callerId: 'macro:direct',
        historicalTokenAvg: getHistoricalTokenAvg('llm_generate')
      })
      tier = routingDecision.tier
      debugLog(`[macroExecutor] smartRouter tier=${tier} for prompt (len=${prompt.length})`)
    } else {
      tier = modelTier
    }
    const tierConfig = getTierConfig(tier)
    let maxTokens = Number(args.maxTokens) || tierConfig.maxTokens
    // P0-B2：仅显式 timeoutMs override 武装本地计时器；默认超时交由 apiStore 统一阶梯
    const stepTimeout = timeoutMs || null

    let currentTier = tier
    let lastError: Error | null = null

    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController()
      const timeoutId = stepTimeout
        ? setTimeout(() => controller.abort(new DOMException(`LLM step timeout after ${stepTimeout}ms`, 'TimeoutError')), stepTimeout)
        : null

      if (externalSignal) {
        if (externalSignal.aborted) {
          if (timeoutId !== null) clearTimeout(timeoutId)
          throw new DOMException('Aborted by external signal', 'AbortError')
        }
        externalSignal.addEventListener('abort', () => {
          controller.abort()
          if (timeoutId !== null) clearTimeout(timeoutId)
        }, { once: true })
      }

      try {
        // P0-10：原请求 llm:chat-completion 死频道（全仓无注册，每次必抛）；改走 api:chat-completion，
        // routingOptions 携带 callerId 使宏路径进入语义缓存/预算/路由体系
        const resp = await globalBus.requestAsync<{ content: string }>('api:chat-completion', {
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          // 2026-09-23：宏步骤此前完全不传 tools —— 插桩实测（handlers.ts 汇聚点）
          // `chan=nonstream tools=0 caller=macro:nano`，即模型看不到 read_file/list_directory/
          // file_write/shell_exec 的存在，只能回"我无法访问你电脑上的本地路径/没有文件系统权限"
          // （Q15 三次改口而行为恒定，正是此因；光在 system prompt 里声明有工具无效）。
          // 防御 Array.isArray：本模块在 funnelMainPath.spec 中被 mock，避免 undefined 传入。
          tools: Array.isArray(NATIVE_TOOL_DEFS) ? NATIVE_TOOL_DEFS : undefined,
          // attempt>0 表示这是"空输出重试"：放开档位上限，否则 min() 会把翻倍后的预算压回档位值
          maxTokens: attempt === 0 ? Math.min(maxTokens, getTierConfig(currentTier).maxTokens) : Math.min(maxTokens, 16384),
          signal: controller.signal,
          // G-2：tierConfig.temperature 首次真实送达模型（原从未进请求体）
          routingOptions: { taskType: 'llm_generate', callerId: `macro:${currentTier}`, temperature: getTierConfig(currentTier).temperature, ...(traceId ? { traceId } : {}) }
        })
        if (timeoutId !== null) clearTimeout(timeoutId)
        // ★ 空输出重试（2026-09-23 定案）：推理模型会先把 maxTokens 花在 reasoning_content 上，
        // 且 reasoning 长度本身会波动 —— 插桩实测同一 prompt / 同一档位 / 同一预算下，
        // contentLen 一次 359、一次 0（sent 均为 2048）。空正文不是"模型拒答"，
        // 而是预算被思考吃满 ⇒ 翻倍预算重试，而不是把它当最终答案交付。
        if (!resp.content && attempt < 3) {
          maxTokens = Math.min(maxTokens * 2, 16384)
          lastError = new Error('空输出（reasoning 吃满预算），已翻倍预算重试')
          continue
        }
        // 2026-09-24：模型发起了工具调用却无人执行 —— 插桩实测 Q15 的 resp 为
        // `contentLen=14 toolCalls=1`（keys=content,toolCalls,usage），而本函数原先只取 content，
        // 于是那句开场白"我先看看这个文件夹里有什么。"成了最终答案。
        // 此处补一环工具回路：执行 toolCalls ⇒ 把真实结果回灌为新一轮 user 消息 ⇒ 让模型据此汇报。
        // 上限一轮（避免死循环与成本失控）；工具执行失败也如实回灌，不掩盖。
        const toolCalls = (resp as { toolCalls?: Array<{ id?: string; name?: string; arguments?: string }> }).toolCalls
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const outs: string[] = []
          for (const call of toolCalls) {
            const rawName = String(call?.name || '')
            const toolName = rawName.replace(/.*___/, '').trim()
            let args: Record<string, unknown> = {}
            try { args = JSON.parse(String(call?.arguments || '{}')) as Record<string, unknown> } catch { args = {} }
            try {
              outs.push(`${toolName}: ${await callToolDirectWithTier(toolName, args, currentTier)}`)
            } catch (toolErr) {
              outs.push(`${toolName}: ⚠️ 执行失败 - ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`)
            }
          }
          const followUp = `我按你的要求调用了工具，真实执行结果如下：\n${outs.join('\n')}\n\n请基于以上真实结果，用中文向用户汇报完成情况：说清实际做了什么、涉及多少个文件、以及每个文件的新名字（若适用）。不要再说"我先看看"之类的前言，也不要编造未执行的动作。`
          try {
            const resp2 = await globalBus.requestAsync<{ content: string }>('api:chat-completion', {
              messages: [{ role: 'user', content: followUp, timestamp: Date.now() }],
              tools: Array.isArray(NATIVE_TOOL_DEFS) ? NATIVE_TOOL_DEFS : undefined,
              maxTokens: Math.min(16384, Math.max(maxTokens, getTierConfig(currentTier).maxTokens)),
              signal: controller.signal,
              routingOptions: { taskType: 'llm_generate', callerId: `macro:${currentTier}`, temperature: getTierConfig(currentTier).temperature, ...(traceId ? { traceId } : {}) }
            })
            const summary = (resp2.content || '').trim()
            return summary || outs.join('\n')
          } catch {
            return outs.join('\n')
          }
        }
        return resp.content || '(LLM无输出)'
      } catch (err) {
        if (timeoutId !== null) clearTimeout(timeoutId)
        lastError = err instanceof Error ? err : new Error(String(err))
        if (externalSignal?.aborted) {
          throw new DOMException('Aborted by external signal', 'AbortError')
        }
        const nextTier = TIER_DOWNGRADE[currentTier]
        if (nextTier && nextTier !== 'rule') {
          debugLog(`[macroExecutor] tier降级: ${currentTier} → ${nextTier}`)
          currentTier = nextTier
        } else {
          break
        }
      }
    }

    throw lastError || new Error('llm_generate failed after all tier downgrades')
  }

  if (fullName === 'knowledge_search') {
    try {
      const { searchKnowledge } = await import('./knowledgeBase')
      const query = String(args.query || args.input || '')
      const results = await searchKnowledge(query, 5)
      return results.filter(r => r && r.trim()).join('\n---\n') || '(未检索到相关内容)'
    } catch (err) {
      throw new Error(`知识库检索失败: ${String(err).substring(0, 100)}`)
    }
  }

  if (fullName === 'list_directory') {
    // P1-17：directory_tree/list_directory 此前无原生实现。Q16 定案：shell 版（dir /b）在本环境
    // 拿不到输出 →「成功但结果为空」→ {{step_N_top_files}} 无值。故优先走 fs 直读 IPC file:list。
    const dirPath = await resolveFilePath(String(args.path || args.dirPath || ''))
    if (!dirPath) throw new Error('list_directory: missing path')
    const { isPathUnsafe } = await import('./dualEngineValidator')
    if (isPathUnsafe(dirPath)) throw new Error(`list_directory: 拒绝敏感路径 ${dirPath}`)
    const api = window.electronAPI as unknown as {
      fileList?: (p: string) => Promise<{ success: boolean; entries?: string[]; error?: string }>
    }
    if (api?.fileList) {
      const r = await api.fileList(dirPath)
      if (!r?.success) throw new Error(`list_directory failed: ${r?.error || 'unknown'}`)
      return (r.entries && r.entries.length > 0) ? r.entries.join('\n') : '(空目录)'
    }
    if (!window.electronAPI?.shellExec) throw new Error('list_directory not available')
    const safePath = dirPath.replace(/["%&|<>^]/g, '')
    const listCmd = isWin ? `dir /b "${safePath}"` : `ls -1 "${safePath}"`
    const result = await window.electronAPI.shellExec({ command: listCmd, timeout: timeoutMs || 10000 })
    if (result.success) return result.stdout || '(空目录)'
    throw new Error(result.stderr || result.stdout || 'list_directory failed')
  }

  const sepIdx = fullName.indexOf('___')
  if (sepIdx < 0) throw new Error(`无效工具名: ${fullName}`)
  const mcpIdRaw = fullName.substring(0, sepIdx)
  const toolName = fullName.substring(sepIdx + 3)
  const connections = globalBus.request<{ id: string }[]>('mcp:get-connections', {})
  const conn = connections.find(c => {
    const safeId = c.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    return safeId === mcpIdRaw
  })
  if (!conn) throw new Error(`MCP连接未找到: ${mcpIdRaw}`)
  const result = await globalBus.requestAsync<string>('mcp:call-tool', { mcpId: conn.id, toolName, args })
  return result
}

export function extractStepResult(result: string, consumerStep: L2DagStep, sourceStepNum: number, allSteps: L2DagStep[]): string {
  const sourceStep = allSteps.find(s => s.step === sourceStepNum)
  const extract = sourceStep?.outputExtract
  if (!extract) {
    const consumerTier = consumerStep.modelTier || 'standard'
    const limit = consumerTier === 'nano' ? 300 : consumerTier === 'mini' ? 600 : consumerTier === 'pro' ? 2000 : 800
    return result.substring(0, limit)
  }
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      const pathParts = extract.replace(/^\$\./, '').split('.')
      let current: unknown = parsed
      for (const part of pathParts) {
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          current = (current as Record<string, unknown>)[part]
        } else if (Array.isArray(current)) {
          const idx = Number(part)
          current = isNaN(idx) ? current : current[idx]
        } else {
          break
        }
      }
      if (current !== undefined && current !== null) {
        return typeof current === 'string' ? current : JSON.stringify(current)
      }
    }
  } catch { /* fall through to truncation */ }
  return result.substring(0, 500)
}

/**
 * B1：从「清单类步骤」（list_directory）的结果里挑出与用户输入最匹配的文件名。
 * 无关键词命中时退回清单中的第一个文件，保证后续 read_file 的 path 非空。
 */
export function pickTopFileFromListing(stepResult: string, userText: string): string {
  const names = stepResult
    .split(/\r?\n/)
    .map(s => s.trim().replace(/^[-*•]\s*/, ''))
    .filter(s => s.length > 0 && !s.startsWith('(') && !s.startsWith('【') && !/[\\/]$/.test(s))
  if (names.length === 0) return ''

  const longestCommon = (a: string, b: string): number => {
    let best = 0
    for (let i = 0; i < a.length; i++) {
      for (let len = best + 1; i + len <= a.length; len++) {
        if (b.includes(a.substring(i, i + len))) best = len
        else break
      }
    }
    return best
  }

  let best = ''
  let bestScore = 0
  for (const n of names) {
    const base = n.replace(/\.\w{1,5}$/, '')
    const score = longestCommon(base, userText)
    if (score > bestScore) { bestScore = score; best = n }
  }
  return bestScore >= 2 ? best : names[0]
}

/**
 * 在「模型驱动循环」里替换工具参数中的步骤占位符。
 * 背景：探索计划（`l0SkillRouter.buildExplorePlan`）不在 macroExecutor 里执行——`confirmPlan` 的
 * Direct/Macro 捷径均以 `macroManifest` 为前提，而探索路径在 `dialogStore.ts:1655` 把
 * `pendingMacroManifestId` 置 null，故落到 dialogStore 的模型驱动循环；该循环把计划文本交给模型、
 * 由模型给出 tool_call 参数，**从不解析 `{{step_N_*}}`** ⇒ 3b 模型照抄字面量 `{{step_1_top_files}}`
 * 当作 path（实测 `文件不存在（路径：{{step_1_top_files}}）`）。
 */
export function substitutePlaceholdersInArgs(
  args: Record<string, unknown>,
  stepResults: Record<number, string>,
  planSteps: L2DagStep[],
  userText = ''
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string' || !v.includes('{{step_')) {
      resolved[k] = v
      continue
    }
    resolved[k] = v.replace(/\{\{step_(\d+)_(result|top_files)\}\}/g, (whole, n: string, kind: string) => {
      const num = Number(n)
      const res = stepResults[num]
      if (!res) return whole
      if (kind === 'result') return res.substring(0, 8000)
      const topName = pickTopFileFromListing(res, userText)
      if (!topName) return whole
      const src = planSteps.find(s => s.step === num)
      const rawDir = src && typeof src.params.path === 'string' ? src.params.path : ''
      const dir = rawDir.replace(/\{\{[^}]+\}\}/g, '')
      return dir ? `${dir}\\${topName}` : topName
    })
  }
  return resolved
}

export function resolveParams(
  step: L2DagStep,
  manifest: L2ToolManifest,
  userInput: { filePath?: string; inputText?: string; context?: string },
  stepResults: Record<number, string>
): Record<string, unknown> {
  const allSteps = manifest.execution.dagPlan?.steps || []
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step.params)) {
    resolved[k] = v
  }
  for (const binding of manifest.execution.paramMapping.bindings) {
    if (binding.targetStep === step.step) {
      const slot = manifest.execution.paramMapping.slots.find(s => s.name === binding.slotName)
      if (slot) {
        let value: string | undefined
        if (slot.source === 'file_path') value = userInput.filePath
        else if (slot.source === 'input_text') value = userInput.inputText
        else if (slot.source === 'context') value = userInput.context
        else if (slot.source === 'clipboard') value = ''
        if (value) resolved[binding.targetParam] = value
      }
    }
  }
  for (const [key, val] of Object.entries(resolved)) {
    if (typeof val !== 'string') continue
    const compiled = getCompiledPrompt(val)
    const variables: Record<string, string> = {
      input: userInput.inputText || '',
      user_file: userInput.filePath || '',
      context: userInput.context || ''
    }
    for (const [sNum, sResult] of Object.entries(stepResults)) {
      variables[`step_${sNum}_result`] = extractStepResult(sResult, step, Number(sNum), allSteps)
      // B1：{{step_N_top_files}} —— 从 N 步的清单结果里挑出目标文件（此前只有声明无实现，
      // 导致 l2-weekly-report-draft-v1 的 read_file{{step_1_top_files}} 与文件检索探索计划拿不到路径）
      const topName = pickTopFileFromListing(sResult, userInput.inputText || '')
      if (topName) {
        const srcStep = allSteps.find(s => s.step === Number(sNum))
        const rawDir = srcStep && typeof srcStep.params.path === 'string' ? srcStep.params.path : ''
        const dir = rawDir
          .replace(/\{\{user_file\}\}/g, userInput.filePath || '')
          .replace(/\{\{input\}\}/g, userInput.inputText || '')
        variables[`step_${sNum}_top_files`] = dir && !dir.includes('{{') ? `${dir}\\${topName}` : topName
      }
    }
    resolved[key] = fillCompiledPrompt(compiled, variables)
  }
  return resolved
}

export function evaluateCondition(expr: string, stepResults: Record<number, string>, fromStep?: number): boolean {
  try {
    // D-09：指定 fromStep 时只对该步骤的输出求值——原实现扫描全部步骤结果中的
    // 任意数字，文件大小、耗时毫秒等无关数字会让 `$.output.amount > N` 误成立
    const candidates: string[] = fromStep !== undefined
      ? (stepResults[fromStep] !== undefined ? [stepResults[fromStep]] : [])
      : Object.values(stepResults)
    const amountMatch = expr.match(/\$\.output\.(amount|totalAmount|total)\s*>\s*(\d+)/)
    if (amountMatch) {
      const threshold = Number(amountMatch[2])
      for (const result of candidates) {
        const numMatch = result.match(/[\d,]+\.?\d*/g)
        if (numMatch) {
          const val = Number(numMatch[0].replace(/,/g, ''))
          if (val > threshold) return true
        }
      }
      return false
    }
    const containsMatch = expr.match(/\$\.output\.contains\(['"](.+?)['"]\)/)
    if (containsMatch) {
      const keyword = containsMatch[1]
      for (const result of candidates) {
        if (result.includes(keyword)) return true
      }
      return false
    }
    return true
  } catch {
    return false
  }
}

export async function executeStep(
  step: L2DagStep,
  manifest: L2ToolManifest,
  userInput: { filePath?: string; inputText?: string; context?: string },
  stepResults: Record<number, string>,
  onStepStart?: (stepNum: number, tool: string) => void,
  onStepDone?: (stepNum: number, result: string) => void,
  onStepFailed?: (stepNum: number, error: string) => void,
  macroSignal?: AbortSignal,
  onSideEffect?: (stepNum: number, tool: string, operation: 'create' | 'modify' | 'read', filePath: string) => void,
  traceId?: string
): Promise<{ done: boolean; result?: string; fromCache?: boolean; fromRule?: boolean; ruleMatchedId?: string; usedFallback?: boolean }> {
  const resolvedArgs = resolveParams(step, manifest, userInput, stepResults)
  onStepStart?.(step.step, step.tool)

  try {
    globalBus.emit('debug:log-event', { level: 'info', tag: step.tool === 'shell_exec' ? 'shell' : step.tool === 'llm_generate' ? 'llm' : 'tool', message: `[executeStep] S${step.step} ${step.tool} | 依赖=${(step.depends_on || []).join(',')} | 参数=${JSON.stringify(resolvedArgs).substring(0, 200)}` })
  } catch { /* ignore */ }

  if (macroSignal?.aborted) {
    onStepFailed?.(step.step, '宏执行已取消')
    return { done: false }
  }

  const ruleTarget = manifest.ruleBasedFallback?.targetStep
  const ruleAppliesToStep = ruleTarget == null || ruleTarget === step.step
  if (step.tool === 'llm_generate' && manifest.ruleBasedFallback?.enabled && ruleAppliesToStep) {
    const ctx = buildRuleContext(userInput, stepResults)
    const ruleResult = runRuleEngine(manifest.ruleBasedFallback, ctx)
    if (ruleResult.matched) {
      onStepDone?.(step.step, ruleResult.output)
      probeStep(manifest.identity.id, step.step, step.tool, 'rule', `规则引擎命中: ${ruleResult.matchedRuleId}`, resolvedArgs, ruleResult.output, 0, { ruleId: ruleResult.matchedRuleId }, traceId)
      return { done: true, result: ruleResult.output, fromCache: false, fromRule: true, ruleMatchedId: ruleResult.matchedRuleId }
    }
  }

  const stepStartTime = Date.now()
  const tier = step.modelTier || (manifest.execution.fallbackModelTier as string | undefined)
  try {
    const contextText = Object.values(stepResults).join('\n') + '\n' + (userInput.inputText || '') + '\n' + (userInput.context || '')
    let groundTruthEntities: ReturnType<typeof extractEntities> = []
    if (step.tool === 'llm_generate' && shouldTrigger(manifest.routing.targetRoles, contextText)) {
      groundTruthEntities = extractEntities(contextText.substring(0, 5000))
    }

    if (needsDualEngineValidation(step.tool)) {
      const { shouldValidate, buildActionManifest, dualEngineValidate } = await import('./dualEngineValidator')
      if (shouldValidate(step, manifest.identity.id)) {
        const actionManifest = buildActionManifest(manifest.identity.id, step, userInput.inputText || '')
        const validation = await dualEngineValidate(actionManifest, userInput.inputText || '')
        try { globalBus.emit('debug:log-event', { level: 'info', tag: 'factguard', message: `[双引擎审核] S${step.step} | intent=${validation.intent_match} | param=${validation.parameter_sane} | risk=${validation.risk_level}${validation.reason ? ' | ' + validation.reason : ''}` }) } catch { /* ignore */ }

        if (!validation.intent_match) {
          const msg = `双引擎审核: 意图偏离 — ${validation.reason || '动作不匹配用户意图'}`
          probeStep(manifest.identity.id, step.step, step.tool, 'error', msg, resolvedArgs, '', Date.now() - stepStartTime, undefined, traceId)
          throw new Error(msg)
        }
        if (!validation.parameter_sane) {
          const msg = `双引擎审核: 参数存疑 — ${validation.reason || '目标文件格式不匹配'}`
          probeStep(manifest.identity.id, step.step, step.tool, 'error', msg, resolvedArgs, '', Date.now() - stepStartTime, undefined, traceId)
          throw new Error(msg)
        }
        if (validation.risk_level === 'high') {
          // P0-9：fail-closed——确认通道断裂、超时、任何异常均按拒绝处理，高危命令绝不无确认执行
          let approved = false
          try {
            approved = await globalBus.requestAsync<boolean>('dialog:confirm-risk', { actionManifest })
          } catch (e) {
            debugLog(`[macroExecutor] 高风险确认链异常，按拒绝处理: ${e}`)
          }
          if (!approved) {
            throw new Error('用户拒绝高风险操作')
          }
        }
      }
    }

    let result = await callToolDirectWithTier(step.tool, resolvedArgs, tier, undefined, macroSignal, stepResults, userInput, traceId)

    // P1-42：宏副作用/工具调用审计埋点（经 bus 桥落 memoryStore.addAuditLog）
    if (SIDE_EFFECT_TOOLS.has(step.tool) || isMcpToolName(step.tool)) {
      try {
        const isMcp = isMcpToolName(step.tool)
        // #2 收尾：traceId 参数化传播（原模块级全局并发下串号）
        globalBus.emit('memory:add-audit-log', {
          userId: 'local',
          action: isMcp ? 'mcp_tool_call' : 'macro_step_exec',
          toolId: step.tool,
          fileName: step.tool === 'file_write' ? String(resolvedArgs.path || resolvedArgs.file_path || '') : undefined,
          mcpId: isMcp ? step.tool.split('___')[0] : undefined,
          details: `S${step.step} ${step.tool} args=${JSON.stringify(resolvedArgs).substring(0, 200)}${traceId ? ` [traceId=${traceId.substring(0, 8)}]` : ''}`
        })
      } catch { /* non-critical */ }
    }

    if (step.tool === 'shell_exec') {
      const cmd = String(resolvedArgs.command || '')
      const fileMatch = cmd.match(/writeFileSync\(\s*['"]([^'"]+)['"]/)
      if (fileMatch) {
        onSideEffect?.(step.step, step.tool, 'create', fileMatch[1])
      }
    }
    // P1-D2：原生写文件工具纳入副作用记录（供产物核验闸门比对用户要求）
    if (step.tool === 'file_write' || step.tool === 'create_docx') {
      const writePath = String(resolvedArgs.filePath || resolvedArgs.path || '')
      if (writePath) onSideEffect?.(step.step, step.tool, 'create', writePath)
    }
    if (step.tool === 'read_file') {
      const path = String(resolvedArgs.path || resolvedArgs.file_path || '')
      if (path) onSideEffect?.(step.step, step.tool, 'read', path)
    }

    if (step.tool === 'llm_generate' && groundTruthEntities.length > 0) {
      const outputEntities = extractEntities(result.substring(0, 5000))
      const factResult = runFactGuardV2(groundTruthEntities, outputEntities, result)
      debugLog(`[FactGuardV2] step${step.step}: ${factResult.summary}`)

      const semiAssistResults = factResult.allConstraintResults.filter(
        r => r.triggered && r.automationLevel === 'semi'
      )
      for (const cr of semiAssistResults) {
        debugLog(`[FactGuardV2] step${step.step}: [${cr.automationLevel}] ${cr.message}${cr.humanJudgmentPrompt ? ' → ' + cr.humanJudgmentPrompt : ''}`)
      }

      if (factResult.severity === 'critical') {
        const errDetail = factResult.conflicts.filter(c => c.severity === 'critical').map(c => c.diff).join('；')
        const constraintErrors = factResult.allConstraintResults.filter(r => r.triggered && r.severity === 'error' && (!r.automationLevel || r.automationLevel === 'full')).map(r => r.message).join('；')
        const fullError = [errDetail, constraintErrors].filter(Boolean).join('；')
        probeStep(manifest.identity.id, step.step, step.tool, 'error', `FactGuard严重冲突: ${fullError}`, resolvedArgs, result, Date.now() - stepStartTime, undefined, traceId)
        throw new Error(`FactGuard: ${fullError}`)
      }
      if (factResult.severity === 'minor' && factResult.correctedOutput) {
        result = factResult.correctedOutput
        debugLog(`[FactGuardV2] step${step.step}: 微小差异已自动修正`)
      }
      if (factResult.hallucinatedEntities.length > 0) {
        const halluList = factResult.hallucinatedEntities.map(e => `${e.type}:${e.raw}`).join(', ')
        debugLog(`[FactGuardV2] step${step.step}: 疑似幻觉实体: ${halluList}`)
      }
    }

    onStepDone?.(step.step, result)
    const dur = Date.now() - stepStartTime
    const tierConfig = tier ? getTierConfig(tier) : null
    probeStep(manifest.identity.id, step.step, step.tool, sourceForTool(step.tool), `${step.tool} @ tier=${tier || 'default'}`, resolvedArgs, result, dur, {
      modelTier: tier,
      modelParams: tierConfig ? { temperature: tierConfig.temperature, maxTokens: tierConfig.maxTokens } : undefined
    }, traceId)
    return { done: true, result, fromCache: false }
  } catch (err) {
    if (macroSignal?.aborted) {
      onStepFailed?.(step.step, '宏执行已取消')
      return { done: false }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? err.stack : undefined
    probeStep(manifest.identity.id, step.step, step.tool, 'error', errMsg, resolvedArgs, '', Date.now() - stepStartTime, { errorStack: errStack }, traceId)

    try {
      const { classifyError } = await import('./errorClassifier')
      const classification = await classifyError(errMsg, step.tool, step.description || '')
      try { globalBus.emit('debug:log-event', { level: 'warn', tag: 'schedule', message: `[错误分类] S${step.step} ${step.tool}: ${classification.category} → ${classification.action}${classification.fixHint ? ' | ' + classification.fixHint : ''}` }) } catch { /* ignore */ }

      if (classification.action === 'abort') {
        onStepFailed?.(step.step, `${errMsg} [${classification.category}] ${classification.fixHint || ''}`)
        return { done: false }
      }

      if (classification.action === 'retry_with_fix' && classification.fixHint) {
        const fixedArgs = { ...resolvedArgs }
        if (step.tool === 'shell_exec' && classification.category === 'resource_missing') {
          const installMatch = errMsg.match(/cannot find module ['"]([^'"]+)['"]/i)
          if (installMatch) {
            const mod = installMatch[1]
            if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(mod)) {
              try { globalBus.emit('debug:log-event', { level: 'warn', tag: 'shell', message: `[安全拒绝] npm包名不合法: ${mod}` }) } catch { /* ignore */ }
            } else {
              try {
                // P1-23：错误文本不可信——自动装包前必须经用户确认，恶意输出可诱导安装任意包
                let installApproved = false
                try {
                  installApproved = await globalBus.requestAsync<boolean>('dialog:confirm-risk', {
                    actionManifest: {
                      skill_id: manifest.identity.id,
                      target_file: `npm:${mod}`,
                      operation: '自动安装缺失npm模块（包名提取自不可信错误信息）',
                      expected_output: `npm install ${mod}`,
                      intent: (userInput.inputText || '').substring(0, 200),
                      isHighRisk: true
                    }
                  })
                } catch { installApproved = false }
                if (!installApproved) {
                  try { globalBus.emit('debug:log-event', { level: 'warn', tag: 'shell', message: `[安全拦截] 用户未确认，跳过自动安装: ${mod}` }) } catch { /* ignore */ }
                } else {
                  const installResult = await window.electronAPI?.shellExec({
                    command: `npm install ${mod}`,
                    timeout: 30000
                  })
                  if (installResult?.success) {
                    try { globalBus.emit('debug:log-event', { level: 'info', tag: 'shell', message: `[自动修复] 已安装缺失模块: ${mod}` }) } catch { /* ignore */ }
                    const retryResult = await callToolDirectWithTier(step.tool, fixedArgs, tier, undefined, macroSignal, stepResults, userInput, traceId)
                    onStepDone?.(step.step, retryResult)
                    return { done: true, result: retryResult, fromCache: false }
                  }
                }
              } catch { /* install failed, fall through */ }
            }
          }
        }
      }

      if (classification.action === 'retry' && !step.fallback) {
        try {
          const retryResult = await callToolDirectWithTier(step.tool, resolvedArgs, tier, undefined, macroSignal, stepResults, userInput, traceId)
          onStepDone?.(step.step, retryResult)
          return { done: true, result: retryResult, fromCache: false }
        } catch (retryErr) {
          onStepFailed?.(step.step, `重试失败: ${String(retryErr).substring(0, 100)} | 原始错误: ${errMsg}`)
          return { done: false }
        }
      }
    } catch { /* classification failed, fall through */ }

    if (step.fallback) {
      try {
        const fbTier = step.modelTier || 'mini'
        const fbResult = await callToolDirectWithTier(step.fallback, resolvedArgs, fbTier, undefined, macroSignal, stepResults, userInput, traceId)
        onStepDone?.(step.step, fbResult)
        return { done: true, result: fbResult, fromCache: false, usedFallback: true }
      } catch (fbErr) {
        onStepFailed?.(step.step, `fallback失败: ${String(fbErr).substring(0, 100)} | 原始错误: ${errMsg}`)
        return { done: false }
      }
    }
    onStepFailed?.(step.step, errMsg)
    return { done: false }
  }
}

export interface StepLineage {
  step: number
  source: 'llm_pro' | 'llm_standard' | 'llm_mini' | 'llm_nano' | 'rule_engine' | 'cache_reuse' | 'auto_compiled' | 'skipped' | 'tool_call' | 'fallback' | 'replay_reuse'
  tool: string
  tier?: string
  ruleId?: string
  durationMs?: number
}

export type MacroLineage = StepLineage[]

/**
 * 空产出（含 `(LLM无输出)`）不得**进入**执行指纹缓存，也不得从中**流出**（复用）。
 *
 * 实测（2026-09-23）：验收考试 Q12/Q15 连续三轮 token 数**逐字相同**（2210 / 2140）
 * 且回复均为 `(LLM无输出)` —— 一次失败一旦写进指纹缓存，后续每次重跑都直接复用该空产出
 * （`autoCompiled && cached` 早退分支在 `computeStepPlan` 之前就取用 `cached.results`，
 * 所以只改 `computeStepPlan` 不生效——这正是 HANDOFF 警告的"改错分支不报错也不生效"）。
 *
 * 就地实现而非从 `scheduleOptimizer` 导入：本模块在 `funnelMainPath.spec` 中被部分 mock，
 * 新增跨模块导出会让测试里该导出为 undefined（见 HANDOFF 记录的 8 条失败），故不新增导入。
 */
function isReusableCachedResult(value: unknown): boolean {
  if (typeof value !== 'string') return value !== null && value !== undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return !trimmed.includes('(LLM无输出)')
}

function tierToLineage(tier?: string): StepLineage['source'] {
  switch (tier) {
    case 'pro': return 'llm_pro'
    case 'standard': return 'llm_standard'
    case 'mini': return 'llm_mini'
    case 'nano': return 'llm_nano'
    default: return 'llm_standard'
  }
}

function sourceLabel(source: StepLineage['source']): string {
  switch (source) {
    case 'llm_pro': return '🤖 LLM Pro'
    case 'llm_standard': return '🤖 LLM Standard'
    case 'llm_mini': return '🤖 LLM Mini'
    case 'llm_nano': return '🤖 LLM Nano'
    case 'rule_engine': return '📏 规则引擎'
    case 'cache_reuse': return '♻️ 缓存复用'
    case 'auto_compiled': return '⚡ 编译态缓存'
    case 'skipped': return '⏭️ 跳过'
    case 'tool_call': return '🔧 工具调用'
    case 'fallback': return '🔄 降级执行'
    case 'replay_reuse': return '🔁 重放复用'
    default: return '❓ 未知'
  }
}

export function formatLineage(lineage: MacroLineage): string {
  return lineage.map(l => `步骤${l.step}: ${sourceLabel(l.source)} (${l.tool}${l.ruleId ? ' 规则=' + l.ruleId : ''}${l.tier ? ' 层级=' + l.tier : ''})`).join('\n')
}

export function computeLineageSavings(lineage: MacroLineage): { tokensSaved: number; llmSteps: number; zeroTokenSteps: number } {
  let tokensSaved = 0
  let llmSteps = 0
  let zeroTokenSteps = 0
  for (const l of lineage) {
    if (l.source.startsWith('llm_')) {
      llmSteps++
    } else {
      zeroTokenSteps++
      tokensSaved += l.tool === 'llm_generate' ? 2000 : 500
    }
  }
  return { tokensSaved, llmSteps, zeroTokenSteps }
}

function buildStepLineage(step: L2DagStep, execResult: { fromRule?: boolean; ruleMatchedId?: string; usedFallback?: boolean }): StepLineage {
  if (execResult.fromRule) {
    return { step: step.step, source: 'rule_engine', tool: step.tool, ruleId: execResult.ruleMatchedId }
  }
  if (execResult.usedFallback) {
    return { step: step.step, source: 'fallback', tool: step.fallback || step.tool, tier: step.modelTier }
  }
  if (step.tool === 'llm_generate') {
    return { step: step.step, source: tierToLineage(step.modelTier), tool: step.tool, tier: step.modelTier }
  }
  return { step: step.step, source: 'tool_call', tool: step.tool }
}

export async function executeMacro(
  manifest: L2ToolManifest,
  userInput: { filePath?: string; inputText?: string; context?: string },
  onStepStart?: (stepNum: number, tool: string) => void,
  onStepDone?: (stepNum: number, result: string) => void,
  onStepFailed?: (stepNum: number, error: string) => void,
  onStepReuse?: (stepNum: number) => void,
  onStepSkip?: (stepNum: number) => void,
  onPlanPreview?: (preview: string) => void,
  replayPriorResults?: Record<number, string>,
  traceId?: string
): Promise<{ results: Record<number, string>; lastResult: string; savedTokens: number; lineage: MacroLineage; sideEffects: import('@/models').SideEffectRecord[] }> {
  const { execution } = manifest
  let savedTokens = 0
  const macroController = new AbortController()
  globalBus.emit('debug:register-abort', macroController)
  const macroSignal = macroController.signal
  // D-08：提前退出路径的统一注销点——direct 返回/dagPlan 缺失/数据流预检失败/
  // 并行 ask_user 中断都必须注销，避免控制器在注册表中泄漏成僵尸
  const unregisterAbort = () => { globalBus.emit('debug:clear-abort', macroController) }
  const lineage: MacroLineage = []

  if (execution.mode === 'direct' && execution.directCall) {
    const compiled = getCompiledPrompt(execution.directCall.promptTemplate)
    const variables: Record<string, string> = {
      input: userInput.inputText || '',
      user_file: userInput.filePath || '',
      context: userInput.context || ''
    }
    for (const slot of execution.paramMapping.slots) {
      let value = ''
      if (slot.source === 'file_path') value = userInput.filePath || ''
      else if (slot.source === 'input_text') value = userInput.inputText || ''
      else if (slot.source === 'context') value = userInput.context || ''
      variables[slot.name.replace(/[{}]/g, '')] = value
    }
    const prompt = fillCompiledPrompt(compiled, variables)
    // P0-10：同上——死频道 llm:chat-completion 改走 api:chat-completion
    const resp = await globalBus.requestAsync<{ content: string }>('api:chat-completion', {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      maxTokens: execution.directCall.maxTokens,
      signal: macroController.signal,
      routingOptions: { taskType: 'raap', callerId: 'macro_directCall', ...(traceId ? { traceId } : {}) }
    })
    // D-08：direct 模式提前返回前注销控制器
    unregisterAbort()
    return { results: { 1: resp.content || '' }, lastResult: resp.content || '', savedTokens: 0, lineage: [{ step: 1, source: 'llm_standard', tool: 'llm_generate' }], sideEffects: [] }
  }

  if (!execution.dagPlan) {
    // D-08：提前 throw 前注销控制器
    unregisterAbort()
    throw new Error('macro/chain mode requires dagPlan')
  }

  const steps = execution.dagPlan.steps
  const inputFingerprint = computeInputFingerprint(userInput)

  const dataflowReport = simulateDataFlow(steps)
  if (!dataflowReport.ok) {
    debugLog(`[MacroExecutor] 数据流预检失败: ${dataflowReport.summary}`)
    const issueList = dataflowReport.issues.filter(i => i.severity === 'error').map(i => i.description).join('；')
    // D-08：提前 throw 前注销控制器
    unregisterAbort()
    throw new Error(`DAG数据流预检失败：${issueList}`)
  }
  if (dataflowReport.issues.length > 0) {
    const warnList = dataflowReport.issues.map(i => i.description).join('；')
    debugLog(`[MacroExecutor] 数据流警告: ${warnList}`)
  }

  // P1-43：工作流时间线生命周期——createLog → updateNodeStatus(随步回调) → completeLog
  // nodeId 用 `S{step}:{tool}` 前缀防同名工具 first-match 冲突
  let wfLogId: string | null = null
  const wfNodeId = (stepNum: number, tool: string) => `S${stepNum}:${tool}`
  const wfUpdate = (stepNum: number, tool: string, status: 'pending' | 'running' | 'completed' | 'failed') => {
    if (!wfLogId) return
    try {
      useWorkflowLogStore().updateNodeStatus(
        wfLogId,
        wfNodeId(stepNum, tool),
        status,
        status === 'running' ? Date.now() : undefined,
        (status === 'completed' || status === 'failed') ? Date.now() : undefined
      )
    } catch { /* 非关键：无 pinia 环境(测试)时跳过 */ }
  }
  const wfComplete = (status: 'completed' | 'failed') => {
    if (!wfLogId) return
    try {
      useWorkflowLogStore().completeLog(wfLogId, status)
    } catch { /* ignore */ }
  }
  try {
    const wfStore = useWorkflowLogStore()
    const wfNodes = steps.map(s => wfNodeId(s.step, s.tool))
    const wfEdges: [string, string, 'data' | 'control'][] = []
    for (const s of steps) {
      for (const dep of s.depends_on || []) {
        const depStep = steps.find(x => x.step === dep)
        wfEdges.push([depStep ? wfNodeId(depStep.step, depStep.tool) : `S${dep}:unknown`, wfNodeId(s.step, s.tool), 'data'])
      }
    }
    wfLogId = wfStore.createLog(manifest.identity.id, wfNodes, wfEdges).id
  } catch { /* 非关键：时间线不可用时静默降级 */ }
  const stepToolOf = (stepNum: number) => steps.find(s => s.step === stepNum)?.tool || ''
  const stepStartCb = (stepNum: number, tool: string) => { wfUpdate(stepNum, tool, 'running'); onStepStart?.(stepNum, tool) }
  const stepDoneCb = (stepNum: number, result: string) => { wfUpdate(stepNum, stepToolOf(stepNum), 'completed'); onStepDone?.(stepNum, result) }
  const stepFailedCb = (stepNum: number, error: string) => { wfUpdate(stepNum, stepToolOf(stepNum), 'failed'); onStepFailed?.(stepNum, error) }

  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const sideEffects: import('@/models').SideEffectRecord[] = []
  let queryFingerprint = ''

  try {
    const { computeQueryFingerprint } = await import('@/stores/feedbackStore')
    queryFingerprint = computeQueryFingerprint(userInput.inputText || '')
  } catch { /* ignore */ }
  const cached = findCachedExecution(manifest.identity.id, inputFingerprint)
  const autoCompiled = isManifestAutoCompiled(manifest.identity.id)

  try {
    globalBus.emit('debug:log-event', { level: 'info', tag: 'schedule', message: `[macroExec] 开始执行 ${manifest.identity.id} | 输入指纹=${inputFingerprint.substring(0, 16)} | 缓存=${!!cached} | 自编译=${autoCompiled}` })
  } catch { /* ignore */ }

  const sideEffectCb = (stepNum: number, tool: string, operation: 'create' | 'modify' | 'read', filePath: string) => {
    sideEffects.push({ stepNum, tool, operation, filePath, originalExisted: operation !== 'create', timestamp: Date.now() })
    try {
      globalBus.emit('debug:log-event', { level: 'info', tag: 'shell', message: `[副作用] S${stepNum} ${tool} ${operation} → ${filePath}` })
    } catch { /* ignore */ }
  }

  if (autoCompiled && cached) {
    const finalResults: Record<number, string> = {}
    // D-05：跟踪失败步骤——原逻辑吞掉 done:false，下游带着缺失变量继续执行，
    // 残缺结果最后还被写成成功指纹，同输入再跑直接返回错误缓存
    let hasFailedStep = false
    for (const step of steps) {
      if (step.tool === 'llm_generate') {
        let ruleMatched = false
        const ruleTarget = manifest.ruleBasedFallback?.targetStep
        const ruleAppliesToStep = ruleTarget == null || ruleTarget === step.step
        if (manifest.ruleBasedFallback?.enabled && ruleAppliesToStep) {
          const ruleCtx = buildRuleContext(userInput, { ...cached.results, ...finalResults })
          const ruleResult = runRuleEngine(manifest.ruleBasedFallback, ruleCtx)
          if (ruleResult.matched) {
            finalResults[step.step] = ruleResult.output
            stepDoneCb(step.step, ruleResult.output)
            savedTokens += 2000
            lineage.push({ step: step.step, source: 'rule_engine', tool: step.tool, ruleId: ruleResult.matchedRuleId })
            ruleMatched = true
          }
        }
        if (!ruleMatched) {
          if (isReusableCachedResult(cached.results[step.step])) {
            finalResults[step.step] = cached.results[step.step]
            wfUpdate(step.step, step.tool, 'completed')
            onStepReuse?.(step.step)
            savedTokens += 2000
            lineage.push({ step: step.step, source: 'auto_compiled', tool: step.tool })
          } else {
            const { done, result } = await executeStep(step, manifest, userInput, finalResults, stepStartCb, stepDoneCb, stepFailedCb, macroController.signal, sideEffectCb, traceId)
            if (done && result) {
              finalResults[step.step] = result
            } else {
              hasFailedStep = true
            }
            lineage.push({ step: step.step, source: tierToLineage(step.modelTier), tool: step.tool, tier: step.modelTier })
          }
        }
      } else {
        // P1-15：统一副作用工具集（原漏 create_docx → docx 结果被编译缓存复用但文件未重建）
        const hasSideEffect = SIDE_EFFECT_TOOLS.has(step.tool)
        if (!hasSideEffect && isReusableCachedResult(cached.results[step.step])) {
          finalResults[step.step] = cached.results[step.step]
          wfUpdate(step.step, step.tool, 'completed')
          onStepReuse?.(step.step)
          lineage.push({ step: step.step, source: 'cache_reuse', tool: step.tool })
        } else {
          const { done, result } = await executeStep(step, manifest, userInput, finalResults, stepStartCb, stepDoneCb, stepFailedCb, macroController.signal, sideEffectCb, traceId)
          if (done && result) {
            finalResults[step.step] = result
          } else {
            hasFailedStep = true
          }
          lineage.push({ step: step.step, source: 'tool_call', tool: step.tool })
        }
      }
      // D-05：失败即停止——下游步骤依赖失败步骤的输出，继续跑只会产生垃圾结果
      if (hasFailedStep) break
    }
    const sideEffectStepNums = new Set(steps.filter(s => SIDE_EFFECT_TOOLS.has(s.tool)).map(s => s.step))
    // P1-14 修复：autoCompiled 路径原传 stepHashes={}，导致下次执行 findDirtySteps
    // 全部误判为脏（或全不脏），指纹脏检查完全失效；改存真实输出哈希。
    // D-05：存在失败步骤时不写指纹，防止残缺结果被缓存为"成功"后同输入直接返回
    if (!hasFailedStep) {
      const autoStepHashes: Record<number, string> = {}
      for (const [num, result] of Object.entries(finalResults)) {
        autoStepHashes[Number(num)] = computeStepOutputHash(result)
      }
      saveExecutionFingerprint(manifest.identity.id, inputFingerprint, autoStepHashes, finalResults, true, sideEffectStepNums)
    }
    if (sideEffects.length > 0) {
      try {
        globalBus.emit('feedback:add-side-effect', { executionId, manifestId: manifest.identity.id, userInput: userInput.inputText || '', queryFingerprint, sideEffects, timestamp: Date.now() })
      } catch { /* ignore */ }
    }
    const lastStep = steps[steps.length - 1]
    wfComplete(hasFailedStep ? 'failed' : 'completed')
    let autoLastResult = hasFailedStep ? '执行失败(编译缓存路径)' : (finalResults[lastStep.step] || '执行完成(编译缓存)')
    // P1-D3：产物核验闸门——成功路径收口时核对"用户要求的命名产物"是否真实产生，
    // 失败即前置核验事实 + 清指纹（防假成功重放）；任何异常 fail-open
    if (!hasFailedStep) {
      try {
        const { applyDeliverableGate } = await import('./deliverableCheck')
        const createdArtifacts = sideEffects.filter(s => s.operation === 'create').map(s => s.filePath)
        autoLastResult = await applyDeliverableGate(userInput.inputText || '', createdArtifacts, autoLastResult, manifest.identity.id, inputFingerprint)
      } catch { /* fail-open */ }
    }
    return { results: finalResults, lastResult: autoLastResult, savedTokens, lineage, sideEffects }
  }

  // P1-14 修复：原传 {}，replay 场景下脏步判定恒空集；改传 replayPriorResults 真实变量表
  const dirtySteps = cached ? findDirtySteps(manifest, cached, replayPriorResults || {}) : new Set<number>()
  const skipSteps = new Set<number>()
  const stepPlan = computeStepPlan(steps, dirtySteps, skipSteps, cached?.results || null)
  const parallelGroups = computeParallelGroups(steps, skipSteps)

  const preview = formatStepPlanVisualization(steps, stepPlan, parallelGroups)
  onPlanPreview?.(preview)

  const stepDone = new Map<number, boolean>()
  const stepFailed = new Map<number, boolean>()
  const results: Record<number, string> = {}
  const conditions = execution.conditions || []

  if (replayPriorResults && Object.keys(replayPriorResults).length > 0) {
    for (const [stepNum, resultStr] of Object.entries(replayPriorResults)) {
      const num = Number(stepNum)
      results[num] = resultStr
      stepDone.set(num, true)
      lineage.push({ step: num, source: 'replay_reuse', tool: steps.find(s => s.step === num)?.tool || 'unknown' })
    }
    savedTokens += Object.keys(replayPriorResults).length * 500
  }

  for (const reuseStep of stepPlan.willReuse) {
    // P1-15：统一不可复用缓存工具集（含 create_docx）
    if (NO_CACHE_REUSE_TOOLS.has(reuseStep.tool)) continue
    if (isReusableCachedResult(cached?.results[reuseStep.step])) {
      results[reuseStep.step] = cached.results[reuseStep.step]
      stepDone.set(reuseStep.step, true)
      wfUpdate(reuseStep.step, reuseStep.tool, 'completed')
      onStepReuse?.(reuseStep.step)
      savedTokens += reuseStep.tool === 'llm_generate' ? 2000 : 500
      lineage.push({ step: reuseStep.step, source: 'cache_reuse', tool: reuseStep.tool })
      probeStep(manifest.identity.id, reuseStep.step, reuseStep.tool, 'cache', `缓存复用(fingerprint=${inputFingerprint.substring(0, 16)})`, {}, cached.results[reuseStep.step], 0, { cacheFingerprint: inputFingerprint }, traceId)
    }
  }

  for (const skipStep of stepPlan.willSkip) {
    skipSteps.add(skipStep.step)
    onStepSkip?.(skipStep.step)
    lineage.push({ step: skipStep.step, source: 'skipped', tool: skipStep.tool })
    probeStep(manifest.identity.id, skipStep.step, skipStep.tool, 'skip', '条件短路跳过', {}, '', 0, undefined, traceId)
  }

  const activeSteps = stepPlan.willExecute
  const maxIterations = activeSteps.length * 2
  let iteration = 0

  const cpId = createCheckpointId(manifest.identity.id, userInput)
  const existingCp = await getCheckpoint(cpId)
  if (existingCp && !replayPriorResults) {
    for (const [sn, rv] of Object.entries(existingCp.completedResults)) {
      const num = Number(sn)
      if (!stepDone.has(num)) {
        results[num] = rv
        stepDone.set(num, true)
        wfUpdate(num, steps.find(s => s.step === num)?.tool || '', 'completed')
        lineage.push({ step: num, source: 'replay_reuse', tool: steps.find(s => s.step === num)?.tool || 'unknown' })
      }
    }
    // D-04：不恢复 failedSteps——原逻辑把失败步骤重载进 stepFailed 后永不重试，
    // 下游依赖永不就绪 → allDone=false → checkpoint 永不删除，该输入组合永久卡死。
    // 改为重跑时对失败步骤重新执行（completedResults 仍按 checkpoint 复用）
    for (const ss of existingCp.skipSteps) {
      skipSteps.add(ss)
    }
    savedTokens += Object.keys(existingCp.completedResults).length * 500
  }
  const cp: DagCheckpoint = {
    id: cpId,
    manifestId: manifest.identity.id,
    userInput,
    completedResults: { ...results },
    failedSteps: Array.from(stepFailed.keys()),
    skipSteps: Array.from(skipSteps),
    totalSteps: steps.length,
    createdAt: existingCp?.createdAt || Date.now(),
    updatedAt: Date.now(),
    resumed: !!existingCp
  }

  while (iteration < maxIterations) {
    iteration++
    if (macroController.signal.aborted) break

    const readySteps = activeSteps.filter(s => {
      if (stepDone.has(s.step) || stepFailed.has(s.step) || skipSteps.has(s.step)) return false
      return (s.depends_on || []).every(d => stepDone.has(d))
    })

    if (readySteps.length === 0) break

    if (readySteps.length === 1) {
      const step = readySteps[0]

      try {
        const pausedState = globalBus.request<{ paused: boolean; pausedStep: number | null; awaitingTakeover: boolean; takeoverStepNum: number | null }>('dialog:get-paused-state', {})
        if (pausedState.paused && pausedState.pausedStep === step.step) {
          globalBus.emit('dialog:add-notice', { message: `⏸️ 步骤${step.step}(${step.tool})已暂停，等待操作...` })
          const pollPaused = () => new Promise<boolean>(resolve => {
            const check = () => {
              const s = globalBus.request<{ paused: boolean }>('dialog:get-paused-state', {})
              if (!s.paused || macroController.signal.aborted) resolve(false)
              else setTimeout(check, 500)
            }
            check()
          })
          await pollPaused()
          const finalState = globalBus.request<{ awaitingTakeover: boolean; takeoverStepNum: number | null }>('dialog:get-paused-state', {})
          if (finalState.awaitingTakeover && finalState.takeoverStepNum === step.step) {
            const takeoverResult = await globalBus.requestAsync<string | null>('dialog:request-takeover', { stepNum: step.step })
            if (takeoverResult) {
              stepDone.set(step.step, true)
              results[step.step] = takeoverResult
              wfUpdate(step.step, step.tool, 'completed')
              lineage.push({ step: step.step, source: 'tool_call' as const, tool: step.tool })
              continue
            }
          }
        }
      } catch { /* ignore */ }

      const execResult = await executeStep(step, manifest, userInput, results, stepStartCb, stepDoneCb, stepFailedCb, macroController.signal, sideEffectCb, traceId)
      if (execResult.done && execResult.result) {
        stepDone.set(step.step, true)
        results[step.step] = execResult.result
        lineage.push(buildStepLineage(step, execResult))
        for (const cond of conditions) {
          if (cond.fromStep === step.step && !evaluateCondition(cond.expr, results)) {
            skipSteps.add(cond.toStep)
          }
        }
      } else {
        stepFailed.set(step.step, true)
        if (execution.dagPlan.fallbackStrategy === 'ask_user') break
      }
    } else {
      const execResults = await Promise.all(
        readySteps.map(async (step) => {
      const execResult = await executeStep(step, manifest, userInput, results, stepStartCb, stepDoneCb, stepFailedCb, macroController.signal, sideEffectCb, traceId)
          return { step, execResult }
        })
      )
      for (const { step, execResult } of execResults) {
        if (execResult.done && execResult.result) {
          stepDone.set(step.step, true)
          results[step.step] = execResult.result
          lineage.push(buildStepLineage(step, execResult))
          for (const cond of conditions) {
            if (cond.fromStep === step.step && !evaluateCondition(cond.expr, results, cond.fromStep)) {
              skipSteps.add(cond.toStep)
            }
          }
        } else {
          stepFailed.set(step.step, true)
          if (execution.dagPlan.fallbackStrategy === 'ask_user') {
            // D-08：并行 ask_user 失败提前返回前注销控制器
            wfComplete('failed')
            unregisterAbort()
            return { results, lastResult: '执行中断', savedTokens, lineage, sideEffects }
          }
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 0))

    cp.completedResults = { ...results }
    cp.failedSteps = Array.from(stepFailed.keys())
    cp.skipSteps = Array.from(skipSteps)
    cp.updatedAt = Date.now()
    saveCheckpoint(cp)
  }

  const allDone = steps.every(s => stepDone.has(s.step) || stepFailed.has(s.step) || skipSteps.has(s.step))
  if (allDone) {
    removeCheckpoint(cpId)
  }

  // 2026-09-23：空产出不得**写入**指纹缓存——否则一次失败会被永久固化并跨执行重放
  // （实测：考试 Q12/Q15 连续三轮 token 逐字相同 2210/2140 且始终无输出）。
  const cacheableResults: Record<number, string> = {}
  for (const [num, result] of Object.entries(results)) {
    if (isReusableCachedResult(result)) cacheableResults[Number(num)] = result
  }
  const stepHashes: Record<number, string> = {}
  for (const [num, result] of Object.entries(cacheableResults)) {
    stepHashes[Number(num)] = computeStepOutputHash(result)
  }
  const sideEffectStepNums = new Set(steps.filter(s => SIDE_EFFECT_TOOLS.has(s.tool)).map(s => s.step))
  saveExecutionFingerprint(manifest.identity.id, inputFingerprint, stepHashes, cacheableResults, !!cached, sideEffectStepNums)

  if (sideEffects.length > 0) {
    try {
      globalBus.emit('feedback:add-side-effect', {
        executionId,
        manifestId: manifest.identity.id,
        userInput: userInput.inputText || '',
        queryFingerprint,
        sideEffects,
        timestamp: Date.now()
      })
    } catch { /* feedback bus not available */ }
  }

  const lastStep = steps.filter(s => !skipSteps.has(s.step))
  const finalStep = lastStep[lastStep.length - 1]
  const lastResult = finalStep ? (results[finalStep.step] || '执行完成') : '执行完成'
  // P1-D3：产物核验闸门——主路径收口时核对"用户要求的命名产物"是否真实产生
  // （存在性/非空），失败即前置核验事实到结果 + 清指纹防假成功重放；fail-open
  let gatedResult = lastResult
  if (stepFailed.size === 0) {
    try {
      const { applyDeliverableGate } = await import('./deliverableCheck')
      const createdArtifacts = sideEffects.filter(s => s.operation === 'create').map(s => s.filePath)
      gatedResult = await applyDeliverableGate(userInput.inputText || '', createdArtifacts, lastResult, manifest.identity.id, inputFingerprint)
    } catch { /* fail-open */ }
  }
  wfComplete(stepFailed.size > 0 ? 'failed' : 'completed')
  // B-09：定向注销本宏的控制器，不再清空全局注册表（避免误杀并发任务）
  unregisterAbort()
  return { results, lastResult: gatedResult, savedTokens, lineage, sideEffects }
}

export function resolveDirectPrompt(
  manifest: L2ToolManifest,
  userInput: { filePath?: string; inputText?: string; context?: string }
): { prompt: string; maxTokens: number } | null {
  if (manifest.execution.mode !== 'direct' || !manifest.execution.directCall) return null
  const compiled = getCompiledPrompt(manifest.execution.directCall.promptTemplate)
  const variables: Record<string, string> = {
    input: userInput.inputText || '',
    user_file: userInput.filePath || '',
    context: userInput.context || ''
  }
  for (const slot of manifest.execution.paramMapping.slots) {
    let value = ''
    if (slot.source === 'file_path') value = userInput.filePath || ''
    else if (slot.source === 'input_text') value = userInput.inputText || ''
    else if (slot.source === 'context') value = userInput.context || ''
    variables[slot.name.replace(/[{}]/g, '')] = value
  }
  const prompt = fillCompiledPrompt(compiled, variables)
  return { prompt, maxTokens: manifest.execution.directCall.maxTokens }
}
