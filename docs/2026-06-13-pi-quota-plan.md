# pi-quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi extension that tracks Anthropic and OpenAI API quota usage from response headers and sends Telegram notifications when quotas reset.

**Architecture:** Hook `after_provider_response` to parse rate-limit headers, track quota state in memory, run background polling timer, send Telegram messages via `fetch()`.

**Tech Stack:** TypeScript, pi Extension API, Node.js `fs`/`path` for config, `fetch()` for Telegram

---

## File Structure

```
pi-quota/
├── index.ts          # Extension entry, event handlers, polling, Telegram, commands
└── quota-tracker.ts  # Quota state tracking, header parsing
```

## Configuration

Read from `~/.pi/agent/settings.json` under `quota` key:

```json
{
  "quota": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "987654321",
    "pollIntervalMs": 600000
  }
}
```

---

### Task 1: Project Setup

**Files:**
- Create: `~/Projects/pi-quota/index.ts`
- Create: `~/Projects/pi-quota/quota-tracker.ts`

- [ ] **Step 1: Create quota-tracker.ts with types and header parsing**

```typescript
export interface QuotaConfig {
  botToken: string;
  chatId: string;
  pollIntervalMs: number;
}

export interface QuotaState {
  provider: "anthropic" | "openai";
  requestsRemaining: number | null;
  requestsReset: Date | null;
  tokensRemaining: number | null;
  tokensReset: Date | null;
  lastUpdated: Date;
}

export function parseAnthropicHeaders(headers: Record<string, string>): Partial<QuotaState> | null {
  const remaining = headers["anthropic-ratelimit-requests-remaining"];
  const reset = headers["anthropic-ratelimit-requests-reset"];
  const tokensRemaining = headers["anthropic-ratelimit-tokens-remaining"];
  const tokensReset = headers["anthropic-ratelimit-tokens-reset"];

  if (!remaining && !tokensRemaining) return null;

  return {
    provider: "anthropic",
    requestsRemaining: remaining ? parseInt(remaining, 10) : null,
    requestsReset: reset ? new Date(reset) : null,
    tokensRemaining: tokensRemaining ? parseInt(tokensRemaining, 10) : null,
    tokensReset: tokensReset ? new Date(tokensReset) : null,
    lastUpdated: new Date(),
  };
}

export function parseOpenAIHeaders(headers: Record<string, string>): Partial<QuotaState> | null {
  const remaining = headers["x-ratelimit-remaining-requests"];
  const reset = headers["x-ratelimit-reset-requests"];
  const tokensRemaining = headers["x-ratelimit-remaining-tokens"];
  const tokensReset = headers["x-ratelimit-reset-tokens"];

  if (!remaining && !tokensRemaining) return null;

  return {
    provider: "openai",
    requestsRemaining: remaining ? parseInt(remaining, 10) : null,
    requestsReset: reset ? new Date(reset) : null,
    tokensRemaining: tokensRemaining ? parseInt(tokensRemaining, 10) : null,
    tokensReset: tokensReset ? new Date(tokensReset) : null,
    lastUpdated: new Date(),
  };
}

export function formatQuotaStatus(states: QuotaState[]): string {
  if (states.length === 0) return "No quota data collected yet.";

  const lines: string[] = ["📊 Quota Status", ""];

  for (const state of states) {
    const provider = state.provider.charAt(0).toUpperCase() + state.provider.slice(1);
    lines.push(`${provider}:`);

    if (state.requestsRemaining !== null) {
      const resetStr = state.requestsReset ? formatResetTime(state.requestsReset) : "unknown";
      lines.push(`• Requests: ${state.requestsRemaining} remaining (resets ${resetStr})`);
    }

    if (state.tokensRemaining !== null) {
      const resetStr = state.tokensReset ? formatResetTime(state.tokensReset) : "unknown";
      lines.push(`• Tokens: ${formatTokens(state.tokensRemaining)} remaining (resets ${resetStr})`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatResetTime(reset: Date): string {
  const now = new Date();
  const diff = reset.getTime() - now.getTime();

  if (diff <= 0) return "now";

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
  return tokens.toString();
}
```

- [ ] **Step 2: Create index.ts with extension skeleton**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type QuotaConfig,
  type QuotaState,
  parseAnthropicHeaders,
  parseOpenAIHeaders,
  formatQuotaStatus,
} from "./quota-tracker";

function loadConfig(): QuotaConfig | null {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    return settings.quota ?? null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const states: QuotaState[] = [];
  let config: QuotaConfig | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();

    if (!config) {
      ctx.ui.notify("pi-quota: No config found in settings.json", "warning");
      return;
    }

    if (!config.botToken || !config.chatId) {
      ctx.ui.notify("pi-quota: botToken and chatId required", "warning");
      return;
    }

    const intervalMs = config.pollIntervalMs ?? 600000;
    pollTimer = setInterval(() => checkQuota(pi, states, config!), intervalMs);
    ctx.ui.notify("pi-quota: tracking started", "info");
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const headers = event.headers as Record<string, string>;
    const provider = detectProvider(event);

    if (!provider) return;

    let parsed: Partial<QuotaState> | null = null;

    if (provider === "anthropic") {
      parsed = parseAnthropicHeaders(headers);
    } else if (provider === "openai") {
      parsed = parseOpenAIHeaders(headers);
    }

    if (!parsed) return;

    const existing = states.find((s) => s.provider === provider);
    if (existing) {
      Object.assign(existing, parsed);
    } else {
      states.push(parsed as QuotaState);
    }
  });

  pi.registerCommand("quota", {
    description: "Show current quota status",
    handler: async (_args, ctx) => {
      const status = formatQuotaStatus(states);
      ctx.ui.notify(status, "info");
    },
  });
}

function detectProvider(event: { headers: Record<string, string> }): "anthropic" | "openai" | null {
  const headers = event.headers;
  if (headers["anthropic-ratelimit-requests-remaining"]) return "anthropic";
  if (headers["x-ratelimit-remaining-requests"]) return "openai";
  return null;
}

async function checkQuota(pi: ExtensionAPI, states: QuotaState[], config: QuotaConfig) {
  for (const state of states) {
    const now = new Date();
    const resetTime = state.requestsReset ?? state.tokensReset;

    if (resetTime && resetTime <= now) {
      await sendTelegram(config, formatQuotaStatus([state]));
    }
  }
}

async function sendTelegram(config: QuotaConfig, text: string) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
    }),
  });
}
```

- [ ] **Step 3: Verify extension loads without errors**

Run: `cd ~/Projects/pi-quota && npx tsc --noEmit index.ts quota-tracker.ts`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/pi-quota
git init
git add .
git commit -m "feat: initial pi-quota extension"
```

---

### Task 2: Telegram Notification Logic

**Files:**
- Modify: `~/Projects/pi-quota/index.ts`

- [ ] **Step 1: Add reset detection and notification sending**

Update `checkQuota` function in `index.ts`:

```typescript
async function checkQuota(pi: ExtensionAPI, states: QuotaState[], config: QuotaConfig) {
  const now = new Date();

  for (const state of states) {
    const resetTime = state.requestsReset ?? state.tokensReset;

    if (!resetTime) continue;

    if (resetTime <= now) {
      const message = `🔄 Quota Reset\n\n${formatProviderStatus(state)}`;
      await sendTelegram(config, message);

      state.requestsReset = null;
      state.tokensReset = null;
    }
  }
}

function formatProviderStatus(state: QuotaState): string {
  const provider = state.provider.charAt(0).toUpperCase() + state.provider.slice(1);
  const lines: string[] = [`${provider}:`];

  if (state.requestsRemaining !== null) {
    lines.push(`• Requests: ${state.requestsRemaining} remaining`);
  }

  if (state.tokensRemaining !== null) {
    lines.push(`• Tokens: ${formatTokens(state.tokensRemaining)} remaining`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 2: Add error handling for Telegram API**

Update `sendTelegram` function:

```typescript
async function sendTelegram(config: QuotaConfig, text: string) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
      }),
    });

    if (!response.ok) {
      console.error(`pi-quota: Telegram API error: ${response.status}`);
    }
  } catch (error) {
    console.error(`pi-quota: Failed to send Telegram message:`, error);
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/pi-quota
git add .
git commit -m "feat: add Telegram notification with reset detection"
```

---

### Task 3: Polling for Quota Status

**Files:**
- Modify: `~/Projects/pi-quota/index.ts`

- [ ] **Step 1: Add API polling function**

Add to `index.ts`:

```typescript
async function pollQuotaStatus(pi: ExtensionAPI, states: QuotaState[]) {
  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (anthropicKey) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const headers = Object.fromEntries(response.headers.entries());
      const parsed = parseAnthropicHeaders(headers);

      if (parsed) {
        updateState(states, parsed);
      }
    }

    if (openaiKey) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const headers = Object.fromEntries(response.headers.entries());
      const parsed = parseOpenAIHeaders(headers);

      if (parsed) {
        updateState(states, parsed);
      }
    }
  } catch (error) {
    console.error("pi-quota: Poll error:", error);
  }
}

function updateState(states: QuotaState[], parsed: Partial<QuotaState>) {
  const existing = states.find((s) => s.provider === parsed.provider);
  if (existing) {
    Object.assign(existing, parsed);
  } else {
    states.push(parsed as QuotaState);
  }
}
```

- [ ] **Step 2: Update session_start to call polling immediately and on interval**

Update `session_start` handler:

```typescript
pi.on("session_start", async (_event, ctx) => {
  config = loadConfig();

  if (!config) {
    ctx.ui.notify("pi-quota: No config found in settings.json", "warning");
    return;
  }

  if (!config.botToken || !config.chatId) {
    ctx.ui.notify("pi-quota: botToken and chatId required", "warning");
    return;
  }

  await pollQuotaStatus(pi, states);

  const intervalMs = config.pollIntervalMs ?? 600000;
  pollTimer = setInterval(() => {
    pollQuotaStatus(pi, states);
    checkQuota(pi, states, config!);
  }, intervalMs);

  ctx.ui.notify("pi-quota: tracking started", "info");
});
```

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/pi-quota
git add .
git commit -m "feat: add API polling for quota status"
```

---

### Task 4: Polish and Edge Cases

**Files:**
- Modify: `~/Projects/pi-quota/index.ts`
- Modify: `~/Projects/pi-quota/quota-tracker.ts`

- [ ] **Step 1: Add /quota-test command to test Telegram**

Add to `index.ts`:

```typescript
pi.registerCommand("quota-test", {
  description: "Test Telegram notification",
  handler: async (_args, ctx) => {
    if (!config) {
      ctx.ui.notify("pi-quota: No config found", "error");
      return;
    }

    await sendTelegram(config, "🧪 pi-quota test message");
    ctx.ui.notify("Test message sent to Telegram", "info");
  },
});
```

- [ ] **Step 2: Add config validation on startup**

Update the config check in `session_start`:

```typescript
if (!config.botToken || !config.chatId) {
  ctx.ui.notify("pi-quota: botToken and chatId required in settings.json", "warning");
  return;
}

if (typeof config.botToken !== "string" || typeof config.chatId !== "string") {
  ctx.ui.notify("pi-quota: botToken and chatId must be strings", "error");
  return;
}

if (config.pollIntervalMs !== undefined && (typeof config.pollIntervalMs !== "number" || config.pollIntervalMs < 60000)) {
  ctx.ui.notify("pi-quota: pollIntervalMs must be >= 60000 (1 minute)", "error");
  return;
}
```

- [ ] **Step 3: Add initial quota status to /quota command**

Update `/quota` handler:

```typescript
pi.registerCommand("quota", {
  description: "Show current quota status",
  handler: async (_args, ctx) => {
    if (states.length === 0) {
      ctx.ui.notify("No quota data collected yet. Waiting for API responses...", "info");
      return;
    }

    const status = formatQuotaStatus(states);
    ctx.ui.notify(status, "info");
  },
});
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/pi-quota
git add .
git commit -m "feat: add /quota-test command and config validation"
```

---

### Task 5: Documentation

**Files:**
- Create: `~/Projects/pi-quota/README.md`

- [ ] **Step 1: Create README.md**

```markdown
# pi-quota

Pi extension that tracks Anthropic and OpenAI API quota usage and sends Telegram notifications when quotas reset.

## Installation

1. Copy `index.ts` and `quota-tracker.ts` to `~/.pi/agent/extensions/pi-quota/`

2. Add to `~/.pi/agent/settings.json`:

```json
{
  "quota": {
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "YOUR_TELEGRAM_CHAT_ID",
    "pollIntervalMs": 600000
  }
}
```

3. Restart pi or run `/reload`

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot API token |
| `chatId` | Yes | — | Telegram chat ID |
| `pollIntervalMs` | No | 600000 | Polling interval (ms) |

## Commands

- `/quota` — Show current quota status
- `/quota-test` — Test Telegram notification

## How It Works

1. Parses rate-limit headers from Anthropic/OpenAI API responses
2. Polls APIs every 10 minutes to refresh quota data
3. Sends Telegram message when quota reset time arrives

## Environment Variables

Requires API keys to be set:
- `ANTHROPIC_API_KEY` for Anthropic quota tracking
- `OPENAI_API_KEY` for OpenAI quota tracking
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/pi-quota
git add .
git commit -m "docs: add README.md"
```

---

### Task 6: Final Review and Testing

- [ ] **Step 1: Review all files for consistency**

Check that:
- All imports are correct
- Function signatures match between files
- No placeholder text remains

- [ ] **Step 2: Test extension loads**

Run: `pi -e ~/Projects/pi-quota/index.ts`
Expected: No errors on startup

- [ ] **Step 3: Test /quota command**

Type `/quota` in pi
Expected: Shows "No quota data collected yet" message

- [ ] **Step 4: Final commit**

```bash
cd ~/Projects/pi-quota
git add .
git commit -m "chore: final review and cleanup"
```
