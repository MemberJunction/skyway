import { describe, it, expect } from 'vitest';
import { SplitOnGO } from '../executor/sql-splitter';

describe('SplitOnGO', () => {
  it('splits on GO separators', () => {
    const script = 'SELECT 1;\nGO\nSELECT 2;\nGO';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(2);
    expect(batches[0].SQL).toBe('SELECT 1;');
    expect(batches[1].SQL).toBe('SELECT 2;');
  });

  it('handles case-insensitive GO', () => {
    const script = 'SELECT 1;\ngo\nSELECT 2;\nGo\nSELECT 3;\nGO';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(3);
  });

  it('handles GO with leading/trailing whitespace', () => {
    const script = 'SELECT 1;\n  GO  \nSELECT 2;';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(2);
  });

  it('handles GO with repeat count', () => {
    const script = 'INSERT INTO T VALUES (1);\nGO 5';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(1);
    expect(batches[0].RepeatCount).toBe(5);
  });

  it('defaults RepeatCount to 1', () => {
    const script = 'SELECT 1;\nGO';
    const batches = SplitOnGO(script);
    expect(batches[0].RepeatCount).toBe(1);
  });

  it('discards empty batches between consecutive GOs', () => {
    const script = 'SELECT 1;\nGO\nGO\nSELECT 2;\nGO';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(2);
    expect(batches[0].SQL).toBe('SELECT 1;');
    expect(batches[1].SQL).toBe('SELECT 2;');
  });

  it('returns single batch when no GO is present', () => {
    const script = 'SELECT 1;\nSELECT 2;';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(1);
    expect(batches[0].SQL).toBe('SELECT 1;\nSELECT 2;');
  });

  it('does not treat GO inside a longer word as separator', () => {
    const script = 'SELECT GOTO;\nGO';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(1);
    expect(batches[0].SQL).toBe('SELECT GOTO;');
  });

  it('handles final batch after last GO', () => {
    const script = 'SELECT 1;\nGO\nSELECT 2;';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(2);
    expect(batches[1].SQL).toBe('SELECT 2;');
    expect(batches[1].RepeatCount).toBe(1);
  });

  it('tracks correct StartLine for each batch', () => {
    const script = 'SELECT 1;\nGO\nSELECT 2;\nSELECT 3;\nGO';
    const batches = SplitOnGO(script);
    expect(batches[0].StartLine).toBe(1);
    expect(batches[1].StartLine).toBe(3);
  });

  it('handles empty input', () => {
    const batches = SplitOnGO('');
    expect(batches).toHaveLength(0);
  });

  it('handles whitespace-only batches as empty', () => {
    const script = '  \n  \nGO\nSELECT 1;\nGO';
    const batches = SplitOnGO(script);
    expect(batches).toHaveLength(1);
    expect(batches[0].SQL).toBe('SELECT 1;');
  });
});
