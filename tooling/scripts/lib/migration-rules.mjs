// Pure rule engine for the migration linter. No I/O so it can be unit-tested (scripts/migration-lint.test.mjs).

export const ALLOW_RE = /^\s*--\s*gate:allow-destructive\s+(\S.*?)\s*$/m;

/** Split SQL into statements, remembering the comment lines that directly precede each one. Handles '...' strings and comments. */
export function splitStatements(sql) {
  const out = [];
  let cur = '', comments = [], i = 0, inStr = false;
  const flush = () => {
    const text = cur.trim();
    if (text) out.push({ text, comments: comments.slice() });
    cur = ''; comments = [];
  };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (inStr) { cur += c; if (c === "'" && n === "'") { cur += n; i += 2; continue; } if (c === "'") inStr = false; i++; continue; }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === '-' && n === '-') {
      const end = sql.indexOf('\n', i); const line = sql.slice(i, end === -1 ? sql.length : end);
      // A comment on its own line (nothing but whitespace before it in the current statement) annotates the next statement.
      if (cur.trim() === '') comments.push(line); else cur += ' ';
      i = end === -1 ? sql.length : end + 1; continue;
    }
    if (c === '/' && n === '*') { const end = sql.indexOf('*/', i + 2); if (cur.trim() === '') comments.push(sql.slice(i, end === -1 ? sql.length : end + 2)); i = end === -1 ? sql.length : end + 2; cur += ' '; continue; }
    if (c === ';') { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return out;
}

const squash = s => s.replace(/\s+/g, ' ').trim();

/** @returns {{rule:string, statement:string, allowed:boolean, reason?:string}[]} */
export function lintSql(sql) {
  const found = [];
  for (const st of splitStatements(sql)) {
    const t = squash(st.text);
    const u = t.toUpperCase();
    const hits = [];
    if (/^DROP TABLE\b/.test(u)) hits.push('DROP TABLE');
    if (/^ALTER TABLE\b.*\bDROP COLUMN\b/.test(u)) hits.push('DROP COLUMN');
    if (/^ALTER TABLE\b.*\bRENAME\b/.test(u)) hits.push('ALTER ... RENAME');
    if (/^DELETE FROM\b/.test(u) && !/\bWHERE\b/.test(u)) hits.push('DELETE FROM without WHERE');
    if (/^UPDATE\b/.test(u) && !/\bWHERE\b/.test(u)) hits.push('UPDATE without WHERE');
    if (/^ALTER TABLE\b.*\bADD( COLUMN)?\b/.test(u)) {
      const def = u.replace(/^ALTER TABLE\s+\S+\s+ADD( COLUMN)?\s+/, '');
      if (/\bNOT NULL\b/.test(def) && !/\bDEFAULT\b/.test(def)) hits.push('ADD COLUMN NOT NULL without DEFAULT');
    }
    for (const rule of hits) {
      const m = st.comments.join('\n').match(ALLOW_RE);
      found.push({ rule, statement: t.slice(0, 140), allowed: !!m, reason: m ? m[1] : undefined });
    }
  }
  return found;
}

export const NAME_RE = /^(\d{4})_[a-z0-9][a-z0-9_]*\.sql$/;

/** @param {string[]} names file names (sorted) @returns {string[]} problems */
export function checkNumbering(names) {
  const problems = [];
  const bad = names.filter(n => !NAME_RE.test(n));
  for (const n of bad) problems.push(`${n}: name must match NNNN_snake_case.sql`);
  const nums = names.filter(n => NAME_RE.test(n)).map(n => Number(n.slice(0, 4)));
  nums.forEach((num, idx) => {
    if (num !== idx + 1) problems.push(`numbering is not sequential: expected ${String(idx + 1).padStart(4, '0')} but found ${String(num).padStart(4, '0')}`);
  });
  return [...new Set(problems)];
}
