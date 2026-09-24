// F-3：shell 输出代码页解码的单测。
// 复现形态：Windows cmd 内建命令按 GBK 输出 ⇒ 原实现 data.toString()(UTF-8) 解出乱码，
// 「系统找不到指定的文件。」变成「ϵͳ�Ҳ���ָ�����ļ���」，失败原因对用户不可读。
import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { decodeShellOutput } from '@electron/shellOutput'

describe('F-3：shell 输出代码页解码', () => {
  it('UTF-8 字节流原样解出（chcp 65001 / 现代 CLI）', () => {
    expect(decodeShellOutput(Buffer.from('找不到文件：a.txt', 'utf8'))).toBe('找不到文件：a.txt')
  })

  it('GBK 字节流不再乱码（Windows cmd 内建命令的中文报错）', () => {
    const gbk = iconv.encode('系统找不到指定的文件。', 'gbk')
    // 先确认这正是原实现会解错的那串字节
    expect(gbk.toString('utf8')).toContain('\uFFFD')
    expect(decodeShellOutput(gbk)).toBe('系统找不到指定的文件。')
  })

  it('纯 ASCII 走 UTF-8 分支（零漂移）', () => {
    expect(decodeShellOutput(Buffer.from('ENOENT: no such file', 'utf8'))).toBe('ENOENT: no such file')
  })

  it('非法字节序列不抛错（诊断通道保底，宁可有损）', () => {
    expect(() => decodeShellOutput(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).not.toThrow()
  })

  it('空缓冲返回空串', () => {
    expect(decodeShellOutput(Buffer.alloc(0))).toBe('')
  })
})
