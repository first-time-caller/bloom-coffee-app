// Reliability gate: data preservation across migrations.
// For each migration N >= 2: build a database with migrations 1..N-1, load representative rows, apply N, and assert every
// pre-existing row/column survives unchanged. SQLite is what D1 runs, so node:sqlite is a faithful, dependency-free stand-in.
// Migrations carrying "-- gate:allow-destructive" are exempt (they must explain themselves in review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSql } from './lib/migration-rules.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(here, '../../backend/migrations');
const fixtures = resolve(here, '../migration-fixtures');
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const sql = f => readFileSync(join(dir, f), 'utf8');

const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").all().map(r => r.name);
const cols = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all();

/** Insert deterministic rows into any table that the hand-written fixture left empty (so new tables are exercised too). */
function fillMissing(db) {
  const deps = new Map(tables(db).map(t => [t, db.prepare(`PRAGMA foreign_key_list("${t}")`).all()]));
  const done = new Set();
  const visit = t => {
    if (done.has(t)) return; done.add(t);
    for (const fk of deps.get(t)) if (fk.table !== t) visit(fk.table);
    if (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c > 0) return;
    const cs = cols(db, t);
    for (let n = 1; n <= 3; n++) {
      const vals = cs.map(c => {
        const fk = deps.get(t).find(f => f.from === c.name);
        if (fk) return db.prepare(`SELECT "${fk.to}" v FROM "${fk.table}" LIMIT 1`).get()?.v ?? null;
        const type = (c.type || '').toUpperCase();
        if (type.includes('INT')) return n;
        if (type.includes('BLOB')) return new Uint8Array([n, 2, 3]);
        if (type.includes('REAL') || type.includes('NUM')) return n + 0.5;
        return `${t}-${c.name}-${n}`;
      });
      db.prepare(`INSERT INTO "${t}" (${cs.map(c => `"${c.name}"`).join(',')}) VALUES (${cs.map(() => '?').join(',')})`).run(...vals);
    }
  };
  for (const t of deps.keys()) visit(t);
}

function snapshot(db) {
  const snap = {};
  for (const t of tables(db)) snap[t] = { cols: cols(db, t).map(c => c.name), rows: db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map(r => ({ ...r })) };
  return snap;
}

test('there is at least the initial migration', () => assert.ok(files.length >= 1));

test('the full migration chain applies cleanly to an empty database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of files) db.exec(sql(f));
  assert.ok(tables(db).length >= 4);
});

for (let n = 1; n < files.length; n++) {
  const next = files[n];
  test(`${next}: rows written under ${files[n - 1]} survive`, t => {
    const destructive = lintSql(sql(next)).some(f => f.allowed);
    if (destructive) { t.skip('migration has an explicit gate:allow-destructive exemption'); return; }
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of files.slice(0, n)) db.exec(sql(f));
    const fx = join(fixtures, files[n - 1].slice(0, 4) + '.sql');
    if (existsSync(fx)) db.exec(readFileSync(fx, 'utf8'));
    fillMissing(db);
    const before = snapshot(db);
    assert.ok(Object.values(before).some(t => t.rows.length > 0), 'precondition: seeded rows exist');

    db.exec(sql(next));

    const after = snapshot(db);
    for (const [table, b] of Object.entries(before)) {
      assert.ok(after[table], `table ${table} was removed by ${next}`);
      assert.equal(after[table].rows.length, b.rows.length, `${table}: row count changed`);
      for (const c of b.cols) assert.ok(after[table].cols.includes(c), `${table}.${c} was removed`);
      b.rows.forEach((row, i) => {
        for (const c of b.cols) assert.deepEqual(after[table].rows[i][c], row[c], `${table}[${i}].${c} changed`);
      });
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'foreign keys intact');
  });
}
