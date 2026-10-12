/**
 * @module executor/driver-error
 * Preserves the structured detail database drivers attach to errors, which `err.message` drops.
 *
 * SQL Server reports a failure as more than a sentence. `sqlcmd` prints:
 *
 *     Msg 1205, Level 13, State 55, Server sql, Procedure trg_OrderLine_RollupTotals, Line 23
 *     Transaction (Process ID 61) was deadlocked on lock resources ...
 *
 * The `tedious`/`mssql` driver surfaces every one of those as a property on the error object, but
 * `err.message` is only the second line. So a migration failure that is entirely explained by
 * "Procedure trg_OrderLine_RollupTotals" arrives as an unattributed deadlock, and the reader is left
 * to guess which of a 60,000-line script's objects was involved.
 *
 * Worse is the multi-error case. SQL Server frequently reports a summary whose real cause is in the
 * messages before it:
 *
 *     Msg 4902 ... Could not create constraint or index. See previous errors.
 *
 * `mssql` collects those in `precedingErrors`, and `err.message` is exactly the line that tells you
 * to go read the ones being discarded.
 *
 * This module turns the error object back into the report the driver actually gave us. It is
 * deliberately duck-typed rather than importing `mssql`: `@skyway/core` is provider-agnostic, and
 * PostgreSQL errors carry an analogous set of fields under different names.
 */

/** A driver error's structured fields, as far as we can identify them. */
export interface DriverErrorDetail {
  /** SQL Server message number (`Msg 1205`) or PostgreSQL SQLSTATE. */
  Code?: string | number;
  /** SQL Server severity class. */
  Severity?: number;
  State?: number;
  /** The procedure, function or trigger the error was raised in — usually the most useful field. */
  Procedure?: string;
  /** Line number WITHIN that procedure (not within the migration file). */
  Line?: number;
  /** Errors SQL Server reported before this one; the cause of a "See previous errors" summary. */
  Preceding?: string[];
}

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const asNonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

/**
 * PostgreSQL's `code` is the SQLSTATE (`23505`, `42P01`) and identifies the failure.
 * `mssql`'s `code` is a transport-level wrapper (`EREQUEST`, `ELOGIN`) that is the same for every
 * query failure and tells the reader nothing — reporting it as `Msg EREQUEST` is worse than
 * reporting nothing. Only the five-character SQLSTATE shape is accepted.
 */
const asSqlState = (v: unknown): string | undefined => {
  const s = asNonEmptyString(v);
  return s && /^[0-9A-Z]{5}$/.test(s) ? s : undefined;
};

/**
 * Pull the structured fields off a driver error.
 *
 * Reads both the error itself and its `originalError`, because `mssql` wraps the `tedious` error and
 * the interesting fields live on either depending on the failure path. Returns an empty object for
 * errors that carry nothing structured, so callers can treat "no detail" and "not a driver error"
 * the same way.
 */
export function ExtractDriverErrorDetail(err: unknown): DriverErrorDetail {
  if (err == null || typeof err !== 'object') {
    return {};
  }

  const e = err as Record<string, unknown>;
  const original = (e.originalError ?? {}) as Record<string, unknown>;
  const info = (original.info ?? {}) as Record<string, unknown>;

  // `number` on mssql, `code` on pg. `class` is SQL Server's severity; tedious also calls it that.
  const pick = <T>(fn: (src: Record<string, unknown>) => T | undefined): T | undefined =>
    fn(e) ?? fn(original) ?? fn(info);

  const preceding = Array.isArray(e.precedingErrors)
    ? (e.precedingErrors as unknown[])
        .map((p) => (p instanceof Error ? p.message : asNonEmptyString(p)))
        .filter((m): m is string => !!m)
    : undefined;

  const detail: DriverErrorDetail = {
    Code: pick((s) => asNumber(s.number)) ?? asSqlState(e.code),
    Severity: pick((s) => asNumber(s.class)),
    State: pick((s) => asNumber(s.state)),
    Procedure: pick((s) => asNonEmptyString(s.procName)),
    Line: pick((s) => asNumber(s.lineNumber)),
    Preceding: preceding && preceding.length > 0 ? preceding : undefined,
  };

  // Drop the keys we could not determine, so `Object.keys(detail).length` is a usable emptiness test.
  for (const key of Object.keys(detail) as Array<keyof DriverErrorDetail>) {
    if (detail[key] === undefined) {
      delete detail[key];
    }
  }
  return detail;
}

/**
 * Render a driver error as the message plus whatever structured detail it carried.
 *
 * Returns the plain message unchanged when there is nothing to add, so this is safe to apply
 * unconditionally and produces no noise for ordinary errors.
 *
 * @example
 * // Msg 1205, Severity 13, State 55, in trg_OrderLine_RollupTotals line 23:
 * // Transaction (Process ID 61) was deadlocked on lock resources ...
 */
export function DescribeDriverError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const detail = ExtractDriverErrorDetail(err);

  const parts: string[] = [];
  if (detail.Code !== undefined) parts.push(`Msg ${detail.Code}`);
  if (detail.Severity !== undefined) parts.push(`Severity ${detail.Severity}`);
  if (detail.State !== undefined) parts.push(`State ${detail.State}`);
  if (detail.Procedure) {
    parts.push(detail.Line !== undefined ? `in ${detail.Procedure} line ${detail.Line}` : `in ${detail.Procedure}`);
  }

  const prefix = parts.length > 0 ? `${parts.join(', ')}: ` : '';

  // The preceding errors ARE the cause when SQL Server says "See previous errors" — put them where
  // they cannot be missed rather than leaving the reader chasing a pointer to discarded output.
  const preceding = detail.Preceding
    ? `\n  Preceding errors (the actual cause):\n${detail.Preceding.map((p) => `    - ${p}`).join('\n')}`
    : '';

  return `${prefix}${message}${preceding}`;
}
