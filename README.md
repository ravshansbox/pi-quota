# pi-quota

Pi extension that tracks Anthropic and OpenAI API quota usage and sends Telegram notifications when quotas reset.

## Installation

1. Copy `index.ts` and `quota-tracker.ts` to `~/.pi/agent/extensions/pi-quota/`

2. Add to `~/.pi/agent/settings.json`:

```json
{
  "quota": {
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "YOUR_TELEGRAM_CHAT_ID"
  }
}
```

3. Restart pi or run `/reload`

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID |
| `pollIntervalMs` | No | `600000` | Interval in ms between reset-time checks (minimum 60000) |

## Commands

- `/quota` — Show current quota status
- `/quota-test` — Test Telegram notification

## How It Works

1. Extracts rate-limit headers passively from Anthropic/OpenAI API responses during normal usage — no API calls made just for headers
2. A periodic timer checks whether any tracked reset times have arrived (interval configurable via `pollIntervalMs`, default 10 minutes)
3. When a reset time is reached, sends a Telegram notification with the quota status

## Environment Variables

Requires API keys to be set:
- `ANTHROPIC_API_KEY` for Anthropic quota tracking
- `OPENAI_API_KEY` for OpenAI quota tracking
