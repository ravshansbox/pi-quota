# pi-quota

Anthropic and OpenAI Codex quota status extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-quota
```

## Usage

Pi loads the extension from `./index.ts` and shows the remaining quota for the provider backing the active model in the footer status line.

- Polls Anthropic and OpenAI Codex usage endpoints at every 10-minute wall-clock mark (`HH:00`, `HH:10`, `HH:20`, `HH:30`, `HH:40`, `HH:50`); polls immediately on session start, then aligns to the next mark
- Shows a footer status for the provider backing the **active model**, and only when quota data for that provider has been polled; switching models re-renders it immediately
- The status shares the footer line with other extensions, so it uses no extra terminal row
- The text stays compact, e.g. `93% 1h29m · 67% 3d13h`, where the 5-hour window comes first and the 7-day window second, and each window shows its remaining percentage followed by time until reset
- Available resets, when present, are appended as `· 2x 5h` (count, then time until the soonest expires)
- Both providers are still polled whenever their credentials exist, so quota is already fresh when the active model changes
- Refreshes Anthropic and OpenAI Codex OAuth access tokens from `~/.pi/agent/auth.json` when needed, writes updated credentials back (re-reading the file first to avoid clobbering concurrent updates), and notifies on the first successful refresh per provider each session
- Appends poll and token-refresh errors to `~/.pi/agent/pi-quota.log`

## Configuration

No configuration is required. OAuth credentials for Anthropic and OpenAI Codex are read from `~/.pi/agent/auth.json`.

## Development

```bash
npm install
npm run check
```
