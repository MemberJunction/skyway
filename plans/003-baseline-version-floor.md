# Plan: Treat baseline as a version floor for resolution

**Branch:** `fix/baseline-version-floor`

## Problem

A baseline migration is meant to mark a point in time before which the database is "already migrated" — older `V`-prefixed scripts represent the history that the baseline replaces and should not be expected in the schema history table. Today, Skyway only honors that semantic on a **fresh** database (when `shouldBaseline` is true, i.e. empty history AND `BaselineOnMigrate=true`).

Once the baseline has been recorded in `flyway_schema_history`, the resolver stops treating the baseline version as a floor. From that point on, any pre-baseline `V` file on disk is evaluated against `highestApplied` and lands in one of two wrong states:

- **`IGNORED`** — when its version is below `highestApplied` and `outOfOrder=false`. `Migrate()` then aborts with "Detected resolved migration not applied to database…"; `Validate()` reports the same as a validation error.
- **`PENDING`** — when its version happens to be above `highestApplied` (e.g. earlier baseline + newer pre-baseline file). `Migrate()` will actually try to run a script that the baseline already represents.

In addition, baseline records in history that don't have a matching file on disk (the normal case — baselines are typically large, single-use bootstrap scripts that get pruned) get reported as `MISSING` by the disk-vs-history reconciliation block.

## Solution

Treat the **highest baseline version** as a floor for the resolver, regardless of whether the baseline came from this run or a prior run. Specifically:

1. Compute an `effectiveBaselineVersion` as the maximum of:
   - The auto-/explicitly-selected baseline file on a fresh-DB run (existing behavior).
   - The highest `version` among `BASELINE` / `SQL_BASELINE` records already in history.
2. Use that floor unconditionally in the versioned-migration loop: any disk file whose version is `<=` the floor is reported as `ABOVE_BASELINE`, never `IGNORED`, never `PENDING`, never expected in history.
3. In the disk-vs-history reconciliation block, suppress the `MISSING` report for baseline-typed records and for any record whose version is `<=` the floor (its absence on disk is expected; the baseline replaces it).
4. Repeatable migrations are unaffected — they're keyed by description, not version.

`Validate()` benefits transitively: it walks `StatusReport` for `IGNORED` entries today, and after the fix those entries will be `ABOVE_BASELINE` instead.

## Files to modify

| File | Change |
|------|--------|
| [packages/core/src/migration/resolver.ts](packages/core/src/migration/resolver.ts) | Compute floor from history + selection; gate versioned skip on floor; suppress MISSING below floor |
| [packages/core/src/__tests__/resolver.test.ts](packages/core/src/__tests__/resolver.test.ts) | New test cases — see "Tests to add" below |

No public API changes. `ResolverResult.EffectiveBaselineVersion` already exists; we'll keep populating it (now from either source) so callers / logs continue to work.

## Implementation steps

### Step 1 — Compute the floor from history

In [resolver.ts:78-90](packages/core/src/migration/resolver.ts#L78-L90), after the discovered-migrations sort and `highestApplied` calc, add:

```typescript
// Highest baseline version already recorded in history (independent of disk files).
// SQL_BASELINE = a B-prefixed file that ran; BASELINE = a `Baseline()` marker.
let highestHistoryBaseline: string | null = null;
for (const record of applied) {
  if ((record.Type === 'BASELINE' || record.Type === 'SQL_BASELINE') && record.Version !== null) {
    if (highestHistoryBaseline === null || record.Version > highestHistoryBaseline) {
      highestHistoryBaseline = record.Version;
    }
  }
}
```

### Step 2 — Fold history floor into `effectiveBaselineVersion`

The existing block at [resolver.ts:92-124](packages/core/src/migration/resolver.ts#L92-L124) only sets `effectiveBaselineVersion` when `shouldBaseline` is true (fresh DB). After that block, add:

```typescript
// History-recorded baseline always sets a floor, even on non-fresh runs.
// When both sources exist, take the higher.
if (highestHistoryBaseline !== null) {
  if (effectiveBaselineVersion === null || highestHistoryBaseline > effectiveBaselineVersion) {
    effectiveBaselineVersion = highestHistoryBaseline;
  }
}
```

This preserves the existing `BaselineAutoSelected` / `BaselineFileCount` semantics (they only describe the fresh-DB selection step) while widening `effectiveBaselineVersion` to include the historical case.

### Step 3 — Use the floor unconditionally in the versioned loop

In the versioned-migration loop ([resolver.ts:127-191](packages/core/src/migration/resolver.ts#L127-L191)), the current `ABOVE_BASELINE` branch is gated on `shouldBaseline`:

```typescript
} else if (shouldBaseline && effectiveBaselineVersion !== null && migration.Version! <= effectiveBaselineVersion) {
```

Drop the `shouldBaseline` gate — the floor now comes from either selection or history:

```typescript
} else if (effectiveBaselineVersion !== null && migration.Version! <= effectiveBaselineVersion) {
```

Order of branches matters and stays the same:
1. Already in history → `APPLIED` / `FAILED`
2. **At or below floor → `ABOVE_BASELINE`** (this branch)
3. Below `highestApplied` and `outOfOrder=false` → `IGNORED`
4. Otherwise → `PENDING`

A pre-baseline file on disk that *was* recorded in history (unusual but possible if the user retroactively added a baseline) still hits branch 1 first and reports as `APPLIED` — correct.

### Step 4 — Suppress `MISSING` for records covered by the floor

In the disk-vs-history reconciliation block at [resolver.ts:194-214](packages/core/src/migration/resolver.ts#L194-L214), the current code reports any history record whose version isn't on disk as `MISSING`. This is wrong for two cases:

- A `BASELINE` / `SQL_BASELINE` record — baseline scripts typically aren't kept on disk after they run.
- Any record at or below the floor — the baseline subsumes it; absence on disk is expected.

Update the filter:

```typescript
for (const record of applied) {
  if (record.Version === null || record.Type === 'SCHEMA') continue;

  // Baseline records and anything at/below the floor are expected to be absent from disk.
  if (record.Type === 'BASELINE' || record.Type === 'SQL_BASELINE') continue;
  if (effectiveBaselineVersion !== null && record.Version <= effectiveBaselineVersion) continue;

  if (!discovered.some((m) => m.Version === record.Version && m.Type !== 'repeatable')) {
    statusReport.push({
      // ... MISSING entry as before
    });
  }
}
```

### Step 5 — Tests

Add to [packages/core/src/__tests__/resolver.test.ts](packages/core/src/__tests__/resolver.test.ts) under a new `describe('ResolveMigrations — baseline floor from history')` block:

| Test | Setup | Expected |
|------|-------|----------|
| Earlier `V` files become `ABOVE_BASELINE` when a baseline is in history | History: `BASELINE` at `202601010000`. Disk: `V202301010000`, `V202401010000`, `V202601020000`. `outOfOrder=false`. | The two old `V`s → `ABOVE_BASELINE`. The newer one → `PENDING`. None `IGNORED`. `EffectiveBaselineVersion === '202601010000'`. |
| `SQL_BASELINE` history record also acts as floor | History: `SQL_BASELINE` at `202601010000`. Same disk as above. | Same outcome — both `BASELINE` and `SQL_BASELINE` types set the floor. |
| Highest of multiple baselines wins | History: two `BASELINE` rows at `202401010000` and `202601010000`. Disk: `V202501010000`. | `EffectiveBaselineVersion === '202601010000'`. The `V` is `ABOVE_BASELINE`. |
| Baseline-typed history records are not reported as `MISSING` | History: `BASELINE` at `202601010000`, no matching disk file. Disk: `V202601020000`. | No `MISSING` entry in `StatusReport`. The new `V` is `PENDING`. |
| Pre-baseline history records are not reported as `MISSING` | History: `BASELINE` at `202601010000`, plus a `SQL` row at `202401010000` whose disk file was deleted. Disk: empty. | No `MISSING` entry. The pre-baseline `SQL` row is silently absorbed by the floor. |
| Floor takes precedence over `IGNORED` | Same as test 1 but with `outOfOrder=false` explicitly — confirm the old `V`s go `ABOVE_BASELINE`, not `IGNORED`. | Already covered by test 1; assert no entry has `State === 'IGNORED'`. |
| Disk-only baseline below history baseline is `ABOVE_BASELINE` | History: `BASELINE` at `202601010000`. Disk: `B202401010000__old.sql`. `BaselineOnMigrate=false`. | The disk baseline file → `ABOVE_BASELINE` (it's at/below the floor). Not `PENDING`. |
| Fresh-DB auto-selection still works (regression) | Existing test at [resolver.test.ts:43-58](packages/core/src/__tests__/resolver.test.ts#L43-L58) — leave untouched. | Pass unchanged. |
| `Validate`-flow case: history baseline + old `V` on disk → no IGNORED | History: `BASELINE` at `202601010000`. Disk: `V202301010000`. `outOfOrder=false`. | `StatusReport.find(State === 'IGNORED')` is undefined (regression guard for `Skyway.Validate`). |

### Step 6 — Build and run tests

```bash
npm run build
npm test
```

All existing tests must continue to pass. The new tests should also pass.

## Out of scope

- No CLI/config changes — the floor is derived from existing data, no new option needed.
- No change to repeatable resolution.
- No change to the per-run / per-migration transaction flow.
- No change to `Skyway.Baseline()` itself — it still inserts a `BASELINE` record; the resolver will pick it up next run as the floor automatically.
- Integration tests aren't extended — this fix is exercisable entirely in the unit tests, and adding a multi-run scenario to the integration runners would be churn for one assertion.

## Risk and rollback

Risk is contained to the resolver — three small edits in one function. Public types unchanged. Worst-case rollback is reverting the resolver edits; the new tests would fail-loudly to flag the regression.

Behavior change for existing users:
- Users who had `outOfOrder=true` set as a workaround for the `IGNORED`-after-baseline issue can drop it (not required — `outOfOrder=true` continues to work).
- Users who relied on `Validate()` flagging old `V` files as errors lose that signal — but it was a false-positive signal anyway.

## Commit / PR

Single commit titled `fix: treat baseline version as resolution floor` with a body referencing this plan.
