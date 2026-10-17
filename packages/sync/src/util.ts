/**
 * First sign-in merge rule, shared by every client so the rule is tested once.
 * Given the records already on this device and the records already in the account, return the ones to upload:
 * those the account lacks, and those where the local copy is strictly newer (by updatedAt, else createdAt).
 * Ties and older copies keep the account's version. Nothing local is ever discarded by this function.
 */
export interface Stamped { id: string; updatedAt?: unknown; createdAt?: unknown }

const stampOf = (r: Stamped): string => {
  const u = r.updatedAt, c = r.createdAt;
  return typeof u === 'string' && u ? u : typeof c === 'string' ? c : '';
};

export function planUpload<T extends Stamped>(local: readonly T[], remote: readonly Stamped[]): { upload: T[]; keepRemote: number } {
  const theirs = new Map<string, Stamped>();
  for (const r of remote) if (r && typeof r.id === 'string') theirs.set(r.id, r);
  const upload: T[] = [];
  const seen = new Set<string>();
  for (const l of local) {
    if (!l || typeof l.id !== 'string' || !l.id || seen.has(l.id)) continue;
    seen.add(l.id);
    const r = theirs.get(l.id);
    if (!r || stampOf(l) > stampOf(r)) upload.push(l);
  }
  return { upload, keepRemote: seen.size - upload.length };
}
