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
  formatTokens,
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

    await pollQuotaStatus(pi, states);

    const intervalMs = config.pollIntervalMs ?? 600000;
    pollTimer = setInterval(() => {
      pollQuotaStatus(pi, states);
      checkQuota(pi, states, config!);
    }, intervalMs);

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
      if (parsed.requestsRemaining !== undefined) existing.requestsRemaining = parsed.requestsRemaining;
      if (parsed.requestsReset !== undefined) existing.requestsReset = parsed.requestsReset;
      if (parsed.tokensRemaining !== undefined) existing.tokensRemaining = parsed.tokensRemaining;
      if (parsed.tokensReset !== undefined) existing.tokensReset = parsed.tokensReset;
      existing.lastUpdated = parsed.lastUpdated ?? new Date();
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
    if (parsed.requestsRemaining !== undefined) existing.requestsRemaining = parsed.requestsRemaining;
    if (parsed.requestsReset !== undefined) existing.requestsReset = parsed.requestsReset;
    if (parsed.tokensRemaining !== undefined) existing.tokensRemaining = parsed.tokensRemaining;
    if (parsed.tokensReset !== undefined) existing.tokensReset = parsed.tokensReset;
    existing.lastUpdated = parsed.lastUpdated ?? new Date();
  } else {
    states.push(parsed as QuotaState);
  }
}

async function checkQuota(_pi: ExtensionAPI, states: QuotaState[], config: QuotaConfig) {
  const now = new Date();

  for (const state of states) {
    const resetTime = state.requestsReset ?? state.tokensReset;

    if (!resetTime) continue;

    if (resetTime <= now) {
      const message = `🔄 Quota Reset\n\n${formatProviderStatus(state)}`;
      const sent = await sendTelegram(config, message);

      if (sent) {
        state.requestsReset = null;
        state.tokensReset = null;
      }
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

async function sendTelegram(config: QuotaConfig, text: string): Promise<boolean> {
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
      return false;
    }

    return true;
  } catch (error) {
    console.error(`pi-quota: Failed to send Telegram message:`, error);
    return false;
  }
}
