# pi-quota

Pi extension that tracks Anthropic and OpenAI Codex quota usage and sends Telegram notifications when quota windows reset.

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
| `pollIntervalMs` | No | 600000 | Polling interval in milliseconds, minimum 60000 |

## Commands

- `/quota` — show current quota status

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints every 10 minutes by default
- Shows a widget below the prompt when the active provider is `anthropic` or `openai-codex`
- Widget format: `7d: 89% left (1d 13h), 5h: 30% left (4h 39m)`
- `/quota` shows both windows with bars
- Schedules one-shot timers for each known reset time and sends a Telegram message when a `5h` or `7d` window resets
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed and writes updated credentials back

## Output example

```text
anthropic:
  7d [████████████████████] 100% (1d 13h)
  5h [████████░░░░░░░░░░░░] 40% (23m)
```

## Notes

- Reset notifications work while pi is running.
- Polling keeps the displayed quota fresh and resynchronises reset timers if the provider changes a reset timestamp.
