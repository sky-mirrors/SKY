import { describe, it, expect } from 'vitest'
import { extractProducedArtifacts } from '@/services/macroExecutor'

// ─────────────────────────────────────────────────────────────────────────────
// 产物副作用抽取（2026-09-30）
//
// 背景：deliverableCheck.conformanceCheck 靠 producedArtifacts 判断「有没有产出」，
// 而该数组只由 onSideEffect 填充——原实现只认 shell_exec(writeFileSync) / file_write /
// create_docx 三类。可题库实际在用的 file_move / file_copy / file_convert /
// image_process 等产出型工具一个都没登记 ⇒ 核验误报「未产生任何文件产物」
// ⇒ 注入误导文案 ⇒ 判卷判否（V2-R04 是确凿误报）。
//
// 各工具产物路径的来源不同（见 executeNativeTool 各分支返回值），故这里逐个钉住：
//   file_write    → 「文件已写入: <path>」
//   file_move     → 「已重命名/移动: <from> → <to>」  取 to
//   file_copy     → 「已复制: <from> → <to>」        取 to
//   file_convert  → 「已生成 PDF: <path>（N 字节，源文件: <src>）」  取 path
//   image_process → 「<to>（WxH, N 字节, fmt）；<to2>（…）」  取每个 to
// ─────────────────────────────────────────────────────────────────────────────

describe('extractProducedArtifacts · 产出型工具的产物路径抽取', () => {
  it('file_move：从「→ to」里取目标路径（V2-R04 的情形）', () => {
    const r = extractProducedArtifacts(
      'file_move',
      '已重命名/移动: C:\\Users\\Administrator\\Desktop\\HoloExam\\out\\notes-copy.md → C:\\Users\\Administrator\\Desktop\\HoloExam\\out\\notes-renamed.md',
      { from: 'C:\\a\\notes-copy.md', to: 'C:\\a\\notes-renamed.md' }
    )
    expect(r).toEqual(['C:\\Users\\Administrator\\Desktop\\HoloExam\\out\\notes-renamed.md'])
  })

  it('file_copy：同理取 to，不把源文件当产物', () => {
    const r = extractProducedArtifacts('file_copy', '已复制: C:\\a\\src.md → C:\\b\\dst.md', { from: 'C:\\a\\src.md', to: 'C:\\b\\dst.md' })
    expect(r).toEqual(['C:\\b\\dst.md'])
  })

  it('file_convert：从「已生成 PDF: <path>（…）」取 path', () => {
    const r = extractProducedArtifacts(
      'file_convert',
      '已生成 PDF: C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.pdf（54927 字节，源文件: C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.md）',
      { source: 'C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.md' }
    )
    expect(r).toEqual(['C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.pdf'])
  })

  it('image_process：多产物逐个取出（含分号分隔的第二项）', () => {
    const r = extractProducedArtifacts(
      'image_process',
      'C:\\Users\\Administrator\\Desktop\\HoloExam\\photos\\img0-200.webp（200x150, 4096 字节, webp）；C:\\Users\\Administrator\\Desktop\\HoloExam\\photos\\img1-200.webp（200x150, 4200 字节, webp）',
      {}
    )
    expect(r).toEqual([
      'C:\\Users\\Administrator\\Desktop\\HoloExam\\photos\\img0-200.webp',
      'C:\\Users\\Administrator\\Desktop\\HoloExam\\photos\\img1-200.webp'
    ])
  })

  it('file_write：保留既有行为（入参取路径）', () => {
    const r = extractProducedArtifacts('file_write', '文件已写入: C:\\out\\a.txt', { path: 'C:\\out\\a.txt' })
    expect(r).toEqual(['C:\\out\\a.txt'])
  })

  it('只读/无产物工具：返回空，不得凭空造产物', () => {
    expect(extractProducedArtifacts('read_file', '文件内容…', { path: 'C:\\a.md' })).toEqual([])
    expect(extractProducedArtifacts('list_directory', '共 3 个文件', { dir: 'C:\\' })).toEqual([])
    expect(extractProducedArtifacts('llm_generate', '这是一段生成文本', {})).toEqual([])
  })

  it('失败/异常返回：不产出路径（避免把错误信息当产物）', () => {
    expect(extractProducedArtifacts('file_move', 'file_move: missing to', {})).toEqual([])
    expect(extractProducedArtifacts('file_convert', 'file_convert failed', {})).toEqual([])
  })

  it('路径去重（同一产物出现多次只记一条）', () => {
    const r = extractProducedArtifacts('file_write', '文件已写入: C:\\out\\a.txt', { path: 'C:\\out\\a.txt' })
    expect(r).toEqual(['C:\\out\\a.txt'])
  })
})
