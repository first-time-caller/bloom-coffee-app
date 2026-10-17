/** Guards on web/index.html: privacy (no third-party requests), CSP freshness, and that the sync bundle is wired in. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineHashes, policy, seal } from '../scripts/seal-web.ts';

const html = readFileSync(new URL('../../../web/index.html', import.meta.url), 'utf8');

describe('web/index.html', () => {
  it('has a CSP meta that is current for every inline script and style (run `npm run seal` if this fails)', () => {
    expect(seal(html)).toBe(html);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:\/\/(?!127|localhost)[^ ;]*fonts/);
    expect(csp).toMatch(/script-src 'self' 'sha256-[^']+'/);
    const h = inlineHashes(html);
    for (const x of [...h.script, ...h.style]) expect(csp).toContain(x);
    expect(csp).toBe(policy(html, /const SYNC_BASE_URL = '([^']*)'/.exec(html)![1]));
  });

  it('allows the configured sync origin in connect-src and nothing else', () => {
    const sealed = seal(html, 'https://sync.example.com/path');
    expect(/connect-src ([^;]*)/.exec(sealed)![1]).toBe("'self' https://sync.example.com");
    expect(sealed).toContain("const SYNC_BASE_URL = 'https://sync.example.com/path';");
    expect(/connect-src ([^;]*)/.exec(html)![1]).toBe("'self'"); // shipped default: sync off
  });

  it('makes no third-party requests: no Google Fonts, no CDN, no absolute URLs but the SVG namespace', () => {
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const urls = (html.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).filter(u => !u.startsWith('http://www.w3.org/2000/svg'));
    expect(urls).toEqual([]);
    expect(html).not.toMatch(/<link[^>]+rel="(preconnect|stylesheet)"/);
    expect(html).not.toMatch(/\son(click|load|error)=/); // inline handlers would need 'unsafe-inline'
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('is well formed at the top and loads bloom-sync.js before the main script', () => {
    expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
    expect(html.match(/<!doctype/gi)).toHaveLength(1);
    expect(html.match(/<\/body>/g)).toHaveLength(1);
    expect(html.indexOf('<script src="bloom-sync.js"></script>')).toBeGreaterThan(0);
    expect(html.indexOf('<script src="bloom-sync.js"></script>')).toBeLessThan(html.indexOf('const SYNC_BASE_URL'));
    expect(html).toMatch(/const SYNC_BASE_URL = '';/);
    expect(html).toMatch(/--font-display:system-ui/);
  });
});
