import type { L2ToolManifest } from '@/models'
import { useApiStore } from '@/stores/apiStore'

interface L0SkillRule {
  name: string
  domain: string
  triggerPatterns: RegExp[]
  forbiddenPatterns?: RegExp[]
  buildPlan: (input: string) => Promise<L0DirectPlan | null>
}

interface L0DirectPlan {
  intent: string
  steps: { step: number; description: string; tool: string; params: Record<string, string>; expectedOutput: string }[]
  isExploration: boolean
}

interface L05QuickMatchResult {
  manifest: L2ToolManifest
  confidence: number
  matchedKeywords: string[]
}

interface L1CapabilityCheck {
  canHandle: boolean
  nodeId: string
  nodeName: string
  confidence: number
  plan: L0DirectPlan | null
}

const FILE_EXT_MAP: Record<string, string> = {
  md: 'docx',
  txt: 'docx',
  html: 'pdf',
  csv: 'xlsx'
}

function extractFilePath(input: string): string | null {
  const m = input.match(/["']?([A-Za-z]:\\[^\s"']+\.\w{1,5})["']?/i)
  if (m) return m[1]
  const m2 = input.match(/["']?(~?\/[^\s"']+\.\w{1,5})["']?/)
  return m2 ? m2[1] : null
}

function extractTargetFormat(input: string): string | null {
  const m = input.match(/(?:转|到|为|成|输出|导出|保存|转换)\s*[.】]?\s*(docx|pdf|txt|md|xlsx|html|json|csv)/i)
  return m ? m[1].toLowerCase() : null
}

function extractSourceExt(input: string): string | null {
  const m = input.match(/\.(\w{1,5})\b/)
  return m ? m[1].toLowerCase() : null
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '')
    .replace(/^[的了地得]+|[的了地得]+$/g, '')
    .substring(0, 30)
}

function stripDirectiveWords(input: string): string {
  let cleaned = input
  cleaned = cleaned.replace(/^(给我|帮我|请|能不能|可以|想要|需要|麻烦|让|叫我来|来帮我|来给我|来请|麻烦你|请帮我|请给我|能不能帮我|能不能给我)/gi, '')
  cleaned = cleaned.replace(/(创建|新建|写|生成|保存|制作|建立|做一个|写一个|生成一个|新建一个|创建一个|写份|写个|创建份|建个)/gi, '')
  cleaned = cleaned.replace(/(一个|一份|一张|一篇|一些|一下)/gi, '')
  cleaned = cleaned.replace(/(在桌面|到桌面|在电脑上|在本地|在D盘|在C盘|桌面上|电脑上)/gi, '')
  cleaned = cleaned.replace(/(文档|文件|docx|word|txt|文本|pdf|xlsx|md|\.docx|\.txt|\.pdf|\.xlsx|\.md)/gi, '')
  cleaned = cleaned.replace(/[的了地得]/g, '')
  cleaned = cleaned.trim()
  if (!cleaned || cleaned.length < 2 || /^[，。！？、,.!?\s]+$/.test(cleaned)) {
    return ''
  }
  return cleaned
}

async function refineFileNameWithLLM(rawName: string): Promise<string> {
  const apiStore = useApiStore()
  const prompt = `判断以下文本是否适合作为文件名。如果适合，输出文件名（不含扩展名，2-20字）；如果不包含有效命名信息，只输出DEFAULT。\n只输出文件名或DEFAULT，不要解释。\n\n文本："${rawName}"`

  try {
    const resp = await apiStore.chatCompletion(
      [{ role: 'user', content: prompt }],
      false,
      undefined,
      32,
      undefined
    )
    const result = (resp.content || '').trim()
    if (result && result !== 'DEFAULT' && result.length >= 2 && result.length <= 30 && !/^\s*$/.test(result)) {
      return sanitizeFileName(result.replace(/["「」『』""'']/g, '').replace(/\.\w{1,5}$/, ''))
    }
    console.log(`[L0 FileName] LLM返回DEFAULT或无效: "${result}"，使用默认名`)
  } catch (e) {
    console.warn('[L0 FileName] LLM兜底失败:', e instanceof Error ? e.message : String(e))
  }
  return ''
}

async function extractFileName(input: string, ext: string): Promise<string> {
  const nameMatch = input.match(/(?:名为|叫|命名|名字是|叫作)\s*["「『""']?([^"」』""'\s]{1,30})/i)
  if (nameMatch) {
    const name = sanitizeFileName(nameMatch[1])
    if (name.length >= 2) return name
  }

  const aboutMatch = input.match(/关于(.{1,20}?)(?:的|之)?(?:文档|文件|报告|方案|计划|总结|纪要|分析)/i)
  if (aboutMatch) {
    const name = sanitizeFileName(aboutMatch[1])
    if (name.length >= 2) return name
  }

  const fileSpecMatch = input.match(/([^\s\\/]{1,40})\.(docx|txt|md|pdf|xlsx)/i)
  if (fileSpecMatch) {
    const name = sanitizeFileName(fileSpecMatch[1])
    if (name.length >= 2) return name
  }

  const cleaned = stripDirectiveWords(input)
  if (!cleaned) return '新建文档'

  const llmResult = await refineFileNameWithLLM(cleaned)
  if (llmResult && llmResult.length >= 2) return llmResult

  return sanitizeFileName(cleaned) || '新建文档'
}

function resolveExt(input: string): string {
  const extMatch = input.match(/\.(docx|txt|md|pdf|xlsx)/i)
  const typeMatch = input.match(/(docx|word|txt|文本|md|pdf|xlsx|文档|文件)/i)
  let ext = extMatch ? extMatch[1].toLowerCase() : ''
  if (!ext) {
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase()
      if (t === 'docx' || t === 'word') ext = 'docx'
      else if (t === 'txt' || t === '文本') ext = 'txt'
      else if (t === 'md') ext = 'md'
      else if (t === 'pdf') ext = 'pdf'
      else if (t === 'xlsx') ext = 'xlsx'
      else ext = 'docx'
    } else {
      ext = 'docx'
    }
  }
  return ext
}

const skillRules: L0SkillRule[] = [
  {
    name: '文件格式转换',
    domain: 'file',
    triggerPatterns: [
      /(转|转换|转为|转成|导出|另存|保存为|处理为|输出为).*(docx|pdf|txt|md|xlsx|html)/i,
      /\.(md|txt|html|csv).*(docx|pdf|xlsx)/i,
      /\b(pandoc|convert|export)\b/i
    ],
    forbiddenPatterns: [
      /(审查|合规|条款|风险|法律|合同)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const filePath = extractFilePath(input)
      const targetFormat = extractTargetFormat(input)
      const sourceExt = extractSourceExt(input)
      if (!targetFormat && !sourceExt) return null

      const effectiveTarget = targetFormat || FILE_EXT_MAP[sourceExt || '']
      if (!effectiveTarget) return null

      const src = filePath || `input.${sourceExt || 'md'}`
      const baseName = src.replace(/\.\w{1,5}$/, '')
      const outputPath = `${baseName}.${effectiveTarget}`

      if (effectiveTarget === 'docx') {
        return {
          intent: `将 ${src} 转换为 .docx`,
          steps: [
            { step: 1, description: `安装docx转换工具`, tool: 'shell_exec', params: { command: 'npm list docx || npm install docx' }, expectedOutput: 'docx库就绪' },
            { step: 2, description: `读取源文件内容`, tool: 'read_file', params: { path: src }, expectedOutput: '文件内容' },
            { step: 3, description: `生成docx文件`, tool: 'shell_exec', params: { command: `node -e "const {Document,Packer,Paragraph,TextRun}=require('docx');const fs=require('fs');const content=process.env.CONTENT||'';const outPath=process.env.OUTPUT_PATH||'output.docx';const doc=new Document({sections:[{children:content.split('\\n').map(line=>new Paragraph({children:[new TextRun(line)]}))]}]});Packer.toBuffer(doc).then(buf=>fs.writeFileSync(outPath,buf))"`, env_content: '{{step_2_result}}', env_output_path: outputPath }, expectedOutput: `${outputPath}` }
          ],
          isExploration: true
        }
      }

      return {
        intent: `将 ${src} 转换为 .${effectiveTarget}`,
        steps: [
          { step: 1, description: `读取源文件`, tool: 'read_file', params: { path: src }, expectedOutput: '文件内容' },
          { step: 2, description: `LLM转换输出.${effectiveTarget}`, tool: 'llm_generate', params: { prompt: `将以下内容转换为${effectiveTarget}格式：\n{{step_1_result}}` }, expectedOutput: `${effectiveTarget}格式内容` }
        ],
        isExploration: true
      }
    }
  },
  {
    name: '快速Shell命令',
    domain: 'system',
    triggerPatterns: [
      /^(ls|dir|pwd|whoami|date|hostname|cat|type|echo|mkdir|cp|copy|mv|move|rm|del)\b/i,
      /^运行\s+/,
      /^执行\s+/,
      /^(npm|node|pip|python|git)\s+/
    ],
    forbiddenPatterns: [
      /(格式|转换|文档|分析|审查|报告)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const cmdMatch = input.match(/^(?:运行|执行)?\s*(.*)$/)
      const cmd = (cmdMatch ? cmdMatch[1] : input).trim()
      if (!cmd || cmd.length < 2) return null
      return {
        intent: `执行命令：${cmd.substring(0, 60)}`,
        steps: [
          { step: 1, description: `执行shell命令`, tool: 'shell_exec', params: { command: cmd }, expectedOutput: '命令输出' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '简单文本生成',
    domain: 'creation',
    triggerPatterns: [
      /^(写|生成|帮我写|帮我生成|起草|撰写)\s*(一个|一份|一段|一篇|一封)?\s*.{0,30}?(代码|函数|脚本|邮件|通知|公告|文案|总结)/i
    ],
    forbiddenPatterns: [
      /(周报|会议纪要|合同|财报|竞品|报销)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      return {
        intent: input.substring(0, 60),
        steps: [
          { step: 1, description: 'LLM直接生成', tool: 'llm_generate', params: { prompt: input }, expectedOutput: '生成内容' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: 'HTTP请求',
    domain: 'network',
    triggerPatterns: [
      /^(curl|fetch|get|post|请求|访问|下载)\s+/i,
      /https?:\/\/\S+/
    ],
    forbiddenPatterns: [],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const urlMatch = input.match(/(https?:\/\/\S+)/)
      const url = urlMatch ? urlMatch[1] : ''
      if (!url) return null
      return {
        intent: `HTTP请求：${url.substring(0, 60)}`,
        steps: [
          { step: 1, description: '发送HTTP请求', tool: 'http_request', params: { url, method: 'GET' }, expectedOutput: '响应内容' }
        ],
        isExploration: true
      }
    }
  },
  {
    name: '文件创建',
    domain: 'file',
    triggerPatterns: [
      /(创建|新建|写|生成|保存)(一个|一份)?\s*(docx|word|txt|文本|文档|文件)/i,
      /(创建|新建|写|生成|保存)(一个|一份)?\s*.{0,10}?(文档|文件)\s*(到|在|保存)/i,
      /在(桌面|电脑上|本地)(创建|新建|写|生成|保存).{0,15}?(文档|文件|docx|txt|word)/i,
      /^(创建|新建)(一个|一份)?\s*(docx|word|txt|文档|文件)/i
    ],
    forbiddenPatterns: [
      /(审查|合规|条款|风险|法律|合同|分析|报告|周报|总结|竞品|财报|KPI|预算)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const ext = resolveExt(input)
      const rawName = await extractFileName(input, ext)
      const fileName = `${rawName}.${ext}`
      const filePath = `%USERPROFILE%\\Desktop\\${fileName}`

      if (ext === 'docx') {
        return {
          intent: `创建docx文件：${fileName}`,
          steps: [
            { step: 1, description: `创建docx文件并保存到桌面`, tool: 'create_docx', params: { filePath }, expectedOutput: `桌面docx文件: ${fileName}` }
          ],
          isExploration: false
        }
      }

      return {
        intent: `创建${ext}文件：${fileName}`,
        steps: [
          { step: 1, description: `创建${ext}文件并保存到桌面`, tool: 'file_write', params: { filePath, content: '' }, expectedOutput: `桌面${ext}文件: ${fileName}` }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '创建文件夹',
    domain: 'file',
    triggerPatterns: [
      /(创建|新建|建)(一个)?\s*(文件夹|目录|folder)/i,
      /在(桌面|电脑上|本地)(创建|新建|建).{0,15}?(文件夹|目录)/i,
      /^(创建|新建)(一个)?\s*(空)?\s*(文件夹|目录)/i
    ],
    forbiddenPatterns: [
      /(文档|docx|txt|pdf|xlsx|审查|分析|写|生成|保存)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const nameMatch = input.match(/(?:名为|叫|命名)\s*["「『""']?([^"」』""'\s]{1,30})/i)
        || input.match(/(?:创建|新建|建)(一个)?\s*(空)?\s*(文件夹|目录)?\s*(.{2,20}?)(?:在|到|$)/i)
      let folderName = '新建文件夹'
      if (nameMatch) {
        const candidate = nameMatch[1] || nameMatch[4]
        if (candidate) {
          const cleaned = sanitizeFileName(candidate)
          if (cleaned.length >= 2) folderName = cleaned
        }
      }
      return {
        intent: `创建文件夹：${folderName}`,
        steps: [
          { step: 1, description: `创建文件夹`, tool: 'create_directory', params: { path: `%USERPROFILE%\\Desktop\\${folderName}` }, expectedOutput: `桌面文件夹: ${folderName}` }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '简单查询',
    domain: 'query',
    triggerPatterns: [
      /^(几点|什么时间|今天是|现在几|天气|计算|算一下|等于多少)/i,
      /^(what time|what day|calculate|compute)\b/i,
      /^(今天|现在|当前).{0,5}?(日期|时间|星期)/i
    ],
    forbiddenPatterns: [
      /(分析|报告|审查|对比|文档|文件|转换)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      return {
        intent: input.substring(0, 60),
        steps: [
          { step: 1, description: 'LLM快速回答', tool: 'llm_generate', params: { prompt: input, modelTier: 'nano' }, expectedOutput: '回答结果' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '快速文件操作',
    domain: 'file',
    triggerPatterns: [
      /^(读取|查看|打开|显示|阅读|看看)(一下)?\s*(文件|文档|内容)?\s*.{0,30}$/i,
      /^(cat|type|head|tail|less|more)\s+/i,
      /^(看看|看一下|读一下|查看一下)\s*.{0,30}$/i
    ],
    forbiddenPatterns: [
      /(分析|审查|转换|修改|编辑|风险|合规|生成报告)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const pathMatch = input.match(/["']?([A-Za-z]:\\[^\s"']+\.\w{1,5})["']?/i)
        || input.match(/["']?(~?\/[^\s"']+\.\w{1,5})["']?/)
        || input.match(/["']?([^\s"']+\.(txt|md|json|csv|log|py|js|ts))["']?/i)
      const filePath = pathMatch ? pathMatch[1] : ''
      if (!filePath) return null
      return {
        intent: `读取文件：${filePath}`,
        steps: [
          { step: 1, description: '读取文件内容', tool: 'read_file', params: { path: filePath }, expectedOutput: '文件内容' }
        ],
        isExploration: false
      }
    }
  }
]

export function classifyDomain(input: string): string[] {
  const inputLower = input.toLowerCase()
  const domainRules: Record<string, string[]> = {
    file: ['md', 'docx', 'pdf', 'txt', 'xlsx', '转换', '导出', '保存为', '格式', '文件', '处理为'],
    creation: ['写', '生成', '起草', '撰写', '创建', '新建', '公告', '文案', '代码', '函数'],
    legal: ['合同', '条款', '合规', '审查', '法律风险', '保密', 'nd'],
    finance: ['报销', '预算', 'kpi', '财报', '财务', '发票'],
    sales: ['竞品', '客户', '销售', '方案'],
    hr: ['简历', '入职', '招聘', '面试'],
    system: ['运行', '执行', '命令', 'shell', 'npm', 'node', 'git', 'ls', 'dir']
  }
  const matched: string[] = []
  for (const [domain, keywords] of Object.entries(domainRules)) {
    if (keywords.some(kw => inputLower.includes(kw))) {
      matched.push(domain)
    }
  }
  return matched.length > 0 ? matched : ['general']
}

export async function tryL0Skill(input: string): Promise<L0DirectPlan | null> {
  for (const rule of skillRules) {
    const triggered = rule.triggerPatterns.some(p => p.test(input))
    if (!triggered) continue
    const forbidden = rule.forbiddenPatterns?.some(p => p.test(input)) || false
    if (forbidden) continue
    const plan = await rule.buildPlan(input)
    if (plan) {
      console.log(`[L0 Skill] 命中规则：${rule.name}（${rule.domain}域），跳过RaaP`)
      return plan
    }
  }
  return null
}

export function tryL05QuickMatch(
  input: string,
  manifests: L2ToolManifest[]
): L05QuickMatchResult | null {
  if (!manifests || manifests.length === 0) return null

  const inputLower = input.toLowerCase()
  const scores: { manifest: L2ToolManifest; hitCount: number; hitRatio: number; matchedKws: string[] }[] = []

  for (const m of manifests) {
    const kws = m.routing.keywords
    if (!kws || kws.length === 0) continue

    const matchedKws: string[] = []
    for (const kw of kws) {
      if (inputLower.includes(kw.toLowerCase())) {
        matchedKws.push(kw)
      }
    }

    if (matchedKws.length === 0) continue

    const hitRatio = matchedKws.length / kws.length
    scores.push({ manifest: m, hitCount: matchedKws.length, hitRatio, matchedKws })
  }

  if (scores.length === 0) return null

  scores.sort((a, b) => b.hitRatio - a.hitRatio || b.hitCount - a.hitCount)

  const top = scores[0]
  const second = scores.length > 1 ? scores[1] : null
  const margin = second ? top.hitRatio - second.hitRatio : 1

  const isSingleStep = top.manifest.execution.mode === 'direct'
    || (top.manifest.execution.dagPlan && top.manifest.execution.dagPlan.steps.length === 1)

  if (!isSingleStep) {
    console.log(`[L0.5] 最佳命中${top.manifest.identity.name}，但为多步(${top.manifest.execution.mode})，交给RaaP`)
    return null
  }

  const confidence = top.hitRatio >= 0.4 && margin >= 0.1
    ? Math.min(top.hitRatio * 1.5, 1.0)
    : 0

  if (confidence >= 0.8) {
    console.log(`[L0.5] 快速匹配命中：${top.manifest.identity.name}（关键词${top.matchedKws.join(',')}，置信${(confidence * 100).toFixed(0)}%）`)
    return { manifest: top.manifest, confidence, matchedKeywords: top.matchedKws }
  }

  if (top.hitRatio >= 0.3) {
    console.log(`[L0.5] 候选${top.manifest.identity.name}置信不足(${(confidence * 100).toFixed(0)}%)，交给RaaP`)
  }

  return null
}

export function checkL1Capability(input: string): L1CapabilityCheck {
  const inputLower = input.toLowerCase()

  const l1Rules: { nodeId: string; nodeName: string; keywords: string[]; forbidden: string[] }[] = [
    {
      nodeId: 'l1-model-gateway',
      nodeName: '模型网关',
      keywords: ['翻译', '生成文本', '写一段', '帮我写', '改写', '润色', '总结一下', '概括'],
      forbidden: ['文档', '文件', 'docx', '报告', '审查', '风险', '合同', '竞品', '周报', '会议纪要', 'xlsx', 'ppt']
    },
    {
      nodeId: 'l1-knowledge-feeder',
      nodeName: '知识检索',
      keywords: ['搜索知识', '查知识库', '检索', '知识库', '查一下'],
      forbidden: ['文档', '文件', '创建', '新建', '写文件', '审查']
    }
  ]

  for (const rule of l1Rules) {
    const hasKeyword = rule.keywords.some(kw => inputLower.includes(kw))
    if (!hasKeyword) continue
    const hasForbidden = rule.forbidden.some(fw => inputLower.includes(fw))
    if (hasForbidden) continue

    const matchedKwCount = rule.keywords.filter(kw => inputLower.includes(kw)).length
    const confidence = Math.min(matchedKwCount / rule.keywords.length * 2, 0.9)

    if (confidence >= 0.6) {
      console.log(`[L1 Check] 命中：${rule.nodeName}（置信${(confidence * 100).toFixed(0)}%）`)
      return {
        canHandle: true,
        nodeId: rule.nodeId,
        nodeName: rule.nodeName,
        confidence,
        plan: {
          intent: input.substring(0, 60),
          steps: [
            { step: 1, description: `${rule.nodeName}处理`, tool: 'llm_generate', params: { prompt: input }, expectedOutput: '处理结果' }
          ],
          isExploration: false
        }
      }
    }
  }

  return { canHandle: false, nodeId: '', nodeName: '', confidence: 0, plan: null }
}

export async function buildExplorePlan(input: string): Promise<L0DirectPlan> {
  const filePath = extractFilePath(input)
  const targetFormat = extractTargetFormat(input)
  const sourceExt = extractSourceExt(input)

  if (filePath || targetFormat || sourceExt) {
    const skillPlan = await skillRules[0].buildPlan(input)
    if (skillPlan) {
      console.log(`[Explore] 文件操作探索模式：${skillPlan.intent}`)
      return skillPlan
    }
  }

  console.log(`[Explore] 通用探索模式，L1直调`)
  return {
    intent: input.substring(0, 60),
    steps: [
      { step: 1, description: 'LLM直接处理用户请求', tool: 'llm_generate', params: { prompt: input }, expectedOutput: '处理结果' }
    ],
    isExploration: true
  }
}

export type { L0DirectPlan }
