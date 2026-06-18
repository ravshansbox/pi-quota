# pi-quota Implementation Plan

> **Status:** Implemented. This document records the structure of the shipped
> single-file extension. See `2026-06-13-pi-quota-design.md` for the full design
> and `README.md` for usage.

**Goal:** A pi extension that tracks Anthropic and OpenAI Codex subscription
quota by polling each provider's OAuth usage endpoint and renders a widget
below the prompt.

**Architecture:** Poll usage endpoints on a timer, refresh OAuth tokens from
`auth.json` when needed, track quota state in memory, render a widget for
each provider with stored credentials.

**Tech Stack:** TypeScript, pi Extension API, Node.js `fs`/`path`/`os`,
`fetch()` for all HTTP.

---

## File Structure

```
pi-quota/
└── index.ts          # Entire extension: events, polling, OAuth refresh, widget
```

There is no separate `quota-tracker.ts`; everything lives in `index.ts`.

## Configuration

Read from `~/.pi/agent/settings.json` under the `quota` key:

```json
{
  "quota": {
    "pollIntervalMs": 600000
  }
}
```

`pollIntervalMs` defaults to 600000 (minimum 60000). OAuth credentials for
Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`; missing
credentials simply mean that provider is not polled.

---

## Task 1: Config and helpers

- `loadConfig` reads and validates the `quota` block.
- `loadAuth` / `saveAuth` read and write `~/.pi/agent/auth.json`.
- `formatResetTime` renders a `Date` as `Nd Nh` / `Nh Nm` / `Nm`.
- `formatQuotaStatus` renders one compact line per provider, used by the widget.

## Task 2: OAuth token refresh

- `ensureAnthropicAccess` / `ensureOpenAIAccess` refresh the access token using
  the stored refresh token when it is missing or within 60s of expiry, write the
  updated record back to `auth.json`, and notify the user.

## Task 3: Quota polling

- `pollQuotaStatus` queries `api.anthropic.com/api/oauth/usage` and
  `chatgpt.com/backend-api/wham/usage`, maps each provider onto the common
  `QuotaState` shape (`5h` short window, `7d` long window), and stores it via
  `updateState`. OpenAI `reset_at` is Unix seconds (×1000).

## Task 4: Lifecycle

- `session_start` validates config, sets the polling timer (`scheduleCheck`),
  runs an initial poll, and shows the widget.
- `session_shutdown` clears the polling timer.

---

## Testing

This extension deliberately has no automated tests. Its behaviour is dominated
by external HTTP APIs (Anthropic, OpenAI Codex) and pi runtime events; it is
verified manually by running it in pi. Do not add a test suite here.

## Verification

```bash
cd ~/Projects/pi-quota && npx tsc --noEmit   # expect no type errors
```
