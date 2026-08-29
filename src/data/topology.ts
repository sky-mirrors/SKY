import { ToolLevel, JobRole, ToolNode, AdjacencyMap, SchemaField, Vector3 } from '@/models'

const L1_TOOLS: ToolNode[] = [
  {
    id: 'l1-knowledge-feeder',
    name: '知识库投喂员',
    level: ToolLevel.L1,
    position: { x: 2.5, y: 0, z: 0 },
    gridIndex: [5, 0, 0],
    description: '将散落的会议录音、PDF合同、邮件长文、Excel报表一键转化为AI可检索的本地知识库',
    apiRole: 'context_preparer',
    enabled: true,
    locked: true
  },
  {
    id: 'l1-model-gateway',
    name: '模型网关',
    level: ToolLevel.L1,
    position: { x: -2.5, y: 0, z: 0 },
    gridIndex: [-5, 0, 0],
    description: '自动探测本地API可用模型列表，一键切换不同模型。是所有AI工具的算力基础（L0.5基建）',
    apiRole: 'api_proxy',
    enabled: true,
    locked: true,
    isL05: true
  },
  {
    id: 'l1-task-translator',
    name: '任务翻译官',
    level: ToolLevel.L1,
    position: { x: 0, y: 2.5, z: 0 },
    gridIndex: [0, 5, 0],
    description: '将大白话自动翻译成结构化Prompt链条并调用模型网关执行',
    apiRole: 'prompt_chain',
    enabled: true,
    locked: true
  },
  {
    id: 'l1-pipeline-builder',
    name: '流水线搭建台',
    level: ToolLevel.L1,
    position: { x: 0, y: -2.5, z: 0 },
    gridIndex: [0, -5, 0],
    description: '将多步骤工作变成拖拽连接的流程图，实现一键全自动跑完。是所有工具的指挥家（Orchestrator）',
    apiRole: 'orchestrator',
    enabled: true,
    locked: true,
    isOrchestrator: true
  },
  {
    id: 'l1-workspace-memory',
    name: '工作区记忆体',
    level: ToolLevel.L1,
    position: { x: 0, y: 0, z: 2.5 },
    gridIndex: [0, 0, 5],
    description: '保存每个项目的历史问答上下文、已投喂的文件指纹，支持追问',
    apiRole: 'context_store',
    enabled: true,
    locked: true
  },
  {
    id: 'l1-result-beautifier',
    name: '结果美化师',
    level: ToolLevel.L1,
    position: { x: 0, y: 0, z: -2.5 },
    gridIndex: [0, 0, -5],
    description: '将AI输出的Markdown/JSON自动渲染为Word样式文本、PPT大纲或标准邮件格式',
    apiRole: 'renderer',
    enabled: true,
    locked: true
  }
]

const L0_NODE: ToolNode = {
  id: 'l0-user-core',
  name: '用户本体',
  level: ToolLevel.L0,
  position: { x: 0, y: 0, z: 0 },
  gridIndex: [0, 0, 0],
  description: '用户中心节点',
  enabled: true,
  locked: true,
  gravityWeight: 1,
  inputSchema: [
    { name: 'task', type: 'string', required: true, description: '用户输入的自然语言任务' },
    { name: 'context', type: 'string', required: false, description: '上下文信息' }
  ],
  outputSchema: [
    { name: 'steps', type: 'array', required: true, description: '分解后的执行步骤' },
    { name: 'result', type: 'markdown', required: true, description: '最终输出的Markdown格式结果' }
  ]
}

type L2Template = { id: string; name: string; jobRoles: JobRole[]; parentL1Id: string; comboToolIds?: string[]; description: string }

const L2_TEMPLATES: L2Template[] = [
  { id: 'l2-financial-report-brief', name: '财报风险一句话解读', jobRoles: [JobRole.Finance], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator'], description: '拖入PDF财报，自动输出一句话总结' },
  { id: 'l2-reimbursement-check', name: '报销单合规检查', jobRoles: [JobRole.Finance], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator', 'l1-result-beautifier'], description: '扫描报销单图片，提取金额判断合规性' },
  { id: 'l2-weekly-report-draft', name: '周报自动草稿', jobRoles: [JobRole.Finance, JobRole.General], parentL1Id: 'l1-pipeline-builder', comboToolIds: ['l1-workspace-memory'], description: '读取本周编辑过的文档生成周报草稿' },
  { id: 'l2-contract-risk-review', name: '合同风险审查', jobRoles: [JobRole.Legal], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator', 'l1-result-beautifier'], description: '上传合同PDF，自动标注风险条款' },
  { id: 'l2-legal-clause-compare', name: '条款对比助手', jobRoles: [JobRole.Legal], parentL1Id: 'l1-task-translator', description: '对比两份合同的差异条款' },
  { id: 'l2-resume-screening', name: '简历初筛助手', jobRoles: [JobRole.HR], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator'], description: '批量解析简历PDF，按岗位要求打分排序' },
  { id: 'l2-onboarding-guide-gen', name: '入职引导生成器', jobRoles: [JobRole.HR], parentL1Id: 'l1-pipeline-builder', comboToolIds: ['l1-result-beautifier'], description: '根据岗位自动生成入职checklist和资料清单' },
  { id: 'l2-sales-proposal-draft', name: '销售提案草稿', jobRoles: [JobRole.Sales], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-result-beautifier'], description: '输入客户需求，生成定制化提案初稿' },
  { id: 'l2-client-email-compose', name: '客户邮件撰写', jobRoles: [JobRole.Sales], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-workspace-memory', 'l1-result-beautifier'], description: '根据历史沟通记录生成跟进邮件' },
  { id: 'l2-meeting-minutes-gen', name: '会议纪要生成', jobRoles: [JobRole.General], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator', 'l1-result-beautifier'], description: '上传会议录音/文字，自动提取要点和行动项' },
  { id: 'l2-doc-translate-en', name: '文档翻译英文版', jobRoles: [JobRole.General], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-result-beautifier'], description: '将中文文档翻译为格式一致的英文版本' },
  { id: 'l2-ppt-outline-gen', name: 'PPT大纲生成', jobRoles: [JobRole.General], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-result-beautifier'], description: '输入主题，自动生成PPT大纲和要点' },
  { id: 'l2-data-excel-summary', name: 'Excel数据摘要', jobRoles: [JobRole.Finance, JobRole.General], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator'], description: '上传Excel，自动识别数据趋势和异常值' },
  { id: 'l2-announcement-draft', name: '公告通知草稿', jobRoles: [JobRole.HR, JobRole.General], parentL1Id: 'l1-task-translator', description: '根据要点自动生成正式公告文本' },
  { id: 'l2-competitor-analysis', name: '竞品分析报告', jobRoles: [JobRole.Sales], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator', 'l1-result-beautifier'], description: '输入竞品资料，生成对比分析报告' },
  { id: 'l2-policy-doc-qa', name: '政策文档问答', jobRoles: [JobRole.HR, JobRole.Legal], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-workspace-memory'], description: '投喂公司制度文档，自然语言查询' },
  { id: 'l2-email-categorizer', name: '邮件自动分类', jobRoles: [JobRole.General], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-pipeline-builder'], description: '自动识别邮件类型并归类打标签' },
  { id: 'l2-budget-forecast', name: '预算预测助手', jobRoles: [JobRole.Finance], parentL1Id: 'l1-knowledge-feeder', comboToolIds: ['l1-task-translator'], description: '基于历史数据预测下季度预算' },
  { id: 'l2-nd-review-checklist', name: 'ND审查清单', jobRoles: [JobRole.Legal], parentL1Id: 'l1-task-translator', comboToolIds: ['l1-result-beautifier'], description: '自动生成保密协议审查要点清单' },
  { id: 'l2-kpi-report-gen', name: 'KPI报告生成', jobRoles: [JobRole.General, JobRole.Sales], parentL1Id: 'l1-pipeline-builder', comboToolIds: ['l1-result-beautifier'], description: '汇总数据自动生成KPI达成报告' }
]

function buildL2Nodes(): ToolNode[] {
  const edgePositions: Vector3[] = []
  const cornerPositions: Vector3[] = []

  for (let a = -1; a <= 1; a += 2) {
    for (let b = -1; b <= 1; b += 2) {
      edgePositions.push({ x: a, y: b, z: 0 })
      edgePositions.push({ x: a, y: 0, z: b })
      edgePositions.push({ x: 0, y: a, z: b })
    }
  }

  for (let x = -1; x <= 1; x += 2) {
    for (let y = -1; y <= 1; y += 2) {
      for (let z = -1; z <= 1; z += 2) {
        cornerPositions.push({ x, y, z })
      }
    }
  }

  const allPositions = [...edgePositions, ...cornerPositions]
  const sqrt2 = Math.SQRT2
  const sqrt3 = Math.sqrt(3)

  return L2_TEMPLATES.map((tmpl, i) => {
    const pos = allPositions[i % allPositions.length]
    const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z)
    const isEdge = Math.abs(dist - sqrt2) < 0.01
    const isCorner = Math.abs(dist - sqrt3) < 0.01
    const scaleFactor = 3.0
    const scaledPos = {
      x: pos.x * scaleFactor,
      y: pos.y * scaleFactor,
      z: pos.z * scaleFactor
    }

    const gridCoords: [number, number, number] = [
      Math.round(scaledPos.x),
      Math.round(scaledPos.y),
      Math.round(scaledPos.z)
    ]

    return {
      id: tmpl.id,
      name: tmpl.name,
      level: ToolLevel.L2,
      position: scaledPos,
      gridIndex: gridCoords,
      description: tmpl.description,
      parentL1Id: tmpl.parentL1Id,
      comboToolIds: tmpl.comboToolIds,
      enabled: true,
      locked: false,
      communityHeat: 0,
      jobRoles: tmpl.jobRoles.map(r => r as string)
    }
  })
}

function buildL3Nodes(): ToolNode[] {
  const nodes: ToolNode[] = []
  const surfacePoints: Vector3[] = []

  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < 98; i++) {
    const y = 1 - (i / 97) * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = goldenAngle * i
    surfacePoints.push({
      x: Math.cos(theta) * radius,
      y: y,
      z: Math.sin(theta) * radius
    })
  }

  const l3Names = [
    'SEO优化建议', '代码审查助手', '数据清洗工具', '图片标签生成', '视频摘要提取',
    '舆情监控', '客户画像分析', '供应链预测', '招标文档解析', '专利检索助手',
    '发票OCR识别', '多语言邮件翻译', '会议日程安排', '项目进度跟踪', '风险预警雷达',
    '智能客服话术', '市场调研报告', '产品需求整理', '技术文档生成', 'API文档编写',
    '数据库查询助手', '日志分析工具', '性能监控面板', '安全扫描器', '合规检查清单',
    '培训材料生成', '员工满意度分析', '考勤异常检测', '薪资测算工具', '社保计算器',
    '离职风险预测', '招聘JD生成', '面试评估表', '团建方案推荐', '员工手册生成',
    '合同到期提醒', '知识产权登记', '诉讼材料整理', '法规变更追踪', '合规培训测试',
    '供应商评估', '采购比价助手', '库存预警系统', '物流追踪工具', '退货处理助手',
    '账龄分析工具', '现金流预测', '税务计算器', '审计日志查询', '费用分摊工具',
    '客户跟进提醒', '商机评分模型', '报价单生成', '合同模板库', '回款进度跟踪',
    '营销文案生成', '社媒内容规划', '广告投放优化', '用户反馈分析', '品牌监测工具',
    '竞品价格追踪', '渠道效果评估', '活动策划助手', '会员管理工具', '积分规则配置',
    '工单自动分配', 'SLA监控面板', '知识图谱构建', 'FAQ自动生成', '对话意图识别',
    '情感分析引擎', '文本校对工具', '格式转换器', '批量水印添加', '文档对比工具',
    '电子签章助手', '文件加密工具', '云存储同步', '版本管理器', '协作批注工具',
    '日程冲突检测', '会议录屏工具', '白板协作助手', '投票决策工具', '任务看板生成',
    '周计划生成器', '习惯追踪器', '专注模式计时', '笔记关联图谱', '剪藏整理工具',
    '阅读摘要生成', '学习路径规划', '考试题库生成', '闪卡制作工具', '翻译对照检查',
    '术语库管理', '风格指南检查'
  ]

  const count = Math.min(98, surfacePoints.length)
  for (let i = 0; i < count; i++) {
    const pos = surfacePoints[i]
    const normalizedPos = {
      x: pos.x * 5,
      y: pos.y * 5,
      z: pos.z * 5
    }

    nodes.push({
      id: `l3-community-${i + 1}`,
      name: l3Names[i] || `社区工具${i + 1}`,
      level: ToolLevel.L3,
      position: normalizedPos,
      gridIndex: [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)],
      description: '社区自动推荐工具',
      enabled: true,
      locked: false,
      communityHeat: Math.random() * 100,
      lastUsedAt: Date.now() - Math.random() * 30 * 24 * 3600 * 1000
    })
  }

  return nodes
}

export function generateAllNodes(): ToolNode[] {
  const l2Nodes = buildL2Nodes()
  const l3Nodes = buildL3Nodes()
  return [L0_NODE, ...L1_TOOLS, ...l2Nodes, ...l3Nodes]
}

export function buildAdjacencyMap(nodes: ToolNode[]): AdjacencyMap {
  const map: AdjacencyMap = {}
  for (const node of nodes) {
    const neighbors: string[] = []
    for (const other of nodes) {
      if (node.id === other.id) continue
      const md =
        Math.abs(node.gridIndex[0] - other.gridIndex[0]) +
        Math.abs(node.gridIndex[1] - other.gridIndex[1]) +
        Math.abs(node.gridIndex[2] - other.gridIndex[2])
      if (md === 1) {
        neighbors.push(other.id)
      }
    }
    map[node.id] = neighbors
  }
  return map
}

export function getJobRoleTemplates(jobRole: JobRole): string[] {
  return L2_TEMPLATES.filter(t => t.jobRoles.includes(jobRole)).map(t => t.id)
}

export { L1_TOOLS, L0_NODE, L2_TEMPLATES }
