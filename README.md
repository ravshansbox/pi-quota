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
    "pollIntervalMs": 600000,
    "updatePollIntervalMs": 60000
  }
}
```

Run `pi update` to install.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID |
| `pollIntervalMs` | No | 600000 | Quota polling interval in milliseconds, minimum 60000 |
| `updatePollIntervalMs` | No | 60000 | Telegram command polling interval in milliseconds, minimum 10000 |

## Commands

- `/quota` (in pi) — show current quota status
- `/quota` (to the Telegram bot) — bot replies with the current quota report; only the configured `chatId` is answered

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints every 10 minutes by default
- Shows a widget below the prompt when the active provider is `anthropic` or `openai-codex`
- Reports use one compact line per provider, e.g. `openai-codex: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)`
- The `/quota` command and Telegram messages use this format; the widget omits the provider prefix since pi already shows the active provider
- Schedules one-shot timers for each known reset time and sends a Telegram message when a `5h` or `7d` window resets
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed and writes updated credentials back

## Multiple pi instances

Telegram allows only one consumer per bot token, and duplicate reset messages are undesirable, so pi-quota elects a single leader across all running instances:

- A lock file at `~/.pi/agent/pi-quota.lock` records the leader's `{ pid, host, ts }`.
- Only the leader sends Telegram messages, polls for `/quota` bot commands, and schedules reset notifications.
- Followers still poll usage and render their own widget, but send no Telegram traffic.
- The leader renews the lock on every `updatePollIntervalMs` tick. If the leader exits cleanly it removes the lock; if it crashes, a follower takes over once the lease goes stale (no renewal for `3 * updatePollIntervalMs`, or the leader's pid is no longer alive on the same host).
- Leader election is best-effort and assumes instances share one machine/home directory.

## Notes

- Reset notifications work while pi is running.
- Polling keeps the displayed quota fresh and resynchronises reset timers if the provider changes a reset timestamp.
- This project deliberately has no automated tests. It is a small single-file extension whose behaviour is dominated by external HTTP APIs (Anthropic, OpenAI Codex, Telegram); it is verified manually by running it in pi. Do not add a test suite here.
