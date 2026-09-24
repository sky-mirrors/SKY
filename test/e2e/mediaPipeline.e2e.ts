/**
 * 第三波·媒体能力：脱离 vitest 的真端到端验收。
 *
 * 为什么单独放 test/e2e（vitest 配置已排除该目录）：这条链路要在 **Electron 主进程**里
 * 用真 ffmpeg.exe 跑（二进制来自 npm 平台包 @ffmpeg-installer/win32-x64），vitest 里没有
 * 那个运行时上下文。本脚本跑的是生产代码（electron/mediaOps.ts）。
 *
 * 输入素材由 ffmpeg 自己用 lavfi 合成（本机没有现成媒体文件），因此这条链路完全自给自足。
 * 运行：npm run verify:media
 */
import { app } from 'electron'
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { processMedia, createFfmpegRunner, resolveFfmpegPath } from '../../electron/mediaOps'

const workDir = join(app.getPath('temp'), 'holo-media-e2e')

function magic(p: string, n = 4): string {
  return existsSync(p) ? readFileSync(p).subarray(0, n).toString('latin1') : ''
}

async function main(): Promise<void> {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const ffmpegPath = resolveFfmpegPath()
  const run = createFfmpegRunner(ffmpegPath)
  const lines: string[] = []
  let failed = 0
  const check = (label: string, ok: boolean, detail: string): void => {
    lines.push(`${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`)
    if (!ok) failed++
  }

  check('ffmpeg 可执行文件就绪', existsSync(ffmpegPath), `${ffmpegPath.split('node_modules').pop()} ${Math.round(statSync(ffmpegPath).size / 1048576)}MB`)

  // 合成 2 秒 320x240 测试视频（含音轨）
  const src = join(workDir, 'src.mp4')
  const gen = await run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src])
  check('合成测试媒体', gen.code === 0 && existsSync(src), `code=${gen.code} ${existsSync(src) ? statSync(src).size + 'B' : gen.stderr.slice(-120)}`)
  if (!existsSync(src)) { lines.push('E2E_RESULT=FAIL(无输入素材，后续用例跳过)'); for (const l of lines) console.log(l); return }

  // 用例 1：转 webm
  const r1 = await processMedia({ inputs: [src], op: { format: 'webm', width: 160 }, outDir: workDir, suffix: '-webm' }, run)
  const w = r1.outputs[0]?.to ?? ''
  check('转 webm', r1.outputs.length === 1 && magic(w) === '\x1aE\xdf\xa3', `${w} ${magic(w, 4)} ${r1.failures[0]?.error ?? ''}`.trim())

  // 用例 2：抽音轨 mp3
  const r2 = await processMedia({ inputs: [src], op: { format: 'mp3' }, outDir: workDir, suffix: '-audio' }, run)
  const a = r2.outputs[0]?.to ?? ''
  check('抽音轨 mp3', r2.outputs.length === 1 && magic(a, 3) === 'ID3', `${a} ${magic(a, 3)} ${r2.failures[0]?.error ?? ''}`.trim())

  // 用例 3：缩略图（0.5s、宽 160）
  const r3 = await processMedia({ inputs: [src], op: { thumbnailAt: 0.5, width: 160 }, outDir: workDir, suffix: '-thumb' }, run)
  const t = r3.outputs[0]?.to ?? ''
  const tb = existsSync(t) ? readFileSync(t) : Buffer.alloc(0)
  check('出缩略图 JPEG', r3.outputs.length === 1 && tb[0] === 0xff && tb[1] === 0xd8, `${t} ${tb.length}B`)

  // 用例 4：压缩 + 探元数据
  const r4 = await processMedia({ inputs: [src], op: { crf: 34 }, outDir: workDir, suffix: '-crf34' }, run)
  const c = r4.outputs[0]
  check('压缩（CRF 34）且探到源信息', r4.outputs.length === 1 && !!r4.probe &&
    Math.abs((r4.probe.durationSec ?? 0) - 2) < 0.5 && r4.probe.width === 320 && r4.probe.height === 240,
    `probe=${JSON.stringify(r4.probe)} out=${c?.bytes ?? 0}B`)
  check('压缩后体积不大于源', !!c && c.bytes <= statSync(src).size, `${c?.bytes ?? 0}B <= ${statSync(src).size}B`)

  // 用例 5：裁剪 0.5s 起、0.5s 长
  const r5 = await processMedia({ inputs: [src], op: { start: 0.5, duration: 0.5 }, outDir: workDir, suffix: '-trim' }, run)
  check('裁剪可执行', r5.outputs.length === 1 && r5.outputs[0].bytes > 0, `${r5.outputs[0]?.to ?? ''} ${r5.outputs[0]?.bytes ?? 0}B`)

  // 用例 6：负例——不支持的源格式必须抛错
  let negOk = false
  try {
    await processMedia({ inputs: [join(workDir, 'x.docx')], op: { crf: 30 }, outDir: workDir }, run)
  } catch (e) { negOk = (e as Error).message.includes('不支持的源格式') }
  check('负例：docx 被显式拒绝', negOk, '抛出「不支持的源格式」')

  for (const l of lines) console.log(l)
  console.log(`输出目录: ${workDir}`)
  console.log(failed === 0 ? 'E2E_RESULT=PASS' : `E2E_RESULT=FAIL(${failed})`)
}

app.whenReady()
  .then(main)
  .catch((e) => { console.log('E2E_RESULT=FAIL 未捕获异常: ' + (e as Error).message) })
  .finally(() => { app.exit() })
