# pi-quota — Design Spec

## Overview

A pi extension that tracks Anthropic and OpenAI API quota usage from response headers and sends Telegram notifications when quotas reset.

## Location

`~/Projects/pi-quota/`

## Structure

```
pi-quota/
├── index.ts          # Extension entry, events, polling, Telegram
└── quota-tracker.ts  # Parse headers, track state
```

## Configuration

All settings under `quota` key in `~/.pi/agent/settings.json`:

```json
{
  "quota": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "987654321",
    "pollIntervalMs": 600000
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID for notifications |
| `pollIntervalMs` | No | 600000 | Polling interval in ms (10 minutes) |

## Components

### 1. Header Parsing (`quota-tracker.ts`)

Parse rate-limit headers from API responses:

**Anthropic headers:**
- `anthropic-ratelimit-requests-remaining`
- `anthropic-ratelimit-requests-reset`
- `anthropic-ratelimit-tokens-remaining`
- `anthropic-ratelimit-tokens-reset`

**OpenAI headers:**
- `x-ratelimit-remaining-requests`
- `x-ratelimit-reset-requests`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-tokens`

### 2. State Tracking

```typescript
interface QuotaState {
  provider: "anthropic" | "openai";
  requestsRemaining: number | null;
  requestsReset: Date | null;
  tokensRemaining: number | null;
  tokensReset: Date | null;
  lastUpdated: Date;
}
```

Store in memory. Reconstruct from session entries on reload.

### 3. Polling

- On `session_start`, start background interval
- Default: every 10 minutes
- Make lightweight API call to refresh quota data
- Update state and schedule notifications

### 4. Telegram Notifications

Single `fetch()` call to Telegram Bot API:

```
POST https://api.telegram.org/bot<token>/sendMessage
{
  "chat_id": "<chatId>",
  "text": "🔄 Quota Reset\n\nAnthropic:\n• Requests: 50 remaining..."
}
```

### 5. Commands

- `/quota` — Display current quota status in pi

## Data Flow

```
API Response
    ↓
after_provider_response
    ↓
Parse rate-limit headers
    ↓
Update QuotaState
    ↓
Check if reset time arrived
    ↓
Send Telegram message
```

## Telegram Message Format

```
🔄 Quota Reset

Anthropic:
• Requests: 50 remaining (resets in 2h 15m)
• Tokens: 150K remaining (resets in 2h 15m)

OpenAI:
• Requests: 100 remaining (resets in 45m)
• Tokens: 500K remaining (resets in 45m)
```

## Dependencies

None. Uses only Node.js built-ins (`fetch`) and pi extension API.
