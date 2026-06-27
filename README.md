# pi-quota

Pi extension that tracks Anthropic and OpenAI Codex quota usage and renders a quota widget for either provider.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/ravshansbox/pi-quota"
  ]
}
```

Run `pi update` to install.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `quota.telegramBotToken` | No | — | Telegram bot token. Required (with `telegramChatId`) to enable reset notifications. |
| `quota.telegramChatId` | No | — | Telegram chat ID that receives reset notifications. |

If both `quota.telegramBotToken` and `quota.telegramChatId` are set in `~/.pi/agent/settings.json`, the extension sends a Telegram message whenever a 5-hour or 7-day window resets. If either is missing, notifications are disabled and behavior is unchanged. The 10-minute polling cadence is fixed.

```json
{
  "quota": {
    "telegramBotToken": "123456:ABC-...",
    "telegramChatId": "987654321"
  }
}
```

The widget is shown whenever a `QuotaState` exists for the provider; no other configuration is required. OAuth credentials for Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`.

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints at every 10-minute wall-clock mark (`HH:00`, `HH:10`, `HH:20`, `HH:30`, `HH:40`, `HH:50`); polls immediately on session start, then aligns to the next mark
- Shows a quota widget when the active provider is `anthropic` or `openai-codex`
- Reports use one compact line per provider, e.g. `claude: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)` for Anthropic and `codex: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)` for OpenAI Codex; each line is prefixed with the short provider label
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed, writes updated credentials back (re-reading the file first to avoid clobbering concurrent updates), and notifies on the first successful refresh per provider each session
- Appends poll and token-refresh errors to `~/.pi/agent/pi-quota.log`
- When Telegram is configured, sends a message whenever a 5h or 7d window resets (one message per window), naming the window that reset and showing both windows' current state, e.g. `claude 5h window reset\n5h: 100% left (5h 0m)\n7d: 89% left (1d 13h)`
- Fires near the actual reset time via a scheduled timer (~30s buffer), with the 10-minute poll as a safety net
- Deduplicates notifications across multiple pi instances using `~/.pi/agent/pi-quota-notified.json` guarded by a short-lived lockfile; the message is sent while the lock is held and the record is written only after a confirmed send, so concurrent instances never send duplicates and transient failures are retried

## Notes

- Polling keeps the displayed quota fresh.
