import { describe, expect, it } from 'vitest';
import { DescribeDriverError, ExtractDriverErrorDetail } from '../executor/driver-error';

/**
 * Builds an error shaped like the one `mssql` throws — the fields live on the wrapper AND on
 * `originalError.info`, and which one is populated depends on the failure path.
 */
function mssqlError(
  message: string,
  fields: Record<string, unknown> = {},
  precedingErrors?: Error[]
): Error {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.code = 'EREQUEST';
  err.originalError = Object.assign(new Error(message), { info: { ...fields } });
  Object.assign(err, fields);
  if (precedingErrors) err.precedingErrors = precedingErrors;
  return err;
}

describe('ExtractDriverErrorDetail', () => {
  it('reads the structured fields SQL Server reports alongside the message', () => {
    const err = mssqlError('Transaction (Process ID 61) was deadlocked on lock resources', {
      number: 1205,
      class: 13,
      state: 55,
      procName: 'trg_OrderLine_RollupTotals',
      lineNumber: 23,
    });

    expect(ExtractDriverErrorDetail(err)).toEqual({
      Code: 1205,
      Severity: 13,
      State: 55,
      Procedure: 'trg_OrderLine_RollupTotals',
      Line: 23,
    });
  });

  it('finds fields that live only on originalError.info', () => {
    const err = new Error('Invalid column name') as Error & Record<string, unknown>;
    err.originalError = { info: { number: 207, class: 16, procName: 'spDoThing', lineNumber: 4 } };

    const detail = ExtractDriverErrorDetail(err);
    expect(detail.Code).toBe(207);
    expect(detail.Procedure).toBe('spDoThing');
    expect(detail.Line).toBe(4);
  });

  it('collects preceding errors, which are the cause of a "See previous errors" summary', () => {
    const err = mssqlError('Could not create constraint or index. See previous errors.', { number: 4902 }, [
      new Error("Invalid column name 'RenewsSubscriptionID'."),
      new Error("Column 'Foo' does not exist."),
    ]);

    expect(ExtractDriverErrorDetail(err).Preceding).toEqual([
      "Invalid column name 'RenewsSubscriptionID'.",
      "Column 'Foo' does not exist.",
    ]);
  });

  it('returns nothing for errors that carry no structured detail', () => {
    expect(ExtractDriverErrorDetail(new Error('plain failure'))).toEqual({});
    expect(ExtractDriverErrorDetail('a string')).toEqual({});
    expect(ExtractDriverErrorDetail(null)).toEqual({});
  });

  it('ignores fields that are present but unusable', () => {
    const err = new Error('x') as Error & Record<string, unknown>;
    Object.assign(err, { number: NaN, procName: '   ', lineNumber: 'nope' });
    expect(ExtractDriverErrorDetail(err)).toEqual({});
  });
});

describe('DescribeDriverError', () => {
  it('names the procedure the error was raised in — the field that identifies the culprit', () => {
    const err = mssqlError('Transaction (Process ID 61) was deadlocked on lock resources', {
      number: 1205,
      class: 13,
      state: 55,
      procName: 'trg_OrderLine_RollupTotals',
      lineNumber: 23,
    });

    const described = DescribeDriverError(err);
    expect(described).toContain('Msg 1205');
    expect(described).toContain('Severity 13');
    expect(described).toContain('State 55');
    // Without this, a deadlock inside a trigger is indistinguishable from server-level instability.
    expect(described).toContain('in trg_OrderLine_RollupTotals line 23');
    expect(described).toContain('was deadlocked on lock resources');
  });

  it('surfaces the preceding errors instead of a pointer to output nobody kept', () => {
    const err = mssqlError('Could not create constraint or index. See previous errors.', { number: 4902 }, [
      new Error("Invalid column name 'RenewsSubscriptionID'."),
    ]);

    const described = DescribeDriverError(err);
    expect(described).toContain('Preceding errors (the actual cause)');
    expect(described).toContain("Invalid column name 'RenewsSubscriptionID'.");
  });

  it('leaves an ordinary error untouched, so it adds no noise', () => {
    expect(DescribeDriverError(new Error('connection refused'))).toBe('connection refused');
  });

  it("ignores mssql's generic transport code but keeps a PostgreSQL SQLSTATE", () => {
    // `EREQUEST` is identical for every mssql query failure — reporting it as a message number is
    // noise. A PG SQLSTATE genuinely identifies the failure, so it is kept.
    const mssql = mssqlError('Some failure', {});
    expect(DescribeDriverError(mssql)).toBe('Some failure');

    const pg = new Error('duplicate key value violates unique constraint') as Error & Record<string, unknown>;
    pg.code = '23505';
    expect(DescribeDriverError(pg)).toContain('Msg 23505');
  });

  it('omits the procedure clause when only a message number is known', () => {
    const err = mssqlError('Some failure', { number: 4902 });
    expect(DescribeDriverError(err)).toBe('Msg 4902: Some failure');
  });

  it('handles a procedure with no line number', () => {
    const err = mssqlError('Some failure', { procName: 'spThing' });
    expect(DescribeDriverError(err)).toBe('in spThing: Some failure');
  });
});
