import { test, expect } from '@playwright/test';

/**
 * Known-defect bookkeeping for gates that collect many findings in one pass.
 * Findings matching a KNOWN entry are reported (as `known-bug` annotations) instead of failing; anything else fails the test, and a
 * KNOWN entry that no longer matches anything fails too (so fixed bugs must be removed from the list).
 */
export type Known = { pattern: RegExp; reason: string; /** intermittent findings: reported when seen, but not flagged stale when absent */ optional?: boolean };

export function expectOnlyKnown(findings: string[], known: Known[], label: string) {
  const unique = [...new Set(findings)];
  const unknown: string[] = [];
  const hit = new Set<Known>();
  for (const f of unique) {
    const k = known.find(k => k.pattern.test(f));
    if (k) hit.add(k); else unknown.push(f);
  }
  for (const k of hit) test.info().annotations.push({ type: 'known-bug', description: `${label}: ${k.reason}` });
  const stale = known.filter(k => !hit.has(k) && !k.optional).map(k => `stale KNOWN-BUG (no longer reproduces, remove it): ${k.pattern} // ${k.reason}`);
  expect([...unknown, ...stale], `${label}:\n${[...unknown, ...stale].join('\n')}`).toEqual([]);
}
