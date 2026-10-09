import { describe, it, expect } from 'vitest'
import type { L2ToolManifest, L2DagStep } from '@/models'
import l2Manifests from '@/data/l2Manifests'
import {
  detectInputForm,
  extractInlineMaterial,
  extractFilePaths,
  splitAttachment,
  classifyTemplateInput,
  adaptPlanToInlineInput,
  bindFilePathToSteps,
  gateTemplateForInput,
  INLINE_MIN_CHARS
} from '@/services/inputForm'

function makeManifest(over: {
  id?: string
  inputType?: 'file' | 'text' | 'file_or_text'
  mode?: 'direct' | 'macro' | 'chain'
  steps?: L2DagStep[]
} = {}): L2ToolManifest {
  return {
    identity: { id: over.id ?? 'm-1', name: '技能一', version: '1', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' },
    visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' },
    routing: { keywords: ['技能'], targetRoles: [], requiredL1: [], inputType: over.inputType ?? 'text', retrievalSummary: '', userSummary: '', confidenceThreshold: 0.5 },
    execution: {
      mode: over.mode ?? 'macro',
      dagPlan: over.steps ? { steps: over.steps, fallbackStrategy: 'retry', maxRetries: 1 } : undefined,
      paramMapping: { slots: [], bindings: [] }
    },
    cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false }
  }
}

// 会议纪要式计划：read_file + llm_generate（{{step_1_result}}）
const MEETING_STEPS: L2DagStep[] = [
  { step: 1, description: '读取会议记录文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '会议原始记录' },
  { step: 2, description: 'AI生成会议纪要', tool: 'llm_generate', depends_on: [1], params: { prompt: '根据以下会议记录生成纪要：\n{{step_1_result}}' }, expectedOutput: '会议纪要' }
]

// 周报式计划：list_directory + read_file(依赖1) + llm_generate(依赖2)
const WEEKLY_STEPS: L2DagStep[] = [
  { step: 1, description: '列出文档', tool: 'list_directory', depends_on: [], params: { path: '{{workspace_dir}}' }, expectedOutput: '文件列表' },
  { step: 2, description: '读取文档', tool: 'read_file', depends_on: [1], params: { path: '{{step_1_top_files}}' }, expectedOutput: '文档内容' },
  { step: 3, description: 'AI生成周报', tool: 'llm_generate', depends_on: [2], params: { prompt: '根据文档生成周报：\n{{step_2_result}}' }, expectedOutput: '周报' }
]

// 财报式计划：read_file + knowledge_search(并行) + llm_generate(依赖1,2)
const FINANCE_STEPS: L2DagStep[] = [
  { step: 1, description: '读取财报', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '财报内容' },
  { step: 2, description: '检索知识', tool: 'knowledge_search', depends_on: [], params: { query: '风险指标' }, expectedOutput: '评估框架' },
  { step: 3, description: 'AI解读', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '框架：{{step_2_result}}\n财报：{{step_1_result}}' }, expectedOutput: '一句话解读' }
]

describe('P0-A inputForm：附件与路径检测', () => {
  it('识别 DialogPanel 附件折叠格式（带指令前缀）', () => {
    const input = '帮我解读这个文件\n\n---\n以下是用户提供的附件内容：\n\n=== 文件: 周报.docx (12.3KB) ===\n本周完成了A项目'
    const info = detectInputForm(input)
    expect(info.hasAttachment).toBe(true)
    expect(info.hasFileInput).toBe(true)
    expect(info.inlineMaterial).toContain('周报.docx')
    expect(info.inlineMaterial).toContain('本周完成了A项目')
    expect(splitAttachment(input).instruction).toBe('帮我解读这个文件')
  })

  it('识别无指令前缀的纯附件输入', () => {
    const input = '以下是用户提供的附件内容：\n\n=== 文件: a.txt (1.0KB) ===\n内容内容内容'
    const info = detectInputForm(input)
    expect(info.hasAttachment).toBe(true)
  })

  it('识别盘符路径与 ~/ 路径', () => {
    const info = detectInputForm('请读取 C:\\Users\\<user>\\Desktop\\HoloExam\\会议记录.docx 整理成纪要')
    expect(info.hasFilePath).toBe(true)
    expect(info.filePaths[0]).toBe('C:\\Users\\<user>\\Desktop\\HoloExam\\会议记录.docx')

    const info2 = detectInputForm('看看 ~/notes/会议记录.md')
    expect(info2.hasFilePath).toBe(true)
    expect(info2.filePaths[0]).toBe('~/notes/会议记录.md')
  })

  it('附件正文里的路径不计入用户引用路径', () => {
    const input = '帮我整理\n\n---\n以下是用户提供的附件内容：\n\n=== 文件: a.md (1KB) ===\n引用路径 C:\\temp\\other.txt'
    expect(extractFilePaths(input)).toHaveLength(0)
  })

  it('泛词"文档"不构成路径', () => {
    const info = detectInputForm('帮我生成一个文档')
    expect(info.hasFilePath).toBe(false)
  })
})

describe('P0-A inputForm：内联材料提取', () => {
  it('冒号后正文超阈值 → 材料', () => {
    const material = extractInlineMaterial('请把这份会议记录整理成会议纪要，会议内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责后续跟进')
    expect(material).toBe('张三汇报了项目进度，李四提出了预算问题，王五负责后续跟进')
  })

  it('空行后正文可作材料（取较长者）', () => {
    const material = extractInlineMaterial('整理会议纪要\n\n张三汇报了项目进度，李四提出了预算问题，王五负责后续跟进工作安排')
    expect(material).toContain('张三汇报了项目进度')
  })

  it('短于阈值不成材料', () => {
    const material = extractInlineMaterial('翻译：你好世界')
    expect(material.length).toBeLessThan(INLINE_MIN_CHARS)
    expect(detectInputForm('翻译：你好世界').hasInlineMaterial).toBe(false)
  })

  it('附件全文优先于冒号/空行候选', () => {
    const input = '帮我总结：以下内容\n\n---\n以下是用户提供的附件内容：\n\n=== 文件: a.md (1KB) ===\n附件正文很长很长很长很长很长很长'
    expect(extractInlineMaterial(input)).toContain('附件正文')
  })
})

describe('P0-A inputForm：模板输入分类', () => {
  it('text 模板恒 original', () => {
    const m = makeManifest({ inputType: 'text' })
    expect(classifyTemplateInput(m, detectInputForm('随便说点什么'))).toBe('original')
  })

  it('file 模板：有路径 → original；有附件 → inline；皆无 → reject', () => {
    const m = makeManifest({ inputType: 'file' })
    expect(classifyTemplateInput(m, detectInputForm('解读 C:\\temp\\a.docx'))).toBe('original')
    expect(classifyTemplateInput(m, detectInputForm('以下是用户提供的附件内容：\n\n=== 文件: a.txt (1KB) ===\n内容内容'))).toBe('inline')
    expect(classifyTemplateInput(m, detectInputForm('帮我解读一下这段文字的意思是什么'))).toBe('reject')
  })

  it('file_or_text 模板：有路径 → original；有内联材料 → inline；皆无 → original（保守）', () => {
    const m = makeManifest({ inputType: 'file_or_text' })
    expect(classifyTemplateInput(m, detectInputForm('整理 C:\\temp\\记录.txt 成纪要'))).toBe('original')
    expect(classifyTemplateInput(m, detectInputForm('整理成会议纪要，内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责跟进'))).toBe('inline')
    expect(classifyTemplateInput(m, detectInputForm('帮我写个会议纪要'))).toBe('original')
  })
})

describe('P0-A inputForm：内联适配', () => {
  it('会议纪要式：剥离 read_file，材料注入 prompt，重编号', () => {
    const material = '张三汇报了项目进度，李四提出了预算问题'
    const adapted = adaptPlanToInlineInput(MEETING_STEPS, material)
    expect(adapted).toHaveLength(1)
    expect(adapted[0].step).toBe(1)
    expect(adapted[0].tool).toBe('llm_generate')
    expect(adapted[0].depends_on).toEqual([])
    expect(String(adapted[0].params.prompt)).toContain(material)
    expect(String(adapted[0].params.prompt)).not.toContain('{{step_1_result}}')
  })

  it('周报式：级联剥离 list_directory + read_file', () => {
    const material = '本周完成了A项目的开发工作'
    const adapted = adaptPlanToInlineInput(WEEKLY_STEPS, material)
    expect(adapted).toHaveLength(1)
    expect(adapted[0].tool).toBe('llm_generate')
    expect(adapted[0].step).toBe(1)
    expect(String(adapted[0].params.prompt)).toContain(material)
  })

  it('财报式：保留并行 knowledge_search 并正确 remap 依赖', () => {
    const material = '营收增长10%，负债率上升'
    const adapted = adaptPlanToInlineInput(FINANCE_STEPS, material)
    expect(adapted).toHaveLength(2)
    expect(adapted[0].tool).toBe('knowledge_search')
    expect(adapted[0].step).toBe(1)
    expect(adapted[1].tool).toBe('llm_generate')
    expect(adapted[1].step).toBe(2)
    expect(adapted[1].depends_on).toEqual([1])
    const prompt = String(adapted[1].params.prompt)
    expect(prompt).toContain('框架：{{step_1_result}}')
    expect(prompt).toContain(material)
  })

  it('无可剥离步骤 → 原引用返回（调用方降级 original）', () => {
    const steps: L2DagStep[] = [
      { step: 1, description: '生成', tool: 'llm_generate', depends_on: [], params: { prompt: '{{input}}' }, expectedOutput: 'o' }
    ]
    expect(adaptPlanToInlineInput(steps, '材料')).toBe(steps)
  })
})

describe('P0-A inputForm：路径绑定与门控入口', () => {
  it('bindFilePathToSteps 替换 {{user_file}}；无占位符原引用返回', () => {
    const bound = bindFilePathToSteps(MEETING_STEPS, 'C:\\temp\\记录.docx')
    expect(bound).not.toBe(MEETING_STEPS)
    expect(String(bound[0].params.path)).toBe('C:\\temp\\记录.docx')

    const noSlot: L2DagStep[] = [{ step: 1, description: 'd', tool: 'llm_generate', depends_on: [], params: { prompt: 'p' }, expectedOutput: 'o' }]
    expect(bindFilePathToSteps(noSlot, 'C:\\x')).toBe(noSlot)
  })

  it('gate：file 模板无文件输入 → reject', () => {
    const m = makeManifest({ id: 'reader', inputType: 'file', steps: MEETING_STEPS })
    expect(gateTemplateForInput(m, '帮我看下这段文字说了什么').action).toBe('reject')
  })

  it('gate：file_or_text + 内联材料 → inline（适配步骤）', () => {
    const m = makeManifest({ id: 'minutes', inputType: 'file_or_text', steps: MEETING_STEPS })
    const gate = gateTemplateForInput(m, '整理成会议纪要，内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责跟进')
    expect(gate.action).toBe('inline')
    expect(gate.steps).toHaveLength(1)
    expect(gate.steps![0].tool).toBe('llm_generate')
    expect(gate.material).toContain('张三汇报')
  })

  it('gate：file_or_text + 真实路径 → original 且 {{user_file}} 已绑定', () => {
    const m = makeManifest({ id: 'minutes', inputType: 'file_or_text', steps: MEETING_STEPS })
    const gate = gateTemplateForInput(m, '把 C:\\Users\\Admin\\Desktop\\记录.docx 整理成会议纪要')
    expect(gate.action).toBe('original')
    expect(gate.steps).toBeDefined()
    expect(String(gate.steps![0].params.path)).toBe('C:\\Users\\Admin\\Desktop\\记录.docx')
  })

  it('gate：text 模板 → original 无适配步骤', () => {
    const m = makeManifest({ id: 't', inputType: 'text', steps: MEETING_STEPS })
    const gate = gateTemplateForInput(m, '随便写点什么内容都可以啊真的')
    expect(gate.action).toBe('original')
    expect(gate.steps).toBeUndefined()
  })

  it('gate：file 模板 + 附件（无路径） → inline（附件全文注入）', () => {
    const m = makeManifest({ id: 'reader', inputType: 'file', steps: MEETING_STEPS })
    const input = '以下是用户提供的附件内容：\n\n=== 文件: 记录.md (1KB) ===\n张三汇报了项目进度，李四提出了预算问题，王五负责跟进'
    const gate = gateTemplateForInput(m, input)
    expect(gate.action).toBe('inline')
    expect(gate.steps).toHaveLength(1)
    expect(String(gate.steps![0].params.prompt)).toContain('张三汇报了项目进度')
  })
})

describe('P0-A A5：官方模板数据修复断言', () => {
  it('文件创建器：泛词已剔除、阈值 ≥0.65', () => {
    const m = l2Manifests.find(x => x.identity.id === 'l2-file-creator-v1')
    expect(m).toBeDefined()
    expect(m!.routing.keywords).not.toContain('文档')
    expect(m!.routing.keywords).not.toContain('文件')
    expect(m!.routing.keywords).not.toContain('桌面')
    expect(m!.routing.keywords).not.toContain('保存')
    expect(m!.routing.confidenceThreshold).toBeGreaterThanOrEqual(0.65)
  })

  it('文件解读助手：泛词已剔除、阈值 ≥0.65', () => {
    const m = l2Manifests.find(x => x.identity.id === 'l2-file-reader-analysis-v1')
    expect(m).toBeDefined()
    expect(m!.routing.keywords).not.toContain('帮我看')
    expect(m!.routing.keywords).not.toContain('内容')
    expect(m!.routing.keywords).not.toContain('说了什么')
    expect(m!.routing.confidenceThreshold).toBeGreaterThanOrEqual(0.65)
  })

  it('会议纪要生成：file_or_text 输入可用内联材料适配（真实模板贯通）', () => {
    const m = l2Manifests.find(x => x.identity.id === 'l2-meeting-minutes-gen-v1')
    expect(m).toBeDefined()
    const gate = gateTemplateForInput(m!, '帮我把这份记录整理成会议纪要，内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责后续跟进')
    expect(gate.action).toBe('inline')
    expect(gate.steps!.every(s => s.tool !== 'read_file')).toBe(true)
    expect(String(gate.steps!.find(s => s.tool === 'llm_generate')!.params.prompt)).toContain('张三汇报了项目进度')
  })

  it('全部 file 模板：无文件输入的输入被门控拒绝', () => {
    const fileManifests = l2Manifests.filter(x => x.routing.inputType === 'file')
    expect(fileManifests.length).toBeGreaterThan(0)
    for (const m of fileManifests) {
      expect(gateTemplateForInput(m, '帮我看看这段文字讲了什么内容大概意思').action).toBe('reject')
    }
  })
})
