import { describe, it, expect } from 'vitest';
import { ExtractErrorIdentifiers, FindContextLines, TruncateSQL } from '../executor/error-context';

describe('ExtractErrorIdentifiers', () => {
  it('extracts column name from Invalid column name error', () => {
    const ids = ExtractErrorIdentifiers("Invalid column name '__mj_CreatedAt'");
    expect(ids).toContain('__mj_CreatedAt');
  });

  it('extracts object name from Invalid object name error', () => {
    const ids = ExtractErrorIdentifiers("Invalid object name 'dbo.MyTable'");
    expect(ids).toContain('dbo.MyTable');
  });

  it('extracts multiple identifiers from a single message', () => {
    const ids = ExtractErrorIdentifiers(
      "Invalid column name 'Foo' in table \"Bar\""
    );
    expect(ids).toContain('Foo');
    expect(ids).toContain('Bar');
  });

  it('returns empty array for unrecognized error messages', () => {
    const ids = ExtractErrorIdentifiers('Timeout expired');
    expect(ids).toEqual([]);
  });

  it('handles stored procedure errors', () => {
    const ids = ExtractErrorIdentifiers("Could not find stored procedure 'sp_DoSomething'");
    expect(ids).toContain('sp_DoSomething');
  });

  it('handles already-exists errors', () => {
    const ids = ExtractErrorIdentifiers("There is already an object named 'MyTable' in the database");
    expect(ids).toContain('MyTable');
  });
});

describe('FindContextLines', () => {
  it('finds lines referencing an identifier', () => {
    const batchSQL = [
      'ALTER TABLE Employees',
      'ADD __mj_CreatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE();',
      'ALTER TABLE Employees',
      'ADD __mj_UpdatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE();',
    ].join('\n');

    const lines = FindContextLines(batchSQL, 100, ['__mj_CreatedAt']);
    expect(lines).toHaveLength(1);
    expect(lines[0].LineNumber).toBe(101); // 100 + 1 (second line, 0-indexed)
    expect(lines[0].Text).toContain('__mj_CreatedAt');
  });

  it('finds multiple lines for the same identifier', () => {
    const batchSQL = [
      'SELECT __mj_CreatedAt FROM Foo;',
      'UPDATE Foo SET __mj_CreatedAt = GETDATE();',
    ].join('\n');

    const lines = FindContextLines(batchSQL, 1, ['__mj_CreatedAt']);
    expect(lines).toHaveLength(2);
    expect(lines[0].LineNumber).toBe(1);
    expect(lines[1].LineNumber).toBe(2);
  });

  it('returns empty array when no identifiers provided', () => {
    const lines = FindContextLines('SELECT 1;', 1, []);
    expect(lines).toEqual([]);
  });

  it('returns empty array when no matches found', () => {
    const lines = FindContextLines('SELECT 1;', 1, ['NoSuchThing']);
    expect(lines).toEqual([]);
  });

  it('does not add the same line twice for multiple identifier matches', () => {
    const batchSQL = 'ALTER TABLE Foo ADD Bar INT, Baz INT;';
    const lines = FindContextLines(batchSQL, 1, ['Bar', 'Baz']);
    expect(lines).toHaveLength(1);
  });
});

describe('TruncateSQL', () => {
  it('returns short SQL unchanged', () => {
    expect(TruncateSQL('SELECT 1;', 500)).toBe('SELECT 1;');
  });

  it('truncates long SQL with ellipsis', () => {
    const longSQL = 'A'.repeat(600);
    const result = TruncateSQL(longSQL, 500);
    expect(result.length).toBeLessThan(600);
    expect(result).toContain('... (truncated)');
  });

  it('uses default maxLength of 500', () => {
    const longSQL = 'B'.repeat(600);
    const result = TruncateSQL(longSQL);
    expect(result).toContain('... (truncated)');
    expect(result.startsWith('B'.repeat(500))).toBe(true);
  });
});
