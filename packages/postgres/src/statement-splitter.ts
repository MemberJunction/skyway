/**
 * @module statement-splitter
 * Splits a PostgreSQL script into individual statements.
 *
 * Used for migrations that run outside a transaction (`executeInTransaction=false`).
 * PostgreSQL runs a multi-statement query string as one implicit transaction, so a statement
 * like `CREATE INDEX CONCURRENTLY` must be sent on its own.
 *
 * Splits on top-level `;`, respecting single-quoted strings (including `E'…'` backslash
 * escapes), double-quoted identifiers, dollar-quoted bodies (`$$…$$`, `$tag$…$tag$`), line
 * comments and nested block comments. Statements consisting only of whitespace and comments
 * are dropped.
 */

import { SQLBatch } from '@memberjunction/skyway-core';

type Mode = 'code' | 'single' | 'escapedSingle' | 'double' | 'dollar' | 'line' | 'block';

export function SplitPostgresStatements(script: string): SQLBatch[] {
  const statements: SQLBatch[] = [];
  let mode: Mode = 'code';
  let start = 0;
  let line = 1;
  let startLine = 1;
  let dollarTag = '';
  let blockDepth = 0;
  let hasCode = false;

  const flush = (end: number) => {
    const sql = script.slice(start, end).trim();
    if (sql.length > 0 && hasCode) {
      const leading = script.slice(start, end).length - script.slice(start, end).trimStart().length;
      const firstLine = startLine + (script.slice(start, start + leading).match(/\n/g)?.length ?? 0);
      statements.push({ SQL: sql, RepeatCount: 1, StartLine: firstLine, EndLine: firstLine + (sql.match(/\n/g)?.length ?? 0) });
    }
    start = end + 1;
    startLine = line;
    hasCode = false;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === '\n') {
      line++;
    }
    switch (mode) {
      case 'code':
        if (ch === '-' && next === '-') {
          mode = 'line';
          i++;
        } else if (ch === '/' && next === '*') {
          mode = 'block';
          blockDepth = 1;
          i++;
        } else if (ch === "'") {
          const prev = script[i - 1];
          mode = (prev === 'E' || prev === 'e') && !isIdentifierChar(script[i - 2]) ? 'escapedSingle' : 'single';
          hasCode = true;
        } else if (ch === '"') {
          mode = 'double';
          hasCode = true;
        } else if (ch === '$') {
          const tag = readDollarTag(script, i);
          if (tag !== null && !isIdentifierChar(script[i - 1])) {
            dollarTag = tag;
            mode = 'dollar';
            i += tag.length - 1;
          }
          hasCode = true;
        } else if (ch === ';') {
          flush(i);
        } else if (!/\s/.test(ch)) {
          hasCode = true;
        }
        break;
      case 'single':
        if (ch === "'") {
          if (next === "'") i++;
          else mode = 'code';
        }
        break;
      case 'escapedSingle':
        if (ch === '\\') i++;
        else if (ch === "'") {
          if (next === "'") i++;
          else mode = 'code';
        }
        break;
      case 'double':
        if (ch === '"') {
          if (next === '"') i++;
          else mode = 'code';
        }
        break;
      case 'dollar':
        if (ch === '$' && script.startsWith(dollarTag, i)) {
          i += dollarTag.length - 1;
          mode = 'code';
        }
        break;
      case 'line':
        if (ch === '\n') mode = 'code';
        break;
      case 'block':
        if (ch === '/' && next === '*') {
          blockDepth++;
          i++;
        } else if (ch === '*' && next === '/') {
          blockDepth--;
          i++;
          if (blockDepth === 0) mode = 'code';
        }
        break;
    }
  }
  flush(script.length);
  return statements;
}

/** The dollar-quote tag starting at `i` (e.g. `$$` or `$body$`), or null when `$` starts no tag. */
function readDollarTag(script: string, i: number): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64));
  return match ? match[0] : null;
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}
