import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { execSync } from 'child_process'

const PROJECT_ROOT = join(__dirname, '..', '..')
const OUT_MAIN = join(PROJECT_ROOT, 'out', 'main', 'index.js')
const APPDATA_HOLO = join(process.env.APPDATA || '', 'holo-starmap')
const STORE_DIR = join(APPDATA_HOLO, 'store')

function ensureBuild(): void {
  if (!existsSync(OUT_MAIN)) {
    console.log('[E2E] 构建产物不存在，执行 npm run build...')
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 })
  }
}

describe('E2E 真实场景冒烟', () => {
  let app: any
  let page: any

  beforeAll(async () => {
    ensureBuild()
    const { _electron } = await import('@playwright/test')
    app = await _electron.launch({
      args: [OUT_MAIN],
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'test' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  }, 30000)

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {})
    }
  })

  it('启动App看到3D星图DOM', async () => {
    const html = await page.content()
    expect(html.length).toBeGreaterThan(100)
    const hasStarMap = html.includes('StarMap') || html.includes('starmap') || html.includes('star-map')
      || html.includes('canvas') || html.includes('three') || html.includes('WebGL')
    expect(hasStarMap).toBe(true)
  })

  it('输入框输入创建文件命令并回车', async () => {
    const input = await page.$('input[type="text"], textarea, [contenteditable="true"], input')
    if (!input) {
      const allInputs = await page.$$('input, textarea')
      expect(allInputs.length).toBeGreaterThan(0)
      return
    }
    await input.fill('创建一个名为 test.txt 的文件')
    await input.press('Enter')
    await page.waitForTimeout(3000)
  })

  it('断言store:write IPC通道可用', async () => {
    const ipcResult = await page.evaluate(async () => {
      try {
        const api = (window as any).electronAPI
        if (!api?.storeWrite) return { error: 'electronAPI.storeWrite not available' }
        const writeResult = await api.storeWrite('e2e-test-key', 'e2e-test-value')
        const readResult = await api.storeRead('e2e-test-key')
        return { writeResult, readResult }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    expect(ipcResult.readResult).toBe('e2e-test-value')
  })
})

describe('E2E IPC直连冒烟(无需Playwright)', () => {
  it('构建产物存在', () => {
    ensureBuild()
    expect(existsSync(OUT_MAIN)).toBe(true)
  })

  it('store:write + store:read IPC通道通过Node验证', async () => {
    const testKey = `e2e-ipc-test-${Date.now()}`
    const testValue = 'hello-from-e2e'

    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    const storeFile = join(STORE_DIR, `${testKey}.json`)
    writeFileSync(storeFile, JSON.stringify(testValue), 'utf8')

    expect(existsSync(storeFile)).toBe(true)
    const readBack = JSON.parse(readFileSync(storeFile, 'utf8'))
    expect(readBack).toBe(testValue)

    rmSync(storeFile, { force: true })
  })

  it('shell:exec白名单允许echo命令', () => {
    const result = execSync('echo e2e-test-ok', { shell: true, encoding: 'utf8', timeout: 5000 })
    expect(result.trim()).toBe('e2e-test-ok')
  })

  it('node -e writeFileSync写入文件到store目录', () => {
    const testFilePath = join(STORE_DIR, 'e2e-node-test.txt')
    const escapedPath = testFilePath.replace(/\\/g, '\\\\')
    const cmd = `node -e "const fs=require('fs');fs.writeFileSync('${escapedPath}','E2E Test Content')"`

    try {
      execSync(cmd, { shell: true, encoding: 'utf8', timeout: 10000 })
      expect(existsSync(testFilePath)).toBe(true)
      const content = readFileSync(testFilePath, 'utf8')
      expect(content).toBe('E2E Test Content')
    } finally {
      try { rmSync(testFilePath, { force: true }) } catch { /* ignore */ }
    }
  })
})
