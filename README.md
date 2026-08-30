# pi-quota

Pi extension that tracks Anthropic and OpenAI Codex quota usage and shows quota in the footer status line for either provider.

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

The status is shown whenever a `QuotaState` exists for the provider; no other configuration is required. OAuth credentials for Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`.

## Behaviour

- Polls Anthropic and OpenAI Codex usage endpoints at every 10-minute wall-clock mark (`HH:00`, `HH:10`, `HH:20`, `HH:30`, `HH:40`, `HH:50`); polls immediately on session start, then aligns to the next mark
- Shows a footer status for the provider backing the **active model**, and only when quota data for that provider has been polled; switching models re-renders it immediately
- The status shares the footer line with other extensions, so it uses no extra terminal row
- The text starts with the provider label (`Claude` or `Codex`) and stays compact, e.g. `Claude: 93% 1h29m | 67% 3d13h`, where the 5-hour window comes first and the 7-day window second, and each window shows its remaining percentage followed by time until reset
- Available resets, when present, are appended as `| 2x 5h` (count, then time until the soonest expires)
- Both providers are still polled whenever their credentials exist, so quota is already fresh when the active model changes
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed, writes updated credentials back (re-reading the file first to avoid clobbering concurrent updates), and notifies on the first successful refresh per provider each session
- Appends poll and token-refresh errors to `~/.pi/agent/pi-quota.log`

## Notes

- Polling keeps the displayed quota fresh.
