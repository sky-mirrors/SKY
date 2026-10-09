import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { expandPathTemplate } from '@electron/pathExpansion'
import { validateReadPath, validateWritePath } from '@electron/pathValidator'

/**
 * F-8 修复（快照 §十二 / HANDOFF 卡点 1 第 1 条）：主对话路径的文件工具不展开
 * `%USERPROFILE%` / `%HOME%`。
 *
 * 亲验结论（2026-09-27）：展开此前只存在于渲染层 `src/services/macroExecutor.ts:130`
 * 的局部 `resolveFilePath`（且全仓 10 处调用**全在 macroExecutor.ts**），主对话路径
 * （`src/stores/dialogStore.ts:613`）把字面量直接透传给 `file:read` ⇒ 主进程按字面量
 * `resolve()`，落在一个名为 `%USERPROFILE%` 的目录上 ⇒「文件不存在」。
 *
 * 修复方式：把展开下沉到主进程 `electron/ipc-handlers.ts` 的**校验入口单一处**
 * （四个 validate* 前置 expandPathTemplate），一处覆盖全部调用方（整组原生文件工具，
 * 不止 read_file），且未来新增 handler 自动获得展开——杜绝「单侧修复」复发。
 */

// 与 pathValidator.getAllowedBaseDirs() 的 fallback 同口径，保证展开后的路径落在允许目录内
const HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'

describe('expandPathTemplate —— 路径模板展开', () => {
  it('展开 %USERPROFILE% 为 home', () => {
    expect(expandPathTemplate('%USERPROFILE%\\Desktop\\a.txt', HOME)).toBe(`${HOME}\\Desktop\\a.txt`)
  })

  it('展开 %HOME% 为 home', () => {
    expect(expandPathTemplate('%HOME%/Desktop/a.txt', HOME)).toBe(`${HOME}/Desktop/a.txt`)
  })

  it('同一模板出现多次时全部展开（原 env:resolvePath 只替首次）', () => {
    expect(expandPathTemplate('%USERPROFILE%\\x\\%USERPROFILE%', HOME)).toBe(`${HOME}\\x\\${HOME}`)
  })

  it('不含模板的普通路径原样返回（幂等，绝对路径不受影响）', () => {
    const abs = 'C:\\Users\\<user>\\Desktop\\a.txt'
    expect(expandPathTemplate(abs, HOME)).toBe(abs)
    expect(expandPathTemplate('/home/user/a.txt', HOME)).toBe('/home/user/a.txt')
  })

  it('空串与非字符串原样返回，不抛错', () => {
    expect(expandPathTemplate('', HOME)).toBe('')
    expect(expandPathTemplate(undefined as unknown as string, HOME)).toBe(undefined)
  })
})

describe('展开后的路径能通过主进程校验（F-8 判据链）', () => {
  it('修复前：字面量 %USERPROFILE% 不被展开（resolved 仍含模板 ⇒ 指向不存在的目录）', () => {
    // 真症状不是「校验被拒」而是「文件不存在」：校验能过（字面量按当前 cwd 相对 resolve，
    // 而 cwd 恰落在允许目录内即判 safe），但 resolved 里保留 %USERPROFILE% 字面量 ⇒
    // existsSync 为 false。这是「展开缺失」而非「校验太松」的实证——故修复点必须在
    // validate 之前，而非把展开塞进 pathValidator 去放宽校验。
    const r = validateReadPath('%USERPROFILE%\\Desktop\\a.txt')
    expect(r.resolved).toContain('%USERPROFILE%')
  })

  it('修复后：展开 → 读校验通过（目标行为）', () => {
    const r = validateReadPath(expandPathTemplate('%USERPROFILE%\\Desktop\\a.txt', HOME))
    expect(r.safe).toBe(true)
  })

  it('修复后：写路径同样通过展开 → 写校验通过', () => {
    const r = validateWritePath(expandPathTemplate('%USERPROFILE%\\Desktop\\out.txt', HOME))
    expect(r.safe).toBe(true)
  })

  it('展开不放松安全边界：模板拼路径遍历仍被拒', () => {
    const r = validateReadPath(expandPathTemplate('%USERPROFILE%\\..\\..\\Windows\\System32\\drivers\\etc\\hosts', HOME))
    expect(r.safe).toBe(false)
  })
})

/**
 * 主进程 handler 在 setupIpc 闭包里、依赖 electron 的 ipcMain，单测拿不到它们
 * （同 `electron/fileListing.ts` 头注的约定）。故沿用本项目对同类 dispatch 的既有做法
 * （见 `fileMoveDispatch.spec.ts`）：对源码文本做契约断言，钉住「路径入口统一前置展开」。
 */
describe('主进程路径入口统一前置展开（防「单侧修复」复发）', () => {
  const src = readFileSync(join(process.cwd(), 'electron/ipc-handlers.ts'), 'utf-8')

  it('四个路径校验入口都包了 expandPathTemplate（新增 handler 自动覆盖）', () => {
    expect(src).toContain('const validatePath = (p: string) => _validatePath(expandPathTemplate(p, homeDir()))')
    expect(src).toContain('const validateReadPath = (p: string) => _validateReadPath(expandPathTemplate(p, homeDir()))')
    expect(src).toContain('const validateWritePath = (p: string) => _validateWritePath(expandPathTemplate(p, homeDir()))')
    expect(src).toContain('const validateOpenPath = (p: string) => _validateOpenPath(expandPathTemplate(p, homeDir()))')
  })

  it('home 取自 app.getPath(\'home\')，与 env:resolvePath 同口径', () => {
    expect(src).toMatch(/homeDir\s*=\s*\(\)\s*=>\s*app\.getPath\('home'\)/)
  })

  it('env:resolvePath 复用同一展开实现（单一真相，避免两套口径）', () => {
    expect(src).toMatch(/expandPathTemplate\(/)
  })
})
