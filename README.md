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

## Commands

- `/quota` — Show current quota status
- `/quota-test` — Test Telegram notification

## How It Works

1. Intercepts rate-limit headers from Anthropic/OpenAI API responses during normal usage
2. Tracks quota resets passively — no background polling required
3. Schedules Telegram notifications to fire when quota reset times arrive

## Environment Variables

Requires API keys to be set:
- `ANTHROPIC_API_KEY` for Anthropic quota tracking
- `OPENAI_API_KEY` for OpenAI quota tracking
