/**
 * @module migration/checksum
 * CRC32 checksum computation compatible with Flyway's Java implementation.
 *
 * Flyway uses `java.util.zip.CRC32` which produces a standard IEEE CRC32
 * value, then stores it as a signed 32-bit integer. This module replicates
 * that exact behavior so checksums match between Skyway and Flyway.
 */

import * as CRC32 from 'crc-32';

/**
 * Computes a Flyway-compatible CRC32 checksum for a migration file's contents.
 *
 * The normalization rules match Flyway's behavior:
 * 1. Read file as UTF-8 (caller's responsibility)
 * 2. Strip BOM if present
 * 3. Normalize line endings: `\r\n` and `\r` → `\n`
 *
 * The resulting CRC32 is returned as a signed 32-bit integer,
 * matching Java's `int` representation.
 *
 * @param content - Raw UTF-8 file content
 * @returns Signed 32-bit CRC32 checksum
 *
 * @example
 * ```typescript
 * const sql = fs.readFileSync('V001__init.sql', 'utf-8');
 * const checksum = ComputeChecksum(sql);
 * // checksum is a signed int like -1295146103
 * ```
 */
export function ComputeChecksum(content: string): number {
  // Strip UTF-8 BOM if present
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // Normalize line endings to \n (matching Flyway)
  const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // CRC32.str() computes CRC32 on the UTF-8 byte representation
  // and returns a signed 32-bit integer — exactly what Flyway stores
  return CRC32.str(normalized);
}
