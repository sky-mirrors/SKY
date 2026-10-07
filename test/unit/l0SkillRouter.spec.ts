import { describe, it, expect } from 'vitest'
import { tryL0Skill, buildExplorePlan, classifyDomain } from '@/services/l0SkillRouter'

describe('l0SkillRouter', () => {
  describe('tryL0Skill', () => {
    it('快速Shell命令 - ls', async () => {
      const plan = await tryL0Skill('ls -la')
      expect(plan).not.toBeNull()
      expect(plan!.intent).toContain('ls -la')
      expect(plan!.steps).toHaveLength(1)
      expect(plan!.steps[0].tool).toBe('shell_exec')
      expect(plan!.isExploration).toBe(false)
    })

    it('快速Shell命令 - npm install', async () => {
      const plan = await tryL0Skill('npm install lodash')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('shell_exec')
      expect(plan!.steps[0].params.command).toBe('npm install lodash')
    })

    it('快速Shell命令 - git status', async () => {
      const plan = await tryL0Skill('git status')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('shell_exec')
    })

    it('快速Shell命令 - 运行npm test', async () => {
      const plan = await tryL0Skill('运行 npm test')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].params.command).toContain('npm test')
    })

    it('快速Shell命令 - 执行python脚本', async () => {
      const plan = await tryL0Skill('执行 python train.py')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].params.command).toContain('python train.py')
    })

    it('快速Shell命令 - forbiddenPattern阻止格式转换关键词', async () => {
      const plan = await tryL0Skill('运行 文件格式转换工具')
      expect(plan).toBeNull()
    })

    it('简单文本生成 - 写代码', async () => {
      const plan = await tryL0Skill('写一个快速排序函数')
      expect(plan).not.toBeNull()
      expect(plan!.steps).toHaveLength(1)
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.isExploration).toBe(false)
    })

    it('简单文本生成 - 帮我写邮件', async () => {
      const plan = await tryL0Skill('帮我写一封请假邮件')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
    })

    it('简单文本生成 - 生成公告', async () => {
      const plan = await tryL0Skill('生成一段公告文案')
      expect(plan).not.toBeNull()
    })

    it('简单文本生成 - forbiddenPattern阻止周报', async () => {
      const plan = await tryL0Skill('写一份周报')
      expect(plan).toBeNull()
    })

    it('简单文本生成 - forbiddenPattern阻止合同', async () => {
      const plan = await tryL0Skill('起草一份合同')
      expect(plan).toBeNull()
    })

    it('P1-D5：文件创建 forbiddenPattern 阻止列查类输入（首考Q14病理）', async () => {
      const plan = await tryL0Skill('整理 HoloExam 文件夹，生成一份文件清单保存到桌面')
      const wentToCreate = plan?.steps.some(s => s.tool === 'file_write' || s.tool === 'create_docx') ?? false
      expect(wentToCreate).toBe(false)
    })

    it('P1-D5：文件创建 forbiddenPattern 阻止转换类输入', async () => {
      const plan = await tryL0Skill('把报告.docx转成pdf保存到桌面')
      const wentToCreate = plan?.steps.some(s => s.tool === 'file_write' || s.tool === 'create_docx') ?? false
      expect(wentToCreate).toBe(false)
    })

    it('P1-D5：正常创建文件输入仍直通文件创建', async () => {
      const plan = await tryL0Skill('在桌面新建一个测试.txt')
      expect(plan).not.toBeNull()
      expect(plan!.steps.some(s => s.tool === 'file_write' || s.tool === 'create_docx')).toBe(true)
    })

    it('HTTP请求 - curl', async () => {
      const plan = await tryL0Skill('curl https://api.example.com/data')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('http_request')
      expect(plan!.steps[0].params.url).toBe('https://api.example.com/data')
    })

    it('HTTP请求 - 包含URL', async () => {
      const plan = await tryL0Skill('请求 https://httpbin.org/get')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('http_request')
    })

    it('HTTP请求 - 无URL返回null', async () => {
      const plan = await tryL0Skill('请求一下数据')
      expect(plan).toBeNull()
    })

    // 2026-09-25：本条原断言「未给完整路径也必须产出转换计划」——而旧计划把源路径伪造成 `input.md`、
    // 跑到 read_file 必报「文件不存在」。这等于把"一个必然失败的假计划"钉成了契约，且实测会让用户
    // 收到「我先确认文件是否存在」后就没有下文。现改为如实索要完整路径（见 l0ConvertSkillPath.spec.ts）。
    it('文件格式转换 - md转docx（未给完整路径时如实索要路径，不产出必失败的假计划）', async () => {
      const plan = await tryL0Skill('将README.md转换为docx')
      expect(plan).not.toBeNull()
      expect(plan!.isExploration).toBe(true)
      expect(JSON.stringify(plan)).not.toMatch(/input\.[\w]{1,5}/)
      expect(plan!.intent).toContain('未识别到源文件路径')
    })

    it('文件格式转换 - forbiddenPattern阻止合同审查', async () => {
      const plan = await tryL0Skill('转换合同审查文档为pdf')
      expect(plan).toBeNull()
    })

    it('复杂意图不命中L0', async () => {
      const plan = await tryL0Skill('帮我分析一下竞品优劣势')
      expect(plan).toBeNull()
    })

    it('空输入不命中', async () => {
      const plan = await tryL0Skill('')
      expect(plan).toBeNull()
    })

    it('模糊短输入不命中', async () => {
      const plan = await tryL0Skill('你好')
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
    it('通用探索模式 - 无文件线索', async () => {
      const plan = await buildExplorePlan('帮我分析一下这个项目的架构')
      expect(plan.isExploration).toBe(true)
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].tool).toBe('llm_generate')
    })

    it('文件操作探索模式 - 含文件路径和目标格式（PDF 走真转换）', async () => {
      const plan = await buildExplorePlan('把C:\\docs\\report.md转换为pdf')
      // 2026-09-24（第一波·文档能力）：A3 的「不支持」说明已被真转换取代——
      // 应用内 mammoth + Electron printToPDF 出 PDF，步骤是真实的 file_convert。
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].tool).toBe('file_convert')
      expect(String(plan.steps[0].params.source)).toBe('C:\\docs\\report.md')
      expect(String(plan.steps[0].params.target)).toBe('C:\\docs\\report.pdf')
      expect(plan.intent.toLowerCase()).toContain('pdf')
    })

    it('PDF 源格式不支持时仍是确定性「不支持」说明（不假装成功）', async () => {
      const plan = await buildExplorePlan('把C:\\docs\\book.xlsx转换为pdf')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].tool).toBe('llm_generate')
      expect(String(plan.steps[0].params.prompt)).toContain('只支持')
    })

    it('文件操作探索模式 - 含目标格式关键词', async () => {
      const plan = await buildExplorePlan('转换为xlsx格式')
      expect(plan.isExploration).toBe(true)
    })

    it('简单查询 - 几号', async () => {
      const plan = await tryL0Skill('今天几号？')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.steps[0].params.modelTier).toBe('nano')
    })

    it('简单查询 - 几点几分', async () => {
      const plan = await tryL0Skill('现在是几点几分？')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('llm_generate')
      expect(plan!.steps[0].params.modelTier).toBe('nano')
    })

    it('文件创建 - 摘要说明不命中(应走L0.5)', async () => {
      const plan = await tryL0Skill('生成一份文档摘要说明')
      expect(plan).toBeNull()
    })

    it('创建文件夹 - 名为xxx', async () => {
      const plan = await tryL0Skill('创建一个名为项目归档的文件夹')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('create_directory')
    })
  })

  // ===== 2026-09-30：补 file_move 的全漏斗空洞 + 收窄 shell 规则触发词 =====
  describe('文件移动重命名（新增规则，补 file_move 空洞）', () => {
    it('两个绝对路径：移动 → 单步 file_move', async () => {
      const plan = await tryL0Skill('把 C:\\Users\\x\\Desktop\\a.txt 移到 C:\\Users\\x\\Desktop\\b.txt')
      expect(plan).not.toBeNull()
      expect(plan!.steps).toHaveLength(1)
      expect(plan!.steps[0].tool).toBe('file_move')
      expect(plan!.steps[0].params.from).toBe('C:\\Users\\x\\Desktop\\a.txt')
      expect(plan!.steps[0].params.to).toBe('C:\\Users\\x\\Desktop\\b.txt')
    })

    it('同目录重命名（to 为裸文件名）→ 解析到源文件所在目录', async () => {
      const plan = await tryL0Skill('把 C:\\Users\\x\\Desktop\\a.txt 重命名为 b.txt')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('file_move')
      expect(plan!.steps[0].params.from).toBe('C:\\Users\\x\\Desktop\\a.txt')
      expect(plan!.steps[0].params.to).toBe('C:\\Users\\x\\Desktop\\b.txt')
    })

    it('抽不到完整路径 → 不产出 file_move（下沉，不伪造）', async () => {
      const plan = await tryL0Skill('把这个文件移动一下')
      const wentToMove = plan?.steps.some(s => s.tool === 'file_move') ?? false
      expect(wentToMove).toBe(false)
    })

    it('与规则 9 划清：图片按拍摄日期重命名仍走 rename_images_by_date', async () => {
      // 带绝对路径，规则 9 才会产出 rename_images_by_date（无路径时它产出澄清计划）
      const plan = await tryL0Skill('把 C:\\Users\\x\\Desktop\\photos 文件夹里的图片按拍摄日期重命名')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('rename_images_by_date')
      expect(plan!.steps[0].tool).not.toBe('file_move')
    })

    it('域词禁入：合同/条款类不产出 file_move', async () => {
      const plan = await tryL0Skill('把这份合同的条款移动到附录')
      const wentToMove = plan?.steps.some(s => s.tool === 'file_move') ?? false
      expect(wentToMove).toBe(false)
    })
  })

  // 缺口 2 回归：shell 白名单（electron/shell-security.ts:4-16 定义 + :436-444 词边界
  // 前缀匹配 isShellCommandAllowed）不含 mv / move / ren / del / rm —— L0 不得再为这些
  // 命令产出必被拒绝的 shell_exec 计划（exit -1）。
  describe('缺口 2 回归：白名单外命令不得产出 shell_exec', () => {
    it('mv 不再产出 shell_exec', async () => {
      const plan = await tryL0Skill('mv C:\\a.txt C:\\b.txt')
      const wentToShell = plan?.steps.some(s => s.tool === 'shell_exec') ?? false
      expect(wentToShell).toBe(false)
    })

    it('del 不再产出 shell_exec', async () => {
      const plan = await tryL0Skill('del C:\\a.txt')
      const wentToShell = plan?.steps.some(s => s.tool === 'shell_exec') ?? false
      expect(wentToShell).toBe(false)
    })

    it('白名单内命令仍走 shell_exec（ls，防误伤）', async () => {
      const plan = await tryL0Skill('ls -la')
      expect(plan).not.toBeNull()
      expect(plan!.steps[0].tool).toBe('shell_exec')
    })
  })
})

// ===== 2026-09-30：格式转换矩阵重写 + 文件复制 =====
// 背景：原「其他格式」分支用 read_file + llm_generate——只产文本、**不落盘**（假转换）。
// 重写后：→pdf 走 file_convert；→docx/txt/md/csv 走「取文本 → 写盘」两步，
// 二进制源（pdf/docx/xlsx/xls）先经 doc_extract 提取；无真实现的组合如实说明。
describe('L0 文件格式转换矩阵（2026-09-30 重写）', () => {
  it('→ pdf 仍走 file_convert（回归）', async () => {
    const plan = await tryL0Skill('把 C:\\docs\\a.md 转成 pdf')
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].tool).toBe('file_convert')
  })

  it('文本 → docx 走 read_file + create_docx（不再 shell/node）', async () => {
    const plan = await tryL0Skill('把 C:\\docs\\a.md 转成 docx')
    expect(plan).not.toBeNull()
    const tools = plan!.steps.map(s => s.tool)
    expect(tools).toContain('create_docx')
    expect(tools).not.toContain('shell_exec')
  })

  it('pdf → txt 走 doc_extract + file_write（真提取，不假装）', async () => {
    const plan = await tryL0Skill('把 C:\\docs\\a.pdf 转成 txt')
    expect(plan).not.toBeNull()
    const tools = plan!.steps.map(s => s.tool)
    expect(tools).toContain('doc_extract')
    expect(tools).toContain('file_write')
    expect(tools).not.toContain('llm_generate')
  })

  it('xlsx → csv 走 doc_extract + file_write', async () => {
    const plan = await tryL0Skill('把 C:\\docs\\a.xlsx 转成 csv')
    expect(plan).not.toBeNull()
    const tools = plan!.steps.map(s => s.tool)
    expect(tools).toContain('doc_extract')
    expect(tools).toContain('file_write')
  })

  it('无真实现的组合（→ xlsx）不产出写盘步骤（如实说明，不假装）', async () => {
    const plan = await tryL0Skill('把 C:\\docs\\a.txt 转成 xlsx')
    const writes = plan?.steps.some(s => s.tool === 'file_write' || s.tool === 'create_docx') ?? false
    expect(writes).toBe(false)
  })
})

describe('L0 文件复制（2026-09-30 新增规则）', () => {
  it('两个绝对路径：复制 → 单步 file_copy', async () => {
    const plan = await tryL0Skill('把 C:\\Users\\x\\Desktop\\a.txt 复制到 C:\\Users\\x\\Desktop\\b.txt')
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(1)
    expect(plan!.steps[0].tool).toBe('file_copy')
    expect(plan!.steps[0].params.from).toBe('C:\\Users\\x\\Desktop\\a.txt')
    expect(plan!.steps[0].params.to).toBe('C:\\Users\\x\\Desktop\\b.txt')
  })

  it('抽不到完整路径 → 不产出 file_copy（下沉，不伪造）', async () => {
    const plan = await tryL0Skill('把这个文件复制一下')
    const wentToCopy = plan?.steps.some(s => s.tool === 'file_copy') ?? false
    expect(wentToCopy).toBe(false)
  })

  it('回归：移动/重命名仍走 file_move（复制规则不抢）', async () => {
    const plan = await tryL0Skill('把 C:\\Users\\x\\Desktop\\a.txt 重命名为 b.txt')
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].tool).toBe('file_move')
  })
})


// ===== 2026-10-07：V2-R15 回归 —— 输入被 funnel 追加会话上下文（含换行）时，shell 命令须取首行 =====
// 背景：sendMessage 会把 withSessionFilesContext(content)（含换行的知识库清单）喂给路由，
// 原 `^(?:运行|执行)?\s*(.*)$` 在多行输入上因 `.` 不跨 `\n` 而整体不匹配 → cmd 回落成整个含 `\n`
// 的输入 → 被 isShellCommandAllowed 以「命令包含shell元字符 '\n'」拒绝（V2-R15 实测）。
describe('L0 快速Shell命令：被追加会话上下文（多行）时命令取首行', () => {
  const DECORATED = '运行 ls 看看当前目录\n\n【本会话可用的知识库文件（请直接依据此清单回答，不要反问目录）】\n- 2026.9.24最新快照.md（12 块）'

  it('命令不得包含换行（否则被 shell 元字符校验拒绝）', async () => {
    const plan = await tryL0Skill(DECORATED)
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].tool).toBe('shell_exec')
    const cmd = String(plan!.steps[0].params.command ?? '')
    expect(cmd).not.toContain('\n')
  })

  it('命令为去掉「运行/执行」前缀后的首行内容', async () => {
    const plan = await tryL0Skill(DECORATED)
    expect(plan!.steps[0].params.command).toBe('ls 看看当前目录')
  })

  it('单行输入行为不变（回归护栏）', async () => {
    const plan = await tryL0Skill('运行 ls -la')
    expect(plan!.steps[0].params.command).toBe('ls -la')
  })

  it('直给命令（无前缀）行为不变（回归护栏）', async () => {
    const plan = await tryL0Skill('ls -la')
    expect(plan!.steps[0].params.command).toBe('ls -la')
  })
})
