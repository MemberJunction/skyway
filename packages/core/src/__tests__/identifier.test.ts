import { describe, it, expect } from 'vitest';
import { validateSqlIdentifier, SQL_IDENTIFIER_PATTERN, SQL_IDENTIFIER_MAX_LENGTH } from '../db/identifier';

describe('validateSqlIdentifier', () => {
  describe('accepts valid identifiers', () => {
    it.each([
      ['simple', 'schema'],
      ['leading_underscore', '_underscore'],
      ['with_digits', 'table_1'],
      ['all_uppercase', 'SCHEMA_NAME'],
      ['mixed_case', 'MyTable'],
      ['single_char', 'x'],
      ['mj_pattern', '__mj'],
      ['historical_flyway_schema', 'flyway_schema_history'],
    ])('%s → %s', (_label, value) => {
      expect(() => validateSqlIdentifier(value, 'test')).not.toThrow();
      expect(validateSqlIdentifier(value, 'test')).toBe(value);
    });
  });

  describe('rejects invalid identifiers', () => {
    it.each([
      ['empty_string', ''],
      ['leading_digit', '1table'],
      ['contains_space', 'my table'],
      ['contains_single_quote', "user';drop"],
      ['contains_double_quote', 'schema"injected'],
      ['contains_backtick', 'table`here'],
      ['contains_semicolon', 'schema;drop'],
      ['contains_hyphen', 'my-schema'],           // legal with quoting but we're strict
      ['contains_dot', 'schema.table'],           // caller must split these
      ['contains_bracket_open', 'schema['],
      ['contains_bracket_close', 'schema]'],
      ['contains_parenthesis', 'fn()'],
      ['contains_star', 'select*'],
      ['sql_comment', '--comment'],
      ['block_comment', '/*hi*/'],
      ['unicode_char', 'schéma'],                 // arguably legal, but our policy is strict
      ['whitespace_only', '   '],
      ['newline', 'line1\nline2'],
    ])('%s rejected', (_label, value) => {
      expect(() => validateSqlIdentifier(value, 'test')).toThrow();
    });

    it('error message includes the role label', () => {
      expect(() => validateSqlIdentifier('bad;sql', 'schema')).toThrow(/schema identifier/);
      expect(() => validateSqlIdentifier('bad;sql', 'database')).toThrow(/database identifier/);
    });

    it('error message includes the offending value', () => {
      expect(() => validateSqlIdentifier('1bad', 'table')).toThrow(/"1bad"/);
    });
  });

  describe('length enforcement', () => {
    it(`rejects identifiers longer than ${SQL_IDENTIFIER_MAX_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(SQL_IDENTIFIER_MAX_LENGTH + 1);
      expect(() => validateSqlIdentifier(tooLong, 'test')).toThrow(/exceeds/);
    });

    it(`accepts identifiers exactly ${SQL_IDENTIFIER_MAX_LENGTH} characters`, () => {
      const atLimit = 'a'.repeat(SQL_IDENTIFIER_MAX_LENGTH);
      expect(() => validateSqlIdentifier(atLimit, 'test')).not.toThrow();
    });
  });

  describe('type safety', () => {
    it('rejects non-string input', () => {
      expect(() => validateSqlIdentifier(undefined as unknown as string, 'test')).toThrow();
      expect(() => validateSqlIdentifier(null as unknown as string, 'test')).toThrow();
      expect(() => validateSqlIdentifier(42 as unknown as string, 'test')).toThrow();
    });
  });

  describe('SQL_IDENTIFIER_PATTERN', () => {
    it('is exported for reuse', () => {
      expect(SQL_IDENTIFIER_PATTERN).toBeInstanceOf(RegExp);
      expect(SQL_IDENTIFIER_PATTERN.test('good_name')).toBe(true);
      expect(SQL_IDENTIFIER_PATTERN.test('bad;name')).toBe(false);
    });
  });
});
