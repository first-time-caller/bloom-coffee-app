// Speed gate: Lighthouse CI against a static server of web/. Mobile emulation (Lighthouse default), 3 runs, median.
const fs = require('node:fs');
const path = require('node:path');
const budgets = require('./budgets.json').lighthouse;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  // Locally: the Chromium preinstalled in $PLAYWRIGHT_BROWSERS_PATH. In GitHub Actions: Playwright's install (same location rule), or the runner's Chrome.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || '', '.cache', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return undefined; // let Lighthouse find a system Chrome (GitHub-hosted runners ship one)
}

const PORT = 4174;
module.exports = {
  ci: {
    collect: {
      startServerCommand: `node scripts/serve.mjs ${PORT}`,
      startServerReadyPattern: 'serving',
      url: [`http://127.0.0.1:${PORT}/index.html`],
      numberOfRuns: 3,
      chromePath: findChrome(),
      settings: {
        // Mobile emulation + simulated Slow 4G / 4x CPU are Lighthouse defaults; stated here so a change is visible in review.
        formFactor: 'mobile',
        chromeFlags: '--no-sandbox --headless=new --disable-gpu',
        onlyCategories: ['performance', 'accessibility', 'best-practices']
      }
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: budgets.performance, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: budgets.accessibility, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['error', { minScore: budgets['best-practices'], aggregationMethod: 'median-run' }]
      }
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' }
  }
};
