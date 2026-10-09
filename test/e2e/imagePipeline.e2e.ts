/**
 * 第二波·图像能力：脱离 vitest 的真端到端验收。
 *
 * 为什么单独放 test/e2e（vitest 配置已排除该目录）：这条链路要在**Electron 运行时**里
 * 验证 sharp 的原生二进制可加载（N-API 预编译包在 Electron 下免 rebuild，但必须实测）。
 * 本脚本跑的是生产代码（electron/imageOps.ts），不是复刻实现。
 *
 * 运行：npm run verify:image
 */
import { app } from 'electron'
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { processImages } from '../../electron/imageOps'

const workDir = join(app.getPath('temp'), 'holo-img-e2e')
const examPhotos = 'C:\\Users\\<user>\\Desktop\\HoloExam\\photos'
const fixtures = join(process.cwd(), 'test', 'fixtures')

function pickInputs(): string[] {
  const fromExam = ['img0.jpg', 'img1.jpg', 'img2.jpg', 'img3.jpg']
    .map(n => join(examPhotos, n))
    .filter(p => existsSync(p))
  if (fromExam.length > 0) return fromExam
  return ['no-exif.jpg', 'exif-datetime-only.jpg'].map(n => join(fixtures, n)).filter(p => existsSync(p))
}

function isWebp(p: string): boolean {
  const head = readFileSync(p).subarray(0, 12).toString('latin1')
  return head.startsWith('RIFF') && head.includes('WEBP')
}
function isJpeg(p: string): boolean {
  const b = readFileSync(p)
  return b[0] === 0xff && b[1] === 0xd8
}

async function main(): Promise<void> {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const inputs = pickInputs()
  const lines: string[] = []
  let failed = 0
  const check = (label: string, ok: boolean, detail: string): void => {
    lines.push(`${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`)
    if (!ok) failed++
  }

  check('输入就绪', inputs.length > 0, `源文件 ${inputs.length} 个`)

  // 用例 1：批量缩到 400 宽并转 webp
  const r1 = await processImages({
    inputs, op: { resize: { width: 400 }, format: 'webp', quality: 75 }, outDir: workDir, suffix: '-w400'
  })
  check('批量缩放+转webp 全部成功', r1.outputs.length === inputs.length && r1.failures.length === 0,
    `成功 ${r1.outputs.length}/${inputs.length}${r1.failures.length ? ' 失败=' + JSON.stringify(r1.failures) : ''}`)
  const allW400 = r1.outputs.every(o => o.width === 400 || o.width <= 400)
  const allWebp = r1.outputs.every(o => isWebp(o.to))
  check('输出宽度=400 且为真 webp', allW400 && allWebp,
    r1.outputs.map(o => `${o.width}x${o.height}/${o.format}`).join(' '))

  // 用例 2：只压缩质量（沿用源格式 jpeg）
  const r2 = await processImages({ inputs, op: { quality: 40 }, outDir: workDir, suffix: '-q40' })
  const smaller = r2.outputs.every(o => o.bytes > 0 && o.bytes < statSync(o.from).size)
  check('压缩后体积变小且仍是 jpeg', r2.outputs.length === inputs.length && smaller && r2.outputs.every(o => isJpeg(o.to)),
    r2.outputs.map(o => `${o.bytes}B<${statSync(o.from).size}B`).join(' '))

  // 用例 3：部分失败必须"部分"——一个坏路径不能拖垮整批，也不能被说成全部成功
  const r3 = await processImages({
    inputs: [...inputs, join(workDir, '不存在.jpg')], op: { quality: 60 }, outDir: workDir, suffix: '-mix'
  })
  check('部分失败如实回传', r3.outputs.length === inputs.length && r3.failures.length === 1,
    `成功 ${r3.outputs.length} 失败 ${r3.failures.length}`)

  // 用例 4：负例——不支持的源格式必须抛错（不交给解码器去试）
  let negOk = false
  try {
    await processImages({ inputs: [join(workDir, 'x.heic')], op: { quality: 50 }, outDir: workDir })
  } catch (e) {
    negOk = (e as Error).message.includes('不支持的源格式')
  }
  check('负例：heic 被显式拒绝', negOk, '抛出「不支持的源格式」')

  for (const l of lines) console.log(l)
  console.log(`输出目录: ${workDir}`)
  console.log(failed === 0 ? 'E2E_RESULT=PASS' : `E2E_RESULT=FAIL(${failed})`)
}

app.whenReady()
  .then(main)
  .catch((e) => { console.log('E2E_RESULT=FAIL 未捕获异常: ' + (e as Error).message) })
  .finally(() => { app.exit() })
