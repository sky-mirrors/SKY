import { describe, it, expect } from 'vitest'
import { tryL0Skill, checkL1Capability } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// 产物输出位置 · 第二波（2026-09-30）
//
// 与 l0OutputPath.spec.ts 同源：V2 的三道同型位置错走的是**三条不同**的路径计算分支。
//   - R01「转 docx 该落 out」走 file_convert 分支 —— 已在 e8794f1 修（l0OutputPath.spec.ts 覆盖）；
//   - R05「建目录该落 out」走 L0「创建文件夹」规则 —— 原把路径**硬编码** %USERPROFILE%\Desktop，
//     题干指定的目录从不参与计算（本文件覆盖）；
//   - M06「压视频该落 out」走 L1 media 分支 —— 构造 flat 参数时漏传 outDir，
//     而 buildMediaProcessArgs 本就支持 outDir（本文件覆盖）；
//   - image 分支与 media 同族（同样支持 outDir、同样漏传），一并补齐并覆盖。
//
// 这是**路由层参数计算**问题，不是提示词问题——模型不参与决定该路径。
// ─────────────────────────────────────────────────────────────────────────────

const OUT = 'C:\\Users\\<user>\\Desktop\\HoloExam\\out'
const MEDIA = 'C:\\Users\\<user>\\Desktop\\HoloExam\\media'
const PHOTOS = 'C:\\Users\\<user>\\Desktop\\HoloExam\\photos'

describe('L0 · 创建文件夹尊重题干指定目录（V2-R05）', () => {
  it('题干「在 <绝对路径> 下建一个名为 X 的文件夹」→ path 落该目录下', async () => {
    const plan = await tryL0Skill(`在 ${OUT} 下建一个名为 v2-newdir 的文件夹`)
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].tool).toBe('create_directory')
    expect(plan!.steps[0].params.path).toBe(`${OUT}\\v2-newdir`)
  })

  it('题干未给目录 → 退回桌面默认（保持既有行为，不得回归）', async () => {
    const plan = await tryL0Skill('新建一个名为 mynewfolder 的文件夹')
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].params.path).toBe('%USERPROFILE%\\Desktop\\mynewfolder')
  })
})

describe('L1 · media 分支透传用户指定输出目录（V2-M06）', () => {
  it('视频压缩题干「存到 <绝对路径> 下」→ media plan 的 outDir = 该目录', () => {
    const src = `${MEDIA}\\clip.mp4`
    const c = checkL1Capability(`把 ${src} 用 crf 28 压缩后存到 ${OUT} 下`)
    expect(c.canHandle).toBe(true)
    expect(c.plan!.steps[0].tool).toBe('media_process')
    expect(c.plan!.steps[0].params.outDir).toBe(OUT)
  })

  it('未指定输出目录 → 不传 outDir（落源同目录，保持既有行为）', () => {
    const src = `${MEDIA}\\clip.mp4`
    const c = checkL1Capability(`把 ${src} 用 crf 28 压缩`)
    expect(c.canHandle).toBe(true)
    expect(c.plan!.steps[0].params.outDir).toBeUndefined()
  })
})

describe('L1 · image 分支透传用户指定输出目录（同族）', () => {
  it('图片转格式题干「存到 <绝对路径> 下」→ image plan 的 outDir = 该目录', () => {
    const src = `${PHOTOS}\\a.jpg`
    const c = checkL1Capability(`把 ${src} 转成 png 存到 ${OUT} 下`)
    expect(c.canHandle).toBe(true)
    expect(c.plan!.steps[0].tool).toBe('image_process')
    expect(c.plan!.steps[0].params.outDir).toBe(OUT)
  })

  it('未指定输出目录 → 不传 outDir（落源同目录，保持既有行为）', () => {
    const src = `${PHOTOS}\\a.jpg`
    const c = checkL1Capability(`把 ${src} 转成 png`)
    expect(c.canHandle).toBe(true)
    expect(c.plan!.steps[0].params.outDir).toBeUndefined()
  })
})
