import { debugLog } from '@/services/debugLog'
import { L2ToolManifest } from '@/models'

const l2Manifests: L2ToolManifest[] = [
  {
    // 第一波·文档能力（2026-09-24）：文档 → PDF。
    // 这是本仓第一个"步骤里调真实外部能力"的清单——其余清单的步骤只有 llm_generate /
    // read_file / knowledge_search / shell_exec，即"只有这么一点功能"的根因。
    identity: { id: 'l2-doc-to-pdf-v1', name: '文档转 PDF', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-doc-to-pdf' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain'], hoverLabel: '读取文档→导出 PDF', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['pdf', '转pdf', '导出pdf', 'pdf格式', '转成pdf', '生成pdf'], targetRoles: ['general', 'finance', 'legal', 'hr'], requiredL1: ['l1-doc-convert'], inputType: 'file', retrievalSummary: '把 docx/md/html/txt 文档导出为 PDF；应用内渲染，无需本机安装 Word/LibreOffice/pandoc', userSummary: '文档→PDF', confidenceThreshold: 0.6 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '导出为 PDF（应用内渲染）', tool: 'file_convert', depends_on: [], params: { source: '{{user_file}}', target: '{{user_file_pdf}}' }, expectedOutput: 'PDF 文件路径' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 1
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '源文档路径（.docx/.md/.html/.txt）', required: true }, { name: '{{user_file_pdf}}', source: 'context', description: '目标 PDF 路径；未提供时与源文件同目录同名', required: false }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'source' }, { slotName: '{{user_file_pdf}}', targetStep: 1, targetParam: 'target' }] }
    },
    cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 2500, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-contract-risk-review-v1', name: '合同风险审查', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-contract-risk-scan' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '上传合同→标注风险→生成报告', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['合同', '风险', '审查', '合规', '条款', '法律'], targetRoles: ['legal'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'], inputType: 'file', retrievalSummary: '上传合同PDF，自动标注风险条款并生成docx审查报告', userSummary: '上传合同→标注风险→生成报告', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索知识库获取合同审查要点', tool: 'knowledge_search', depends_on: [], params: { query: '合同风险审查要点 常见陷阱 条款分析' }, expectedOutput: '合同审查知识要点', fallback: 'llm_generate', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '读取合同文件内容', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '合同全文', modelTier: 'nano' },
          { step: 3, description: 'AI分析风险条款', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是一名合同审查专家。根据以下审查要点和合同原文，逐条分析风险条款。每个风险条款需标注：原文摘录、风险等级、修改建议。\n\n审查要点：{{step_1_result}}\n\n合同原文：{{step_2_result}}' }, expectedOutput: '风险条款分析报告', fallback: 'llm_generate', modelTier: 'pro' },
          { step: 4, description: '生成docx审查报告', tool: 'shell_exec', depends_on: [3], params: { command: 'node -e "const {Document,Packer,Paragraph,TextRun,HeadingLevel}=require(\'docx\');const fs=require(\'fs\');const analysis=process.env.ANALYSIS;const doc=new Document({sections:[{children:[new Paragraph({text:\'合同风险审查报告\',heading:HeadingLevel.HEADING_1}),new Paragraph({children:[new TextRun(analysis)]})]}]});Packer.toBuffer(doc).then(buf=>fs.writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\合同风险审查报告.docx\',buf))"' }, expectedOutput: '桌面docx报告' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '合同文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 2, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2800, avgExecutionTime: 15000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-weekly-report-draft-v1', name: '周报自动草稿', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-weekly-report' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain'], hoverLabel: '读取本周文档→生成周报草稿', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['周报', '工作总结', '汇报', '本周', '草稿'], targetRoles: ['finance', 'general'], requiredL1: ['l1-pipeline-builder', 'l1-workspace-memory'], inputType: 'file_or_text', retrievalSummary: '读取本周编辑过的文档，自动生成周报草稿；也可直接粘贴本周要点', userSummary: '读取本周文档→生成周报', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '列出本周修改的文档', tool: 'list_directory', depends_on: [], params: { path: '{{workspace_dir}}' }, expectedOutput: '文件列表', modelTier: 'nano' },
          { step: 2, description: '读取关键文档内容', tool: 'read_file', depends_on: [1], params: { path: '{{step_1_top_files}}' }, expectedOutput: '文档内容摘要', modelTier: 'nano' },
          { step: 3, description: 'AI生成周报', tool: 'llm_generate', depends_on: [2], params: { prompt: '根据以下本周工作文档，生成一份周报草稿，包含：本周完成工作、进行中工作、下周计划、需要协调的事项。\n\n文档内容：{{step_2_result}}' }, expectedOutput: '周报文本', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{workspace_dir}}', source: 'context', description: '工作目录路径', required: true }], bindings: [{ slotName: '{{workspace_dir}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2200, avgExecutionTime: 12000, cacheable: true, cacheKeyTemplate: 'weekly-{{current_week}}-v1.0.0', cacheTTL: 86400000 }
  },
  {
    identity: { id: 'l2-doc-translate-en-v1', name: '文档翻译英文版', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-translate-en' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '中文文档→格式一致的英文版', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['翻译', '英文', 'English', '中译英', '文档翻译'], targetRoles: ['general'], requiredL1: ['l1-task-translator', 'l1-result-beautifier'], inputType: 'file_or_text', retrievalSummary: '将中文文档翻译为格式一致的英文版本', userSummary: '中文→英文翻译', confidenceThreshold: 0.75 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '请将以下中文内容翻译为英文，保持原有格式和段落结构不变。专业术语保留原文并附英文翻译：\n\n{{input}}', maxTokens: 8192 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '待翻译的中文文本', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1200, avgExecutionTime: 5000, cacheable: true, cacheKeyTemplate: 'translate-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  },
  {
    identity: { id: 'l2-financial-report-brief-v1', name: '财报风险一句话解读', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-financial-brief' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['sparkle', 'lightning'], hoverLabel: '拖入财报PDF→一句话风险总结', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['财报', '风险', '财务', '解读', '摘要', '盈利', '亏损'], targetRoles: ['finance'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'file', retrievalSummary: '拖入PDF财报，自动输出一句话风险总结', userSummary: '拖入财报→一句话风险总结', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取财报文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '财报文本内容', modelTier: 'nano' },
          { step: 2, description: '检索财务风险指标', tool: 'knowledge_search', depends_on: [], params: { query: '财报风险指标 财务健康度 现金流 负债率' }, expectedOutput: '财务风险评估框架', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 3, description: 'AI生成一句话解读', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是资深财务分析师。根据财报内容和风险评估框架，用一句话概括这份财报的核心风险。格式：\'[公司名]财报风险：[核心风险]，[关键指标数据]。\'\n\n评估框架：{{step_2_result}}\n\n财报内容：{{step_1_result}}', maxTokens: 200 }, expectedOutput: '一句话风险总结', modelTier: 'mini' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '财报PDF路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1800, avgExecutionTime: 8000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-competitor-analysis-v1', name: '竞品分析报告', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-competitor-analysis' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '输入竞品资料→对比分析报告', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['竞品', '对比', '分析', '市场', '竞争', '产品对比'], targetRoles: ['sales'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'], inputType: 'file_or_text', retrievalSummary: '输入竞品资料，生成对比分析报告', userSummary: '输入竞品资料→对比分析', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索竞品分析方法论', tool: 'knowledge_search', depends_on: [], params: { query: '竞品分析框架 SWOT 功能对比 市场定位' }, expectedOutput: '竞品分析方法论', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '读取竞品资料', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '竞品原始资料', modelTier: 'nano' },
          { step: 3, description: 'AI生成对比分析', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是市场分析专家。根据竞品分析框架和竞品资料，生成一份结构化的对比分析报告，包含：产品定位对比、功能差异、价格策略、优劣势分析、建议策略。\n\n分析框架：{{step_1_result}}\n\n竞品资料：{{step_2_result}}' }, expectedOutput: '竞品对比分析文本', modelTier: 'pro' },
          { step: 4, description: '生成docx报告', tool: 'shell_exec', depends_on: [3], params: { command: 'node -e "const {Document,Packer,Paragraph,TextRun,HeadingLevel}=require(\'docx\');const fs=require(\'fs\');const analysis=process.env.ANALYSIS;const doc=new Document({sections:[{children:[new Paragraph({text:\'竞品分析报告\',heading:HeadingLevel.HEADING_1}),new Paragraph({children:[new TextRun(analysis)]})]}]});Packer.toBuffer(doc).then(buf=>fs.writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\竞品分析报告.docx\',buf))"' }, expectedOutput: '桌面docx报告' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '竞品资料文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 2, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2500, avgExecutionTime: 18000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-announcement-draft-v1', name: '公告通知草稿', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-announcement' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '输入要点→正式公告文本', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['公告', '通知', '通告', '发文', '公告草稿'], targetRoles: ['hr', 'general'], requiredL1: ['l1-task-translator'], inputType: 'text', retrievalSummary: '根据要点自动生成正式公告通知文本', userSummary: '输入要点→正式公告', confidenceThreshold: 0.75 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '请根据以下要点，生成一份正式的公司公告通知。要求：格式规范、措辞正式、结构清晰（标题+正文+落款）。\n\n要点：{{input}}', maxTokens: 2048 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '公告要点', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 800, avgExecutionTime: 3000, cacheable: true, cacheKeyTemplate: 'announce-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  },
  {
    identity: { id: 'l2-reimbursement-check-v1', name: '报销单合规检查', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-reimbursement-check' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '上传报销单→合规检查→报告', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['报销', '合规', '发票', '费用', '审批'], targetRoles: ['finance'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'], inputType: 'file', retrievalSummary: '上传报销单，自动检查合规性并生成检查报告', userSummary: '上传报销单→合规检查', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索报销合规规则', tool: 'knowledge_search', depends_on: [], params: { query: '报销合规规则 发票要求 费用标准 审批流程' }, expectedOutput: '报销合规规则', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '读取报销单文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '报销单内容', modelTier: 'nano' },
          { step: 3, description: 'AI合规性检查', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是财务合规审核员。根据报销合规规则，逐项检查以下报销单的合规性。标注：不合规项、原因、修改建议。\n\n合规规则：{{step_1_result}}\n\n报销单内容：{{step_2_result}}' }, expectedOutput: '合规检查结果', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '报销单文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 2, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2200, avgExecutionTime: 12000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: true,
      coverage: 0.7,
      rules: [
        { id: 'r1', conditions: [{ field: 'step_1_result', operator: 'contains', value: '发票缺失' }], action: { outputTemplate: '⚠️ 不合规：发票缺失。根据报销规定，所有报销项目必须附带有效发票。请补充发票后重新提交。', severity: 'error', tags: ['发票缺失'] }, priority: 10 },
        { id: 'r2', conditions: [{ field: 'step_1_amount', operator: 'gt', value: 5000 }], action: { outputTemplate: '⚠️ 需审批：报销金额 {{step_1_amount}} 元超过5000元限额，需部门经理审批。', severity: 'warning', tags: ['超额'] }, priority: 9 },
        { id: 'r3', conditions: [{ field: 'step_1_result', operator: 'regex', value: '餐饮|交通|住宿' }, { field: 'step_1_amount', operator: 'gt', value: 500 }], action: { outputTemplate: '⚠️ 需关注：差旅费用 {{step_1_amount}} 元，请确认是否符合差旅标准。', severity: 'warning', tags: ['差旅'] }, priority: 8 },
        { id: 'r4', conditions: [{ field: 'step_1_result', operator: 'contains', value: '超期' }], action: { outputTemplate: '⚠️ 超期报销：报销单包含超期项目，请说明延迟原因。', severity: 'warning', tags: ['超期'] }, priority: 7 },
        { id: 'r5', conditions: [{ field: 'step_1_amount', operator: 'lte', value: 5000 }, { field: 'step_1_result', operator: 'not_contains', value: '发票缺失' }], action: { outputTemplate: '✅ 初步合规：报销金额 {{step_1_amount}} 元在限额内，格式检查通过。', severity: 'info', tags: ['合规'] }, priority: 1 }
      ],
      fallbackToLLM: true
    }
  },
  {
    identity: { id: 'l2-legal-clause-compare-v1', name: '条款对比助手', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-legal-clause-compare' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '上传两份文件→条款对比', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['条款', '对比', '合同对比', '法条', '差异'], targetRoles: ['legal'], requiredL1: ['l1-task-translator', 'l1-result-beautifier'], inputType: 'file', retrievalSummary: '对比两份文件的条款差异，生成对比分析', userSummary: '上传两份文件→条款对比', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取第一份文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '文件一内容', modelTier: 'nano' },
          { step: 2, description: '读取第二份文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file_2}}' }, expectedOutput: '文件二内容', modelTier: 'nano' },
          { step: 3, description: 'AI条款对比分析', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是法律条款对比专家。逐条对比以下两份文件的条款差异，标注：新增条款、删除条款、修改条款（含具体差异说明）。\n\n文件一：{{step_1_result}}\n\n文件二：{{step_2_result}}' }, expectedOutput: '条款对比分析', modelTier: 'pro' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '第一份文件路径', required: true }, { name: '{{user_file_2}}', source: 'context', description: '第二份文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }, { slotName: '{{user_file_2}}', targetStep: 2, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2000, avgExecutionTime: 14000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-resume-screening-v1', name: '简历初筛助手', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-resume-screening' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['sparkle'], hoverLabel: '上传简历→初筛评分→排序', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['简历', '招聘', '筛选', '人才', '候选人'], targetRoles: ['hr'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'file', retrievalSummary: '上传简历文件，自动初筛评分并排序推荐', userSummary: '上传简历→初筛评分', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索岗位要求', tool: 'knowledge_search', depends_on: [], params: { query: '岗位要求 招聘标准 技能要求 面试评估' }, expectedOutput: '岗位要求标准', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '读取简历文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '简历内容', modelTier: 'nano' },
          { step: 3, description: 'AI初筛评分', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是资深HR。根据岗位要求和简历内容，对候选人进行初筛评分。输出：匹配度(0-100)、优势、不足、建议(推荐面试/待定/不推荐)。\n\n岗位要求：{{step_1_result}}\n\n简历内容：{{step_2_result}}' }, expectedOutput: '初筛评分结果', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '简历文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 2, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2400, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-onboarding-guide-gen-v1', name: '入职引导生成器', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-onboarding-guide' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain'], hoverLabel: '输入岗位→生成入职引导', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['入职', '引导', '新员工', '入职指南'], targetRoles: ['hr'], requiredL1: ['l1-pipeline-builder', 'l1-result-beautifier'], inputType: 'text', retrievalSummary: '根据岗位信息自动生成入职引导手册', userSummary: '输入岗位→生成入职引导', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索入职流程模板', tool: 'knowledge_search', depends_on: [], params: { query: '入职流程 新员工引导 入职checklist 公司制度' }, expectedOutput: '入职流程模板', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: 'AI生成入职引导', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是HR专家。根据入职流程模板和岗位信息，生成一份完整的入职引导手册。包含：第一天安排、第一周任务、需要完成的培训、需提交的材料、关键联系人。\n\n入职流程模板：{{step_1_result}}\n\n岗位信息：{{input}}' }, expectedOutput: '入职引导手册', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '岗位信息', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 2, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1600, avgExecutionTime: 8000, cacheable: true, cacheKeyTemplate: 'onboarding-{{input_hash}}-v1.0.0', cacheTTL: 86400000 }
  },
  {
    identity: { id: 'l2-sales-proposal-draft-v1', name: '销售提案草稿', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-sales-proposal' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain'], hoverLabel: '输入客户需求→生成提案', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    // A（路由假阳性修复）：意图反向门——变换（改写/翻译/润色/总结）或列查（列出/查看）类输入
    // 要的不是"生成提案"，禁止路由到本宏（治 Q4「商务邮件改写」被误派进销售提案）
    routing: { keywords: ['提案', '销售', '方案', '商务', '报价'], forbiddenKeywords: ['改写', '重写', '润色', '翻译', '精简', '缩写', '概括', '总结', '改成', '转成', '转换为', '转换成', '纪要', '列出', '清单', '有哪些', '查看', '找出', '列举', '搜索', '查找'], targetRoles: ['sales'], requiredL1: ['l1-task-translator', 'l1-result-beautifier'], inputType: 'text', retrievalSummary: '根据客户需求自动生成销售提案草稿', userSummary: '输入客户需求→生成提案', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索产品方案模板', tool: 'knowledge_search', depends_on: [], params: { query: '销售提案模板 商务方案 报价策略 客户需求分析' }, expectedOutput: '销售提案框架', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: 'AI生成销售提案', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是资深销售顾问。根据提案框架和客户需求，生成一份结构化的销售提案。包含：需求理解、解决方案、实施计划、报价方案、成功案例。\n\n提案框架：{{step_1_result}}\n\n客户需求：{{input}}' }, expectedOutput: '销售提案文本', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '客户需求描述', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 2, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1800, avgExecutionTime: 9000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-client-email-compose-v1', name: '客户邮件撰写', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-client-email' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '输入要点→生成商务邮件', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['邮件', '客户', '回复', '商务邮件', '邮件草稿'], targetRoles: ['sales', 'general'], requiredL1: ['l1-task-translator', 'l1-workspace-memory'], inputType: 'text', retrievalSummary: '根据要点自动生成专业商务邮件', userSummary: '输入要点→生成商务邮件', confidenceThreshold: 0.75 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '请根据以下要点撰写一封专业的商务邮件。要求：称呼得体、内容清晰、语气专业、结尾礼貌。\n\n要点：{{input}}', maxTokens: 2048 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '邮件要点', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 600, avgExecutionTime: 3000, cacheable: true, cacheKeyTemplate: 'email-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  },
  {
    identity: { id: 'l2-meeting-minutes-gen-v1', name: '会议纪要生成', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-meeting-minutes' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '上传记录→生成会议纪要', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['会议', '纪要', '记录', '会议记录', '会议总结'], targetRoles: ['general'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'], inputType: 'file_or_text', retrievalSummary: '上传会议记录或笔记，自动生成结构化会议纪要', userSummary: '上传记录→生成会议纪要', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取会议记录文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '会议原始记录', modelTier: 'nano' },
          { step: 2, description: 'AI生成会议纪要', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是会议纪要专家。根据以下会议记录，生成一份结构化的会议纪要。包含：会议主题、参会人员、讨论要点、决议事项、后续行动(含负责人和截止日期)。\n\n会议记录：{{step_1_result}}' }, expectedOutput: '结构化会议纪要', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '会议记录文件路径', required: false }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2200, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-ppt-outline-gen-v1', name: 'PPT大纲生成', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-ppt-outline' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '输入主题→生成PPT大纲', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['PPT', '大纲', '演示', '幻灯片', '汇报大纲'], targetRoles: ['general'], requiredL1: ['l1-task-translator', 'l1-result-beautifier'], inputType: 'text', retrievalSummary: '根据主题自动生成PPT演示大纲结构', userSummary: '输入主题→生成PPT大纲', confidenceThreshold: 0.75 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '请根据以下主题，生成一份PPT演示大纲。包含：标题页、目录页、各章节标题和要点、总结页。每页标注建议的视觉元素。\n\n主题：{{input}}', maxTokens: 4096 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: 'PPT主题', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 800, avgExecutionTime: 4000, cacheable: true, cacheKeyTemplate: 'ppt-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  },
  {
    identity: { id: 'l2-data-excel-summary-v1', name: 'Excel数据摘要', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-excel-summary' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['sparkle'], hoverLabel: '上传Excel→数据摘要分析', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['Excel', '数据', '摘要', '表格', '统计'], targetRoles: ['finance', 'general'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'file', retrievalSummary: '上传Excel文件，自动生成数据摘要和统计分析', userSummary: '上传Excel→数据摘要分析', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取Excel文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: 'Excel数据内容', modelTier: 'nano' },
          { step: 2, description: 'AI生成数据摘要', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是数据分析专家。根据以下Excel数据，生成一份摘要报告。包含：数据概况(行列数、字段名)、关键统计(均值、中位数、极值)、异常值标注、趋势判断。\n\n数据内容：{{step_1_result}}' }, expectedOutput: '数据摘要报告', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: 'Excel文件路径', required: true }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2000, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: true,
      coverage: 0.5,
      rules: [
        { id: 'xs1', conditions: [{ field: 'step_1_amount', operator: 'gt', value: 0 }], action: { outputTemplate: '数据概况：检测到数值数据，最大值 {{step_1_amount}} 元。\n关键发现：数值型字段已提取，含金额/数量指标。\n建议：如需详细统计分析，将使用AI进一步分析。', severity: 'info', tags: ['数值摘要'] }, priority: 5 }
      ],
      fallbackToLLM: true
    }
  },
  {
    identity: { id: 'l2-policy-doc-qa-v1', name: '政策文档问答', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-policy-qa' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '输入问题→政策文档解答', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['政策', '文档', '问答', '规定', '制度'], targetRoles: ['hr', 'general'], requiredL1: ['l1-knowledge-feeder', 'l1-workspace-memory'], inputType: 'text', retrievalSummary: '根据知识库中的政策文档回答问题', userSummary: '输入问题→政策文档解答', confidenceThreshold: 0.65 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '请根据知识库中的政策文档回答以下问题。如果找不到相关政策依据，请明确说明。回答需引用具体政策条目。\n\n问题：{{input}}', maxTokens: 2048 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '政策问题', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 400, avgExecutionTime: 3000, cacheable: true, cacheKeyTemplate: 'policy-{{input_hash}}-v1.0.0', cacheTTL: 86400000 }
  },
  {
    identity: { id: 'l2-email-categorizer-v1', name: '邮件自动分类', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-email-categorizer' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain'], hoverLabel: '输入邮件→分类+建议操作', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['邮件分类', '收件箱', '整理', '标签', '归档'], targetRoles: ['general'], requiredL1: ['l1-task-translator', 'l1-pipeline-builder'], inputType: 'text', retrievalSummary: '自动对邮件内容分类并建议处理方式', userSummary: '输入邮件→分类+建议操作', confidenceThreshold: 0.7 },
    execution: {
      mode: 'chain',
      dagPlan: {
        steps: [
          { step: 1, description: 'AI分类邮件内容', tool: 'llm_generate', depends_on: [], params: { prompt: '你是邮件分类助手。根据以下邮件内容，判断邮件类别（紧急/常规/通知/垃圾）和优先级（高/中/低），并建议处理方式。\n\n邮件内容：{{input}}' }, expectedOutput: '分类结果', modelTier: 'mini' },
          { step: 2, description: 'AI生成回复草稿', tool: 'llm_generate', depends_on: [1], params: { prompt: '根据以下邮件分类结果，生成一封简短的回复草稿（如果需要回复）。\n\n分类结果：{{step_1_result}}' }, expectedOutput: '回复草稿', modelTier: 'mini' }
        ],
        fallbackStrategy: 'skip',
        maxRetries: 1
      },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '邮件内容', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 1, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1000, avgExecutionTime: 8000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: true,
      coverage: 0.75,
      targetStep: 1,
      rules: [
        { id: 'ec1', conditions: [{ field: 'input', operator: 'regex', value: '紧急|立即|马上|asap|urgent|deadline' }], action: { outputTemplate: '分类：紧急 | 优先级：高\n建议：立即处理，该邮件标记为紧急事项。', severity: 'error', tags: ['紧急'] }, priority: 10 },
        { id: 'ec2', conditions: [{ field: 'input', operator: 'regex', value: '会议|通知|公告|提醒|schedule|meeting' }], action: { outputTemplate: '分类：通知 | 优先级：中\n建议：确认日程安排，归档至通知文件夹。', severity: 'info', tags: ['通知'] }, priority: 8 },
        { id: 'ec3', conditions: [{ field: 'input', operator: 'regex', value: '优惠|促销|折扣|广告|subscribe|newsletter' }], action: { outputTemplate: '分类：推广/垃圾 | 优先级：低\n建议：可归档或删除，非工作相关邮件。', severity: 'info', tags: ['垃圾'] }, priority: 7 },
        { id: 'ec4', conditions: [{ field: 'input', operator: 'regex', value: '审批|签字|确认|同意|approve|sign' }], action: { outputTemplate: '分类：待办 | 优先级：高\n建议：需要您的审批操作，请尽快处理。', severity: 'warning', tags: ['审批'] }, priority: 9 },
        { id: 'ec5', conditions: [{ field: 'input', operator: 'regex', value: '报告|数据|分析|汇总|report|summary' }], action: { outputTemplate: '分类：常规 | 优先级：中\n建议：阅读后归档至相关项目文件夹。', severity: 'info', tags: ['常规'] }, priority: 5 }
      ],
      fallbackToLLM: true
    }
  },
  {
    identity: { id: 'l2-budget-forecast-v1', name: '预算预测助手', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-budget-forecast' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['sparkle'], hoverLabel: '输入预算数据→趋势预测', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['预算', '预测', '财务', '费用预测', '预算规划'], targetRoles: ['finance'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'file_or_text', retrievalSummary: '根据历史预算数据生成趋势预测和建议', userSummary: '输入预算数据→趋势预测', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取预算数据文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '预算数据', modelTier: 'nano' },
          { step: 2, description: '检索预算分析方法', tool: 'knowledge_search', depends_on: [], params: { query: '预算预测方法 趋势分析 财务建模 成本控制' }, expectedOutput: '预算分析方法', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 3, description: 'AI生成预算预测', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是财务预测专家。根据历史预算数据和分析方法，生成下季度预算预测。包含：趋势判断、关键假设、预测结果、风险因素、建议调整。\n\n预算数据：{{step_1_result}}\n\n分析方法：{{step_2_result}}' }, expectedOutput: '预算预测报告', modelTier: 'pro' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '预算数据文件路径', required: false }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 2000, avgExecutionTime: 12000, cacheable: false, cacheTTL: 0 }
  },
  {
    identity: { id: 'l2-nd-review-checklist-v1', name: 'ND审查清单', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-nd-checklist' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '输入ND内容→审查清单', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['ND', '保密协议', '审查', '清单', 'NDA'], targetRoles: ['legal'], requiredL1: ['l1-task-translator', 'l1-result-beautifier'], inputType: 'text', retrievalSummary: '生成ND/保密协议审查清单', userSummary: '输入ND内容→审查清单', confidenceThreshold: 0.75 },
    execution: {
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '你是保密协议审查专家。请根据以下ND/保密协议内容，生成一份审查清单。逐项检查：保密范围、期限、违约责任、例外条款、管辖法律等。每项标注是否合规及建议。\n\n协议内容：{{input}}', maxTokens: 4096 },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: 'ND协议内容', required: true }], bindings: [{ slotName: '{{input}}', targetStep: 0, targetParam: 'prompt' }] }
    },
    cacheMeta: { estimatedTokenSaving: 600, avgExecutionTime: 4000, cacheable: true, cacheKeyTemplate: 'nd-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  },
  {
    identity: { id: 'l2-kpi-report-gen-v1', name: 'KPI报告生成', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-kpi-report' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '输入KPI数据→生成报告', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['KPI', '绩效', '指标', '报告', '考核'], targetRoles: ['hr', 'general'], requiredL1: ['l1-pipeline-builder', 'l1-result-beautifier'], inputType: 'file_or_text', retrievalSummary: '根据KPI数据自动生成绩效分析报告', userSummary: '输入KPI数据→生成报告', confidenceThreshold: 0.7 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取KPI数据', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: 'KPI数据', modelTier: 'nano' },
          { step: 2, description: 'AI生成KPI分析报告', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是绩效分析专家。根据以下KPI数据，生成一份绩效分析报告。包含：指标达标率、同比/环比变化、异常指标分析、改进建议、下期目标建议。\n\nKPI数据：{{step_1_result}}' }, expectedOutput: 'KPI分析报告', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: 'KPI数据文件路径', required: false }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1800, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: true,
      coverage: 0.5,
      rules: [
        { id: 'kpi1', conditions: [{ field: 'step_1_result', operator: 'regex', value: '\\d+%.*低于|未达标|不达标|缺失' }], action: { outputTemplate: '⚠️ KPI异常检测：发现未达标指标。\n数据概况：KPI数据已提取，含百分比指标。\n建议：关注未达标项目，制定改进计划。', severity: 'warning', tags: ['KPI异常'] }, priority: 8 },
        { id: 'kpi2', conditions: [{ field: 'step_1_result', operator: 'regex', value: '\\d+%.*超过|达标|优秀|完成' }], action: { outputTemplate: '✅ KPI初步达标：部分指标已完成。\n数据概况：KPI数据已提取，含百分比指标。\n建议：持续关注，保持优势指标表现。', severity: 'info', tags: ['KPI达标'] }, priority: 5 }
      ],
      fallbackToLLM: true
    }
  },
  {
    identity: { id: 'l2-file-reader-analysis-v1', name: '文件解读助手', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-file-reader' },
    visual: { baseColor: '#44aaff', ringStyle: 'dashed', badges: ['file'], hoverLabel: '上传文件→解读内容→回答问题', anchorGlow: '#66ccff', upgradeGlow: '#88ddff' },
    // Q15 修复：本工具只"解读文件并回答"，不生成/改动文件——「改文件」类指令一律拒收
    // （Q15「图片按日期重命名」因泛词「文件」命中而误投到此，须由禁词门拦住）
    routing: { keywords: ['文件', '解读', '解析', '阅读', '读懂', '理解', '看下文件', '分析文件'], forbiddenKeywords: ['重命名', '改名', '命名', '转换', '转成', '转为', '转换为', '转换成', '创建', '新建', '删除', '移动', '复制', '写入', '生成文件'], targetRoles: ['general', 'hr', 'finance', 'legal', 'sales'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'file', retrievalSummary: '上传任意文件，解读其内容并回答关于文件的问题，不生成额外文件', userSummary: '上传文件→解读内容→回答问题', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读取文件内容', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '文件原始内容', modelTier: 'nano' },
          { step: 2, description: '检索相关知识背景', tool: 'knowledge_search', depends_on: [], params: { query: '{{input}}' }, expectedOutput: '相关背景知识', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 3, description: 'AI解读文件内容', tool: 'llm_generate', depends_on: [1, 2], params: { prompt: '你是一名文件解读专家。请仔细阅读以下文件内容，用清晰的中文解读这份文件：\n1. 这是什么类型的文件？\n2. 核心内容是什么？\n3. 关键信息有哪些？\n4. 有什么需要注意的？\n\n相关背景：{{step_2_result}}\n\n文件内容：\n{{step_1_result}}' }, expectedOutput: '文件解读', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 1
      },
      paramMapping: { slots: [{ name: '{{user_file}}', source: 'file_path', description: '要解读的文件路径', required: true }, { name: '{{input}}', source: 'input_text', description: '用户的具体问题', required: false }], bindings: [{ slotName: '{{user_file}}', targetStep: 1, targetParam: 'path' }] }
    },
    cacheMeta: { estimatedTokenSaving: 1500, avgExecutionTime: 8000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: false,
      coverage: 0,
      rules: [],
      fallbackToLLM: true
    }
  },
  {
    identity: { id: 'l2-file-creator-v1', name: '文件创建器', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-file-creator' },
    visual: { baseColor: '#66ffaa', ringStyle: 'solid', badges: ['lightning'], hoverLabel: '描述内容→创建文件→保存到桌面', anchorGlow: '#88ffcc', upgradeGlow: '#aaffdd' },
    // A5 修复：剔除泛词 '文档','文件','桌面','保存'（它们让任何提到"文件/保存"的输入都命中本模板，
    // 是 Q4/Q6/Q12 误路由主因之一），阈值 0.3 → 0.65 与其他官方模板对齐
    // P1-D5：列查/查看/转换类禁词——此类输入要求的是"读/列举/转格式"而非"创建"，
    // 首考 Q14 即"列清单"被误投到本清单后写死 新建文档.docx 造成假完成
    routing: { keywords: ['创建', '新建', '写文件', '生成文件', '写文档', '生成文档', '创建docx', '新建docx', '写docx', '保存文件', '创建txt', '新建txt', '创建word', '新建word', '生成word', '写word', 'docx'], forbiddenKeywords: ['列出', '清单', '有哪些', '看一下', '查看', '找出', '搜索', '查找', '列举', '转成', '转为', '转换为', '转换'], targetRoles: ['general', 'hr', 'finance', 'legal', 'sales'], requiredL1: ['l1-task-translator'], inputType: 'text', retrievalSummary: '根据用户描述创建docx/txt等文件并保存到桌面', userSummary: '描述内容→创建文件→保存到桌面', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
            { step: 1, description: '创建docx文件并保存到桌面', tool: 'shell_exec', depends_on: [], params: { command: 'node -e "const{Document,Packer,Paragraph,TextRun}=require(\'docx\');const fs=require(\'fs\');const raw=(process.env.USER_INPUT||\'\').trim();let content=raw.replace(/^(帮我|请|麻烦)?(写|创建|生成|新建)(一个|一份)?/,\'\').trim()||raw;const doc=new Document({sections:[{children:content.split(\'\\n\').map(line=>new Paragraph({children:[new TextRun(line)]}))}]});Packer.toBuffer(doc).then(buf=>{fs.writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\新建文档.docx\',buf);console.log(\'文件已保存: 新建文档.docx\')})"' }, expectedOutput: '桌面docx文件' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 1
      },
      paramMapping: { slots: [{ name: 'input', source: 'input_text', description: '你想创建的文件内容描述', required: false }], bindings: [] }
    },
    cacheMeta: { estimatedTokenSaving: 800, avgExecutionTime: 10000, cacheable: false, cacheTTL: 0 },
    ruleBasedFallback: {
      enabled: false,
      coverage: 0,
      rules: [],
      fallbackToLLM: true
    }
  },
  {
    // A5 批新增（hr pack 供给扩充）：用户输入经 prompt 模板变量 {{input}} 注入（macroExecutor 编译填充），
    // bindings 不指向 prompt（binding 为参数整体替换，会覆盖模板）；slots 仅作 funnel 输入声明
    identity: { id: 'l2-attendance-exception-note-v1', name: '考勤异常说明生成', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-attendance-note' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'lightning'], hoverLabel: '口述考勤异常→正式说明', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['考勤', '迟到', '早退', '缺卡', '补卡', '异常说明', '考勤说明'], targetRoles: ['hr', 'general'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'text', retrievalSummary: '根据口述的考勤异常情况，生成正式的考勤异常说明', userSummary: '口述异常→正式考勤说明', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索知识库获取考勤制度与说明规范', tool: 'knowledge_search', depends_on: [], params: { query: '考勤制度 迟到 早退 缺卡 补考勤 说明规范' }, expectedOutput: '考勤制度知识要点', fallback: 'llm_generate', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '生成正式考勤异常说明', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是一名HR专员。根据以下考勤制度要点和员工口述的异常情况，生成一份正式的考勤异常说明，包含：称谓、异常日期与时间、具体情况说明、后续处理（如补卡/调休申请）、承诺与落款。措辞正式客观。\n\n考勤制度要点：{{step_1_result}}\n\n员工口述的异常情况：{{input}}' }, expectedOutput: '考勤异常说明文本', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '考勤异常情况口述', required: true }], bindings: [] }
    },
    cacheMeta: { estimatedTokenSaving: 900, avgExecutionTime: 8000, cacheable: true, cacheKeyTemplate: 'attendance-note-{{input_hash}}-v1.0.0', cacheTTL: 86400000 }
  },
  {
    identity: { id: 'l2-offboarding-checklist-v1', name: '离职交接清单生成', version: '1.0.0', author: 'official', createdAt: 1700000000000, updatedAt: 1700000000000, templateId: 'official-offboarding-checklist' },
    visual: { baseColor: '#00e5ff', ringStyle: 'solid', badges: ['chain', 'sparkle'], hoverLabel: '岗位信息→交接清单', anchorGlow: '#00ffcc', upgradeGlow: '#ffd700' },
    routing: { keywords: ['离职', '辞职', '交接', '工作交接', '离职交接', '交接清单'], targetRoles: ['hr', 'general'], requiredL1: ['l1-knowledge-feeder', 'l1-task-translator'], inputType: 'text', retrievalSummary: '根据岗位与职责描述，生成分类的离职交接清单', userSummary: '岗位信息→离职交接清单', confidenceThreshold: 0.65 },
    execution: {
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '检索知识库获取离职交接流程要点', tool: 'knowledge_search', depends_on: [], params: { query: '离职交接 流程 工作交接 离职证明 经济补偿' }, expectedOutput: '离职交接流程知识要点', fallback: 'llm_generate', modelTier: 'nano', outputExtract: '$.summary' },
          { step: 2, description: '生成分类的离职交接清单', tool: 'llm_generate', depends_on: [1], params: { prompt: '你是一名HR专员。根据以下交接流程要点和岗位描述，生成一份离职交接清单，按四类组织：①文档与资料交接 ②系统权限与账户 ③办公资产归还 ④工作知识与项目交接。每项标注交接对象与完成标准。\n\n交接流程要点：{{step_1_result}}\n\n岗位描述：{{input}}' }, expectedOutput: '离职交接清单文本', modelTier: 'standard' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      },
      paramMapping: { slots: [{ name: '{{input}}', source: 'input_text', description: '岗位与职责描述', required: true }], bindings: [] }
    },
    cacheMeta: { estimatedTokenSaving: 1000, avgExecutionTime: 9000, cacheable: true, cacheKeyTemplate: 'offboarding-{{input_hash}}-v1.0.0', cacheTTL: 604800000 }
  }
]

export default l2Manifests

export function getManifestById(id: string): L2ToolManifest | undefined {
  return l2Manifests.find(m => m.identity.id === id)
}

const CUSTOM_MANIFESTS_KEY = 'holo-custom-manifests'

export function loadCustomManifests(): L2ToolManifest[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MANIFESTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveCustomManifest(m: L2ToolManifest): void {
  const customs = loadCustomManifests()
  const idx = customs.findIndex(c => c.identity.id === m.identity.id)
  if (idx >= 0) customs[idx] = m
  else customs.push(m)
  localStorage.setItem(CUSTOM_MANIFESTS_KEY, JSON.stringify(customs))
  const existing = l2Manifests.findIndex(x => x.identity.id === m.identity.id)
  if (existing >= 0) l2Manifests[existing] = m
  else l2Manifests.push(m)
}

export function removeCustomManifest(id: string): void {
  const customs = loadCustomManifests().filter(c => c.identity.id !== id)
  localStorage.setItem(CUSTOM_MANIFESTS_KEY, JSON.stringify(customs))
  const idx = l2Manifests.findIndex(x => x.identity.id === id)
  if (idx >= 0) l2Manifests.splice(idx, 1)
}

export function initCustomManifests(): void {
  const customs = loadCustomManifests()
  for (const m of customs) {
    if (!l2Manifests.find(x => x.identity.id === m.identity.id)) {
      l2Manifests.push(m)
    }
  }
}