import { describe, it, expect } from 'vitest'
import { tryL0Skill, buildExplorePlan, classifyDomain } from '@/services/l0SkillRouter'

describe('l0SkillRouter', () => {
  describe('tryL0Skill', () => {
    it('快速Shell命令 - ls', () => {
      const plan = tryL0Skill('ls -la')
      expect(plan).not.toBeNull()
      expect(plan!.intent).toContain('ls -la')
      expect(plan!.steps).toHaveLength(1)
      expect(plan!.steps[0].tool).toBe('shell_exec')
      expect(plan!.isExploration).toBe(false)
    })

    it('快速Shell命令 - npm install', () => {
      const plan = tryL0Skill('npm install lodash')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('shell_exec')
      expect(plan!.steps[0].params.command).toBe('npm install lodash')
    })

    it('快速Shell命令 - git status', () => {
      const plan = tryL0Skill('git status')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('shell_exec')
    })

    it('快速Shell命令 - 运行npm test', () => {
      const plan = tryL0Skill('运行 npm test')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].params.command).toContain('npm test')
    })

    it('快速Shell命令 - 执行python脚本', () => {
      const plan = tryL0Skill('执行 python train.py')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].params.command).toContain('python train.py')
    })

    it('快速Shell命令 - forbiddenPattern阻止格式转换关键词', () => {
      const plan = tryL0Skill('运行 文件格式转换工具')
      expect(plan).toBeNull()
    })

    it('简单文本生成 - 写代码', () => {
      const plan = tryL0Skill('写一个快速排序函数')
      expect(plan).not.toBeNull()
      expect(plan!.steps).toHaveLength(1)
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.isExploration).toBe(false)
    })

    it('简单文本生成 - 帮我写邮件', () => {
      const plan = tryL0Skill('帮我写一封请假邮件')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
    })

    it('简单文本生成 - 生成公告', () => {
      const plan = tryL0Skill('生成一段公告文案')
      expect(plan).not.toBeNull()
    })

    it('简单文本生成 - forbiddenPattern阻止周报', () => {
      const plan = tryL0Skill('写一份周报')
      expect(plan).toBeNull()
    })

    it('简单文本生成 - forbiddenPattern阻止合同', () => {
      const plan = tryL0Skill('起草一份合同')
      expect(plan).toBeNull()
    })

    it('HTTP请求 - curl', () => {
      const plan = tryL0Skill('curl https://api.example.com/data')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('http_request')
      expect(plan!.steps[0].params.url).toBe('https://api.example.com/data')
    })

    it('HTTP请求 - 包含URL', () => {
      const plan = tryL0Skill('请求 https://httpbin.org/get')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('http_request')
    })

    it('HTTP请求 - 无URL返回null', () => {
      const plan = tryL0Skill('请求一下数据')
      expect(plan).toBeNull()
    })

    it('文件格式转换 - md转docx', () => {
      const plan = tryL0Skill('将README.md转换为docx')
      expect(plan).not.toBeNull()
      expect(plan!.intent).toContain('docx')
      expect(plan!.isExploration).toBe(true)
    })

    it('文件格式转换 - forbiddenPattern阻止合同审查', () => {
      const plan = tryL0Skill('转换合同审查文档为pdf')
      expect(plan).toBeNull()
    })

    it('复杂意图不命中L0', () => {
      const plan = tryL0Skill('帮我分析一下竞品优劣势')
      expect(plan).toBeNull()
    })

    it('空输入不命中', () => {
      const plan = tryL0Skill('')
      expect(plan).toBeNull()
    })

    it('模糊短输入不命中', () => {
      const plan = tryL0Skill('你好')
      expect(plan).toBeNull()
    })
  })

  describe('classifyDomain', () => {
    it('文件域', () => {
      expect(classifyDomain('将md转换为docx')).toContain('file')
    })

    it('创作域', () => {
      expect(classifyDomain('写一个函数')).toContain('creation')
    })

    it('法律域', () => {
      expect(classifyDomain('合同条款审查')).toContain('legal')
    })

    it('财务域', () => {
      expect(classifyDomain('报销预算分析')).toContain('finance')
    })

    it('多域匹配', () => {
      const domains = classifyDomain('将合同文件转换为pdf')
      expect(domains).toContain('file')
      expect(domains).toContain('legal')
    })

    it('未知域返回general', () => {
      expect(classifyDomain('随便聊聊')).toContain('general')
    })

    it('系统域', () => {
      expect(classifyDomain('运行shell命令')).toContain('system')
    })

    it('HR域', () => {
      expect(classifyDomain('简历筛选')).toContain('hr')
    })

    it('销售域', () => {
      expect(classifyDomain('竞品分析方案')).toContain('sales')
    })
  })

  describe('buildExplorePlan', () => {
    it('通用探索模式 - 无文件线索', () => {
      const plan = buildExplorePlan('帮我分析一下这个项目的架构')
      expect(plan.isExploration).toBe(true)
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].tool).toBe('llm_generate')
    })

    it('文件操作探索模式 - 含文件路径和目标格式', () => {
      const plan = buildExplorePlan('把C:\\docs\\report.md转换为pdf')
      expect(plan.isExploration).toBe(true)
      expect(plan.intent).toContain('pdf')
    })

    it('文件操作探索模式 - 含目标格式关键词', () => {
      const plan = buildExplorePlan('转换为xlsx格式')
      expect(plan.isExploration).toBe(true)
    })

    it('简单查询 - 几号', () => {
      const plan = tryL0Skill('今天几号？')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.steps[0].params.modelTier).toBe('nano')
    })

    it('简单查询 - 几点几分', () => {
      const plan = tryL0Skill('现在是几点几分？')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.steps[0].params.modelTier).toBe('nano')
    })

    it('文件创建 - 摘要说明不命中(应走L0.5)', () => {
      const plan = tryL0Skill('生成一份文档摘要说明')
      expect(plan).toBeNull()
    })

    it('创建文件夹 - 名为xxx', () => {
      const plan = tryL0Skill('创建一个名为项目归档的文件夹')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('create_directory')
    })
  })
})
