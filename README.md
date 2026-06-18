# pi-quota

Pi extension that tracks Anthropic and OpenAI Codex quota usage and renders a widget below the prompt for either provider.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/ravshansbox/pi-quota"
  ],
  "quota": {
    "pollIntervalMs": 600000
  }
}
```

Run `pi update` to install.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `pollIntervalMs` | No | 600000 | Quota polling interval in milliseconds, minimum 60000 |

The widget is shown whenever a `QuotaState` exists for the provider; no other configuration is required. OAuth credentials for Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`.

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints every 10 minutes by default
- Shows a widget below the prompt when the active provider is `anthropic` or `openai-codex`
- Reports use one compact line per provider, e.g. `codex: 7d: 89% left (1d 13h), 5h: 30% left (4h 39m)`; the widget omits the provider prefix since pi already shows the active provider
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed and writes updated credentials back

## Notes

- Polling keeps the displayed quota fresh.
- This project deliberately has no automated tests. It is a small single-file extension whose behaviour is dominated by external HTTP APIs (Anthropic, OpenAI Codex); it is verified manually by running it in pi. Do not add a test suite here.
