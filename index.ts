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
  let checkTimer: ReturnType<typeof setTimeout> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    states.length = 0;
    config = loadConfig();

    if (!config) {
      ctx.ui.notify("pi-quota: No config found in settings.json", "warning");
      return;
    }

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

    const intervalMs = config.pollIntervalMs ?? 600000;

    const scheduleCheck = () => {
      checkTimer = setTimeout(async () => {
        await pollQuotaStatus(states);
        await checkQuota(states, config!);
        scheduleCheck();
      }, intervalMs);
    };

    await pollQuotaStatus(states);
    scheduleCheck();
    ctx.ui.notify("pi-quota: tracking started", "info");
  });

  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
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
      if (states.length === 0) {
        ctx.ui.notify("No quota data collected yet. Waiting for API responses...", "info");
        return;
      }

      const status = formatQuotaStatus(states);
      ctx.ui.notify(status, "info");
    },
  });

  pi.registerCommand("quota-test", {
    description: "Test Telegram notification",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify("pi-quota: No config found", "error");
        return;
      }

      const sent = await sendTelegram(config, "🧪 pi-quota test message");
      ctx.ui.notify(sent ? "Test message sent" : "Failed to send — check logs", sent ? "info" : "error");
    },
  });
}

function detectProvider(event: { headers: Record<string, string> }): "anthropic" | "openai" | null {
  const headers = event.headers;
  if (headers["anthropic-ratelimit-requests-remaining"]) return "anthropic";
  if (headers["x-ratelimit-remaining-requests"]) return "openai";
  return null;
}

async function pollQuotaStatus(states: QuotaState[]) {
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

async function checkQuota(states: QuotaState[], config: QuotaConfig) {
  const now = new Date();

  for (const state of states) {
    const resetTime = state.requestsReset ?? state.tokensReset;

    if (!resetTime) continue;

    if (resetTime <= now) {
      const message = `🔄 Quota Reset\n\n${formatQuotaStatus([state])}`;
      const sent = await sendTelegram(config, message);

      if (sent) {
        state.requestsReset = null;
        state.tokensReset = null;
      }
    }
  }
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
