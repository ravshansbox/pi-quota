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
