#!/usr/bin/env node
// V2 题库（50 题）桌面素材生成脚本 —— 见 docs/60-测试与验收.md。
// 用法：在仓库根 `node docs/exam-fixtures/make-fixtures.cjs`
// 只新增（docs/ media/ out/ 与 photos/sample.jpg），不动既有 V1 素材。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { Document, Packer, Paragraph, HeadingLevel } = require('docx')

// 夹具落在当前用户桌面（开源后可移植，不再绑死某一台机器）；需要放别处时用 HOLO_EXAM_DIR 指定
const ROOT = process.env.HOLO_EXAM_DIR || path.join(os.homedir(), 'Desktop', 'HoloExam')
const DOCS = path.join(ROOT, 'docs')
const MEDIA = path.join(ROOT, 'media')
const OUT = path.join(ROOT, 'out')
const PHOTOS = path.join(ROOT, 'photos')
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

async function main() {
  for (const d of [DOCS, MEDIA, OUT]) fs.mkdirSync(d, { recursive: true })

  // 1. notes.md —— 含小标题；T03「念第一个文件并改写成口语化」、R12「列 md 文件」用
  fs.writeFileSync(path.join(DOCS, 'notes.md'), `# 项目周会纪要

## 本周完成
- 完成登录模块的接口联调，覆盖 12 个用例
- 修复导出 PDF 时中文乱码的问题
- 上线灰度环境，观察 3 天无异常

## 下周计划
- 接入支付回调的幂等校验
- 补齐订单模块的单元测试

## 风险
- 第三方对账接口文档缺失，可能影响联调排期
`, 'utf8')

  // 2. expense.txt —— 含超 2000 元且未附发票的条目，让 R16 有可判内容
  fs.writeFileSync(path.join(DOCS, 'expense.txt'), `报销单（提交人：张三）

1. 高铁票 深圳-北京      1650 元   附电子发票
2. 住宿费 2 晚            980 元   附酒店发票
3. 客户招待餐费          2480 元   未附发票
4. 市内交通                86 元   附行程单
5. 办公用品采购          1250 元   附发票
`, 'utf8')

  // 3. empty.txt —— 0 字节（E08 空文件题要求如实说明「文件为空」）
  fs.writeFileSync(path.join(DOCS, 'empty.txt'), '')

  // 4. data.xlsx —— 供 R13「xlsx 转 csv」真实提取表格
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['月份', '销售额', '订单数'],
    ['1月', 128000, 412],
    ['2月', 96500, 338],
    ['3月', 153200, 501]
  ]), '销售')
  XLSX.writeFile(wb, path.join(DOCS, 'data.xlsx'))

  // 5. sample.docx —— 供 R02「docx 转 txt」
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: '产品需求说明', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('本文件用于验收考试的格式转换用例。'),
    new Paragraph('要求：把本 docx 转成 txt，内容须来自原文件而非转述。')
  ] }] })
  fs.writeFileSync(path.join(DOCS, 'sample.docx'), await Packer.toBuffer(doc))

  // 6. photos/sample.jpg —— 供 M01「缩到 200 宽转 webp」、M05「压缩，质量 60」
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .jpeg({ quality: 90 })
    .toFile(path.join(PHOTOS, 'sample.jpg'))

  // 7. media/clip.mp4 —— 4 秒、带音频轨：M04 取「第 2 秒」画面、M03 抽音轨、M06 crf 压缩
  execFileSync(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    path.join(MEDIA, 'clip.mp4')
  ], { stdio: 'inherit' })

  console.log('素材生成完成')
}

main().catch(e => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1) })
