# Relay DJT Maintainer Guide

This file explains how the repository works. The public-facing
[`README.md`](./README.md) is partly generated and is intended for quickly
reading the latest posts.

## Purpose

Relay DJT polls independent public archives of Donald J. Trump's Truth Social
account, stores text posts in `djt.json`, and displays posts from the last
three days in the root README.

The repository preserves:

- Posts older than the current fetch window
- Previously observed versions of edited text
- Deleted posts and available deletion timestamps
- Original Truth Social post IDs, URLs, and creation times

## Files

- `src/truth-posts.mjs`: Fetches and normalizes source records.
- `src/read-posts.mjs`: Prints posts for a requested rolling window.
- `src/update-djt.mjs`: Merges observations, writes `djt.json`, and regenerates
  the latest-post section in `README.md`.
- `djt.json`: Persistent versioned archive, sorted newest first.
- `.github/workflows/update-djt.yml`: Scheduled updater and commit job.
- `README.md`: Public project page and generated latest-post feed.

## Commands

Install:

```bash
npm install
```

Update the persistent archive and README:

```bash
npm run update
```

Read without changing stored files:

```bash
npm run read -- --days 3
npm run read -- --days 3 --json
```

## Update Process

Each update:

1. Fetches text posts from Roll Call and Trump's Truth using a 24-hour overlap.
2. Fetches Roll Call deleted records back to the oldest stored post date.
3. Deduplicates observations by Truth Social post ID.
4. Adds new posts.
5. Appends a version when the current text differs from the last stored
   version.
6. Marks deleted posts without removing their text or version history.
7. Sorts all posts newest first.
8. Rewrites the generated section between `DJT_POSTS_START` and
   `DJT_POSTS_END` in `README.md`.
9. Leaves both files untouched when nothing changed.

Do not remove or duplicate the generated README markers.

The 24-hour overlap gives scheduled runs substantial recovery room if GitHub
Actions starts late or misses several runs. Recent volume normally fits in one
50-record API page. Pagination remains enabled as a fallback for unusually
busy periods.

Override the overlap for a local or one-off run:

```bash
DJT_OVERLAP_HOURS=36 npm run update
```

For scheduled runs, edit `DJT_OVERLAP_HOURS` in
`.github/workflows/update-djt.yml`.

## Version Semantics

The source does not provide an authoritative edit timestamp. Each version uses
`firstSeenAt`, which records when Relay DJT first observed that text.

```json
{
  "currentVersion": 2,
  "versions": [
    {
      "version": 1,
      "text": "Original text",
      "firstSeenAt": "2026-06-12T10:00:00.000Z"
    },
    {
      "version": 2,
      "text": "Edited text",
      "firstSeenAt": "2026-06-12T10:10:00.000Z"
    }
  ]
}
```

Deletion fields:

- `deleted`: Whether the source reports the post as deleted.
- `deletedAt`: Source-provided deletion time, when available.
- `deletedDetectedAt`: When Relay DJT first observed the deletion.

## GitHub Actions

The `Engine` workflow does not use GitHub's cron scheduler. A manually started
or dispatched run updates the archive, waits four and a half minutes, queues
its successor with `repository_dispatch`, and remains alive for another 30
seconds during handoff.

The `djt-engine` concurrency group allows one running engine and one queued
successor, preventing overlapping archive commits. If GitHub cancels or
interrupts the chain before a successor is queued, restart it manually:

```bash
gh workflow run update-djt.yml
```

## Data Source

Truth Social currently blocks direct automated API requests. The fetcher uses
two independent public archives:

```text
https://rollcall.com/wp-json/factbase/v1/twitter
https://trumpstruth.org/
```

Roll Call is authoritative for edits and deletions. Trump's Truth contributes
new IDs that Roll Call misses and keeps recent collection working when Roll
Call is unavailable. Existing text is not replaced from the fallback source,
which prevents formatting differences from being mistaken for edits.

The update fails only when both recent-post sources fail. A Roll Call deletion
audit failure is nonfatal and is retried on the next run. Media-only
placeholders and ReTruth markers are intentionally excluded.

## Troubleshooting

Run the updater locally and inspect its summary:

```bash
npm run update
git diff -- djt.json README.md
```

Check recent workflow runs:

```bash
gh run list --workflow update-djt.yml
```

Manually start or restart the engine:

```bash
gh workflow run update-djt.yml
```

Trigger an update with an authenticated HTTP `POST`:

```bash
curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/alastorid/djt/dispatches \
  -d '{"event_type":"engine"}'
```

The token needs permission to access this repository and trigger repository
dispatch events. GitHub does not provide an unauthenticated public `POST`
endpoint for Actions.

If a workflow cannot push, confirm that repository Actions settings allow
GitHub Actions to create and approve commits with the configured token.
