# Release lines

Skyway is a standalone database migration CLI and library workspace (not an MJ OpenApp — it has no
`mj-app.json`, no OpenApp SQL migrations, and zero `@memberjunction/*` runtime dependencies). It
adopts the MemberJunction release-line branch model adapted for standalone semantic-versioned lines
(`lts/<major>.<minor>`) while keeping the existing `main` workflow and automated npm publishing
(`publish.yml` on `main`) intact.

| Branch | Purpose | What lands there |
|---|---|---|
| `main` | Active development (default branch) & `latest` npm publisher | All new work, first |
| `next` | Optional integration branch (mirrors `main` at cut; ready if development moves off `main`) | Future development if adopted |
| `lts/X.Y` | Release / LTS line for `X.Y.x` | Cherry-picked backports from `main` (or `next`) |

## The line status record

[`release-lines.json`](../release-lines.json) lists each standalone release line: its branch
(`lts/X.Y`), the semver it was cut at (`version`, never changed once cut), whether it is `open` or
`lts`, and whether it releases through `main` (npm dist-tag `latest`) or from its own branch
(dist-tag `lts-X.Y`). CI reads the authoritative copy on `main` (the configured
`developmentBranch`). Freezing a line to `lts` is a support decision: have one of the owners in
`.github/CODEOWNERS` review the change.

A line is `open` (features and fixes backported from `main`) or `lts` (fixes only). An LTS line
never reopens.

## Daily flow

1. Open your PR against `main` (or `next` if adopted), with a changeset under `.changeset/` when
   publishing package changes.
2. Add a `backport lts/X.Y` label for each release line the change should reach (before or after
   merging). When the PR merges, the backport workflow opens one cherry-pick PR per labelled line.
3. If a cherry-pick hits a conflict, the workflow opens a draft PR for you to finish. If you add a
   commit of your own to resolve the conflict, add the `backport-adjusted` label so reviewers and
   `lines: on next first` recognize the conflict-resolution commit.
4. Direct PRs into `lts/*` that bypass `main` / `next` are rejected by `lines: on next first`.

## Publishing

- **Current newest line (`0.7` through `main`):** `.github/workflows/publish.yml` continues to
  version and publish `@memberjunction/skyway-*` packages on pushes to `main` whenever `.changeset/`
  contains pending changesets.
- **Older LTS lines (future):** Once a newer line supersedes `0.7` on `main`, mark `0.7` as
  `releasesThrough: "branch"` and publish patch releases from `lts/0.7` under dist-tag `lts-0.7`.

## The checks

| Check | On | What it enforces |
|---|---|---|
| `lines: record` | PRs into `main` / `next` | `release-lines.json` is valid, line identity never changes, LTS never reopens, backport labels name real lines, and script unit tests pass |
| `lines: on next first` | PRs into `lts/*` | Every commit carries `(cherry picked from commit <sha>)` with `<sha>` on `main` or `next`; conflict fixes need `backport-adjusted`; line-cut PRs require a maintainer/admin-applied `line-cut` label |
| `PostgreSQL — full Skyway lifecycle` | All PRs (`main`, `next`, `lts/*`) | Build, unit tests, and real PostgreSQL integration test suite |
| `SQL Server — full Skyway lifecycle` | All PRs (`main`, `next`, `lts/*`) | Build and real SQL Server integration test suite |

## Cutting a new release line

1. On `main`, add the new line to `release-lines.json` (`status: "open"`, `version: "X.Y.0"`,
   `releasesThrough: "main"`) and update the previous line to `releasesThrough: "branch"`. Have one
   of its `CODEOWNERS` review and merge.
2. Create the `backport lts/X.Y` label and ensure the `protect-lts` ruleset covers `refs/heads/lts/*`.
3. Push `lts/X.Y` from `main`.
4. Open a `ci/cut-lts-X.Y` PR into `lts/X.Y` setting `.github/CODEOWNERS` to `* @bg-BC @rkihm-BC`,
   apply the `line-cut` label (maintainer/admin only), and request code-owner review.
