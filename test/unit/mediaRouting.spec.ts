import { describe, it, expect } from 'vitest'
import { extractMediaOp, checkL1Capability } from '@/services/l0SkillRouter'

// 第三波·媒体能力（2026-09-30 补）：L1 的"确定性能力直调"入口。
// `l1-media-ops` 此前**登记在 L1_CAPABILITIES 且被 l2-media-process-v1 引用为 requiredL1，
// 却没有任何路由出口**（checkL1Capability 只认 doc-convert/image-ops 两个后补确定性能力）。
// 与 image-ops 同款不变量——只在**同时**满足「提到音视频」与「抽得到明确操作」时才直调；
// 缺任一条就交给下游层（L2 的 media manifest / 探索），不猜用户意图。

describe('extractMediaOp - 从自然语言抽可确定执行的操作', () => {
  it('格式：转/导出/保存 都能抽到', () => {
    expect(extractMediaOp('把这个视频转成 webm')).toMatchObject({ format: 'webm' })
    expect(extractMediaOp('导出为 MP4')).toMatchObject({ format: 'mp4' })
    expect(extractMediaOp('转成 gif')).toMatchObject({ format: 'gif' })
  })

  it('压缩质量 crf', () => {
    expect(extractMediaOp('压缩 crf 28')).toMatchObject({ crf: 28 })
  })

  it('裁剪：起点与时长', () => {
    expect(extractMediaOp('从第 5 秒开始')).toMatchObject({ start: 5 })
    expect(extractMediaOp('裁剪 10 秒')).toMatchObject({ duration: 10 })
  })

  it('出缩略图：第 N 秒', () => {
    expect(extractMediaOp('在第 3 秒出缩略图')).toMatchObject({ thumbnailAt: 3 })
  })

  it('缩放宽度', () => {
    expect(extractMediaOp('宽度改成 1280')).toMatchObject({ width: 1280 })
  })

  it('抽不到就返回空对象（不硬猜）', () => {
    expect(extractMediaOp('这个视频怎么样')).toEqual({})
    expect(extractMediaOp('帮我看看这段音频')).toEqual({})
  })
})

describe('checkL1Capability - 媒体能力直调的门槛', () => {
  it('有媒体 + 有明确操作 → 直调 media_process（参数已拍平）', () => {
    const r = checkL1Capability('把 C:\\clips\\a.mp4 转成 webm')
    expect(r.canHandle).toBe(true)
    expect(r.nodeId).toBe('l1-media-ops')
    expect(r.plan?.steps[0].tool).toBe('media_process')
    expect(r.plan?.steps[0].params).toMatchObject({ inputs: 'C:\\clips\\a.mp4', format: 'webm' })
  })

  it('压缩参数以字符串承载（下游 buildMediaProcessArgs 会 Number 回来）', () => {
    const r = checkL1Capability('把 C:\\clips\\a.mp4 压缩 crf 28')
    expect(r.nodeId).toBe('l1-media-ops')
    expect(r.plan?.steps[0].params.crf).toBe('28')
    expect(Number(r.plan?.steps[0].params.crf)).toBe(28)
  })

  it('有媒体但没说怎么处理 → 不抢占（交给下游层）', () => {
    const r = checkL1Capability('帮我看看 C:\\clips\\a.mp4 这个视频')
    expect(r.nodeId).not.toBe('l1-media-ops')
  })

  it('说了操作但没有明确路径 → 不抢占', () => {
    const r = checkL1Capability('把我录的视频压缩一下')
    expect(r.nodeId).not.toBe('l1-media-ops')
  })

  it('图像能力未被媒体规则抢走（两类请求互不串台）', () => {
    const r = checkL1Capability('把 C:\\pics\\a.jpg 转成 webp，宽度 800')
    expect(r.nodeId).toBe('l1-image-ops')
  })

  it('文档转 PDF 仍归 doc-convert（不串台）', () => {
    const r = checkL1Capability('把 C:\\docs\\report.docx 转成 pdf')
    expect(r.nodeId).toBe('l1-doc-convert')
  })
})
