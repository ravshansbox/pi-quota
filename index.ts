/**
 * pi-quota — tracks Anthropic and OpenAI Codex subscription quota and notifies on reset via Telegram.
 *
 * NOTE: This extension deliberately has no automated tests. It is a single-file extension whose
 * behaviour is dominated by external HTTP APIs (Anthropic, OpenAI Codex, Telegram) and pi runtime
 * events; it is verified manually by running it in pi. Do not add a test suite here.
 */

import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface QuotaConfig {
  botToken: string;
  chatId: string;
  pollIntervalMs?: number;
  updatePollIntervalMs?: number;
}

interface QuotaState {
  provider: "anthropic" | "openai";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  lastUpdated: Date;
}

type OAuthAuthRecord = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
};

type AuthFile = Record<string, OAuthAuthRecord>;

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number | string };
  };
};

type ResetWindow = "5h" | "7d";

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

type TimerRecord = {
  resetAt: number;
  handle: ReturnType<typeof setTimeout>;
};

type Lease = {
  pid: number;
  host: string;
  ts: number;
};

const LEASE_STALE_FACTOR = 3;

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
      const provider = state.provider === "openai" ? "openai-codex" : state.provider;
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

function leaderPath() {
  return join(homedir(), ".pi", "agent", "pi-quota.lock");
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

function readLease(): Lease | null {
  try {
    return JSON.parse(readFileSync(leaderPath(), "utf-8")) as Lease;
  } catch {
    return null;
  }
}

function tryCreateLease(lease: Lease): boolean {
  try {
    writeFileSync(leaderPath(), JSON.stringify(lease), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function overwriteLease(lease: Lease) {
  try {
    writeFileSync(leaderPath(), JSON.stringify(lease));
  } catch (error) {
    logError("failed to write leader lock:", error);
  }
}

function pidAlive(pid: number, host: string): boolean {
  if (host !== hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function leaseIsStale(lease: Lease, staleMs: number): boolean {
  if (Date.now() - lease.ts > staleMs) return true;
  return !pidAlive(lease.pid, lease.host);
}

export default function (pi: ExtensionAPI) {
  const states: QuotaState[] = [];
  let config: QuotaConfig | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let updateOffset: number | undefined;

  let ctxRef: ExtensionContext | null = null;
  let isLeader = false;
  let leaseStaleMs = 180000;
  let botPollError: string | null = null;
  const resetTimers = new Map<string, TimerRecord>();
  const selfLease = (): Lease => ({ pid: process.pid, host: hostname(), ts: Date.now() });

  function ownsLease(lease: Lease | null): boolean {
    return !!lease && lease.pid === process.pid && lease.host === hostname();
  }

  function becomeLeader() {
    const wasLeader = isLeader;
    isLeader = true;
    if (!wasLeader) syncResetTimers();
  }

  function becomeFollower() {
    if (!isLeader) return;
    isLeader = false;
    resetTimers.forEach((timer) => clearTimeout(timer.handle));
    resetTimers.clear();
  }

  function evaluateLeadership() {
    const lease = readLease();

    if (ownsLease(lease)) {
      overwriteLease(selfLease());
      becomeLeader();
      return;
    }

    if (!lease) {
      if (tryCreateLease(selfLease())) {
        becomeLeader();
      } else {
        becomeFollower();
      }
      return;
    }

    if (leaseIsStale(lease, leaseStaleMs)) {
      overwriteLease(selfLease());
      if (ownsLease(readLease())) {
        becomeLeader();
      } else {
        becomeFollower();
      }
      return;
    }

    becomeFollower();
  }

  function updateWidget() {
    if (!ctxRef) return;

    const providerStates = states.filter((s) => s.provider === "anthropic" || s.provider === "openai");

    if (providerStates.length === 0) {
      ctxRef.ui.setWidget("pi-quota", undefined);
      return;
    }

    const statusLabel = isLeader ? "main" : "standby";
    const errorSuffix = botPollError ? ` · telegram ${botPollError}` : "";

    const lines: string[] = [];
    for (const state of providerStates) {
      const parts: string[] = [];
      if (state.sevenDayRemaining !== null) {
        const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
        parts.push(`7d: ${state.sevenDayRemaining}% left (${resetStr})`);
      }
      if (state.fiveHourRemaining !== null) {
        const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
        parts.push(`5h: ${state.fiveHourRemaining}% left (${resetStr})`);
      }
      const label = state.provider === "openai" ? "openai-codex" : state.provider;
      lines.push(`${label}: ${parts.join(", ")}`);
    }

    lines.push(`role: ${statusLabel}${errorSuffix}`);
    ctxRef.ui.setWidget("pi-quota", lines);
  }

  function formatBotPollError(error: unknown): string {
    const code = error instanceof Error && "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : error instanceof Error && "code" in error
        ? String(error.code)
        : null;

    if (code === "ETIMEDOUT") return "timeout";
    if (error instanceof TypeError && error.message === "fetch failed") return "fetch failed";
    if (error instanceof Error && error.message) return error.message;
    return "failed";
  }

  function syncResetTimer(state: QuotaState, window: ResetWindow, reset: Date | null) {
    const key = `${state.provider}:${window}`;
    const existing = resetTimers.get(key);

    if (!reset) {
      if (existing) {
        clearTimeout(existing.handle);
        resetTimers.delete(key);
      }
      return;
    }

    if (!isLeader) {
      if (existing) {
        clearTimeout(existing.handle);
        resetTimers.delete(key);
      }
      return;
    }

    const resetAt = reset.getTime();
    if (existing && existing.resetAt === resetAt) return;
    if (existing) clearTimeout(existing.handle);

    const delay = Math.max(0, resetAt - Date.now());
    const handle = setTimeout(async () => {
      if (!isLeader) {
        resetTimers.delete(key);
        return;
      }
      const label = state.provider === "openai" ? "openai-codex" : state.provider;
      const message = `🔄 ${label} ${window} quota reset\n\n${formatQuotaStatus([state])}`;
      if (await sendTelegram(config!, message)) {
        resetTimers.delete(key);
      }
    }, delay);

    resetTimers.set(key, { resetAt, handle });
  }

  function syncResetTimers() {
    for (const state of states) {
      syncResetTimer(state, "5h", state.fiveHourReset);
      syncResetTimer(state, "7d", state.sevenDayReset);
    }
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

  async function sendTelegram(quotaConfig: QuotaConfig, text: string): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${quotaConfig.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: quotaConfig.chatId, text }),
      });

      if (!response.ok) {
        logError(`Telegram API error: ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      logError("Failed to send Telegram message:", error);
      return false;
    }
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
              provider: "openai",
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

  async function pollBotCommands() {
    if (!config || !isLeader) return;
    try {
      const params = new URLSearchParams({ timeout: "0" });
      if (updateOffset !== undefined) params.set("offset", String(updateOffset));

      const response = await fetch(`https://api.telegram.org/bot${config.botToken}/getUpdates?${params.toString()}`);
      if (!response.ok) {
        botPollError = `HTTP ${response.status}`;
        logError(`getUpdates failed: ${response.status}`);
        updateWidget();
        return;
      }

      if (botPollError) {
        botPollError = null;
        updateWidget();
      }

      const data = await response.json() as { result?: TelegramUpdate[] };
      const updates = data.result ?? [];

      for (const update of updates) {
        updateOffset = update.update_id + 1;

        const message = update.message;
        if (!message?.text || message.chat?.id === undefined) continue;
        if (String(message.chat.id) !== config.chatId) continue;

        const command = message.text.trim().split(/\s+/)[0]?.split("@")[0];
        if (command !== "/quota") continue;

        await sendTelegram(config, formatQuotaStatus(states));
      }
    } catch (error) {
      botPollError = formatBotPollError(error);
      logError(`getUpdates error: ${botPollError}`);
      updateWidget();
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

    if (config.updatePollIntervalMs !== undefined && (typeof config.updatePollIntervalMs !== "number" || config.updatePollIntervalMs < 10000)) {
      ctx.ui.notify("pi-quota: updatePollIntervalMs must be >= 10000 (10 seconds)", "error");
      return;
    }

    const intervalMs = config.pollIntervalMs ?? 600000;
    const updateIntervalMs = config.updatePollIntervalMs ?? 60000;
    leaseStaleMs = updateIntervalMs * LEASE_STALE_FACTOR;

    const scheduleCheck = () => {
      checkTimer = setTimeout(async () => {
        await pollQuotaStatus();
        syncResetTimers();
        updateWidget();
        scheduleCheck();
      }, intervalMs);
    };

    const scheduleUpdates = () => {
      updateTimer = setTimeout(async () => {
        evaluateLeadership();
        await pollBotCommands();
        scheduleUpdates();
      }, updateIntervalMs);
    };

    evaluateLeadership();
    await pollQuotaStatus();
    syncResetTimers();
    scheduleCheck();
    scheduleUpdates();

    updateWidget();
    ctx.ui.notify("pi-quota: tracking started", "info");
  });

  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    resetTimers.forEach((timer) => clearTimeout(timer.handle));
    resetTimers.clear();
    if (ownsLease(readLease())) {
      try {
        unlinkSync(leaderPath());
      } catch {
        // already gone
      }
    }
    isLeader = false;
  });
}
