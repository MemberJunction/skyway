/**
 * @module migration/checksum
 * CRC32 checksum computation compatible with Flyway's Java implementation.
 *
 * Flyway computes checksums using Java's `java.util.zip.CRC32` class.
 * The critical detail is that Flyway reads the file **line-by-line** using
 * `BufferedReader.readLine()`, which strips all line endings (`\n`, `\r`, `\r\n`).
 * Each line's UTF-8 bytes are fed individually to `crc32.update(bytes)`.
 *
 * This means the CRC32 is computed over the concatenation of all lines'
 * UTF-8 bytes, with NO newline characters included. Changing only line endings
 * (LF vs CRLF) does not change the checksum.
 *
 * The result is cast from Java's `long` to `int` (signed 32-bit), which
 * is equivalent to the standard IEEE CRC32 value interpreted as signed.
 */

import * as CRC32 from 'crc-32';

/**
 * Computes a Flyway-compatible CRC32 checksum for a migration file's contents.
 *
 * Replicates Flyway's exact algorithm:
 * 1. Strip BOM if present
 * 2. Split content into lines (stripping all line endings)
 * 3. For each line, compute UTF-8 bytes and feed to CRC32
 * 4. Return the result as a signed 32-bit integer
 *
 * @param content - Raw UTF-8 file content
 * @returns Signed 32-bit CRC32 checksum matching Flyway's output
 *
 * @example
 * ```typescript
 * const sql = fs.readFileSync('V001__init.sql', 'utf-8');
 * const checksum = ComputeChecksum(sql);
 * // checksum matches Flyway's flyway_schema_history.checksum value
 * ```
 */
export function ComputeChecksum(content: string): number {
  // Strip UTF-8 BOM if present
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // Split into lines, stripping all line endings (matches BufferedReader.readLine())
  const lines = stripped.split(/\r\n|\r|\n/);

  // Compute CRC32 line-by-line, feeding each line's UTF-8 bytes
  // This matches Flyway's: for each line, crc32.update(line.getBytes("UTF-8"))
  let crc = 0;
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf-8');
    crc = CRC32.buf(bytes, crc);
  }

  return crc;
}
