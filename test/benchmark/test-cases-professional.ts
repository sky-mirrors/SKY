export interface ProfessionalTestCase {
  input: string
  label: string
  profession: 'accounting' | 'legal'
  timeSlot: 'morning' | 'afternoon' | 'overtime'
  taskType: string
  expectedRoute: 'l0' | 'l05' | 'raap'
  l0RequiresLlm: boolean
  isRepeat: boolean
  isVariant: boolean
  repeatOf: string | null
  variantOf: string | null
}

const INVOICE_SAMPLE_A = `发票代码：044002100311
发票号码：28472961
开票日期：2026年08月15日
购买方：北京星辰科技有限公司 纳税人识别号：91110108MA01WXYZ3K
销售方：上海瀚海数据服务有限公司 纳税人识别号：91310115MA1HABCD2E
商品名称：数据平台建设服务
数量：1 单价：￥128,000.00
金额：￥128,000.00 税率：6% 税额：￥7,680.00
价税合计：￥135,680.00`

const INVOICE_SAMPLE_B = `发票代码：044002100312
发票号码：28472962
开票日期：2026年08月16日
购买方：北京星辰科技有限公司 纳税人识别号：91110108MA01WXYZ3K
销售方：深圳云端网络技术有限公司 纳税人识别号：91440300MA5EFGHJ3K
商品名称：云服务器租赁费（2026年8月）
数量：12 单价：￥2,500.00/月
金额：￥30,000.00 税率：6% 税额：￥1,800.00
价税合计：￥31,800.00`

const INVOICE_SAMPLE_C = `发票代码：044002100313
发票号码：28472963
开票日期：2026年08月17日
购买方：北京星辰科技有限公司 纳税人识别号：91110108MA01WXYZ3K
销售方：广州博雅办公用品有限公司 纳税人识别号：91440106MA59KLMN4P
商品名称：办公设备采购（笔记本电脑×5+显示器×5）
金额：￥45,000.00 税率：13% 税额：￥5,850.00
价税合计：￥50,850.00`

const LEDGER_DATA = `科目余额表 2026年8月
科目编码    科目名称        期初余额        本期借方        本期贷方        期末余额
1001      库存现金        15,200.00      28,000.00      31,500.00      11,700.00
1002      银行存款        2,450,000.00   1,856,000.00   1,623,000.00   2,683,000.00
1122      应收账款        890,000.00     567,000.00     432,000.00     1,025,000.00
2202      应付账款        675,000.00     398,000.00     512,000.00     789,000.00
2221      应交税费        128,000.00     95,000.00      107,000.00     140,000.00
6001      主营业务收入                   1,856,000.00                   1,856,000.00
6401      主营业务成本                   1,123,000.00                   1,123,000.00
6601      管理费用                       287,000.00                     287,000.00
6602      销售费用                       156,000.00                     156,000.00
6603      财务费用                       12,000.00                      12,000.00`

const FINANCIAL_REPORT_Q2 = `2026年度Q2财务报表
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

const CONTRACT_A = `甲方：北京星辰科技有限公司
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

const CONTRACT_B = `甲方：北京星辰科技有限公司
乙方：深圳云端网络技术有限公司
合同编号：XCH-2026-0092
签订日期：2026年5月20日

一、合作范围
甲方委托乙方提供云基础设施运维服务，服务期12个月，服务费￥960,000.00/年。
付款方式：季度预付￥240,000.00。

二、服务标准
系统可用性不低于99.9%，每月计划外停机时间不超过43分钟。
响应时间：P1故障15分钟内响应，P2故障30分钟内响应。

三、保密条款
双方应对本合同及服务过程中知悉的对方商业秘密严格保密，保密期限为合同终止后2年。
违反保密义务的一方应赔偿对方因此遭受的全部损失，最低不少于￥200,000.00。

四、违约责任
如乙方未达到服务标准，每降低0.1%可用性，扣减当季服务费的5%。
如甲方逾期付款，每逾期一天，需支付应付金额0.05%的滞纳金。

五、争议解决
因本合同引起的争议，双方应协商解决；协商不成的，提交深圳国际仲裁院仲裁。

甲方签字：张伟总经理
乙方签字：王芳总监
日期：2026年5月20日`

const CONTRACT_C = `甲方：北京星辰科技有限公司
乙方：广州博雅办公用品有限公司
合同编号：XCH-2026-0095
签订日期：2026年7月10日

一、合作范围
甲方向乙方采购办公设备与耗材，框架协议金额￥500,000.00/年。
按实际采购订单结算，季度对账。

二、交付与验收
乙方应在收到订单后3个工作日内交付，甲方收货后5个工作日内验收。
如交付商品不符合约定，乙方应在5个工作日内更换。

三、保密条款
双方应对本合同及交易过程中知悉的对方商业秘密严格保密，保密期限为合同终止后1年。

四、知识产权
乙方提供的设备如有知识产权纠纷，由乙方承担全部责任。

五、争议解决
因本合同引起的争议，双方应协商解决；协商不成的，提交广州仲裁委员会仲裁。

甲方签字：张伟总经理
乙方签字：赵军经理
日期：2026年7月10日`

const NDA_TEMPLATE = `保密协议（NDA）

甲方（披露方）：______
乙方（接收方）：______
签订日期：______

一、保密信息范围
甲方拟向乙方披露的与______项目相关的技术方案、商业计划、客户数据、财务信息等均属保密信息。

二、保密义务
1. 乙方仅可将保密信息用于评估上述项目的合作目的
2. 乙方应对保密信息采取不低于保护自身同等重要信息的保密措施
3. 未经甲方书面同意，乙方不得向任何第三方披露保密信息

三、保密期限
自本协议签署之日起______年

四、违约责任
违反保密义务的一方应赔偿对方因此遭受的全部损失，最低不少于人民币______万元

五、适用法律
本协议适用中华人民共和国法律`

const DD_CHECKLIST = `尽职调查清单 - 标准模板

A. 公司基本信息
1. 营业执照副本 2. 公司章程及修正案 3. 股东名册及出资证明
4. 董监高名单及简历 5. 组织架构图

B. 财务信息
1. 近三年审计报告 2. 近三年纳税申报表 3. 银行流水（近12个月）
4. 应收账款账龄分析 5. 存货盘点报告

C. 法律合规
1. 重大合同清单 2. 诉讼仲裁案件 3. 行政处罚记录
4. 知识产权清单 5. 劳动合同及社保缴纳

D. 业务运营
1. 主要客户及供应商清单 2. 业务资质许可 3. 竞争分析
4. 关联交易情况 5. 数据安全合规`

export function getAccountingMorningCases(): ProfessionalTestCase[] {
  return [
    { input: `${INVOICE_SAMPLE_A}\n\n提取这张发票的关键信息：发票号码、金额、税率、税额`, label: 'ACCT-AM01', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${INVOICE_SAMPLE_B}\n\n提取这张发票的关键信息：发票号码、金额、税率、税额`, label: 'ACCT-AM02', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${INVOICE_SAMPLE_C}\n\n提取这张发票的关键信息：发票号码、金额、税率、税额`, label: 'ACCT-AM03', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${INVOICE_SAMPLE_A}\n\n提取这张发票的关键信息：发票号码、金额、税率、税额`, label: 'ACCT-AM04', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'ACCT-AM01', variantOf: null },
    { input: `${INVOICE_SAMPLE_B}\n\n验证这张发票的税额计算是否正确`, label: 'ACCT-AM05', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM02' },
    { input: `${INVOICE_SAMPLE_C}\n\n验证这张发票的税额计算是否正确`, label: 'ACCT-AM06', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM03' },
    { input: `${LEDGER_DATA}\n\n核对科目余额表，标注异常波动科目`, label: 'ACCT-AM07', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `录入银行回单：8月15日收到客户A货款￥432,000.00，8月16日付供应商B材料款￥198,500.00，8月17日代扣社保￥67,200.00`, label: 'ACCT-AM08', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `录入银行回单：8月18日收到客户C预付款￥150,000.00，8月19日付房租￥28,000.00，8月20日付水电费￥3,200.00`, label: 'ACCT-AM09', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM08' },
    { input: `${LEDGER_DATA}\n\n核对科目余额表，标注异常波动科目`, label: 'ACCT-AM10', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'ACCT-AM07', variantOf: null },
    { input: `核对8月工资表：应发总额￥892,000.00，代扣个税￥53,600.00，代扣社保￥134,000.00，实发￥704,400.00，验算是否平衡`, label: 'ACCT-AM11', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `核对8月工资表：应发总额￥892,000.00，代扣个税￥53,600.00，代扣社保￥134,000.00，实发￥704,400.00，验算是否平衡`, label: 'ACCT-AM12', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-AM11', variantOf: null },
    { input: '计算 135680 + 31800 + 50850 三张发票合计金额', label: 'ACCT-AM13', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '今天几号？', label: 'ACCT-AM14', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '当前人民币对美元汇率是多少？计算10000美元折合人民币', label: 'ACCT-AM15', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${INVOICE_SAMPLE_A}\n\n归档这张发票到8月应付账款`, label: 'ACCT-AM16', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM01' },
    { input: `${INVOICE_SAMPLE_B}\n\n归档这张发票到8月应付账款`, label: 'ACCT-AM17', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM02' },
    { input: `${INVOICE_SAMPLE_C}\n\n归档这张发票到8月应付账款`, label: 'ACCT-AM18', profession: 'accounting', timeSlot: 'morning', taskType: 'invoice', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM03' },
    { input: `核对9月工资表：应发总额￥920,000.00，代扣个税￥57,500.00，代扣社保￥138,000.00，实发￥724,500.00，验算是否平衡`, label: 'ACCT-AM19', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-AM11' },
    { input: '计算 432000 + 150000 + 89000 本月回款总额', label: 'ACCT-AM20', profession: 'accounting', timeSlot: 'morning', taskType: 'data_entry', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
  ]
}

export function getAccountingAfternoonCases(): ProfessionalTestCase[] {
  return [
    { input: `${FINANCIAL_REPORT_Q2}\n\n生成Q2财务摘要报告`, label: 'ACCT-PM01', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `根据以下数据生成月度费用分析报告：\n管理费用：房租28000+物业5000+办公耗材12000+差旅18000+招待8000=71000\n销售费用：广告50000+佣金35000+运输12000=97000\n研发费用：人员工资68000+设备折旧15000+云服务8000=91000`, label: 'ACCT-PM02', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${FINANCIAL_REPORT_Q2}\n\n生成Q2现金流量分析摘要`, label: 'ACCT-PM03', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM01' },
    { input: `${FINANCIAL_REPORT_Q2}\n\n深度分析Q2财报，对比去年同期，预测Q3营收趋势，评估盈利能力持续性`, label: 'ACCT-PM04', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `生成年度财务决算报告框架，包含资产负债分析、利润分配方案、盈余公积计提建议`, label: 'ACCT-PM05', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${FINANCIAL_REPORT_Q2}\n\n生成Q2财务摘要报告`, label: 'ACCT-PM06', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'ACCT-PM01', variantOf: null },
    { input: `计算增值税：销售额￥856,000（含税），税率6%，求不含税销售额和应纳税额`, label: 'ACCT-PM07', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `计算增值税：销售额￥1,250,000（含税），税率13%，求不含税销售额和应纳税额`, label: 'ACCT-PM08', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM07' },
    { input: `计算企业所得税：利润总额￥2,890,000，纳税调增￥120,000（招待费超标），纳税调减￥80,000（研发加计扣除），税率25%，求应纳税额`, label: 'ACCT-PM09', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `计算企业所得税：利润总额￥3,450,000，纳税调增￥95,000（招待费超标），纳税调减￥120,000（研发加计扣除），税率25%，求应纳税额`, label: 'ACCT-PM10', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM09' },
    { input: `计算个税：月薪￥35,000，五险一金扣除￥5,250，专项附加扣除￥3,000，求应纳税额`, label: 'ACCT-PM11', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `计算个税：月薪￥28,000，五险一金扣除￥4,200，专项附加扣除￥2,000，求应纳税额`, label: 'ACCT-PM12', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM11' },
    { input: `检查8月增值税申报表：销项税额￥156,800，进项税额￥89,200，进项转出￥3,500，本期应纳税额是否正确`, label: 'ACCT-PM13', profession: 'accounting', timeSlot: 'afternoon', taskType: 'compliance', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查公司财务制度是否合规：差旅费标准（总监级住宿800/晚、经理级500/晚、员工级300/晚）是否超过税法扣除限额`, label: 'ACCT-PM14', profession: 'accounting', timeSlot: 'afternoon', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查8月增值税申报表：销项税额￥156,800，进项税额￥89,200，进项转出￥3,500，本期应纳税额是否正确`, label: 'ACCT-PM15', profession: 'accounting', timeSlot: 'afternoon', taskType: 'compliance', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-PM13', variantOf: null },
    { input: `${FINANCIAL_REPORT_Q2}\n\n生成Q2利润分析摘要`, label: 'ACCT-PM16', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM01' },
    { input: `根据以下数据生成月度费用分析报告：\n管理费用：房租28000+物业5000+办公耗材12000+差旅18000+招待8000=71000\n销售费用：广告50000+佣金35000+运输12000=97000\n研发费用：人员工资68000+设备折旧15000+云服务8000=91000`, label: 'ACCT-PM17', profession: 'accounting', timeSlot: 'afternoon', taskType: 'report', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'ACCT-PM02', variantOf: null },
    { input: `计算增值税：销售额￥560,000（含税），税率6%，求不含税销售额和应纳税额`, label: 'ACCT-PM18', profession: 'accounting', timeSlot: 'afternoon', taskType: 'tax', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM07' },
    { input: `检查9月增值税申报表：销项税额￥168,500，进项税额￥95,600，进项转出￥4,200，本期应纳税额是否正确`, label: 'ACCT-PM19', profession: 'accounting', timeSlot: 'afternoon', taskType: 'compliance', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM13' },
    { input: `检查公司报销制度是否合规：餐饮费标准（总监级500/餐、经理级300/餐、员工级150/餐）是否超过税法扣除限额`, label: 'ACCT-PM20', profession: 'accounting', timeSlot: 'afternoon', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-PM14' },
  ]
}

export function getAccountingOvertimeCases(): ProfessionalTestCase[] {
  return [
    { input: `生成Q3预算：研发部门——人员成本￥2,400,000，设备采购￥580,000，云服务￥360,000，培训￥120,000，差旅￥85,000，合计预算多少`, label: 'ACCT-OT01', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `生成Q3预算：销售部门——人员成本￥1,800,000，广告投放￥650,000，渠道佣金￥420,000，差旅￥200,000，招待￥95,000，合计预算多少`, label: 'ACCT-OT02', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT01' },
    { input: `Q2实际费用：研发人员￥2,350,000、设备￥620,000、云服务￥340,000、培训￥95,000、差旅￥78,000。与预算偏差分析`, label: 'ACCT-OT03', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `制定下年度成本优化方案，目标降低15%运营成本，需要分析各部门费用结构并提出具体措施`, label: 'ACCT-OT04', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `生成Q3预算：研发部门——人员成本￥2,400,000，设备采购￥580,000，云服务￥360,000，培训￥120,000，差旅￥85,000，合计预算多少`, label: 'ACCT-OT05', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-OT01', variantOf: null },
    { input: `生成Q3预算：销售部门——人员成本￥1,800,000，广告投放￥650,000，渠道佣金￥420,000，差旅￥200,000，招待￥95,000，合计预算多少`, label: 'ACCT-OT06', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-OT02', variantOf: null },
    { input: '算一下公司本月水电费总计：房租18000+电费3200+水费680', label: 'ACCT-OT07', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '计算 (4500 + 3200) × 0.85 折扣后金额', label: 'ACCT-OT08', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '查一下张三的报销单', label: 'ACCT-OT09', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `Q2实际费用：销售部门人员￥1,750,000、广告￥620,000、佣金￥380,000、差旅￥185,000、招待￥88,000。与预算偏差分析`, label: 'ACCT-OT10', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT03' },
    { input: '计算 (28000 + 5000 + 12000) × 12 年度管理费用固定成本', label: 'ACCT-OT11', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '查一下李四的报销单', label: 'ACCT-OT12', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT09' },
    { input: `生成Q3预算：行政部门——人员成本￥960,000，办公费￥180,000，差旅￥65,000，培训￥45,000，合计预算多少`, label: 'ACCT-OT13', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT01' },
    { input: `生成Q3预算：研发部门——人员成本￥2,400,000，设备采购￥580,000，云服务￥360,000，培训￥120,000，差旅￥85,000，合计预算多少`, label: 'ACCT-OT14', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-OT01', variantOf: null },
    { input: `评估公司全年预算执行率，按部门分解差异原因，提出Q4调整建议`, label: 'ACCT-OT15', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT04' },
    { input: '算一下 2400000 + 580000 + 360000 + 120000 + 85000 研发部Q3预算总额', label: 'ACCT-OT16', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT01' },
    { input: `生成Q3预算：行政部门——人员成本￥960,000，办公费￥180,000，差旅￥65,000，培训￥45,000，合计预算多少`, label: 'ACCT-OT17', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: true, isVariant: false, repeatOf: 'ACCT-OT13', variantOf: null },
    { input: '现在几点几分？', label: 'ACCT-OT18', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '计算 1800000 + 650000 + 420000 + 200000 + 95000 销售部Q3预算总额', label: 'ACCT-OT19', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT02' },
    { input: '查一下王五的报销单', label: 'ACCT-OT20', profession: 'accounting', timeSlot: 'overtime', taskType: 'budget', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'ACCT-OT09' },
  ]
}

export function getLegalMorningCases(): ProfessionalTestCase[] {
  return [
    { input: `${CONTRACT_A}\n\n审查这份合同的条款风险`, label: 'LEGAL-AM01', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${CONTRACT_B}\n\n审查这份合同的条款风险`, label: 'LEGAL-AM02', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM01' },
    { input: `${CONTRACT_C}\n\n审查这份合同的条款风险`, label: 'LEGAL-AM03', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM01' },
    { input: `${CONTRACT_A}\n\n审查这份合同中的保密条款是否充分保护甲方利益`, label: 'LEGAL-AM04', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM01' },
    { input: `${CONTRACT_B}\n\n审查这份合同中的违约责任条款是否合理`, label: 'LEGAL-AM05', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM02' },
    { input: `${CONTRACT_C}\n\n审查这份合同中的争议解决条款是否适合我方`, label: 'LEGAL-AM06', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM03' },
    { input: `${CONTRACT_A}\n\n审查这份合同的条款风险`, label: 'LEGAL-AM07', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM01', variantOf: null },
    { input: `${CONTRACT_B}\n\n审查这份合同的条款风险`, label: 'LEGAL-AM08', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM02', variantOf: null },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于50万，保密期限3年`, label: 'LEGAL-AM09', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于100万，保密期限5年`, label: 'LEGAL-AM10', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM09' },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于30万，保密期限2年，仅限技术信息`, label: 'LEGAL-AM11', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM09' },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于50万，保密期限3年`, label: 'LEGAL-AM12', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM09', variantOf: null },
    { input: `${CONTRACT_A}\n\n审查这份合同的付款条款是否对我方有利`, label: 'LEGAL-AM13', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM01' },
    { input: `${CONTRACT_C}\n\n审查这份合同的交付验收条款是否完善`, label: 'LEGAL-AM14', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM03' },
    { input: `${CONTRACT_A}\n\n审查这份合同的付款条款是否对我方有利`, label: 'LEGAL-AM15', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM13', variantOf: null },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于80万，保密期限4年，涵盖技术信息和商业信息`, label: 'LEGAL-AM16', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM09' },
    { input: `${CONTRACT_B}\n\n审查这份合同的服务标准条款是否对我方有利`, label: 'LEGAL-AM17', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-AM02' },
    { input: `${CONTRACT_A}\n\n审查这份合同中的保密条款是否充分保护甲方利益`, label: 'LEGAL-AM18', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM04', variantOf: null },
    { input: `${NDA_TEMPLATE}\n\n帮我写一份保密协议，要求违约金不低于80万，保密期限4年，涵盖技术信息和商业信息`, label: 'LEGAL-AM19', profession: 'legal', timeSlot: 'morning', taskType: 'nda', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM16', variantOf: null },
    { input: `${CONTRACT_B}\n\n审查这份合同中的违约责任条款是否合理`, label: 'LEGAL-AM20', profession: 'legal', timeSlot: 'morning', taskType: 'contract_review', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-AM05', variantOf: null },
  ]
}

export function getLegalAfternoonCases(): ProfessionalTestCase[] {
  return [
    { input: `检索《中华人民共和国劳动合同法》第39条关于用人单位单方解除劳动合同的规定，并解释适用条件`, label: 'LEGAL-PM01', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检索《中华人民共和国劳动合同法》第40条关于无过失性辞退的规定，并解释适用条件`, label: 'LEGAL-PM02', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM01' },
    { input: `检索《个人信息保护法》关于跨境数据传输的规定，列举合规要求清单`, label: 'LEGAL-PM03', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `对比《民法典》合同编与原《合同法》关于格式条款的规定差异`, label: 'LEGAL-PM04', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检索《中华人民共和国劳动合同法》第39条关于用人单位单方解除劳动合同的规定，并解释适用条件`, label: 'LEGAL-PM05', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-PM01', variantOf: null },
    { input: `检索《个人信息保护法》关于数据主体权利的规定，列举企业合规义务清单`, label: 'LEGAL-PM06', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM03' },
    { input: `${DD_CHECKLIST}\n\n针对北京星辰科技有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM07', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `${DD_CHECKLIST}\n\n针对上海瀚海数据服务有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM08', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM07' },
    { input: `${DD_CHECKLIST}\n\n针对深圳云端网络技术有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM09', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM07' },
    { input: `${DD_CHECKLIST}\n\n针对北京星辰科技有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM10', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-PM07', variantOf: null },
    { input: `生成知识产权尽职调查专项报告，包含专利有效性分析、商标注册状态核查、侵权风险评估`, label: 'LEGAL-PM11', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `生成人力资源合规尽职调查专项报告，包含劳动合同审查、社保缴纳核查、竞业限制协议评估`, label: 'LEGAL-PM12', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检索《反不正当竞争法》关于商业秘密保护的规定，列举侵权认定标准`, label: 'LEGAL-PM13', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检索《反垄断法》关于经营者集中申报的规定，列举申报标准和豁免条件`, label: 'LEGAL-PM14', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM13' },
    { input: `${DD_CHECKLIST}\n\n针对广州博雅办公用品有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM15', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM07' },
    { input: `检索《反不正当竞争法》关于商业秘密保护的规定，列举侵权认定标准`, label: 'LEGAL-PM16', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-PM13', variantOf: null },
    { input: `对比中国和欧盟数据保护法规的异同，评估跨境业务合规风险`, label: 'LEGAL-PM17', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM04' },
    { input: `${DD_CHECKLIST}\n\n针对深圳云端网络技术有限公司生成尽职调查报告，重点标注风险点`, label: 'LEGAL-PM18', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-PM09', variantOf: null },
    { input: `检索《著作权法》关于软件著作权保护的规定，列举登记流程和维权要点`, label: 'LEGAL-PM19', profession: 'legal', timeSlot: 'afternoon', taskType: 'legal_research', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-PM13' },
    { input: `生成知识产权尽职调查专项报告，包含专利有效性分析、商标注册状态核查、侵权风险评估`, label: 'LEGAL-PM20', profession: 'legal', timeSlot: 'afternoon', taskType: 'due_diligence', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-PM11', variantOf: null },
  ]
}

export function getLegalOvertimeCases(): ProfessionalTestCase[] {
  return [
    { input: `检查公司数据隐私政策是否符合《个人信息保护法》要求，列出合规差距清单`, label: 'LEGAL-OT01', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查公司员工手册是否符合《劳动法》要求，列出合规差距清单`, label: 'LEGAL-OT02', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-OT01' },
    { input: `检查公司知识产权管理制度是否完善，列出合规差距清单`, label: 'LEGAL-OT03', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-OT01' },
    { input: `公司数据隐私政策合规检查清单：1.隐私政策是否明示收集信息范围 2.是否提供数据删除机制 3.是否获得用户明示同意 4.是否限制数据保留期限`, label: 'LEGAL-OT04', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查公司数据隐私政策是否符合《个人信息保护法》要求，列出合规差距清单`, label: 'LEGAL-OT05', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT01', variantOf: null },
    { input: `检查公司员工手册是否符合《劳动法》要求，列出合规差距清单`, label: 'LEGAL-OT06', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT02', variantOf: null },
    { input: `员工李某因严重违反规章制度被辞退，公司已掌握以下证据：1.三次书面警告 2.监控录像 3.同事证言。请分析劳动争议胜诉概率及应诉策略`, label: 'LEGAL-OT07', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `供应商交货延迟导致我方违约，合同约定延迟交货每天扣0.1%合同金额，供应商已延迟15天。请分析我方索赔方案和法律风险`, label: 'LEGAL-OT08', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: '今天几号？', label: 'LEGAL-OT09', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查公司竞业限制协议模板是否符合《劳动合同法》要求，列出合规差距清单`, label: 'LEGAL-OT10', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-OT01' },
    { input: `检查公司知识产权管理制度是否完善，列出合规差距清单`, label: 'LEGAL-OT11', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT03', variantOf: null },
    { input: `客户投诉产品侵权，要求赔偿￥500,000。请分析侵权风险和应对策略`, label: 'LEGAL-OT12', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `公司员工手册合规检查清单：1.是否明确工作时间 2.是否规定加班审批流程 3.是否包含安全操作规程 4.是否明确奖惩制度`, label: 'LEGAL-OT13', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-OT04' },
    { input: `员工王某以未签劳动合同为由申请劳动仲裁，要求双倍工资差额￥86,000。请分析我方抗辩理由和败诉风险`, label: 'LEGAL-OT14', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: false, isVariant: true, repeatOf: null, variantOf: 'LEGAL-OT07' },
    { input: `检查公司竞业限制协议模板是否符合《劳动合同法》要求，列出合规差距清单`, label: 'LEGAL-OT15', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT10', variantOf: null },
    { input: `供应商交货延迟导致我方违约，合同约定延迟交货每天扣0.1%合同金额，供应商已延迟15天。请分析我方索赔方案和法律风险`, label: 'LEGAL-OT16', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT08', variantOf: null },
    { input: `检查公司商标注册状态：注册号12345678-星辰科技、注册号23456789-瀚海数据，确认是否续展和变更`, label: 'LEGAL-OT17', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `客户投诉产品侵权，要求赔偿￥500,000。请分析侵权风险和应对策略`, label: 'LEGAL-OT18', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'raap', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT12', variantOf: null },
    { input: '现在几点几分？', label: 'LEGAL-OT19', profession: 'legal', timeSlot: 'overtime', taskType: 'dispute', expectedRoute: 'l0', l0RequiresLlm: true, isRepeat: false, isVariant: false, repeatOf: null, variantOf: null },
    { input: `检查公司商标注册状态：注册号12345678-星辰科技、注册号23456789-瀚海数据，确认是否续展和变更`, label: 'LEGAL-OT20', profession: 'legal', timeSlot: 'overtime', taskType: 'compliance', expectedRoute: 'l05', l0RequiresLlm: false, isRepeat: true, isVariant: false, repeatOf: 'LEGAL-OT17', variantOf: null },
  ]
}

export function getAllProfessionalCases(): ProfessionalTestCase[] {
  return [
    ...getAccountingMorningCases(),
    ...getAccountingAfternoonCases(),
    ...getAccountingOvertimeCases(),
    ...getLegalMorningCases(),
    ...getLegalAfternoonCases(),
    ...getLegalOvertimeCases(),
  ]
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  invoice: '发票处理', data_entry: '数据录入/核对', report: '报表生成',
  tax: '税务计算', compliance: '合规检查', budget: '预算预测',
  contract_review: '合同审查', nda: 'NDA起草', legal_research: '法律研究',
  due_diligence: '尽职调查', dispute: '争议解决'
}

export const TIME_SLOT_LABELS: Record<string, string> = {
  morning: '上午(8:30-12:00)', afternoon: '下午(13:00-17:30)', overtime: '加班(18:00-20:00)'
}
