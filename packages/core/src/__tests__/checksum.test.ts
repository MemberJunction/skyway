import { describe, it, expect } from 'vitest';
import { ComputeChecksum } from '../migration/checksum';

describe('ComputeChecksum', () => {
  it('returns a signed 32-bit integer', () => {
    const result = ComputeChecksum('SELECT 1;');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-2147483648);
    expect(result).toBeLessThanOrEqual(2147483647);
  });

  it('produces identical checksums for LF vs CRLF line endings', () => {
    const lf = 'CREATE TABLE Foo (\n  ID INT\n);';
    const crlf = 'CREATE TABLE Foo (\r\n  ID INT\r\n);';
    expect(ComputeChecksum(lf)).toBe(ComputeChecksum(crlf));
  });

  it('produces identical checksums for CR vs LF line endings', () => {
    const lf = 'SELECT 1;\nSELECT 2;';
    const cr = 'SELECT 1;\rSELECT 2;';
    expect(ComputeChecksum(lf)).toBe(ComputeChecksum(cr));
  });

  it('strips UTF-8 BOM before computing', () => {
    const withBOM = '\uFEFFSELECT 1;';
    const withoutBOM = 'SELECT 1;';
    expect(ComputeChecksum(withBOM)).toBe(ComputeChecksum(withoutBOM));
  });

  it('returns different checksums for different content', () => {
    const a = ComputeChecksum('CREATE TABLE A (ID INT);');
    const b = ComputeChecksum('CREATE TABLE B (ID INT);');
    expect(a).not.toBe(b);
  });

  it('handles empty content', () => {
    const result = ComputeChecksum('');
    expect(typeof result).toBe('number');
  });

  it('handles multi-line SQL consistently', () => {
    const sql = [
      'CREATE TABLE Users (',
      '  ID INT PRIMARY KEY,',
      '  Name NVARCHAR(100)',
      ');',
    ].join('\n');

    // Same content should always produce same checksum
    expect(ComputeChecksum(sql)).toBe(ComputeChecksum(sql));
  });

  it('handles unicode content', () => {
    const sql = "INSERT INTO T VALUES (N'こんにちは');";
    const result = ComputeChecksum(sql);
    expect(typeof result).toBe('number');
    // Verify deterministic
    expect(ComputeChecksum(sql)).toBe(result);
  });
});
