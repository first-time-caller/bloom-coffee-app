// Proves each lint rule fires (and that the escape hatch works). Run: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSql, checkNumbering, splitStatements } from './lib/migration-rules.mjs';

const rules = sql => lintSql(sql).filter(f => !f.allowed).map(f => f.rule);

test('forbids destructive DDL/DML', () => {
  assert.deepEqual(rules('DROP TABLE users;'), ['DROP TABLE']);
  assert.deepEqual(rules('ALTER TABLE users DROP COLUMN name;'), ['DROP COLUMN']);
  assert.deepEqual(rules('ALTER TABLE users RENAME TO people;'), ['ALTER ... RENAME']);
  assert.deepEqual(rules('ALTER TABLE users RENAME COLUMN name TO full_name;'), ['ALTER ... RENAME']);
  assert.deepEqual(rules('DELETE FROM docs;'), ['DELETE FROM without WHERE']);
  assert.deepEqual(rules('UPDATE docs SET deleted = 0;'), ['UPDATE without WHERE']);
  assert.deepEqual(rules('ALTER TABLE users ADD COLUMN x TEXT NOT NULL;'), ['ADD COLUMN NOT NULL without DEFAULT']);
});
test('allows safe statements', () => {
  assert.deepEqual(rules("DELETE FROM docs WHERE deleted = 1;"), []);
  assert.deepEqual(rules("UPDATE docs SET deleted = 0 WHERE user_id = 'a';"), []);
  assert.deepEqual(rules("ALTER TABLE users ADD COLUMN x TEXT NOT NULL DEFAULT '';"), []);
  assert.deepEqual(rules('ALTER TABLE users ADD COLUMN x TEXT;'), []);
  assert.deepEqual(rules('CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX i ON t(id); DROP INDEX i;'), []);
});
test('ignores keywords inside comments and strings', () => {
  assert.deepEqual(rules("-- DROP TABLE users;\nINSERT INTO t VALUES ('DROP TABLE x; DELETE FROM y');"), []);
  assert.deepEqual(rules('/* DROP TABLE users; */ SELECT 1;'), []);
});
test('escape hatch needs a reason and applies to the next statement only', () => {
  const ok = lintSql('-- gate:allow-destructive legacy table, data exported 2026-01\nDROP TABLE old;');
  assert.equal(ok.length, 1); assert.equal(ok[0].allowed, true); assert.match(ok[0].reason, /exported/);
  assert.deepEqual(rules('-- gate:allow-destructive\nDROP TABLE old;'), ['DROP TABLE']); // no reason
  assert.deepEqual(rules('-- gate:allow-destructive reason here\nSELECT 1;\nDROP TABLE old;'), ['DROP TABLE']);
});
test('numbering must be sequential and well named', () => {
  assert.deepEqual(checkNumbering(['0001_init.sql', '0002_more.sql']), []);
  assert.match(checkNumbering(['0001_init.sql', '0003_gap.sql'])[0], /not sequential/);
  assert.match(checkNumbering(['0001_init.sql', '0001_dup.sql'])[0], /not sequential/);
  assert.match(checkNumbering(['init.sql'])[0], /must match/);
});
test('splitStatements keeps quoted semicolons together', () => {
  assert.equal(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;").length, 2);
});
