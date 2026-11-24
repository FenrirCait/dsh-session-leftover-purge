# dsh-session-leftover-purge

[简体中文](README.md) | **English**

Deleting a DSH session cleans DSH's own records, but several plugins keep their own copies:
**billion-context** snapshots and `index.db`, **cost-meter** ledger rows and per-turn receipts,
**dsh-context** overview caches, and **archive-manager**'s projcache.

This plugin subscribes to the `api-session/removed` event that archive-manager emits on a
right-click delete, and cleans those copies per **session family** (the session plus its
`session-<parent>|sub:<hex>` subagent runs). It also reconciles at boot to find families DSH no
longer has but a plugin still lists.

## Install

```bash
dsh plugin add dsh-session-leftover-purge                    # npm, no git needed
dsh plugin add github:FenrirCait/dsh-session-leftover-purge   # tip of main
dsh plugin add github:FenrirCait/dsh-session-leftover-purge#vX.Y.Z
dsh plugin add https://github.com/FenrirCait/dsh-session-leftover-purge/releases/latest/download/dsh-session-leftover-purge.tgz
```

**Fully quit and reopen DSH after installing.** The host half is loaded by the DSH Loader at process
start; a package installed while DSH is running is not mounted into the current process.

## Requirements

- DeepSeek Harness `>= 0.2.0-rc.1 < 0.3.0-0`
- **Node >= 22.13 or >= 23.4** — the plugin reads and writes bili's index through the built-in
  `node:sqlite`. Below that it logs `node:sqlite-unavailable` once and skips the index half.

Optional companions (missing ones are skipped, never an error): `@michengai/dsh-archive-manager`
(delete entry point), `billion-context`, `dsh-cost-meter`, `dsh-context`.

## Usage

Nothing to configure. Settings live under **Settings → Plugins → Plugin manager →
dsh-session-leftover-purge**; changes take effect immediately.

| Setting | Default | What it does |
|---|---|---|
| Master switch | on | Turning it off stops all cleanup and unsubscribes from deletes |
| bili JSON snapshot | on | Moves the family's snapshot files away |
| bili index | on | Rows, content refcounts, the three session-keyed `kv_store` blobs; `VACUUM INTO` backup first |
| cost-meter ledger rows | off | Removes `days[*].sessions[]` entries only; totals stay untouched |
| cost-meter detail files | off | Removes per-turn receipts (copied into trash first) |
| cost-meter reprice backup report | on | Lists cost-meter's own `before-reprice` backups in the boot report; **never deletes them** |
| dsh-context cache | off | Removes family entries from `overview-cache.v3` shards (report only by default) |
| archive projcache | off | Removes session-keyed files from `session_projcache` (report only by default) |
| Backup retention | 7 days | `0` keeps everything |
| Backup size cap | 2048 MB | Oldest batches go first; `0` = no cap |
| Dry run | off | Reports only — the boot sweep obeys it too |
| Reconcile on boot | on | Scans for orphan snapshot families, writes `orphans.json` |
| Sweep stale bindings on boot | on | Drops `kv_store` entries for deleted sessions (and their subagents) before bili's lane starts |
| Auto purge orphans | off | Cleans orphans found during reconcile instead of only reporting |
| Boot delay | 8000 ms | How long to wait before reconciling |

The three fields **Restore latest backup / Delete all backups / Back up the cost-meter ledger now**
are triggers: write a new number and save to run the action once.

## Session storage backends

"Does this session still exist?" is the only question that matters before a delete. Three answers:

| Backend | How it is detected |
|---|---|
| `jsonl` | `$DSH_HOME/sessions/<project>/<session>/` directories exist |
| `sqlite` | `<sessions>/sessions.sqlite`, with the table and id column discovered from the schema |
| `unknown` | neither is readable |

`unknown` answers **"alive" for every id**: when the store cannot be read, nothing is deleted. Boot
reconcile skips orphan detection entirely in that state — an unreadable backend must never hand
`Auto purge orphans` a list of "everything".

## What gets cleaned

| Target | Action | Default |
|---|---|---|
| bili snapshots | moved to the batch | on |
| bili `index.db` | rows + per-reference refcounts + three kv blobs, one transaction | on |
| cost-meter ledger | detail rows only, totals preserved | off |
| cost-meter receipts | per-turn files | off |
| dsh-context `overview-cache.v3` | family entries dropped, `savedAt` refreshed, atomic rewrite | report only |
| archive-manager `session_projcache` | session-keyed files only | report only |

## Backups and restore

Every batch under `~/.dsh/storages/session-leftover-purge/trash/<timestamp>/` holds:

- `index.db` — consistent `VACUUM INTO` snapshot (falls back to the three-file copy on old SQLite)
- `session-…__*.json` — moved bili snapshots
- `kv-store.json.bak` — the kv rows before the boot sweep rewrote them (deliberately not `*.json`,
  or *Restore latest backup* would replay it into bili's session tree)
- `ledger.json` — the ledger before it was edited
- `cost-files/`, `cache/`, `projcache/` — each adapter's originals

Restore is the **Restore latest backup** trigger. A locked database or ledger is never overwritten:
the copy is staged as `*.restored-<timestamp>` for you to swap in after quitting DSH.

## Logs

- `purge.log` — one `ready v…` and one `roots … store=…` line per start, one line per purge/restore/sweep
- `orphans.json` — last reconcile result, including `store` and `evidence`
- `triggers.json` — trigger numbers that already fired

## Limits

- Only covers deletes made through archive-manager; other paths are caught by the boot reconcile.
- Subagent runs are only cleaned together with their parent: DSH emits one event for the parent.
- bili's lane rewrites `kv_store` from memory, so the sweep has to win the boot race; if the blobs
  changed between read and write the round gives up (`changed-during-read`) and retries next start.
- The plugin's own state follows `$DSH_HOME` (override: `SESSION_LEFTOVER_PURGE_DIR`); bili's data
  directory is user-level (`BILI_SESSIONS_DIR`) and is not isolated per profile.
- A `SQLITE_BUSY` on bili's index is skipped and retried next time.
- Never touches DSH attachments or Electron's localStorage.
- Every failure is logged only; nothing is thrown into DSH's delete flow.

MIT License.
