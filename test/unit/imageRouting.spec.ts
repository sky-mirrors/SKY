import { describe, it, expect } from 'vitest'
import { extractImageOp, checkL1Capability } from '@/services/l0SkillRouter'

// 第二波·图像能力：L1 的"确定性能力直调"入口。
// 关键不变量——只在**同时**满足「提到图片」与「抽得到明确操作」时才直调；
// 缺任一条就交给下游层（不猜用户意图、不把"看看这张图"抢过来直调）。

describe('extractImageOp - 从自然语言抽可确定执行的操作', () => {
  it('宽度：多种说法都能抽到', () => {
    expect(extractImageOp('把图片宽度改成 800')).toMatchObject({ resize: { width: 800 } })
    expect(extractImageOp('缩到 1024 宽')).toMatchObject({ resize: { width: 1024 } })
    expect(extractImageOp('width 640')).toMatchObject({ resize: { width: 640 } })
  })

  it('比例：百分比与「一半」', () => {
    expect(extractImageOp('把这批图缩小 50%')).toMatchObject({ resize: { percent: 50 } })
    expect(extractImageOp('图片缩一半')).toMatchObject({ resize: { percent: 50 } })
  })

  it('格式：jpg 归一为 jpeg；质量与灰度', () => {
    expect(extractImageOp('转成 webp')).toMatchObject({ format: 'webp' })
    expect(extractImageOp('导出为 JPG')).toMatchObject({ format: 'jpeg' })
    expect(extractImageOp('压缩质量 60')).toMatchObject({ quality: 60 })
    expect(extractImageOp('转成黑白的图片')).toMatchObject({ grayscale: true })
  })

  it('抽不到就返回空对象（不硬猜）', () => {
    expect(extractImageOp('帮我看看这张照片')).toEqual({})
    expect(extractImageOp('这个图里的字是什么')).toEqual({})
  })
})

describe('checkL1Capability - 图像能力直调的门槛', () => {
  it('有图 + 有明确操作 → 直调 image_process（参数已拍平）', () => {
    const r = checkL1Capability('把 C:\\pics\\a.jpg 转成 webp，宽度 800')
    expect(r.canHandle).toBe(true)
    expect(r.nodeId).toBe('l1-image-ops')
    expect(r.plan?.steps[0].tool).toBe('image_process')
    // L1 计划步骤的 params 契约定为 Record<string, string>，故数值以字符串承载；
    // 下游 buildImageProcessArgs 会 Number() 回来（见 imageOps.spec 的对应用例）。
    expect(r.plan?.steps[0].params).toMatchObject({ inputs: 'C:\\pics\\a.jpg', format: 'webp', width: '800' })
    expect(Number(r.plan?.steps[0].params.width)).toBe(800)
  })

  it('有图但没说怎么处理 → 不抢占（交给下游层）', () => {
    const r = checkL1Capability('帮我看看 C:\\pics\\a.jpg 这张照片')
    expect(r.nodeId).not.toBe('l1-image-ops')
  })

  it('说了操作但没有明确路径 → 不抢占', () => {
    const r = checkL1Capability('把我的照片压缩一下')
    expect(r.nodeId).not.toBe('l1-image-ops')
  })

  it('文档转 PDF 的能力直调未被图像规则抢走（两类请求互不串台）', () => {
    const r = checkL1Capability('把 C:\\docs\\report.docx 转成 pdf')
    expect(r.nodeId).toBe('l1-doc-convert')
    expect(r.plan?.steps[0].tool).toBe('file_convert')
  })
})
