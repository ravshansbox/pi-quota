# pi-quota — Clock-Aligned Polling Design

## Overview

The pi-quota extension currently polls each provider on a relative schedule:
`setTimeout` for `pollIntervalMs` after the previous poll resolves. Polls
therefore drift based on the actual completion time of each poll, including
the cost of OAuth refresh and HTTP round-trips.

This change replaces that with an absolute, wall-clock-aligned schedule:
polls land on every 10-minute mark of the local hour (`HH:00, HH:10, HH:20,
HH:30, HH:40, HH:50`). The first poll of a session still runs immediately so
the widget is never empty; subsequent polls align to the next mark strictly
after the previous poll resolved.

The 10-minute cadence is no longer configurable. It is a fixed invariant of
the extension.

## Motivation

A relative schedule means that ten consecutive successful polls at the
default 600 s interval land on marks like `03:42:18, 03:52:21, 04:02:25, …`,
drifting arbitrarily across the hour. An absolute schedule makes the timing
of quota samples predictable, easier to correlate with provider-side events,
and easier to reason about when reading the `pi-quota.log` trace.

## Behaviour

### `session_start`

1. Clear any prior timer and reset in-session state (unchanged from today).
2. Run the immediate poll + auto-redeem + widget update (`refresh`),
   exactly as today. The widget is therefore populated as soon as the
   extension loads.
3. Compute `nextMark` = the next wall-clock instant where
   `minutes % 10 === 0`, strictly after the time the immediate poll
   resolved.
4. `setTimeout` for `nextMark - now` ms. On fire: poll + auto-redeem +
   widget update, then recompute `nextMark` from the post-poll time and
   re-arm.

### Steady state

Polls land on `00, 10, 20, 30, 40, 50` of every hour. Worked examples:

- Session starts at 03:42:30. Polls at 03:42:30, 03:50:00, 04:00:00, …
- Session starts at 03:50:00 exactly. Polls at 03:50:00, 04:00:00, 04:10:00, …
- Session starts at 03:59:55. Polls at 03:59:55, then at 04:00:00,
  04:10:00, …. The first interval can be arbitrarily short when the
  immediate poll resolves close to a mark; the schedule aligns from
  that mark onward.

### `session_shutdown`

Unchanged. The pending `setTimeout` is cleared.

## Configuration Changes

- **Remove** `pollIntervalMs` from `QuotaConfig`, from the session_start
  validation block, and the `MIN_POLL_INTERVAL_MS` and
  `DEFAULT_POLL_INTERVAL_MS` constants. The 10-minute cadence is a fixed
  invariant.
- **Keep** `codexResets.autoRedeem` and the `quota` config object as-is.
- **Keep** `loadConfig()` (other config fields may exist).
- **Settings.json**: an existing `pollIntervalMs` entry is silently
  ignored. No warning, no migration, no schema bump.
- **README**: drop the `pollIntervalMs` row from the configuration table
  and from the install-snippet example. Update the behaviour bullet from
  "every 10 minutes by default" to "at every 10-minute wall-clock mark
  (HH:00, HH:10, …); polls immediately on session start, then aligns to
  the next mark".

## Implementation Outline

A single new helper, plus the rewired `scheduleCheck`. All inside `index.ts`.

```ts
function nextMarkAfter(time: Date): Date {
  const next = new Date(time.getTime());
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  const bump = 10 - (minute % 10);
  next.setMinutes(minute + (bump === 0 ? 10 : bump));
  return next;
}
```

In `session_start`, after dropping the `pollIntervalMs` plumbing:

```ts
const scheduleCheck = () => {
  const next = nextMarkAfter(new Date());
  const delay = Math.max(0, next.getTime() - Date.now());
  checkTimer = setTimeout(async () => {
    await pollQuotaStatus();
    await tryAutoRedeemCodexReset();
    updateWidget();
    scheduleCheck();
  }, delay);
};

void refresh();
scheduleCheck();
```

`session_shutdown` is unchanged. No new files, no new dependencies. The
only types/constants touched are the removal of `pollIntervalMs`,
`MIN_POLL_INTERVAL_MS`, and `DEFAULT_POLL_INTERVAL_MS`; `QuotaConfig`
keeps `codexResets` only.

## Edge Cases

- **Slow poll crossing a mark.** A poll starting at 03:50:00 that takes
  15 s and finishes at 03:50:15 re-arms the timer at 03:50:15, so
  `nextMarkAfter` returns 04:00:00. The 04:00 fire happens normally. No
  double-fire, no overlap.
- **Poll longer than 10 min.** A single in-flight poll means `setTimeout`
  is re-armed only after it resolves, so the next mark is computed from
  the actual completion time. Worst case the schedule drifts by the poll
  duration, but two polls never run concurrently. This matches the
  existing single-`setTimeout` invariant.
- **Session start exactly on a mark.** The immediate poll runs and
  finishes at 03:50:00.x; `nextMarkAfter(03:50:00.x) = 04:00:00`. We do
  not double-poll at 04:00 — the timer for 04:00 fires 10 min after
  completion.
- **DST transitions.** `Date` arithmetic across a spring-forward or
  fall-back hour is well-defined in Node: `setMinutes(60)` on a
  non-existent local time rolls forward to the next valid instant, and
  `setMinutes(120)` on a duplicated fall-back hour picks the second
  occurrence. Both yield the correct `next` mark. No special handling.
- **System clock jumps.** `setTimeout` honours wall-clock deadlines in
  Node; a backward jump delays the next fire and a forward jump fires
  it early. Same behaviour as any wall-clock-driven scheduler; no worse
  than today.
- **Timer reset on `session_start` re-fire.** The existing
  `if (checkTimer) clearTimeout(checkTimer)` at the top of
  `session_start` is kept, so reloading the extension or starting a new
  session restarts cleanly.

## Out of Scope

- No test suite. The project's README explicitly says not to add one.
- No new public config. No new dependencies. No new files.
- No changes to `pollQuotaStatus`, OAuth refresh, Codex auto-redeem,
  widget rendering, or error logging.
- No timezone control. The schedule uses the user's local time, the same
  semantics as today's `new Date()`-based logic.
- No changes to the header comment in `index.ts`.

## Testing

Manual. Verify by:

1. Starting a session at a non-aligned time (e.g. 03:42:30) and
   confirming subsequent polls land on 03:50:00, 04:00:00, 04:10:00, …
2. Starting a session exactly on a 10-min mark (e.g. 03:50:00) and
   confirming the next poll lands on 04:00:00.
3. Forcing a slow poll (e.g. by pointing one provider at an
   unreachable host, exercising the 30 s timeout) and confirming the
   next fire still lands on the next mark after the slow poll resolved,
   with no concurrent polls.
4. Confirming that a stale `pollIntervalMs` in `settings.json` is
   silently ignored and does not affect the schedule.
