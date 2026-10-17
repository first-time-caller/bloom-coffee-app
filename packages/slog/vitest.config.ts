import { defineConfig } from 'vitest/config';

// Reliability gate: >=85% on every metric (see docs/QUALITY-GATES.md).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/browser.ts'], // 2-line bundle entry point, exercised by the web e2e gate
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 }
    }
  }
});
