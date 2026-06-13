# pi-quota — Design Spec

## Overview

A pi extension that tracks Anthropic and OpenAI Codex subscription quota usage by
polling each provider's OAuth usage endpoint, renders a widget for the active
provider, and sends Telegram notifications when a quota window resets. When
multiple pi instances run on the same machine, a file-lock leader election
ensures only one instance sends Telegram traffic.

## Location

`~/Projects/pi-quota/`

## Structure

```
pi-quota/
└── index.ts          # Extension entry: events, polling, OAuth refresh,
                      # leader election, Telegram, widget, commands
```

The extension is a single file. There is no separate `quota-tracker.ts`.

## Configuration

All settings under the `quota` key in `~/.pi/agent/settings.json`:

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

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID for notifications |
| `pollIntervalMs` | No | 600000 | Quota polling interval in ms, minimum 60000 |
| `updatePollIntervalMs` | No | 60000 | Telegram command / leadership tick in ms, minimum 10000 |

## Components

### 1. Quota Polling

On `session_start` and then every `pollIntervalMs`, `pollQuotaStatus` reads
OAuth credentials from `~/.pi/agent/auth.json`, refreshes access tokens when
needed, and queries each provider's usage endpoint:

**Anthropic** — `GET https://api.anthropic.com/api/oauth/usage`
with `Authorization: Bearer <access>` and the `anthropic-beta`
`claude-code-20250219,oauth-2025-04-20` header. Response fields used:
`five_hour.utilization`, `five_hour.resets_at`, `seven_day.utilization`,
`seven_day.resets_at`.

**OpenAI Codex** — `GET https://chatgpt.com/backend-api/wham/usage`
with `Authorization: Bearer <access>`. Response fields used:
`rate_limit.primary_window.used_percent`, `primary_window.reset_at`,
`rate_limit.secondary_window.used_percent`, `secondary_window.reset_at`.
OpenAI `reset_at` values are Unix seconds and are multiplied by 1000.

Remaining percentage is computed as `round(100 - utilization)` (Anthropic) or
`round(100 - used_percent)` (OpenAI). For presentation both providers are mapped
onto a common two-window shape: a short window labelled `5h` and a long window
labelled `7d`.

### 2. OAuth Token Refresh

Before each usage call, `ensureAnthropicAccess` / `ensureOpenAIAccess` check the
stored token's `expires` timestamp. If it is within 60 seconds of expiry (or
missing), they exchange the stored `refresh` token for a new access token, write
the updated record back to `auth.json`, and notify the user. Refresh failures
log an error and fall back to the existing record.

### 3. State Tracking

```typescript
interface QuotaState {
  provider: "anthropic" | "openai";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  lastUpdated: Date;
}
```

State is held in memory for the lifetime of the session and refreshed on each
poll. There is one `QuotaState` per provider.

### 4. Reset Notifications

For each known reset time, the leader schedules a one-shot `setTimeout`
(`syncResetTimer`). When a `5h` or `7d` window resets, the leader sends a
Telegram message containing the current status for that provider. Timers are
keyed by `provider:window` and rescheduled when the provider reports a new reset
timestamp. Only the leader holds reset timers; followers clear theirs.

### 5. Leader Election

A lock file at `~/.pi/agent/pi-quota.lock` records `{ pid, host, ts }`.
On every `updatePollIntervalMs` tick, `evaluateLeadership` runs:

- If the lock is owned by this process, renew its timestamp and remain leader.
- If there is no lock, attempt an exclusive create (`wx`); success becomes leader.
- If the lock is stale — no renewal for `LEASE_STALE_FACTOR` (3) ×
  `updatePollIntervalMs`, or the recorded pid is no longer alive on the same
  host — overwrite it and re-read to confirm ownership.
- Otherwise become a follower.

Only the leader polls Telegram for `/quota` commands, schedules reset timers, and
sends messages. Followers still poll usage and render their own widget. On clean
shutdown the leader removes the lock. Election is best-effort and assumes
instances share one machine and home directory.

### 6. Telegram

`sendTelegram` issues a single `POST` to the Bot API `sendMessage` method and
returns whether it succeeded. `pollBotCommands` (leader only) calls `getUpdates`
with `timeout=0`, advances the update offset, and replies to `/quota` messages
that originate from the configured `chatId`.

### 7. Widget and Commands

- A widget is shown below the prompt when the active model provider is
  `anthropic` or `openai-codex`, displaying that provider's status line. It is
  updated on `session_start`, `model_select`, and each poll.
- `/quota` (in pi) notifies the current status for all tracked providers.

## Output Format

One compact line per provider, e.g.:

```
openai-codex: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)
```

The same `formatQuotaStatus` output is reused for the widget, the `/quota`
command, and Telegram messages.

## Dependencies

None beyond Node.js built-ins (`fetch`, `fs`, `path`, `os`) and the pi
extension API.

## Testing

This extension deliberately has no automated tests. Its behaviour is dominated
by external HTTP APIs (Anthropic, OpenAI Codex, Telegram) and pi runtime events;
it is verified manually by running it in pi.
