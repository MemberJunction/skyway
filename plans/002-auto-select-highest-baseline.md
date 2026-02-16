# Plan: Auto-select highest baseline migration (zero-config baselining)

**Issue:** [#2 — Auto-select highest baseline migration](https://github.com/MemberJunction/skyway/issues/2)
**Branch:** `feature/auto-baseline-selection`

## Problem

When `BaselineOnMigrate` is enabled and a fresh database is initialized, the user must explicitly set `BaselineVersion` to match a specific `B`-prefixed migration file. If omitted, it defaults to `"1"`, and if no `B1__*.sql` file exists, the baseline is silently skipped. This is a footgun — users have to know the exact version string and keep it in sync with their migration files.

## Solution

When `BaselineOnMigrate` is `true` and `BaselineVersion` is not explicitly set (i.e., still the default `"1"`), automatically select the highest-versioned `B` migration file instead of looking for a `B1__*.sql` that almost certainly doesn't exist.

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/migration/resolver.ts` | Core auto-selection logic |
| `packages/core/src/core/config.ts` | Add sentinel for "not explicitly set" |
| `packages/core/src/core/skyway.ts` | Pass auto-selected version to logging & dry-run |
| `packages/cli/src/config-loader.ts` | Distinguish "user set baseline-version" from "default" |
| `packages/cli/src/commands/baseline.ts` | Support auto-selection in standalone `baseline` command |
| `packages/core/src/__tests__/resolver.test.ts` | **New file** — unit tests for resolver including auto-selection |

## Implementation Steps

### Step 1: Config — Track whether BaselineVersion was explicitly set

**File:** `packages/core/src/core/config.ts`

The default `BaselineVersion` is `"1"`. The issue says auto-selection should kick in when `BaselineVersion` is not explicitly set (or is the default `"1"`). Rather than adding a separate boolean flag, we can use a sentinel approach: treat `"1"` as the "not explicitly configured" value, since no real baseline file would ever use version `"1"` (the issue confirms this is the existing behavior).

No changes needed to the `SkywayConfig` or `MigrationConfig` interfaces — the resolver can simply check `baselineVersion === '1'` to detect the default. This keeps the API surface minimal and backwards-compatible.

### Step 2: Resolver — Auto-select highest baseline when version is default

**File:** `packages/core/src/migration/resolver.ts`

This is the core change. In `ResolveMigrations()`, update the baseline resolution block (lines 84-101):

**Current logic:**
```typescript
if (shouldBaseline && baselines.length > 0) {
  const matchingBaseline = baselines.find((b) => b.Version === baselineVersion);
  if (matchingBaseline) {
    pending.push(matchingBaseline);
    // ... status report
  }
}
```

**New logic:**
```typescript
if (shouldBaseline && baselines.length > 0) {
  let selectedBaseline: ResolvedMigration | undefined;

  if (baselineVersion === '1') {
    // Auto-select: pick the highest-versioned baseline
    // baselines are already sorted ascending by version, so take the last one
    selectedBaseline = baselines[baselines.length - 1];
  } else {
    // Explicit version: find exact match
    selectedBaseline = baselines.find((b) => b.Version === baselineVersion);
  }

  if (selectedBaseline) {
    pending.push(selectedBaseline);
    statusReport.push({
      Type: 'baseline',
      Version: selectedBaseline.Version,
      Description: selectedBaseline.Description,
      State: 'PENDING',
      Script: selectedBaseline.ScriptPath,
      DiskChecksum: selectedBaseline.Checksum,
      AppliedChecksum: null,
      InstalledOn: null,
      ExecutionTime: null,
    });
  }
}
```

**Critical downstream change:** The versioned migration skip logic (line 123) currently compares against the passed-in `baselineVersion` parameter. When auto-selecting, it must compare against the *selected* baseline's version instead:

```typescript
// Before:
} else if (shouldBaseline && migration.Version! <= baselineVersion) {

// After — use the actual selected baseline version:
} else if (shouldBaseline && effectiveBaselineVersion !== null && migration.Version! <= effectiveBaselineVersion) {
```

Where `effectiveBaselineVersion` is set to `selectedBaseline?.Version ?? null` from the baseline resolution block above.

Also update the `ResolverResult` interface to include the auto-selected version for downstream consumers (logging, dry-run, `info` command):

```typescript
export interface ResolverResult {
  PendingMigrations: ResolvedMigration[];
  StatusReport: MigrationStatus[];
  ShouldBaseline: boolean;
  /** The effective baseline version used (auto-selected or explicit). Null if no baseline. */
  EffectiveBaselineVersion: string | null;
  /** True if the baseline version was auto-selected (not explicitly configured). */
  BaselineAutoSelected: boolean;
}
```

### Step 3: Skyway — Log auto-selection in migrate and dry-run

**File:** `packages/core/src/core/skyway.ts`

In the `Migrate()` method, after `ResolveMigrations()` returns, add a log line when auto-selection occurred:

```typescript
const resolution = ResolveMigrations(...);

if (resolution.BaselineAutoSelected && resolution.EffectiveBaselineVersion) {
  this.callbacks.OnLog?.(
    `Auto-selected baseline version: ${resolution.EffectiveBaselineVersion} (highest of ${baselines.length} baseline file(s))`
  );
}
```

The `baselines.length` value isn't currently available here. Two options:
1. Add a `BaselineFileCount` to `ResolverResult` (preferred — keeps it self-contained)
2. Count baselines from discovered migrations in `Skyway.Migrate()`

Go with option 1: add `BaselineFileCount: number` to `ResolverResult`.

In the dry-run block, the auto-selected baseline will already appear in the pending list, so the existing log output will show it naturally. No additional change needed there.

In the `Info()` method, the `StatusReport` already includes baseline entries with their version, so the `info` command will show the correct auto-selected baseline without additional changes.

### Step 4: CLI baseline command — Support auto-selection

**File:** `packages/cli/src/commands/baseline.ts`

When `RunBaseline` is called without an explicit version, it currently passes `version ?? config.Migrations.BaselineVersion ?? '1'` to `skyway.Baseline()`. Update this to also support auto-selection:

- If no explicit version and the config version is the default `"1"`, scan for `B`-prefixed files and auto-select the highest version.
- This requires importing the scanner to discover baseline files.

```typescript
import { ScanAndResolveMigrations } from '@skyway/core';

export async function RunBaseline(config: SkywayConfig, version?: string): Promise<boolean> {
  let effectiveVersion = version ?? config.Migrations.BaselineVersion ?? '1';

  // Auto-select highest baseline if no explicit version
  if (effectiveVersion === '1' && !version) {
    const discovered = await ScanAndResolveMigrations(config.Migrations.Locations);
    const baselines = discovered
      .filter(m => m.Type === 'baseline')
      .sort((a, b) => a.Version!.localeCompare(b.Version!));
    if (baselines.length > 0) {
      effectiveVersion = baselines[baselines.length - 1].Version!;
      LogInfo(`Auto-selected baseline version: ${effectiveVersion} (highest of ${baselines.length} baseline file(s))`);
    }
  }

  // ... rest of existing logic using effectiveVersion
}
```

**Note:** The `ScanAndResolveMigrations` function needs to be re-exported from `@skyway/core`'s public API. Check `packages/core/src/index.ts` to verify it's exported; if not, add the export.

### Step 5: Config loader — No changes needed

**File:** `packages/cli/src/config-loader.ts`

The default `BaselineVersion` is already `"1"` (line 172). The auto-selection logic is triggered when the resolver sees `"1"`, regardless of whether it came from the default or an explicit `--baseline-version 1` flag. This is acceptable because:
- Nobody would explicitly set `--baseline-version 1` and expect a `B1__*.sql` file (version strings are timestamps like `202601122300`)
- If they did have a `B1__*.sql`, the explicit-match path in the resolver would still find it (since `baselines.find(b => b.Version === '1')` would match)

Wait — actually there's a subtle issue. If the user explicitly passes `--baseline-version 1`, the resolver would auto-select the highest baseline instead of looking for `B1__*.sql`. This is unlikely but technically a breaking edge case. To be safe, track whether the value was explicitly set:

**Option A (simple):** Keep the sentinel approach. Document that `"1"` triggers auto-selection. This matches the issue's spec: *"Auto-selection only kicks in when BaselineVersion is not explicitly set (or is the default '1')"*.

**Option B (precise):** Add a flag to the config-loader that records whether `--baseline-version` was provided. Pass this to the resolver.

**Decision:** Go with Option A. The issue explicitly says `"or is the default '1'"` triggers auto-selection, so this is the intended behavior. It also keeps the implementation simpler.

### Step 6: Unit tests for resolver

**New file:** `packages/core/src/__tests__/resolver.test.ts`

Create comprehensive unit tests for `ResolveMigrations()`, including the new auto-selection behavior. These tests operate on in-memory data (no DB or filesystem needed).

#### Test cases:

**Auto-selection tests:**
1. **Auto-select with multiple baselines** — given 3 `B` files and `baselineVersion='1'`, selects the highest version
2. **Auto-select with single baseline** — given 1 `B` file and `baselineVersion='1'`, selects it
3. **No baselines available** — given 0 `B` files and `baselineVersion='1'`, no baseline selected
4. **Explicit override** — given `baselineVersion='202501010000'`, selects the matching `B` file even when a higher one exists
5. **Explicit version not found** — given `baselineVersion='999'` and no matching file, no baseline selected
6. **Skip versioned migrations at or below auto-selected baseline** — versioned migrations below the auto-selected version should be marked `ABOVE_BASELINE`
7. **Apply versioned migrations above auto-selected baseline** — versioned migrations above the auto-selected version should be `PENDING`
8. **Only triggers on empty DB** — if history records exist, auto-selection does not activate even with `baselineOnMigrate=true`
9. **`BaselineOnMigrate` disabled** — no auto-selection regardless of baseline files

**Existing resolver behavior tests (regression coverage):**
10. **Versioned migration pending** — new migration on disk, not in history
11. **Versioned migration already applied** — in history, matches disk
12. **Missing migration** — in history but not on disk
13. **Failed migration** — in history with `success=false`
14. **Repeatable migration pending** — first run
15. **Repeatable migration outdated** — checksum changed
16. **Repeatable migration unchanged** — checksum matches
17. **Out-of-order detection** — with `outOfOrder=false`

#### Test helper:

```typescript
function makeMigration(overrides: Partial<ResolvedMigration>): ResolvedMigration {
  return {
    Type: 'versioned',
    Version: '202601010000',
    Description: 'Test migration',
    Filename: 'V202601010000__Test_migration.sql',
    FilePath: '/migrations/V202601010000__Test_migration.sql',
    ScriptPath: 'V202601010000__Test_migration.sql',
    SQL: 'SELECT 1',
    Checksum: 12345,
    ...overrides,
  };
}
```

### Step 7: Verify `@skyway/core` exports

**File:** `packages/core/src/index.ts`

Ensure `ScanAndResolveMigrations` is exported so the CLI `baseline` command can use it. Check current exports and add if missing.

## Backwards Compatibility

- Existing configs with explicit `BaselineVersion` (e.g., `"202601122300"`) continue to work unchanged — the resolver only auto-selects when the version is `"1"` (the default)
- Existing configs with `BaselineOnMigrate: false` (the default) are unaffected — auto-selection only activates when both `BaselineOnMigrate` is `true` AND the DB is empty
- The `ResolverResult` interface gets two new optional-ish fields, but since it's returned (not consumed) by external code, this is non-breaking

## Acceptance Criteria Mapping

| Criteria | Addressed in |
|----------|-------------|
| Auto-select highest B migration on empty DB | Step 2 (resolver) |
| Skip versioned migrations at or below auto-selected baseline | Step 2 (resolver, `effectiveBaselineVersion`) |
| Explicit `BaselineVersion` overrides auto-selection | Step 2 (resolver, `baselineVersion !== '1'` branch) |
| `info` and dry-run show auto-selected baseline | Step 3 (logging) + existing status report |
| Log message for auto-selection | Step 3 (`Skyway.Migrate()` log) |
| Unit tests | Step 6 (9 auto-selection + 8 regression tests) |

## Estimated Scope

- ~50 lines changed in `resolver.ts`
- ~5 lines added to `ResolverResult` interface
- ~10 lines added to `skyway.ts` for logging
- ~20 lines changed in `baseline.ts` CLI command
- ~250 lines new in `resolver.test.ts`
- No changes to config interfaces or config-loader
