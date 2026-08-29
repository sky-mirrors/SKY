import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/services/macroExecutor.ts', 'src/services/scheduleOptimizer.ts', 'src/services/errorClassifier.ts', 'src/services/dualEngineValidator.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60
      },
      perFile: true
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})
