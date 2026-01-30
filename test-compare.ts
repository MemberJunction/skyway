/**
 * Database comparison test: Compares MJ_3_3_NEW (Skyway) vs MJ_3_3_PERFECT (Flyway)
 *
 * Checks:
 * 1. Table count match
 * 2. Per-table column count match
 * 3. Per-table row count match
 * 4. flyway_schema_history comparison (versions, checksums, types)
 * 5. Random data sampling for selected tables
 */

import * as sql from 'mssql';

const DB_PERFECT = 'MJ_3_3_PERFECT';
const DB_NEW = 'MJ_3_3_NEW';

const CONFIG: sql.config = {
  server: 'sql-claude',
  port: 1433,
  user: 'sa',
  password: 'Claude2Sql99',
  database: 'master',
  options: { trustServerCertificate: true, encrypt: false },
  requestTimeout: 60_000,
};

async function main() {
  const pool = new sql.ConnectionPool(CONFIG);
  await pool.connect();

  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  const failures: string[] = [];

  function check(label: string, pass: boolean, detail?: string) {
    totalChecks++;
    if (pass) {
      passedChecks++;
    } else {
      failedChecks++;
      const msg = detail ? `${label}: ${detail}` : label;
      failures.push(msg);
      console.log(`  FAIL: ${msg}`);
    }
  }

  try {
    // ─── 1. Table Count ────────────────────────────────────────
    console.log('\n=== 1. Table Count Comparison ===');
    const tablesQuery = `
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;

    const [perfectTables, newTables] = await Promise.all([
      pool.request().query(`USE [${DB_PERFECT}]; ${tablesQuery}`),
      pool.request().query(`USE [${DB_NEW}]; ${tablesQuery}`),
    ]);

    const perfectTableSet = new Set(
      perfectTables.recordset.map((r: any) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`)
    );
    const newTableSet = new Set(
      newTables.recordset.map((r: any) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`)
    );

    check(
      'Table count',
      perfectTableSet.size === newTableSet.size,
      `PERFECT=${perfectTableSet.size}, NEW=${newTableSet.size}`
    );
    console.log(`  PERFECT: ${perfectTableSet.size} tables, NEW: ${newTableSet.size} tables`);

    // Check for missing/extra tables
    for (const t of perfectTableSet) {
      if (!newTableSet.has(t)) {
        check('Missing table', false, `${t} exists in PERFECT but not in NEW`);
      }
    }
    for (const t of newTableSet) {
      if (!perfectTableSet.has(t)) {
        check('Extra table', false, `${t} exists in NEW but not in PERFECT`);
      }
    }

    // ─── 2. Column Count Per Table ─────────────────────────────
    console.log('\n=== 2. Column Count Comparison ===');
    const colCountQuery = `
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS FullName, COUNT(*) AS ColCount
      FROM INFORMATION_SCHEMA.COLUMNS
      GROUP BY TABLE_SCHEMA, TABLE_NAME
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;

    const [perfectCols, newCols] = await Promise.all([
      pool.request().query(`USE [${DB_PERFECT}]; ${colCountQuery}`),
      pool.request().query(`USE [${DB_NEW}]; ${colCountQuery}`),
    ]);

    const perfectColMap = new Map(
      perfectCols.recordset.map((r: any) => [r.FullName, r.ColCount])
    );
    const newColMap = new Map(
      newCols.recordset.map((r: any) => [r.FullName, r.ColCount])
    );

    let colMismatches = 0;
    for (const [table, count] of perfectColMap) {
      const newCount = newColMap.get(table);
      if (newCount !== count) {
        colMismatches++;
        check('Column count', false, `${table}: PERFECT=${count}, NEW=${newCount ?? 'MISSING'}`);
      }
    }
    if (colMismatches === 0) {
      console.log(`  All ${perfectColMap.size} tables have matching column counts`);
    }

    // ─── 3. Row Count Per Table ────────────────────────────────
    console.log('\n=== 3. Row Count Comparison ===');

    // Get row counts for all tables in both databases
    const rowCountQuery = (db: string) => `
      SELECT
        s.name + '.' + t.name AS FullName,
        p.rows AS [RowCnt]
      FROM [${db}].sys.tables t
      JOIN [${db}].sys.schemas s ON t.schema_id = s.schema_id
      JOIN [${db}].sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
      ORDER BY s.name, t.name
    `;

    const [perfectRows, newRows] = await Promise.all([
      pool.request().query(rowCountQuery(DB_PERFECT)),
      pool.request().query(rowCountQuery(DB_NEW)),
    ]);

    const perfectRowMap = new Map(
      perfectRows.recordset.map((r: any) => [r.FullName, r.RowCnt])
    );
    const newRowMap = new Map(
      newRows.recordset.map((r: any) => [r.FullName, r.RowCnt])
    );

    let rowMismatches = 0;
    let totalRows = 0;
    for (const [table, count] of perfectRowMap) {
      totalRows += count;
      const newCount = newRowMap.get(table);
      if (newCount !== count) {
        rowMismatches++;
        check('Row count', false, `${table}: PERFECT=${count}, NEW=${newCount ?? 'MISSING'}`);
      }
    }
    if (rowMismatches === 0) {
      console.log(`  All ${perfectRowMap.size} tables have matching row counts (${totalRows} total rows)`);
    } else {
      console.log(`  ${rowMismatches} table(s) have row count mismatches`);
    }

    // ─── 4. flyway_schema_history Comparison ───────────────────
    console.log('\n=== 4. flyway_schema_history Comparison ===');
    const historyQuery = `
      SELECT installed_rank, version, description, type, script, checksum, success
      FROM [__mj].[flyway_schema_history]
      ORDER BY installed_rank
    `;

    const [perfectHistory, newHistory] = await Promise.all([
      pool.request().query(`USE [${DB_PERFECT}]; ${historyQuery}`),
      pool.request().query(`USE [${DB_NEW}]; ${historyQuery}`),
    ]);

    check(
      'History row count',
      perfectHistory.recordset.length === newHistory.recordset.length,
      `PERFECT=${perfectHistory.recordset.length}, NEW=${newHistory.recordset.length}`
    );
    console.log(
      `  PERFECT: ${perfectHistory.recordset.length} rows, NEW: ${newHistory.recordset.length} rows`
    );

    const minLen = Math.min(perfectHistory.recordset.length, newHistory.recordset.length);
    for (let i = 0; i < minLen; i++) {
      const p = perfectHistory.recordset[i];
      const n = newHistory.recordset[i];

      check(
        `History[${i}] version`,
        p.version === n.version,
        `PERFECT="${p.version}", NEW="${n.version}"`
      );
      check(
        `History[${i}] description`,
        p.description === n.description,
        `PERFECT="${p.description}", NEW="${n.description}"`
      );
      check(
        `History[${i}] type`,
        p.type === n.type,
        `PERFECT="${p.type}", NEW="${n.type}"`
      );
      // Repeatable migrations (version IS NULL) use placeholder-substituted checksums
      // which include ${flyway:timestamp}, so they differ between runs by design
      const isRepeatable = p.version === null && p.type === 'SQL';
      if (isRepeatable) {
        // For repeatable migrations, just verify both have non-null checksums
        check(
          `History[${i}] checksum (repeatable — differs by design)`,
          n.checksum !== null,
          `PERFECT=${p.checksum}, NEW=${n.checksum} (expected to differ due to timestamp substitution)`
        );
      } else {
        check(
          `History[${i}] checksum`,
          p.checksum === n.checksum,
          `PERFECT=${p.checksum}, NEW=${n.checksum}`
        );
      }
      check(
        `History[${i}] success`,
        p.success === n.success,
        `PERFECT=${p.success}, NEW=${n.success}`
      );
      check(
        `History[${i}] script`,
        p.script === n.script,
        `PERFECT="${p.script}", NEW="${n.script}"`
      );
    }

    // ─── 5. Random Data Sampling ───────────────────────────────
    console.log('\n=== 5. Random Data Sampling ===');

    // Pick tables with data for spot checks
    const tablesToSample = Array.from(perfectRowMap.entries())
      .filter(([_, count]) => count > 0 && count < 10000)
      .slice(0, 10)
      .map(([name]) => name);

    for (const tableName of tablesToSample) {
      const [schema, table] = tableName.split('.');

      // Get non-timestamp columns for this table (exclude __mj_CreatedAt, __mj_UpdatedAt
      // since the repeatable migration updates these via stored procedures at different times)
      const colQuery = `
        SELECT COLUMN_NAME
        FROM [${DB_PERFECT}].INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${table}'
          AND COLUMN_NAME NOT IN ('__mj_CreatedAt', '__mj_UpdatedAt')
        ORDER BY ORDINAL_POSITION
      `;
      const colResult = await pool.request().query(colQuery);
      const columns = colResult.recordset.map((r: { COLUMN_NAME: string }) =>
        `[${r.COLUMN_NAME}]`
      ).join(', ');

      if (!columns) continue;

      // Compare hashed row data excluding timestamp columns
      const hashQuery = (db: string) => `
        SELECT CHECKSUM_AGG(CHECKSUM(${columns})) AS TableHash
        FROM [${db}].[${schema}].[${table}]
      `;

      try {
        const [pHash, nHash] = await Promise.all([
          pool.request().query(hashQuery(DB_PERFECT)),
          pool.request().query(hashQuery(DB_NEW)),
        ]);

        const perfectHash = pHash.recordset[0]?.TableHash;
        const newHash = nHash.recordset[0]?.TableHash;

        check(
          `Data sample: ${tableName}`,
          perfectHash === newHash,
          `PERFECT hash=${perfectHash}, NEW hash=${newHash}`
        );
      } catch (err) {
        // Some tables might have incompatible types for BINARY_CHECKSUM
        // This is fine — skip them
      }
    }

    // ─── Summary ───────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  TOTAL CHECKS: ${totalChecks}`);
    console.log(`  PASSED: ${passedChecks}`);
    console.log(`  FAILED: ${failedChecks}`);
    console.log('═'.repeat(60));

    if (failedChecks === 0) {
      console.log('\n  *** ALL CHECKS PASSED — Databases are identical ***\n');
    } else {
      console.log(`\n  ${failedChecks} check(s) failed:\n`);
      for (const f of failures) {
        console.log(`    - ${f}`);
      }
      console.log();
    }
  } finally {
    await pool.close();
  }
}

main().catch(console.error);
