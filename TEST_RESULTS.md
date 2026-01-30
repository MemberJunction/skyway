# Skyway vs Flyway Comparison Test Results

**Date**: 2026-01-30
**Flyway Version**: 9.22.3 (Community Edition)
**Skyway Version**: 0.1.0 (initial-build)
**SQL Server**: 2022 Developer Edition (16.0) on Linux
**Migration Set**: MemberJunction v3.x (23 migrations)

## Test Setup

Two identical databases were created from the same migration files:

- **MJ_3_3_PERFECT**: Created by Flyway 9.22.3 (Java)
- **MJ_3_3_NEW**: Created by Skyway (TypeScript)

Both ran against `/workspace/MJ/migrations` containing:
- 1 baseline migration (`B202601122300__v3.0_Baseline.sql` — 6,796 SQL batches)
- 21 versioned migrations (`V202601200000` through `V202601281700`)
- 1 repeatable migration (`R__RefreshMetadata.sql`)

## Results Summary

```
════════════════════════════════════════════════════════════
  TOTAL CHECKS: 156
  PASSED: 156
  FAILED: 0
════════════════════════════════════════════════════════════

  *** ALL CHECKS PASSED — Databases are identical ***
```

## Detailed Results

### 1. Table Count Comparison
```
PERFECT: 267 tables
NEW:     267 tables
Result:  MATCH ✅
```

### 2. Column Count Comparison
```
All 543 table/schema combinations have matching column counts ✅
```

### 3. Row Count Comparison
```
All 267 tables have matching row counts ✅
```

### 4. flyway_schema_history Comparison
```
PERFECT: 24 rows
NEW:     24 rows

Per-row checks (version, description, type, checksum, success, script):
  - Rows 0-22 (SCHEMA + baseline + 21 versioned): All fields match exactly ✅
  - Row 23 (repeatable): All fields match except checksum (expected — see note) ✅
```

**Note on repeatable migration checksums**: Flyway computes repeatable migration
checksums *after* placeholder substitution. Since `${flyway:timestamp}` resolves
to the current time, the checksum is intentionally different each run. This is by
design — it forces repeatable migrations to always re-execute. Both Flyway and
Skyway exhibit this same behavior.

### 5. Data Sampling
```
All sampled tables have matching data hashes ✅
(Comparison excludes __mj_CreatedAt/__mj_UpdatedAt columns which differ
 due to the repeatable migration running stored procedures at different times)
```

## Bugs Fixed During Testing

### 1. Version Parsing Regex
**File**: `packages/core/src/migration/parser.ts`
**Issue**: Regex `(\d[\w.]*)` was too greedy — captured `202601200000__v3.1.x` as the version instead of `202601200000`.
**Fix**: Changed to `(\d+)` to match only numeric digits.

### 2. CRC32 Checksum Algorithm
**File**: `packages/core/src/migration/checksum.ts`
**Issue**: Computing CRC32 on full file content string. Flyway uses `BufferedReader.readLine()` which strips line endings, then feeds each line's UTF-8 bytes to `CRC32.update()` individually.
**Fix**: Split on line endings, feed each line's bytes to CRC32 progressively.
**Verification**: Compiled equivalent Java program — output matches exactly.

### 3. Repeatable Migration Checksum Timing
**File**: `packages/core/src/core/skyway.ts`
**Issue**: Computing all checksums on raw file content. Flyway's `SqlMigrationResolver.getChecksumForLoadableResource()` (decompiled from bytecode) computes repeatable migration checksums *after* placeholder substitution.
**Fix**: Recompute checksum for repeatable migrations after `SubstitutePlaceholders()`.

## Migration Execution Performance

| Migration | Flyway (ms) | Skyway (ms) |
|-----------|-------------|-------------|
| Baseline (6,796 batches) | ~15,000 | ~15,600 |
| Total (23 migrations) | ~118,000 | ~108,800 |

## How to Reproduce

```bash
# 1. Run Flyway against MJ_3_3_PERFECT
~/.node-flyway/flyway-9.22.3/flyway \
  -url="jdbc:sqlserver://sql-claude:1433;databaseName=MJ_3_3_PERFECT;encrypt=false;trustServerCertificate=true" \
  -user=sa -password=Claude2Sql99 -schemas=__mj \
  -locations="filesystem:/workspace/MJ/migrations" \
  -baselineVersion=202601122300 -baselineOnMigrate=true migrate

# 2. Run Skyway against MJ_3_3_NEW
npx tsx test-migration.ts

# 3. Compare databases
npx tsx test-compare.ts
```
