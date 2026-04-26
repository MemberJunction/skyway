/**
 * @module executor/error-context
 * Extracts contextual information from SQL errors to help debug failed migrations.
 *
 * When a SQL batch fails, the error message often references identifiers like
 * column names, table names, or constraint names. This module extracts those
 * identifiers and finds the lines in the batch SQL that reference them,
 * providing file-level line numbers for easy navigation in an editor.
 */

/**
 * A line from the failed batch that relates to the error.
 */
export interface ContextLine {
  /** 1-based line number in the original migration file */
  LineNumber: number;
  /** The text content of the line */
  Text: string;
}

/**
 * Common SQL Server error message patterns that contain identifiers.
 * Each pattern captures the identifier name in group 1.
 */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /Invalid column name '([^']+)'/i,
  /Invalid object name '([^']+)'/i,
  /Column name '([^']+)'/i,
  /Could not find stored procedure '([^']+)'/i,
  /There is already an object named '([^']+)'/i,
  /Cannot find the object "([^"]+)"/i,
  /constraint "([^"]+)"/i,
  /constraint '([^']+)'/i,
  /index '([^']+)'/i,
  /Cannot insert duplicate key.*object '([^']+)'/i,
  /FOREIGN KEY constraint "([^"]+)"/i,
  /FOREIGN KEY constraint '([^']+)'/i,
  /table "([^"]+)"/i,
  /column "([^"]+)"/i,
];

/**
 * Extracts identifiers mentioned in a SQL Server error message.
 *
 * @param errorMessage - The error message from SQL Server
 * @returns Array of unique identifiers found in the error message
 */
export function ExtractErrorIdentifiers(errorMessage: string): string[] {
  const identifiers = new Set<string>();

  for (const pattern of IDENTIFIER_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match?.[1]) {
      identifiers.add(match[1]);
    }
  }

  return Array.from(identifiers);
}

/**
 * Finds lines in a SQL batch that reference the given identifiers.
 * Returns lines with their original file line numbers.
 *
 * @param batchSQL - The SQL text of the failed batch
 * @param batchStartLine - 1-based line number where the batch starts in the file
 * @param identifiers - Identifiers to search for (column names, table names, etc.)
 * @returns Array of context lines referencing the identifiers
 */
export function FindContextLines(
  batchSQL: string,
  batchStartLine: number,
  identifiers: string[]
): ContextLine[] {
  if (identifiers.length === 0) {
    return [];
  }

  const lines = batchSQL.split('\n');
  const contextLines: ContextLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const identifier of identifiers) {
      if (line.includes(identifier)) {
        contextLines.push({
          LineNumber: batchStartLine + i,
          Text: line.trimEnd(),
        });
        break; // Don't add the same line twice
      }
    }
  }

  return contextLines;
}

/**
 * Truncates SQL text for display, adding an ellipsis if truncated.
 *
 * @param sql - SQL text to truncate
 * @param maxLength - Maximum character length (default 500)
 * @returns Truncated SQL string
 */
export function TruncateSQL(sql: string, maxLength: number = 500): string {
  if (sql.length <= maxLength) {
    return sql;
  }
  return sql.substring(0, maxLength) + '\n... (truncated)';
}
