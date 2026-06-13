import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type QuotaConfig,
  type QuotaState,
  formatQuotaStatus,
  formatResetTime,
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
  let currentProvider: string | null = null;
  let ctxRef: any = null;

  function updateWidget() {
    if (!ctxRef) return;

    if (!currentProvider) {
      ctxRef.ui.setWidget("pi-quota", undefined);
      return;
    }
    
    const providerKey = currentProvider === "openai-codex" ? "openai" : currentProvider;
    const state = states.find((s) => s.provider === providerKey);
    
    if (!state) {
      ctxRef.ui.setWidget("pi-quota", undefined);
      return;
    }

    const parts: string[] = [];
    
    if (state.sevenDayRemaining !== null) {
      const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "?";
      parts.push(`7d: ${state.sevenDayRemaining}% left (${resetStr})`);
    }
    
    if (state.fiveHourRemaining !== null) {
      const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "?";
      parts.push(`5h: ${state.fiveHourRemaining}% left (${resetStr})`);
    }
    
    if (parts.length > 0) {
      ctxRef.ui.setWidget("pi-quota", [parts.join(", ")]);
    } else {
      ctxRef.ui.setWidget("pi-quota", undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    states.length = 0;
    config = loadConfig();
    ctxRef = ctx;

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
        await pollQuotaStatus(states, config!);
        updateWidget();
        scheduleCheck();
      }, intervalMs);
    };

    await pollQuotaStatus(states, config!);
    scheduleCheck();
    const startProvider = ctx.model?.provider;
    if (startProvider === "anthropic" || startProvider === "openai-codex") {
      currentProvider = startProvider;
    }
    updateWidget();
    ctx.ui.notify("pi-quota: tracking started", "info");
  });

  pi.on("model_select", async (event, ctx) => {
    const provider = event.model?.provider;
    if (provider === "anthropic" || provider === "openai-codex") {
      currentProvider = provider;
    } else {
      currentProvider = null;
    }
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
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

async function pollQuotaStatus(states: QuotaState[], config: QuotaConfig) {
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
        
        await updateState(states, config, {
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
          
          await updateState(states, config, {
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

async function updateState(states: QuotaState[], config: QuotaConfig, parsed: QuotaState) {
  const existing = states.find((s) => s.provider === parsed.provider);

  if (!existing) {
    states.push(parsed);
    return;
  }

  await detectAndNotifyReset(config, parsed.provider, "5h", existing.fiveHourReset, parsed.fiveHourReset, parsed);
  await detectAndNotifyReset(config, parsed.provider, "7d", existing.sevenDayReset, parsed.sevenDayReset, parsed);

  existing.fiveHourRemaining = parsed.fiveHourRemaining;
  existing.fiveHourReset = parsed.fiveHourReset;
  existing.sevenDayRemaining = parsed.sevenDayRemaining;
  existing.sevenDayReset = parsed.sevenDayReset;
  existing.lastUpdated = parsed.lastUpdated;
}

async function detectAndNotifyReset(
  config: QuotaConfig,
  provider: "anthropic" | "openai",
  window: "5h" | "7d",
  oldReset: Date | null,
  newReset: Date | null,
  newState: QuotaState,
) {
  if (!oldReset || !newReset) return;
  if (newReset.getTime() <= oldReset.getTime()) return;

  const label = provider === "openai" ? "openai-codex" : provider;
  const message = `🔄 ${label} ${window} quota reset\n\n${formatQuotaStatus([newState])}`;
  await sendTelegram(config, message);
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
