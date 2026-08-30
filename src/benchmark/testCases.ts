export interface TestCase {
  input: string
  label: string
  group: string
  expectedRoute: 'l0' | 'l05' | 'raap' | 'l1' | 'fingerprint'
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

function buildLongText(): string {
  const paragraphs = [
    CONTRACT_SAMPLE,
    `附表一：项目里程碑\nM1: 需求分析完成 2026-04-30\nM2: 系统设计评审 2026-05-31\nM3: 核心模块开发完成 2026-06-30\nM4: 集成测试通过 2026-08-15\nM5: 用户验收测试 2026-09-30\nM6: 正式上线 2026-10-31`,
    `附表二：人员配置\n项目经理：王芳（15人月）\n技术负责人：赵军（12人月）\n前端开发：3人×8人月\n后端开发：4人×8人月\n测试工程师：2人×6人月\n运维工程师：1人×3人月`,
    `附表三：技术规范\n数据库：PostgreSQL 15+\n应用服务器：4核8GB×2台\n负载均衡：Nginx + Keepalived\n监控：Prometheus + Grafana\n日志：ELK Stack\n安全：等保三级\n并发要求：1000 QPS\n响应时间：<200ms (P99)`
  ]
  return paragraphs.join('\n\n')
}

const LONG_TEXT = buildLongText()

export function getTestCases(): TestCase[] {
  return [
    { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式。`, label: 'A1_转换', group: 'A', expectedRoute: 'l0' },
    { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式。`, label: 'A2_转换_重复', group: 'A', expectedRoute: 'fingerprint' },
    { input: 'ls -la', label: 'A3_Shell', group: 'A', expectedRoute: 'l0' },
    { input: 'ls -la', label: 'A4_Shell_重复', group: 'A', expectedRoute: 'fingerprint' },
    { input: '查一下张三的报销单', label: 'A5_查询', group: 'A', expectedRoute: 'l05' },
    { input: '查一下张三的报销单', label: 'A6_查询_重复', group: 'A', expectedRoute: 'fingerprint' },

    { input: '翻译这句英文：Hello world, how are you?', label: 'B1_翻译_英', group: 'B', expectedRoute: 'l05' },
    { input: '把这句话译成中文：Good morning, everyone.', label: 'B2_翻译_英2', group: 'B', expectedRoute: 'l05' },
    { input: '写一段关于人工智能的文案', label: 'B3_生成_AI', group: 'B', expectedRoute: 'l0' },
    { input: '帮我生成一段介绍大模型的产品描述', label: 'B4_生成_产品', group: 'B', expectedRoute: 'l0' },

    { input: `${LONG_TEXT}\n\n分析这份财报，对比去年同期，预测下季度营收`, label: 'C1_分析', group: 'C', expectedRoute: 'raap' },
    { input: '写一份关于碳中和的深度研究报告，包含数据引用和结论', label: 'C2_报告', group: 'C', expectedRoute: 'raap' },

    { input: '今天几号？', label: 'D1_日期', group: 'D', expectedRoute: 'l0' },
    { input: '计算 1234 × 5678', label: 'D2_计算', group: 'D', expectedRoute: 'l0' },

    { input: `${LONG_TEXT}\n\n审查这份合同的条款风险`, label: 'E1_合同审查', group: 'E', expectedRoute: 'raap' },
    { input: '帮我写一份保密协议，要求违约金不低于50万', label: 'E2_NDA', group: 'E', expectedRoute: 'raap' }
  ]
}
