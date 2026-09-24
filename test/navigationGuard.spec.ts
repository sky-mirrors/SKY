import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { isAllowedNavigationTarget } from '@electron/navigation-guard'

describe('E-1: will-navigate 导航白名单（isAllowedNavigationTarget）', () => {
  const rendererDir = fileURLToPath('file:///C:/App/out/renderer')
  const dev = 'http://localhost:5173'
  const policy = { rendererDir, devServerUrl: dev }

  it('渲染目录内的 file:// 入口 → 允许', () => {
    expect(isAllowedNavigationTarget('file:///C:/App/out/renderer/index.html', policy)).toBe(true)
  })

  it('渲染目录下其它入口 file:// → 允许', () => {
    expect(isAllowedNavigationTarget('file:///C:/App/out/renderer/pipeline.html', policy)).toBe(true)
  })

  it('渲染目录外的 file:// → 拒绝', () => {
    expect(isAllowedNavigationTarget('file:///C:/Windows/System32/evil.html', policy)).toBe(false)
  })

  it('dev 渲染服务器同源 URL → 允许', () => {
    expect(isAllowedNavigationTarget('http://localhost:5173/pipeline.html', policy)).toBe(true)
  })

  it('dev origin 前缀伪造（localhost:5173.evil.com）→ 拒绝', () => {
    expect(isAllowedNavigationTarget('http://localhost:5173.evil.com/x', policy)).toBe(false)
  })

  it('外部 https → 拒绝', () => {
    expect(isAllowedNavigationTarget('https://evil.com/', policy)).toBe(false)
  })

  it('javascript: URI → 拒绝', () => {
    expect(isAllowedNavigationTarget('javascript:alert(1)', policy)).toBe(false)
  })

  it('空 URL → 拒绝', () => {
    expect(isAllowedNavigationTarget('', policy)).toBe(false)
  })

  it('未配置 dev server 时 http://localhost 不放行', () => {
    expect(isAllowedNavigationTarget('http://localhost:5173/x', { rendererDir })).toBe(false)
  })
})

describe('E-1: 生产 HTML 入口均带 CSP', () => {
  for (const f of ['index.html', 'pipeline.html', 'debug.html', 'benchmark.html', 'rule-review.html']) {
    it(`${f} 含 Content-Security-Policy meta`, () => {
      const html = readFileSync(join(process.cwd(), f), 'utf8')
      expect(html).toMatch(/http-equiv=["']Content-Security-Policy["']/i)
    })
  }
})
