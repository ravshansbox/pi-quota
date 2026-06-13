# pi-quota

Pi extension that tracks Anthropic and OpenAI Codex quota usage and sends Telegram notifications when quotas reset.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/ravshansbox/pi-quota"
  ],
  "quota": {
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "YOUR_TELEGRAM_CHAT_ID",
    "pollIntervalMs": 600000
  }
}
```

Run `pi update` to install.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID |
| `pollIntervalMs` | No | 600000 | Polling interval (ms, minimum 60000) |

## Commands

- `/quota` — Show current quota status with progress bars

## How It Works

1. Polls Anthropic and OpenAI Codex usage APIs every 10 minutes using OAuth tokens from `~/.pi/agent/auth.json`
2. Displays 5-hour and weekly quota usage with progress bars
3. Sends Telegram notification when a quota window resets

## Output Example

```
anthropic:
  week [████████████████████] 100% (1d 13h)
  5h   [████████░░░░░░░░░░░░] 40% (23m)
```
