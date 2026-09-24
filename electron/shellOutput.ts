// F-3（2026-09-24）：shell 输出的代码页解码。
//
// Windows 的 cmd 内建命令（dir / type / echo 等）按**系统 ANSI 代码页**输出字节流——
// 简中环境即 GBK/CP936。主进程原先一律 `data.toString()`（UTF-8 解码），于是
// 「系统找不到指定的文件。」这类中文失败信息上屏即乱码，**失败原因对用户完全不可读**
// （LIFECYCLE-GAPS F-3，手术题 S3 实测）。
import iconv from 'iconv-lite'

/**
 * 解码 shell 输出字节流。
 *
 * 策略（顺序即优先级）：
 * 1. UTF-8 **严格**解码——`chcp 65001` 或现代 CLI 的输出走这条（fatal 模式保证不静默吞错）；
 * 2. 失败（非法序列）⇒ 判定为本地代码页，按 GBK 解；
 * 3. GBK 也失败 ⇒ 退回宽松 UTF-8。
 *
 * 任何情况下都不抛错：这是诊断信息通道，宁可有损也不能把异常抛进 stderr 收集路径。
 */
export function decodeShellOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return iconv.decode(buf, 'gbk')
    } catch {
      return buf.toString('utf8')
    }
  }
}
