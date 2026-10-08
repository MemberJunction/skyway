import { describe, it, expect } from 'vitest';
import { SplitPostgresStatements } from '../statement-splitter';

const sqls = (script: string) => SplitPostgresStatements(script).map((b) => b.SQL);

describe('SplitPostgresStatements', () => {
  it('splits on top-level semicolons and drops empty statements', () => {
    expect(sqls('CREATE INDEX CONCURRENTLY a ON t (c);\n\nCREATE INDEX CONCURRENTLY b ON t (d);\n;')).toEqual([
      'CREATE INDEX CONCURRENTLY a ON t (c)',
      'CREATE INDEX CONCURRENTLY b ON t (d)'
    ]);
  });

  it('keeps a final statement without a trailing semicolon', () => {
    expect(sqls('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside strings, identifiers and E-strings', () => {
    expect(sqls(`INSERT INTO t VALUES ('a;b', 'it''s; fine'); SELECT "odd;name" FROM t; SELECT E'x\\';y'`)).toEqual([
      `INSERT INTO t VALUES ('a;b', 'it''s; fine')`,
      'SELECT "odd;name" FROM t',
      `SELECT E'x\\';y'`
    ]);
  });

  it('ignores semicolons inside dollar-quoted bodies', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql';
    const tagged = 'DO $body$ BEGIN PERFORM 1; END $body$';
    expect(sqls(`${fn};\n${tagged};`)).toEqual([fn, tagged]);
  });

  it('treats a $n parameter as code, not a dollar quote', () => {
    expect(sqls('PREPARE p AS SELECT $1; SELECT 2')).toEqual(['PREPARE p AS SELECT $1', 'SELECT 2']);
  });

  it('ignores semicolons in line and nested block comments, and drops comment-only statements', () => {
    const script = '-- header; with a semicolon\nSELECT 1; /* outer /* inner; */ still; */ SELECT 2;\n-- trailing comment only;';
    expect(sqls(script)).toEqual(['-- header; with a semicolon\nSELECT 1', '/* outer /* inner; */ still; */ SELECT 2']);
  });

  it('reports 1-based start and end lines', () => {
    const batches = SplitPostgresStatements('SELECT 1;\n\nCREATE INDEX CONCURRENTLY a\n  ON t (c);\n');
    expect(batches.map((b) => [b.StartLine, b.EndLine])).toEqual([[1, 1], [3, 4]]);
  });

  it('returns nothing for an empty or comment-only script', () => {
    expect(sqls('')).toEqual([]);
    expect(sqls('-- nothing here\n/* or here */')).toEqual([]);
  });
});
