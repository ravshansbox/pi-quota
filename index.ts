import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearResetTimers,
  scheduleResetTimers,
  sendResetNotification,
  syncResetTimers,
  type TimerMap,
} from "./quota-core.ts";
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

type OAuthAuthRecord = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
};

type AuthFile = Record<string, OAuthAuthRecord>;

function authPath() {
  return join(homedir(), ".pi", "agent", "auth.json");
}

function loadAuth(): AuthFile | null {
  try {
    const raw = readFileSync(authPath(), "utf-8");
    return JSON.parse(raw) as AuthFile;
  } catch {
    return null;
  }
}

function saveAuth(auth: AuthFile) {
  writeFileSync(authPath(), JSON.stringify(auth, null, 2));
}

export default function (pi: ExtensionAPI) {
  const states: QuotaState[] = [];
  let config: QuotaConfig | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let currentProvider: string | null = null;
  let ctxRef: ExtensionContext | null = null;
  let resetTimers: TimerMap = new Map();

  function timerDeps() {
    return {
      setTimer(fn: () => void | Promise<void>, delay: number) {
        return setTimeout(fn, delay);
      },
      clearTimer(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      async notify(provider: "anthropic" | "openai", window: "5h" | "7d", state: QuotaState, quotaConfig: QuotaConfig) {
        return sendResetNotification(provider, window, state, quotaConfig, sendTelegram);
      },
    };
  }

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
        await pollQuotaStatus(states, config!, ctxRef);
        for (const state of states) {
          syncResetTimers(state, config!, resetTimers, timerDeps());
        }
        updateWidget();
        scheduleCheck();
      }, intervalMs);
    };

    await pollQuotaStatus(states, config!, ctxRef);
    resetTimers = scheduleResetTimers(states, config, timerDeps());
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
    clearResetTimers(resetTimers, (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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

async function pollQuotaStatus(states: QuotaState[], config: QuotaConfig, ctx?: ExtensionContext | null) {
  try {
    const auth = loadAuth();
    if (!auth) return;

    const anthropicAuth = await ensureAnthropicAccess(auth, ctx);
    if (anthropicAuth?.access) {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          "Authorization": `Bearer ${anthropicAuth.access}`,
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
      } else {
        console.error(`pi-quota: Anthropic usage request failed: ${response.status}`);
      }
    }

    const openaiAuth = await ensureOpenAIAccess(auth, ctx);
    if (openaiAuth?.access) {
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          "Authorization": `Bearer ${openaiAuth.access}`,
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
      } else {
        console.error(`pi-quota: OpenAI Codex usage request failed: ${response.status}`);
      }
    }
  } catch (error) {
    console.error("pi-quota: Poll error:", error);
  }
}

function updateState(states: QuotaState[], parsed: QuotaState) {
  const existing = states.find((s) => s.provider === parsed.provider);
  if (!existing) {
    states.push(parsed);
    return;
  }

  existing.fiveHourRemaining = parsed.fiveHourRemaining;
  existing.fiveHourReset = parsed.fiveHourReset;
  existing.sevenDayRemaining = parsed.sevenDayRemaining;
  existing.sevenDayReset = parsed.sevenDayReset;
  existing.lastUpdated = parsed.lastUpdated;
}

async function ensureAnthropicAccess(auth: AuthFile, ctx?: ExtensionContext | null) {
  const record = auth.anthropic;
  if (!record?.refresh) return record;
  if (record.expires && record.expires > Date.now() + 60_000 && record.access) return record;

  const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refresh,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    }),
  });

  if (!response.ok) {
    console.error(`pi-quota: Anthropic token refresh failed: ${response.status}`);
    return record;
  }

  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  auth.anthropic = {
    ...record,
    access: data.access_token ?? record.access,
    refresh: data.refresh_token ?? record.refresh,
    expires: data.expires_in ? Date.now() + data.expires_in * 1000 : record.expires,
  };
  saveAuth(auth);
  ctx?.ui.notify("pi-quota: refreshed Anthropic auth", "info");
  return auth.anthropic;
}

async function ensureOpenAIAccess(auth: AuthFile, ctx?: ExtensionContext | null) {
  const record = auth["openai-codex"];
  if (!record?.refresh) return record;
  if (record.expires && record.expires > Date.now() + 60_000 && record.access) return record;

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refresh,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    }),
  });

  if (!response.ok) {
    console.error(`pi-quota: OpenAI Codex token refresh failed: ${response.status}`);
    return record;
  }

  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  auth["openai-codex"] = {
    ...record,
    access: data.access_token ?? record.access,
    refresh: data.refresh_token ?? record.refresh,
    expires: data.expires_in ? Date.now() + data.expires_in * 1000 : record.expires,
  };
  saveAuth(auth);
  ctx?.ui.notify("pi-quota: refreshed OpenAI Codex auth", "info");
  return auth["openai-codex"];
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
