# pi-quota Implementation Plan

> **Status:** Implemented. This document records the structure of the shipped
> single-file extension. See `2026-06-13-pi-quota-design.md` for the full design
> and `README.md` for usage.

**Goal:** A pi extension that tracks Anthropic and OpenAI Codex subscription
quota by polling each provider's OAuth usage endpoint and sends Telegram
notifications when a quota window resets.

**Architecture:** Poll usage endpoints on a timer, refresh OAuth tokens from
`auth.json` when needed, track quota state in memory, render a widget for the
active provider, elect a single leader across pi instances, and have the leader
send Telegram messages and serve `/quota` bot commands.

**Tech Stack:** TypeScript, pi Extension API, Node.js `fs`/`path`/`os`,
`fetch()` for all HTTP.

---

## File Structure

```
pi-quota/
└── index.ts          # Entire extension: events, polling, OAuth refresh,
                      # leader election, Telegram, widget, commands
```

There is no separate `quota-tracker.ts`; everything lives in `index.ts`.

## Configuration

Read from `~/.pi/agent/settings.json` under the `quota` key:

```json
{
  "quota": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "987654321",
    "pollIntervalMs": 600000,
    "updatePollIntervalMs": 60000
  }
}
```

`pollIntervalMs` defaults to 600000 (minimum 60000). `updatePollIntervalMs`
defaults to 60000 (minimum 10000).

---

## Task 1: Config and helpers

- `loadConfig` reads and validates the `quota` block.
- `loadAuth` / `saveAuth` read and write `~/.pi/agent/auth.json`.
- `formatResetTime` renders a `Date` as `Nd Nh` / `Nh Nm` / `Nm`.
- `formatQuotaStatus` renders one compact line per provider, used by the widget,
  the `/quota` command, and Telegram.

## Task 2: OAuth token refresh

- `ensureAnthropicAccess` / `ensureOpenAIAccess` refresh the access token using
  the stored refresh token when it is missing or within 60s of expiry, write the
  updated record back to `auth.json`, and notify the user.

## Task 3: Quota polling

- `pollQuotaStatus` queries `api.anthropic.com/api/oauth/usage` and
  `chatgpt.com/backend-api/wham/usage`, maps each provider onto the common
  `QuotaState` shape (`5h` short window, `7d` long window), and stores it via
  `updateState`. OpenAI `reset_at` is Unix seconds (×1000).

## Task 4: Reset notifications

- `syncResetTimer` / `syncResetTimers` schedule one-shot `setTimeout`s per
  `provider:window`, rescheduling when reset timestamps change. Only the leader
  holds timers and sends the reset Telegram message.

## Task 5: Leader election

- A lock file `~/.pi/agent/pi-quota.lock` holds `{ pid, host, ts }`.
- `evaluateLeadership` renews ownership, creates the lock exclusively when
  absent, takes over a stale lease (`LEASE_STALE_FACTOR` × `updatePollIntervalMs`
  with no renewal, or dead pid on the same host), and otherwise becomes a
  follower. `becomeLeader` / `becomeFollower` start and clear reset timers.

## Task 6: Telegram and widget

- `sendTelegram` posts to the Bot API and returns success.
- `pollBotCommands` (leader only) reads `getUpdates`, advances the offset, and
  replies to `/quota` from the configured `chatId`.
- `updateWidget` shows the active provider's line when the model provider is
  `anthropic` or `openai-codex`; updated on `session_start`, `model_select`, and
  each poll.
- `/quota` command notifies the current status in pi.

## Task 7: Lifecycle

- `session_start` validates config, sets timers (`scheduleCheck`,
  `scheduleUpdates`), runs an initial poll and leadership evaluation, and shows
  the widget.
- `session_shutdown` clears all timers and removes the lock if owned.

---

## Testing

This extension deliberately has no automated tests. Its behaviour is dominated
by external HTTP APIs (Anthropic, OpenAI Codex, Telegram) and pi runtime events;
it is verified manually by running it in pi. Do not add a test suite here.

## Verification

```bash
cd ~/Projects/pi-quota && npx tsc --noEmit   # expect no type errors
```
