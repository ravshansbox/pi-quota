/**
 * pi-quota — tracks Anthropic and OpenAI Codex subscription quota and renders a widget.
 *
 * NOTE: This extension deliberately has no automated tests. It is a single-file extension whose
 * behaviour is dominated by external HTTP APIs (Anthropic, OpenAI Codex) and pi runtime events;
 * it is verified manually by running it in pi. Do not add a test suite here.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface QuotaConfig {
  pollIntervalMs?: number;
}

interface QuotaState {
  provider: "anthropic" | "openai-codex";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  lastUpdated: Date;
}

type WidgetSegment = { text: string; role: "muted" | "warning" };

type OAuthAuthRecord = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
};

type AuthFile = Record<string, OAuthAuthRecord>;

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type AnthropicUsageWindow = {
  utilization?: number;
  resets_at?: string;
};

type AnthropicUsageResponse = {
  five_hour?: AnthropicUsageWindow;
  seven_day?: AnthropicUsageWindow;
};

type OpenAIUsageWindow = {
  used_percent?: number;
  reset_at?: number;
};

type OpenAIUsageResponse = {
  rate_limit?: {
    primary_window?: OpenAIUsageWindow;
    secondary_window?: OpenAIUsageWindow;
  };
};

const PROVIDER_LABELS: Record<QuotaState["provider"], string> = {
  anthropic: "claude",
  "openai-codex": "codex",
};

function formatResetTime(reset: Date): string {
  const diff = reset.getTime() - Date.now();
  if (diff <= 0) return "now";

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "now";
}

function formatQuotaStatus(states: QuotaState[], showProvider = true): string {
  if (states.length === 0) return "No quota data collected yet.";

  return states
    .map((state) => {
      const provider = PROVIDER_LABELS[state.provider];
      const parts: string[] = [];

      if (state.sevenDayRemaining !== null) {
        const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
        parts.push(`7d: ${state.sevenDayRemaining}% left (${resetStr})`);
      }

      if (state.fiveHourRemaining !== null) {
        const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
        parts.push(`5h: ${state.fiveHourRemaining}% left (${resetStr})`);
      }

      return showProvider ? `${provider}: ${parts.join(", ")}` : parts.join(", ");
    })
    .join("\n");
}

function loadConfig(): QuotaConfig | null {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return settings.quota ?? null;
  } catch {
    return null;
  }
}

function authPath() {
  return join(homedir(), ".pi", "agent", "auth.json");
}

function loadAuth(): AuthFile | null {
  try {
    return JSON.parse(readFileSync(authPath(), "utf-8")) as AuthFile;
  } catch {
    return null;
  }
}

function saveAuth(auth: AuthFile) {
  writeFileSync(authPath(), JSON.stringify(auth, null, 2));
}

function logPath() {
  return join(homedir(), ".pi", "agent", "pi-quota.log");
}

function logError(message: string, error?: unknown) {
  const detail = error instanceof Error ? error.stack ?? error.message : error !== undefined ? String(error) : "";
  const line = `[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ""}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
  }
}

export default function (pi: ExtensionAPI) {
  const states: QuotaState[] = [];
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let ctxRef: ExtensionContext | null = null;

  function buildWidgetLines(): WidgetSegment[][] {
    const providerStates = states.filter((s) => s.provider === "anthropic" || s.provider === "openai-codex");
    if (providerStates.length === 0) return [];

    const lines: WidgetSegment[][] = [];
    for (const state of providerStates) {
      const label = PROVIDER_LABELS[state.provider];
      const parts: string[] = [];
      if (state.sevenDayRemaining !== null) {
        const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
        parts.push(`7d: ${state.sevenDayRemaining}% left (${resetStr})`);
      }
      if (state.fiveHourRemaining !== null) {
        const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
        parts.push(`5h: ${state.fiveHourRemaining}% left (${resetStr})`);
      }
      lines.push([{ role: "muted", text: `${label}: ${parts.join(", ")}` }]);
    }
    return lines;
  }

  function updateWidget() {
    if (!ctxRef) return;

    const lines = buildWidgetLines();

    if (lines.length === 0) {
      ctxRef.ui.setWidget("pi-quota", undefined);
      return;
    }

    ctxRef.ui.setWidget("pi-quota", (_tui, theme) => {
      const body = lines.map((line) => line.map((seg) => theme.fg(seg.role, seg.text)).join("")).join("\n");
      return new Text(body, 0, 0);
    });
  }

  function updateState(parsed: QuotaState) {
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

  async function ensureAnthropicAccess(auth: AuthFile): Promise<OAuthAuthRecord | undefined> {
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
      logError(`Anthropic token refresh failed: ${response.status}`);
      return record;
    }

    const data = await response.json() as OAuthTokenResponse;
    auth.anthropic = {
      ...record,
      access: data.access_token ?? record.access,
      refresh: data.refresh_token ?? record.refresh,
      expires: data.expires_in ? Date.now() + data.expires_in * 1000 : record.expires,
    };
    saveAuth(auth);
    ctxRef?.ui.notify("pi-quota: refreshed Anthropic auth", "info");
    return auth.anthropic;
  }

  async function ensureOpenAIAccess(auth: AuthFile): Promise<OAuthAuthRecord | undefined> {
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
      logError(`OpenAI Codex token refresh failed: ${response.status}`);
      return record;
    }

    const data = await response.json() as OAuthTokenResponse;
    auth["openai-codex"] = {
      ...record,
      access: data.access_token ?? record.access,
      refresh: data.refresh_token ?? record.refresh,
      expires: data.expires_in ? Date.now() + data.expires_in * 1000 : record.expires,
    };
    saveAuth(auth);
    ctxRef?.ui.notify("pi-quota: refreshed OpenAI Codex auth", "info");
    return auth["openai-codex"];
  }

  async function pollQuotaStatus() {
    try {
      const auth = loadAuth();
      if (!auth) return;

      const anthropicAuth = await ensureAnthropicAccess(auth);
      if (anthropicAuth?.access) {
        const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            "Authorization": `Bearer ${anthropicAuth.access}`,
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "accept": "application/json",
          },
        });

        if (response.ok) {
          const data = await response.json() as AnthropicUsageResponse;
          const fiveHour = data.five_hour;
          const sevenDay = data.seven_day;
          updateState({
            provider: "anthropic",
            fiveHourRemaining: fiveHour ? Math.round(100 - (fiveHour.utilization ?? 0)) : null,
            fiveHourReset: fiveHour?.resets_at ? new Date(fiveHour.resets_at) : null,
            sevenDayRemaining: sevenDay ? Math.round(100 - (sevenDay.utilization ?? 0)) : null,
            sevenDayReset: sevenDay?.resets_at ? new Date(sevenDay.resets_at) : null,
            lastUpdated: new Date(),
          });
        } else {
          logError(`Anthropic usage request failed: ${response.status}`);
        }
      }

      const openaiAuth = await ensureOpenAIAccess(auth);
      if (openaiAuth?.access) {
        const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
          headers: {
            "Authorization": `Bearer ${openaiAuth.access}`,
            "User-Agent": "pi-quota/1.0",
            "accept": "application/json",
          },
        });

        if (response.ok) {
          const data = await response.json() as OpenAIUsageResponse;
          if (data.rate_limit) {
            const primary = data.rate_limit.primary_window;
            const secondary = data.rate_limit.secondary_window;
            updateState({
              provider: "openai-codex",
              fiveHourRemaining: primary ? Math.round(100 - (primary.used_percent ?? 0)) : null,
              fiveHourReset: primary?.reset_at ? new Date(primary.reset_at * 1000) : null,
              sevenDayRemaining: secondary ? Math.round(100 - (secondary.used_percent ?? 0)) : null,
              sevenDayReset: secondary?.reset_at ? new Date(secondary.reset_at * 1000) : null,
              lastUpdated: new Date(),
            });
          }
        } else {
          logError(`OpenAI Codex usage request failed: ${response.status}`);
        }
      }
    } catch (error) {
      logError("Poll error:", error);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    states.length = 0;
    ctxRef = ctx;

    const config = loadConfig();
    if (config?.pollIntervalMs !== undefined && (typeof config.pollIntervalMs !== "number" || config.pollIntervalMs < 60000)) {
      ctx.ui.notify("pi-quota: pollIntervalMs must be >= 60000 (1 minute)", "error");
      return;
    }

    const intervalMs = config?.pollIntervalMs ?? 600000;

    const scheduleCheck = () => {
      checkTimer = setTimeout(async () => {
        await pollQuotaStatus();
        updateWidget();
        scheduleCheck();
      }, intervalMs);
    };

    await pollQuotaStatus();
    scheduleCheck();

    updateWidget();
    ctx.ui.notify("pi-quota: tracking started", "info");
  });

  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  });
}
