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

function loadAuth(): Record<string, { type?: string; access?: string; key?: string }> | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const raw = readFileSync(authPath, "utf-8");
    return JSON.parse(raw);
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

}

function detectProvider(event: { headers: Record<string, string> }): "anthropic" | "openai" | null {
  const headers = event.headers;
  if (headers["anthropic-ratelimit-requests-remaining"]) return "anthropic";
  if (headers["x-ratelimit-remaining-requests"]) return "openai";
  return null;
}

async function pollQuotaStatus(states: QuotaState[]) {
  try {
    const auth = loadAuth();
    if (!auth) return;

    const anthropicToken = auth.anthropic?.access;
    const openaiToken = auth["openai-codex"]?.access;

    if (anthropicToken) {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          "Authorization": `Bearer ${anthropicToken}`,
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "accept": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json() as any;
        
        const fiveHour = data.five_hour;
        const sevenDay = data.seven_day;
        
        updateState(states, {
          provider: "anthropic",
          fiveHourRemaining: fiveHour ? Math.round(100 - (fiveHour.utilization ?? 0)) : null,
          fiveHourReset: fiveHour?.resets_at ? new Date(fiveHour.resets_at) : null,
          sevenDayRemaining: sevenDay ? Math.round(100 - (sevenDay.utilization ?? 0)) : null,
          sevenDayReset: sevenDay?.resets_at ? new Date(sevenDay.resets_at) : null,
          lastUpdated: new Date(),
        });
      }
    }

    if (openaiToken) {
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          "Authorization": `Bearer ${openaiToken}`,
          "User-Agent": "pi-quota/1.0",
          "accept": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json() as any;
        
        if (data.rate_limit) {
          const primary = data.rate_limit.primary_window;
          const secondary = data.rate_limit.secondary_window;
          
          updateState(states, {
            provider: "openai",
            fiveHourRemaining: primary ? Math.round(100 - (primary.used_percent ?? 0)) : null,
            fiveHourReset: primary?.reset_at ? new Date(primary.reset_at * 1000) : null,
            sevenDayRemaining: secondary ? Math.round(100 - (secondary.used_percent ?? 0)) : null,
            sevenDayReset: secondary?.reset_at ? new Date(secondary.reset_at * 1000) : null,
            lastUpdated: new Date(),
          });
        }
      }
    }
  } catch (error) {
    console.error("pi-quota: Poll error:", error);
  }
}

function updateState(states: QuotaState[], parsed: Partial<QuotaState>) {
  const existing = states.find((s) => s.provider === parsed.provider);
  if (existing) {
    if (parsed.fiveHourRemaining !== undefined) existing.fiveHourRemaining = parsed.fiveHourRemaining;
    if (parsed.fiveHourReset !== undefined) existing.fiveHourReset = parsed.fiveHourReset;
    if (parsed.sevenDayRemaining !== undefined) existing.sevenDayRemaining = parsed.sevenDayRemaining;
    if (parsed.sevenDayReset !== undefined) existing.sevenDayReset = parsed.sevenDayReset;
    existing.lastUpdated = parsed.lastUpdated ?? new Date();
  } else {
    states.push(parsed as QuotaState);
  }
}

async function checkQuota(states: QuotaState[], config: QuotaConfig) {
  const now = new Date();

  for (const state of states) {
    const fiveHourReset = state.fiveHourReset;
    const sevenDayReset = state.sevenDayReset;

    if (fiveHourReset && fiveHourReset <= now) {
      const message = `🔄 5 Hour Quota Reset\n\n${formatQuotaStatus([state])}`;
      const sent = await sendTelegram(config, message);
      if (sent) state.fiveHourReset = null;
    }

    if (sevenDayReset && sevenDayReset <= now) {
      const message = `🔄 7 Day Quota Reset\n\n${formatQuotaStatus([state])}`;
      const sent = await sendTelegram(config, message);
      if (sent) state.sevenDayReset = null;
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
