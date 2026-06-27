# Telegram quota-reset notifications — Design

**Date:** 2026-06-27
**Status:** Approved (pending implementation plan)

## Summary

Extend `pi-quota` to send a Telegram message whenever a usage window
*resets* (its remaining quota rolls back up to a fresh window) for either
provider — Anthropic (`claude`) and OpenAI Codex (`codex`). Notifications fire
on every rollover regardless of how much quota was used, and arrive within
~30s–1min of the actual reset.

When Telegram is not configured, the extension behaves exactly as it does
today — zero behavioral change.

## Requirements

- Trigger: a window *resets* (remaining jumps back up to a fresh window), not
  when it is exhausted.
- Providers: both `anthropic` and `openai-codex`.
- Frequency: notify on *every* rollover, regardless of prior usage.
- Windows: both the 5-hour and 7-day windows.
- Timeliness: keep the existing 10-minute poll, but also fire close to the
  actual reset time (within ~1 minute) using a scheduled timer; do not wait up
  to 10 minutes for the next poll.
- One message per window that reset (5h and 7d are separate messages).
- Message states which window reset and shows both windows' current state.
- Delivery failures must never break the poll loop.
- Multiple pi instances must not send duplicate messages for the same reset.
  No message may be lost on a transient delivery failure.

## Configuration

Add two optional fields to the existing `quota` config block in
`~/.pi/agent/settings.json`:

```json
{
  "quota": {
    "telegramBotToken": "123456:ABC-...",
    "telegramChatId": "987654321"
  }
}
```

- Both fields are required to enable the feature.
- If either is missing, the feature is silently disabled (no detection, no
  scheduling, no sends).
- `loadConfig()` already reads the `quota` block; the `QuotaConfig` interface
  gains `telegramBotToken?: string` and `telegramChatId?: string`.

## Reset detection

Maintain an in-memory map of the last-seen reset timestamp per provider, per
window:

```
lastSeenReset: {
  anthropic:      { fiveHour: Date | null, sevenDay: Date | null },
  "openai-codex": { fiveHour: Date | null, sevenDay: Date | null },
}
```

On every poll, after `updateState` records fresh values, evaluate each
provider/window:

- **First observation** (stored value is `null`): record the reset time, send
  nothing. This establishes the baseline.
- **Rollover**: the new reset time is *later* than the stored one → the window
  rolled over → send a Telegram message, then store the new reset time.
- **Unchanged or earlier**: keep the stored value, send nothing.

This detection is the single source of truth for "did it reset." Both the
10-minute poll and the scheduled reset timers funnel through it, so whichever
observes the forward jump first sends exactly one message and updates the
stored timestamp — the other will then see "unchanged" and stay quiet.

A window whose reset time is `null` (API omitted it) is treated like a baseline:
no timer, no notification.

## Scheduled reset timers

In addition to the steady 10-minute poll, after each successful poll the
extension (re)schedules a precise timer for each known reset timestamp:

- For each provider/window with a known reset `Date`, schedule a timer at
  `resetTime + 30s` (buffer that gives the upstream API a moment to reflect the
  new window).
- When a reset timer fires: run `pollQuotaStatus()` to fetch fresh data; the
  detection logic above then observes the forward jump and sends the message.
- Timers are cleared and rebuilt on every poll so that shifting reset times stay
  accurate. Up to 4 timers exist at once (2 providers × 2 windows).
- Skip scheduling when the reset time is in the past, or when a timer for the
  same timestamp is already scheduled.
- The 10-minute poll remains a safety net: if a timer is ever missed, the next
  poll still detects the rollover.

Net effect: the message fires ~30s–1min after the actual reset.

## Concurrency across pi instances

Each running pi instance loads its own copy of the extension and polls
independently. Telegram delivery is a shared external side effect, so without
coordination N instances would each send a message for the same reset (N
duplicates). Two on-disk artifacts coordinate them:

- **Notified record** — `~/.pi/agent/pi-quota-notified.json`: persistent shared
  memory of which reset has already been announced, keyed by provider and
  window, storing the announced reset timestamp (ms):

  ```json
  {
    "anthropic":      { "fiveHour": 1750000000000, "sevenDay": 1750500000000 },
    "openai-codex":   { "fiveHour": 1750000000000, "sevenDay": 1750500000000 }
  }
  ```

- **Lockfile** — a short-lived exclusive mutex guarding the read-check-send-mark
  sequence on the notified record. It is *not* a long-lived "master" role; it is
  acquired and released per reset event.

The in-memory `lastSeenReset` map (from the detection section) stays as a cheap
pre-filter so the common "nothing changed" poll never touches the lock or files;
the notified record is the source of truth for whether a message was sent.

### Send sequence (per detected rollover)

For a rollover `(provider, window, newResetTime)`:

1. Acquire the exclusive lock by creating the lockfile with the `wx` flag
   (fails if it already exists). If it exists but its mtime is older than the
   stale TTL, treat it as abandoned, remove it, and retry the create.
2. Read `pi-quota-notified.json`. If it already records a timestamp
   `>= newResetTime` for `(provider, window)` → release the lock and skip
   (another instance already delivered it).
3. Send the Telegram message **while still holding the lock**.
4. On HTTP success → write `notified[provider][window] = newResetTime` to the
   record → release the lock (delete the lockfile).
5. On failure → release the lock **without** marking, and `logError`. The next
   poll or reset timer retries, so transient errors never lose a notification.

### Guarantees

- **No concurrent duplicates** — the lock is held across the send, so two
  instances cannot both be in the send path for the same reset.
- **No lost messages** — the record is only written after a confirmed HTTP
  success; failures are retried on the next poll/timer.
- **No master / no failover** — the lock is per-event and short-lived; any
  instance exiting at any time is harmless.
- **Stale-lock safety** — the stale TTL is **60s**, comfortably above the 30s
  request timeout, so a legitimately slow send is never reclaimed mid-flight.
- **Residual risk (irreducible)** — if a process dies in the sub-millisecond
  window between Telegram confirming delivery and the record being written, the
  next instance may re-send once. Telegram's `sendMessage` has no idempotency
  key, so this cannot be fully eliminated.

## Message format & delivery

One message per window that reset, naming the window and showing both windows'
current state. Provider label uses the existing `PROVIDER_LABELS`
(`claude` / `codex`); the parenthetical reuses `formatResetTime`.

Example (5h window of Anthropic just reset):

```
claude 5h window reset
5h: 100% left (5h 0m)
7d: 89% left (1d 13h)
```

Delivery:

- POST to `https://api.telegram.org/bot<token>/sendMessage` with a JSON body
  `{ chat_id, text }`.
- Use the existing `REQUEST_TIMEOUT_MS` (30s) `AbortSignal.timeout` pattern.
- On any failure (non-2xx response or network/abort error), append to
  `~/.pi/agent/pi-quota.log` via the existing `logError`. Never throw into the
  poll loop.

## Lifecycle & edge cases

- **`session_start`**: clear the in-memory `lastSeenReset` map and all reset
  timers (existing state reset already runs here). The first poll establishes
  in-memory baselines silently; the on-disk notified record persists across
  sessions and is not cleared.
- **`session_shutdown`**: clear all reset timers alongside the existing
  `checkTimer`.
- **Feature disabled** (missing token/chatId): skip detection, scheduling, and
  sends entirely — identical to current behavior.
- **Resets while pi is closed**: the next session re-baselines silently; no
  retroactive notification. Accepted limitation (polling only happens while pi
  runs).
- **Codex reset credits / auto-redeem**: unrelated to this feature and left
  untouched.

## Testing

The repository does not include tests for this feature. `index.ts` remains
verified manually by running it in pi, consistent with its existing note.

## Out of scope

- Exhaustion / low-quota warnings (only resets are notified).
- Configurable thresholds or per-window enable/disable.
- Retroactive notification for resets that occur while pi is not running.
- Batching multiple windows into a single message.
