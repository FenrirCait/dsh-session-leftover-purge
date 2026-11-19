# dsh-session-leftover-purge

[简体中文](README.md) | **English**

Deleting a session clears DeepSeek Harness's own transcript, but
[billion-context](https://github.com/ranxianglei/billion-context) keeps a JSON snapshot plus a
shared `index.db`, and `dsh-cost-meter` keeps ledger rows. The deleted conversation therefore
keeps showing up in bili's panel and its text stays in the database. This plugin subscribes to
the public `api-session/removed` event and finishes the cleanup.

## Install

```bash
# simplest: install the latest from npm — no git, no GitHub access needed
dsh plugin add dsh-session-leftover-purge

# default: always the tip of main (needs git on the target machine)
dsh plugin add github:FenrirCait/dsh-session-leftover-purge

# pin an exact version by replacing vX.Y.Z with any tag from the tags page
dsh plugin add github:FenrirCait/dsh-session-leftover-purge#vX.Y.Z

# no git needed: always the newest packed tarball
dsh plugin add https://github.com/FenrirCait/dsh-session-leftover-purge/releases/latest/download/dsh-session-leftover-purge.tgz
```

None of the four commands changes between releases — copy them as-is.

The first one goes through the npm registry — the simplest and most reliable of the four. The
two git forms go through pnpm's git protocol and therefore need `git` on the target machine; the
last is a plain HTTPS download and only needs reachable GitHub. Every release publishes two
assets: the versioned `…-X.Y.Z.tgz` and the fixed name `dsh-session-leftover-purge.tgz` that
`latest/download/` resolves to.

**Fully quit and reopen DSH after installing.** The host half is loaded by the DSH Loader at
process start, so a package installed while DSH is running is not mounted into the current
process. Reloading the page only refreshes the settings form, it does not make the cleanup run.

## Requirements

**Required:** DeepSeek Harness itself (`>= 0.2.0-rc.1 < 0.3.0-0`). The plugin runs no background
service, and the only third-party package it imports — `@deepseek-ai/schemastery` — is supplied by
the host: it is declared as an optional peer dependency and already installed by DSH's own
`dsh-settings`, so **nothing extra needs installing**.

The plugin reads and writes bili's index through Node's built-in `node:sqlite`: **Node >= 22.13 or
>= 23.4** loads it without a flag. Below that the package still installs, but the whole `index.db`
half degrades to "skipped" — look for a `node:sqlite-unavailable node=…` line in the log
(`engines.node` states the same floor).

**Co-operates with** (missing ones are skipped, never an error):

| Component | Behaviour when absent |
|---|---|
| `@michengai/dsh-archive-manager` | No "delete session" entry point, so no purge is triggered; only the boot reconcile runs |
| `billion-context` (bili) | Snapshot and index steps are skipped, logged as `bili-sessions-root-missing` |
| `dsh-cost-meter` | Ledger and detail-file steps are skipped, logged as `ledger-missing` / `cost-files-root-missing` |

In short: install it and it runs. Whatever is missing simply gets less cleanup — a missing
neighbour never stops the plugin from loading.

## Usage

Nothing to configure. By default it does two things: removes the bili JSON snapshot and the
`index.db` rows for the deleted session.

| Setting | Default | What it does |
|---|---|---|
| Master switch | on | Turning it off stops all cleanup and unsubscribes from deletes |
| bili JSON snapshot | on | Removes the entry from bili's panel |
| bili SQLite index | on | Deletes the index rows; a backup is taken before any row is touched |
| cost-meter ledger rows | off | Deletes the ledger's detail rows only, the daily totals stay untouched |
| cost-meter raw detail files | off | Deletes the per-turn usage receipts |
| Reclaim index.db space | off | VACUUMs deleted pages away on boot; a failure leaves data intact |
| Backup retention | 7 days | Older batches are removed on the next start; `0` keeps them forever |
| Backup size cap | 2048 MB | Above it the oldest batches go first; `0` = no cap. The index snapshot is hundreds of MB, so this is what actually bounds the disk |
| Dry run | off | Logs what would happen, moves and deletes nothing |
| Reconcile on boot | on | Scans for orphan snapshots at startup and writes a report |
| Sweep stale bindings on boot | on | Drops `kv_store` entries of deleted sessions **and their subagent children** from all three blobs, before bili's lane starts; the rows are backed up first and a dry run only counts |
| Auto purge orphans | off | Cleans orphans found during reconcile instead of only reporting |
| Boot delay | 8000 ms | How long to wait before reconciling |

Settings live under **Settings → Plugins → Plugin manager → dsh-session-leftover-purge**.
Changes take effect immediately, no restart needed.

The three fields **Restore latest backup / Delete all backups / Back up the cost-meter ledger
now** are triggers: **write a new number and save** to run the action once. DSH renders schema
fields, not buttons, so bumping a number is how an action is expressed.

## What "deleting from the index" actually covers

`index.db` is not one table. Removing a session takes four kinds of references:

- **Rows**: `messages` / `message_media` / `refs` / `blocks` / `dead_refs` / `checkpoints`
  (non-pinned only) / `ccr_entries` / `session_ext` / `conversations` / `sessions`
- **`content` refcounts**: every `content_hash` / `media_hash` / `summary_hash` / `one_hash` /
  `state_hash` that belonged to the session has to lose one reference. Skip this and the blob
  stays pinned at `refcount > 0` forever, invisible to the orphan sweep — that is exactly how a
  real database accumulated hundreds of rows nobody could collect
- **JSON blobs**: three blobs in `kv_store` are keyed by session id — `plugin-conversations/table`,
  `prefix-affinity/v1` and `session-order/v1` (replayed into bili's skeleton cache on start), so a
  `WHERE session_id = ?` delete never reaches them and a binding survives that the panel does not
  show
- **Subagent pseudo-sessions**: bili files a subagent run as its own session,
  `session-<parent>|sub:<hex>`. Its `deleteSession` only ever deletes the exact id, and DSH only
  emits one delete event for the parent, so those rows used to stay forever. Deleting a parent now
  takes its whole `|sub:` family with it: rows, content references, the three blobs, snapshots

The last one has a timing trap: bili's lane keeps the whole conversation table in memory and
**rewrites `kv_store` from memory on every request**, so a binding removed during the purge is
back within seconds. The window that actually holds is **before the lane starts** — which is what
the boot sweep takes: it drops bindings whose session no longer exists, and the lane then hydrates
an already-clean table.

## Backups and restore

Every purge leaves a restorable copy under
`~/.dsh/storages/session-leftover-purge/trash/<timestamp>/`:

- `index.db` — the full database before any row was deleted. Written with `VACUUM INTO` when possible:
  one consistent snapshot read through the WAL, free pages dropped, and no "stale sidecar against a
  different main file" hazard. Older SQLite builds fall back to the three-file byte copy
  (`index.db` / `-wal` / `-shm`).
- `session-…__*.json` — the bili snapshots that were moved away
- `kv-store.json.bak` — the raw `kv_store` rows before the boot sweep rewrote them (the extension is
  not `.json` on purpose: *Restore latest backup* would otherwise copy it into bili's session tree)
- `ledger.json` — the full ledger before it was edited (only when the ledger was touched)
- `cost-files/` — the cost-meter detail files that were removed

Restoring is the **Restore latest backup** trigger above. If bili happens to hold the database
lock at that moment, the files are written as `index.db.restored-<timestamp>*` for you to swap
in manually — the running database is never overwritten by force.

## Logs

Under `~/.dsh/storages/session-leftover-purge/`:

- `purge.log` — one `ready v…` and one `roots …` line per start, one line per purge / restore / backup deletion
- `orphans.json` — result of the last reconcile pass
- `triggers.json` — the trigger numbers that have already fired

## Limits

- Only covers deletes made through archive-manager; other paths are caught by the boot reconcile.
- Subagent pseudo-sessions are only cleaned together with their parent: DSH never emits an event
  for a `|sub:` child.
- The boot sweep has to win the race against bili's lane. If the lane is already writing, this
  round gives up (`changed-during-read` in the log) and retries on the next start; the rows it
  would have changed are backed up to `kv-store.json.bak` first.
- The plugin's own state follows `$DSH_HOME` (default `~/.dsh`) and can be overridden with
  `SESSION_LEFTOVER_PURGE_DIR`; bili's data directory is user-level
  (`~/.local/share/billion-context/sessions` or `BILI_SESSIONS_DIR`) and is not isolated per profile.
  For a genuinely disposable test setup, point both at a temp directory.
- Every start writes one `roots state=… bili=… sessions=…` line to the log, so you can see which
  data an instance is about to touch before it deletes anything.
- bili's `index.db` belongs to another process, so a `SQLITE_BUSY` is skipped and retried next time.
- Never touches DSH attachments or Electron's localStorage.
- Every failure is logged only; nothing is thrown into DSH's own delete flow.

MIT License.
