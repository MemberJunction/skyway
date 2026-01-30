import { describe, it, expect } from 'vitest';
import { SubstitutePlaceholders, PlaceholderContext } from '../executor/placeholder';

const defaultContext: PlaceholderContext = {
  DefaultSchema: '__mj',
  Timestamp: '2026-01-30T00:00:00.000Z',
  Database: 'TestDB',
  User: 'sa',
  Filename: 'V1__Init.sql',
  Table: 'flyway_schema_history',
};

describe('SubstitutePlaceholders', () => {
  it('replaces ${flyway:defaultSchema}', () => {
    const sql = 'CREATE TABLE [${flyway:defaultSchema}].[Users] (ID INT);';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('CREATE TABLE [__mj].[Users] (ID INT);');
  });

  it('replaces ${flyway:timestamp}', () => {
    const sql = "SELECT '${flyway:timestamp}';";
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe("SELECT '2026-01-30T00:00:00.000Z';");
  });

  it('replaces ${flyway:database}', () => {
    const sql = 'USE [${flyway:database}];';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('USE [TestDB];');
  });

  it('replaces ${flyway:user}', () => {
    const sql = "SELECT '${flyway:user}';";
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe("SELECT 'sa';");
  });

  it('replaces ${flyway:table}', () => {
    const sql = 'SELECT * FROM [${flyway:table}];';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('SELECT * FROM [flyway_schema_history];');
  });

  it('replaces user-defined placeholders', () => {
    const sql = 'SET @version = ${appVersion};';
    const result = SubstitutePlaceholders(sql, { appVersion: '3.0.0' }, defaultContext);
    expect(result).toBe("SET @version = 3.0.0;");
  });

  it('user placeholders override built-ins', () => {
    const sql = 'USE [${flyway:defaultSchema}];';
    const result = SubstitutePlaceholders(sql, { 'flyway:defaultSchema': 'custom' }, defaultContext);
    expect(result).toBe('USE [custom];');
  });

  it('leaves unknown ${...} patterns untouched', () => {
    const sql = "EXEC sp_exec @code = N'var x = ${myVar};';";
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe("EXEC sp_exec @code = N'var x = ${myVar};';");
  });

  it('handles multiple placeholders in one string', () => {
    const sql = 'CREATE TABLE [${flyway:defaultSchema}].[${flyway:table}] (ID INT);';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('CREATE TABLE [__mj].[flyway_schema_history] (ID INT);');
  });

  it('handles SQL with no placeholders', () => {
    const sql = 'SELECT 1;';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('SELECT 1;');
  });

  it('handles mixed known and unknown placeholders', () => {
    const sql = '[${flyway:defaultSchema}] and ${unknown} and ${flyway:database}';
    const result = SubstitutePlaceholders(sql, {}, defaultContext);
    expect(result).toBe('[__mj] and ${unknown} and TestDB');
  });
});
