import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tests/**/*.spec.ts', 'plugin-build/test/marshal-sse.test.js'], testTimeout: 10_000 } })
