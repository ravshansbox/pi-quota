# pi-quota — Design Spec

## Overview

A pi extension that tracks Anthropic and OpenAI Codex subscription quota usage by
polling each provider's OAuth usage endpoint, and renders a widget for each
provider that has a stored OAuth credential.

## Location

`~/Projects/pi-quota/`

## Structure

```
pi-quota/
└── index.ts          # Extension entry: events, polling, OAuth refresh, widget
```

The extension is a single file. There is no separate `quota-tracker.ts`.

## Configuration

All settings under the `quota` key in `~/.pi/agent/settings.json`:

```json
{
  "quota": {
    "pollIntervalMs": 600000
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `pollIntervalMs` | No | 600000 | Quota polling interval in ms, minimum 60000 |

OAuth credentials for Anthropic and OpenAI Codex are read from
`~/.pi/agent/auth.json`. Neither provider is required: a missing credential just
means that provider is not polled and not shown in the widget.

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
  provider: "anthropic" | "openai-codex";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  lastUpdated: Date;
}
```

State is held in memory for the lifetime of the session and refreshed on each
poll. There is one `QuotaState` per provider.

### 4. Widget

`updateWidget` sets (or clears) a pi widget named `pi-quota` for every tracked
provider. It runs on `session_start` and after each poll. The widget renders
each provider's compact status line (see Output Format), prefixed with the
short provider label (`claude` for Anthropic, `codex` for OpenAI Codex).

## Output Format

One compact line per provider, e.g. `claude: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)` for Anthropic and `codex: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)` for OpenAI Codex. Each line is prefixed with the short provider label. The widget builds its output via the `buildWidgetLines` helper.

## Dependencies

None beyond Node.js built-ins (`fetch`, `fs`, `path`, `os`) and the pi
extension API. Poll and token-refresh errors are appended to
`~/.pi/agent/pi-quota.log`.

## Testing

This extension deliberately has no automated tests. Its behaviour is dominated
by external HTTP APIs (Anthropic, OpenAI Codex) and pi runtime events; it is
verified manually by running it in pi.
