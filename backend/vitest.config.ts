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
    test: { setupFiles: ['./test/setup.ts'] }
  };
});
