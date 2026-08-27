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

The widget is shown whenever a `QuotaState` exists for the provider; no other configuration is required. OAuth credentials for Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`.

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints at every 10-minute wall-clock mark (`HH:00`, `HH:10`, `HH:20`, `HH:30`, `HH:40`, `HH:50`); polls immediately on session start, then aligns to the next mark
- Shows a single-line widget for the provider backing the **active model**, and only when quota data for that provider has been polled; switching models re-renders it immediately
- The line is compact and unlabelled, e.g. `7d 67% 3d13h, 5h 93% 1h29m`, where each window shows its remaining percentage followed by time until reset
- Available resets, when present, are appended as `2x 5h` (count, then time until the soonest expires)
- Both providers are still polled whenever their credentials exist, so quota is already fresh when the active model changes
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed, writes updated credentials back (re-reading the file first to avoid clobbering concurrent updates), and notifies on the first successful refresh per provider each session
- Appends poll and token-refresh errors to `~/.pi/agent/pi-quota.log`

## Notes

- Polling keeps the displayed quota fresh.
