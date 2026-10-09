import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // 2026-10-09：测试失败时也产出覆盖率报告。vitest 默认 reportOnFailure=false，
      // 会让「存在任一失败用例」时**静默跳过**报告 ⇒ 阈值根本不执行、真实覆盖率无从查看。
      // 本机在 Ollama 运行时 apiStore.timerDispose 必失败（见 docs/60 已知噪声），正好命中该盲区。
      reportOnFailure: true,
      include: ['src/services/**/*.ts', 'src/stores/**/*.ts'],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40
      },
      perFile: true
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron')
    }
  }
})
