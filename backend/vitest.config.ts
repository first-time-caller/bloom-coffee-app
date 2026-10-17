import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: { bindings: { MIGRATIONS: migrations, AUTH_RATE_LIMIT: '8' } }
      })
    ],
    server: { fs: { allow: ['..'] } },
    test: {
      setupFiles: ['./test/setup.ts'],
      // Reliability gate: >=85% on every metric (see docs/QUALITY-GATES.md).
      coverage: {
        allowExternal: true, // web/bloom-sync.js lives outside backend/
        // v8 is unsupported inside workerd (no node:inspector), so use istanbul; see docs/QUALITY-GATES.md
        provider: 'istanbul',
        include: ['src/**/*.ts', path.join(import.meta.dirname, '../web/bloom-sync.js')],
        reporter: ['text-summary', 'text', 'json-summary', 'lcov'],
        reportsDirectory: './coverage',
        thresholds: {
          // Worker source: hard 85% floor on every metric.
          'src/**/*.ts': { lines: 85, branches: 85, functions: 85, statements: 85 },
          // web/bloom-sync.js is exercised only through test/adapter.test.ts. Branches are below 85%, so this is a
          // ratchet: floors sit just under the measured baseline (tooling/coverage-baseline.json). Raise, never lower.
          [path.join(import.meta.dirname, '../web/bloom-sync.js')]: { lines: 94, branches: 66, functions: 82, statements: 84 }
        }
      }
    }
  };
});
