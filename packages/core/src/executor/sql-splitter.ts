/**
 * @module executor/sql-splitter
 * Splits SQL scripts on `GO` batch separator statements.
 *
 * SQL Server uses `GO` as a client-side batch separator — it is NOT
 * a T-SQL statement. The `sqlcmd` and SSMS tools split scripts on `GO`
 * lines and send each batch independently to the server.
 *
 * Skyway replicates this behavior:
 * - `GO` must appear as the sole content on its line (ignoring whitespace)
 * - `GO` can optionally be followed by a count: `GO 5` (repeat batch 5 times)
 * - `GO` inside string literals or comments is NOT treated as a separator
 *   (handled by line-based detection — `GO` on its own line is unambiguous)
 * - Empty batches (no statements between GO markers) are discarded
 */

/**
 * A single SQL batch extracted from a larger script.
 */
export interface SQLBatch {
  /** The SQL text for this batch (without the GO separator) */
  SQL: string;

  /**
   * Number of times to execute this batch.
   * Usually 1, but can be higher if `GO N` was used.
   */
  RepeatCount: number;

  /** 1-based line number where this batch starts in the original script */
  StartLine: number;
}

/**
 * Regex matching a GO statement on its own line.
 * Captures an optional repeat count after GO.
 *
 * Valid matches:
 *   GO          → count = undefined (defaults to 1)
 *   GO 5        → count = 5
 *   go          → case-insensitive
 *     GO        → leading/trailing whitespace OK
 *
 * Does NOT match:
 *   GOTO        → GO must be followed by whitespace, digit, or EOL
 *   SELECT 'GO' → GO is part of a larger line
 */
const GO_PATTERN = /^\s*GO\s*(\d+)?\s*$/i;

/**
 * Splits a SQL script into batches separated by `GO` statements.
 *
 * Each batch is the concatenation of lines between two `GO` markers
 * (or between the start/end of the script and a `GO` marker).
 * Empty batches are excluded from the result.
 *
 * @param script - Full SQL script content
 * @returns Array of non-empty SQL batches in order
 *
 * @example
 * ```typescript
 * const batches = SplitOnGO(`
 *   CREATE TABLE Foo (ID INT);
 *   GO
 *   INSERT INTO Foo VALUES (1);
 *   GO
 * `);
 * // batches.length === 2
 * // batches[0].SQL === 'CREATE TABLE Foo (ID INT);'
 * // batches[1].SQL === 'INSERT INTO Foo VALUES (1);'
 * ```
 */
export function SplitOnGO(script: string): SQLBatch[] {
  const lines = script.split('\n');
  const batches: SQLBatch[] = [];

  let currentBatchLines: string[] = [];
  let batchStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const goMatch = line.match(GO_PATTERN);

    if (goMatch) {
      // This line is a GO separator
      const batchSQL = currentBatchLines.join('\n').trim();

      if (batchSQL.length > 0) {
        const repeatCount = goMatch[1] ? parseInt(goMatch[1], 10) : 1;
        batches.push({
          SQL: batchSQL,
          RepeatCount: repeatCount,
          StartLine: batchStartLine,
        });
      }

      // Reset for next batch
      currentBatchLines = [];
      batchStartLine = i + 2; // Next line (1-based)
    } else {
      currentBatchLines.push(line);
    }
  }

  // Don't forget the final batch (after last GO or if no GO at all)
  const finalSQL = currentBatchLines.join('\n').trim();
  if (finalSQL.length > 0) {
    batches.push({
      SQL: finalSQL,
      RepeatCount: 1,
      StartLine: batchStartLine,
    });
  }

  return batches;
}
