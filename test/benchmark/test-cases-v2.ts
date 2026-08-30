export interface TestCaseV2 {
  input: string
  label: string
  group: string
  domain: string
  expectedRoute: 'l0' | 'l05' | 'raap'
  l0RequiresLlm: boolean
  isRepeat: boolean
  repeatOf: string | null
}

export const DOMAINS = ['file', 'system', 'creation', 'translation', 'legal', 'finance', 'code', 'office'] as const
export type Domain = typeof DOMAINS[number]
export const DOMAIN_LABELS: Record<string, string> = {
  file: '文件操作', system: '系统命令', creation: '文本生成',
  translation: '翻译查询', legal: '法律合规', finance: '财务分析',
  code: '代码开发', office: '日常办公'
}

const CONTRACT_SAMPLE = `甲方：北京星辰科技有限公司
乙方：上海瀚海数据服务有限公司
合同编号：XCH-2026-0089
签订日期：2026年3月15日

一、合作范围
甲方委托乙方进行数据平台建设，项目总金额￥1,280,000.00（大写：壹佰贰拾捌万元整）。
付款方式：合同签订后支付30%预付款即￥384,000.00，中期验收后支付40%即￥512,000.00，终验后支付30%即￥384,000.00。

二、项目周期
项目启动日期：2026年4月1日
中期验收截止：2026年7月31日
终验截止：2026年10月31日
如延期交付，每延期一天，乙方需支付合同总额0.05%即￥640.00/天的违约金。

三、保密条款
双方应对本合同及项目过程中知悉的对方商业秘密严格保密，保密期限为合同终止后3年。
违反保密义务的一方应赔偿对方因此遭受的全部损失，最低不少于￥100,000.00。

四、知识产权
项目交付物的知识产权归甲方所有，乙方不得将项目成果用于其他客户或自行商业化。

五、争议解决
因本合同引起的争议，双方应协商解决；协商不成的，提交北京仲裁委员会仲裁。

甲方签字：张伟总经理
乙方签字：李明总监
日期：2026年3月15日`

const LONG_TEXT = [
  CONTRACT_SAMPLE,
  '附表一：项目里程碑 M1需求分析 M2系统设计 M3核心开发 M4集成测试 M5用户验收 M6正式上线',
  '附表二：人员配置 项目经理王芳15人月 技术负责人赵军12人月 前端3人×8人月 后端4人×8人月 测试2人×6人月',
  '附表三：技术规范 PostgreSQL15+ 应用服务器4核8GB×2台 负载均衡Nginx+Keepalived 监控Prometheus+Grafana 并发1000QPS 响应<200ms'
].join('\n\n')

const FINANCE_TEXT = `2026年度Q2财务报表
公司：北京星辰科技有限公司
报告期：2026年4月1日 - 2026年6月30日

一、营收概况
总营收：￥48,560,000（同比增长12.3%）
其中：软件产品收入￥32,100,000（占比66.1%）
服务收入￥11,260,000（占比23.2%）
硬件销售￥5,200,000（占比10.7%）

二、成本结构
营业成本：￥29,136,000（成本率60.0%）
人力成本：￥18,240,000（占营收37.6%）
研发投入：￥8,740,000（占营收18.0%）
销售费用：￥4,370,400（占营收9.0%）
管理费用：￥2,913,600（占营收6.0%）

三、利润
毛利润：￥19,424,000（毛利率40.0%）
营业利润：￥3,400,000
净利润：￥2,890,000（净利率5.95%）

四、现金流
经营活动现金流：￥5,120,000
投资活动现金流：-￥2,340,000
筹资活动现金流：-￥890,000`

const CODE_TEXT = `// user-service.ts - 用户服务模块
import { Database } from './database'
import { Validator } from './validator'

export class UserService {
  private db: Database
  private validator: Validator

  constructor(db: Database, validator: Validator) {
    this.db = db
    this.validator = validator
  }

  async getUser(id: string): Promise<User | null> {
    if (!this.validator.isUUID(id)) {
      throw new Error('Invalid user ID format')
    }
    return this.db.query('SELECT * FROM users WHERE id = $1', [id])
  }

  async createUser(data: CreateUserDTO): Promise<User> {
    const errors = this.validator.validateUser(data)
    if (errors.length > 0) {
      throw new ValidationError(errors)
    }
    const hashedPassword = await bcrypt.hash(data.password, 10)
    return this.db.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *',
      [data.name, data.email, hashedPassword]
    )
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM users WHERE id = $1', [id])
    return result.rowCount > 0
  }
}`

export function getTestCasesV2(): TestCaseV2[] {
  return [
    // ═══ Group A: 文件操作 (file) ═══
    { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式`, label: 'A1', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '将季度报告导出为docx格式', label: 'A2', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '读取一下config.json文件的内容', label: 'A3', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '在桌面创建一个txt文档', label: 'A4', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${LONG_TEXT}\n\n翻译这份文件的内容为英文`, label: 'A5', group: 'A', domain: 'file', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成一份文档摘要说明', label: 'A6', group: 'A', domain: 'file', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一个文件批量重命名脚本', label: 'A7', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: `${LONG_TEXT}\n\n审查这份合同的条款风险`, label: 'A8', group: 'A', domain: 'file', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '分析文件目录结构并推荐最佳组织方式', label: 'A9', group: 'A', domain: 'file', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式`, label: 'A10', group: 'A', domain: 'file', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, repeatOf: 'A1' },

    // ═══ Group B: 系统命令 (system) ═══
    { input: 'ls -la', label: 'B1', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: 'whoami', label: 'B2', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: 'npm install axios', label: 'B3', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: 'git status', label: 'B4', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '运行 npm run build', label: 'B5', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '执行 python train_model.py', label: 'B6', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: 'curl https://api.example.com/health', label: 'B7', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成部署脚本的配置文件', label: 'B8', group: 'B', domain: 'system', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生产环境服务器返回500错误，帮我排查根本原因', label: 'B9', group: 'B', domain: 'system', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: 'ls -la', label: 'B10', group: 'B', domain: 'system', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: true, repeatOf: 'B1' },

    // ═══ Group C: 文本生成 (creation) ═══
    { input: '写一段关于人工智能的文案', label: 'C1', group: 'C', domain: 'creation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '帮我写一个公告通知全公司下周体检', label: 'C2', group: 'C', domain: 'creation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '生成一段Python排序函数代码', label: 'C3', group: 'C', domain: 'creation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '起草一封给客户的道歉邮件', label: 'C4', group: 'C', domain: 'creation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '写一份周报总结本周项目进展', label: 'C5', group: 'C', domain: 'creation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '帮我生成一份竞品分析报告', label: 'C6', group: 'C', domain: 'creation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一份会议纪要，包含参会人员和决议事项', label: 'C7', group: 'C', domain: 'creation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '撰写年度技术白皮书，包含行业趋势分析和战略建议', label: 'C8', group: 'C', domain: 'creation', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成市场调研报告，需要数据引用和竞品对比', label: 'C9', group: 'C', domain: 'creation', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一段关于人工智能的文案', label: 'C10', group: 'C', domain: 'creation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, repeatOf: 'C1' },

    // ═══ Group D: 翻译查询 (translation) ═══
    { input: '翻译这句英文：The quick brown fox jumps over the lazy dog', label: 'D1', group: 'D', domain: 'translation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '把这句话译成中文：Artificial intelligence is transforming every industry.', label: 'D2', group: 'D', domain: 'translation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '翻译：Nous devons accélérer la transformation numérique', label: 'D3', group: 'D', domain: 'translation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '今天几号？', label: 'D4', group: 'D', domain: 'translation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '计算 9876 × 5432', label: 'D5', group: 'D', domain: 'translation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '现在是几点几分？', label: 'D6', group: 'D', domain: 'translation', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '翻译这份技术文档并解释其中的专业术语', label: 'D7', group: 'D', domain: 'translation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '对比中英文版本的法律条款差异，给出风险评估', label: 'D8', group: 'D', domain: 'translation', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '将产品说明书翻译成5种语言，确保文化适应性', label: 'D9', group: 'D', domain: 'translation', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '翻译这句英文：The quick brown fox jumps over the lazy dog', label: 'D10', group: 'D', domain: 'translation', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, repeatOf: 'D1' },

    // ═══ Group E: 法律合规 (legal) ═══
    { input: '帮我写一份保密协议，要求违约金不低于50万', label: 'E1', group: 'E', domain: 'legal', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${LONG_TEXT}\n\n审查这份合同的条款风险`, label: 'E2', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成一份劳动合同模板', label: 'E3', group: 'E', domain: 'legal', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '检查公司数据隐私政策是否符合GDPR要求', label: 'E4', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '合同中的竞业限制条款是否合法有效', label: 'E5', group: 'E', domain: 'legal', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${FINANCE_TEXT}\n\n分析这份财报中的税务合规风险`, label: 'E6', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '撰写知识产权转让协议，包含专利和商标', label: 'E7', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '评估跨境数据传输的法律风险和合规要求', label: 'E8', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '对比中国和欧盟隐私保护法规的异同', label: 'E9', group: 'E', domain: 'legal', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '帮我写一份保密协议，要求违约金不低于50万', label: 'E10', group: 'E', domain: 'legal', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, repeatOf: 'E1' },

    // ═══ Group F: 财务分析 (finance) ═══
    { input: '算一下公司本月水电费总计：房租18000+电费3200+水费680', label: 'F1', group: 'F', domain: 'finance', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '查一下张三的报销单', label: 'F2', group: 'F', domain: 'finance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成Q2预算执行情况摘要', label: 'F3', group: 'F', domain: 'finance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '帮我做一份KPI达成率报告', label: 'F4', group: 'F', domain: 'finance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${FINANCE_TEXT}\n\n分析这份财报，对比去年同期，预测下季度营收`, label: 'F5', group: 'F', domain: 'finance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${FINANCE_TEXT}\n\n评估公司现金流健康度，给出优化建议`, label: 'F6', group: 'F', domain: 'finance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '制定下年度成本优化方案，目标降低15%运营成本', label: 'F7', group: 'F', domain: 'finance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '投资组合风险评估，包含股票债券基金配置建议', label: 'F8', group: 'F', domain: 'finance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '报销差旅费，北京到上海往返机票+3天住宿', label: 'F9', group: 'F', domain: 'finance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '查一下张三的报销单', label: 'F10', group: 'F', domain: 'finance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, repeatOf: 'F2' },

    // ═══ Group G: 代码开发 (code) ═══
    { input: '写一个JavaScript防抖函数', label: 'G1', group: 'G', domain: 'code', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '帮我生成一个REST API接口的TypeScript类型定义', label: 'G2', group: 'G', domain: 'code', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: 'npm run test', label: 'G3', group: 'G', domain: 'code', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${CODE_TEXT}\n\n这段代码有什么bug？帮我修复`, label: 'G4', group: 'G', domain: 'code', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成API文档，包含请求参数和响应格式', label: 'G5', group: 'G', domain: 'code', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一段代码审核的总结报告', label: 'G6', group: 'G', domain: 'code', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '设计微服务架构，包含服务拆分策略和通信方案', label: 'G7', group: 'G', domain: 'code', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: `${CODE_TEXT}\n\n重构这段代码，提升性能和可维护性，给出详细方案`, label: 'G8', group: 'G', domain: 'code', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '制定技术债务清理计划，包含优先级排序和资源估算', label: 'G9', group: 'G', domain: 'code', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一个JavaScript防抖函数', label: 'G10', group: 'G', domain: 'code', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, repeatOf: 'G1' },

    // ═══ Group H: 日常办公 (office) ═══
    { input: '今天星期几？', label: 'H1', group: 'H', domain: 'office', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '计算 (4500 + 3200) × 0.85', label: 'H2', group: 'H', domain: 'office', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '创建一个名为项目归档的文件夹', label: 'H3', group: 'H', domain: 'office', expectedRoute: 'l0', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '写一段通知：明天下午3点全员大会', label: 'H4', group: 'H', domain: 'office', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, repeatOf: null },
    { input: '帮我写一份周报，包含本周完成事项和下周计划', label: 'H5', group: 'H', domain: 'office', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '生成报销单模板，包含差旅和餐饮', label: 'H6', group: 'H', domain: 'office', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '撰写本月工作总结，包含项目进度和团队表现', label: 'H7', group: 'H', domain: 'office', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '制定Q3部门资源分配方案，包含人力和预算', label: 'H8', group: 'H', domain: 'office', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '分析项目进度偏差原因，给出纠偏措施和风险评估', label: 'H9', group: 'H', domain: 'office', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, repeatOf: null },
    { input: '今天星期几？', label: 'H10', group: 'H', domain: 'office', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, repeatOf: 'H1' }
  ]
}
