import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        // Workers' WebCrypto caps PBKDF2 at 100k rounds, so the in-workerd client tests use 1000; production floors stay 600k.
        miniflare: { bindings: { MIGRATIONS: migrations, AUTH_RATE_LIMIT: '8', MIN_KDF_ITERATIONS: '1000' } }
      })
    ],
    server: { fs: { allow: ['..'] } },
    test: {
      setupFiles: ['./test/setup.ts'],
      // Reliability gate: >=85% on every metric (see docs/QUALITY-GATES.md).
      coverage: {
        // v8 is unsupported inside workerd (no node:inspector), so use istanbul; see docs/QUALITY-GATES.md
        provider: 'istanbul',
        include: ['src/**/*.ts'], // web/bloom-sync.js is a minified build output of packages/sync (covered there)
        reporter: ['text-summary', 'text', 'json-summary', 'lcov'],
        reportsDirectory: './coverage',
        thresholds: {
          // Worker source: hard 85% floor on every metric.
          'src/**/*.ts': { lines: 85, branches: 85, functions: 85, statements: 85 }
        }
      }
    }
  };
});
