# pi-quota main/standby coordination — design

Date: 2026-06-27

## Problem

pi-quota runs independently in every pi instance. With N instances open, all N
run the same loop in parallel, unaware of each other:

- **Polling load** — each instance polls the Anthropic and OpenAI Codex usage
  APIs every ~10 minutes (aligned to the wall clock), so load scales linearly
  with the number of open pi windows.
- **`auth.json` write race** — each instance may refresh OAuth tokens and write
  `~/.pi/agent/auth.json` with no locking (last-write-wins).
- **Double-redeem** — `tryAutoRedeemCodexReset` is gated only by an in-process
  flag, so two instances can both redeem a saved Codex reset credit, burning two
  credits instead of one.
- Only Telegram reset notifications are coordinated today, via a transient lock
  (`pi-quota-notified.lock`) plus an idempotency file (`pi-quota-notified.json`).

There is currently **no persistent role**: no instance "is" main; whichever wins
the notification lock for a given reset sends it.

## Goal

No matter how many pi instances run, exactly **one** instance (main) hits the
provider APIs, refreshes auth, runs auto-redeem, and sends notifications. The
rest (standby) render the same widget from shared data. The widget shows each
instance's role.

## Components

### 1. Leader lease — `~/.pi/agent/pi-quota-leader.json`

Holds `{ pid, hostname, heartbeatAt }`.

A heartbeat timer runs every **20s**:

- If I am leader (file `pid` == mine): rewrite the file to bump `heartbeatAt`
  (and mtime).
- If file `pid` != mine: I am demoted → become standby.
- If no file, or stale (`now − heartbeatAt > 60s`): try to claim via exclusive
  create (`open(path, "wx")`, reusing the existing stale-takeover logic from
  `acquireLock`). The winner becomes main.

On `session_shutdown`: if I am leader, delete the file → instant clean failover.

Staleness threshold is **60s** (matches existing `LOCK_STALE_MS`); heartbeat at
**20s** allows two renewals to fail before a standby acts.

### 2. Shared state — `~/.pi/agent/pi-quota-state.json`

- Main writes after every successful poll: the serialized `states` array
  (provider, percentages, reset times as ISO strings, `resetsAvailable`,
  `lastUpdated`).
- Standbys `fs.watch` this file and re-read on change, so their widget updates
  instantly when main writes fresh data.

### 3. Role-based behavior

- **Main:** runs the existing `runCycle()` (poll, auto-redeem, notifications,
  schedule reset timers) **and** writes the state file after each poll. The file
  watcher is stopped.
- **Standby:** does **not** poll, refresh auth, redeem, or notify. Starts the
  file watcher, fills its in-memory `states` from the state file, and renders the
  widget.
- **Transitions** flip these cleanly:
  - Promote (standby → main): start polling/heartbeat-as-leader, stop watcher,
    run a cycle immediately.
  - Demote (main → standby): stop poll timer and reset timers, start watcher,
    re-read state file.

### 4. Widget

Add a header line above the provider lines:

```
quota: main
claude: 7d: 80% left (2d 4h), 5h: 95% left (3h 12m)
codex:  7d: 60% left (5d 1h), 5h: 88% left (1h 30m)
```

The header reads `quota: main` or `quota: standby` depending on this instance's
role. Provider lines are unchanged and remain uniform with each other.

## What this fixes

- **Polling load:** N instances → 1 poller.
- **`auth.json` write race:** only main writes it.
- **Double-redeem:** only main redeems Codex credits.
- Notifications: already de-duped; now originate only from main. The
  notified-lock + `notified.json` remain as a safety net for the brief failover
  overlap window.

## Edge cases

- **Main crashes / machine sleeps:** lease goes stale after 60s → a standby
  promotes and starts polling. Brief gap (≤ ~60s) with no polling — acceptable.
- **Sleep/wake double-main:** two instances may both consider themselves main
  for a few seconds. The notified-lock + `notified.json` idempotency prevents
  duplicate Telegram sends; the residual risk is a small double-redeem window,
  unchanged in likelihood from the per-attempt overlap that exists today and
  mitigated because redeem is gated on observed state.
- **Fresh standby with no state file yet:** widget shows `quota: standby` with no
  provider lines until main writes the first state.

## Testing

This extension deliberately has no automated test suite (single-file, behavior
dominated by external HTTP APIs and pi runtime events). Verified manually by
running multiple pi instances and observing:

- Only one instance polls (check `pi-quota.log` / network).
- Widget shows `main` on exactly one instance, `standby` on the rest.
- Killing main causes a standby to promote within ~60s.
- Standby widgets update when main writes new data.
