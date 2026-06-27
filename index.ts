/**
 * pi-quota — tracks Anthropic and OpenAI Codex subscription quota and renders a widget.
 *
 * NOTE: This extension deliberately has no automated tests. It is a single-file extension whose
 * behaviour is dominated by external HTTP APIs (Anthropic, OpenAI Codex) and pi runtime events;
 * it is verified manually by running it in pi. Do not add a test suite here.
 */

import { readFile, writeFile, appendFile, open, unlink, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface QuotaConfig {
  codexResets?: {
    autoRedeem?: boolean;
  };
  telegramBotToken?: string;
  telegramChatId?: string;
}

interface QuotaState {
  provider: "anthropic" | "openai-codex";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  resetsAvailable: number;
  lastUpdated: Date;
}

type WidgetSegment = { text: string; role: "muted" };

type OAuthAuthRecord = {
  access?: string;
  refresh?: string;
  expires?: number;
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
  rate_limit_reset_credits?: {
    available_count?: number;
  };
};

type CodexResetCredit = {
  id: string;
  status?: string;
};

type CodexResetCreditList = {
  credits: CodexResetCredit[];
  available_count?: number;
};

type CodexResetConsumeResponse = {
  code?: string;
};

const PROVIDER_LABELS: Record<QuotaState["provider"], string> = {
  anthropic: "claude",
  "openai-codex": "codex",
};

const REQUEST_TIMEOUT_MS = 30_000;

type WindowKey = "fiveHour" | "sevenDay";

const WINDOW_LABELS: Record<WindowKey, string> = {
  fiveHour: "5h",
  sevenDay: "7d",
};

const RESET_TIMER_BUFFER_MS = 30_000;
const LOCK_STALE_MS = 60_000;
// Minimum upward jump in remaining quota (percentage points) that counts as a
// window reset. Distinguishes a genuine rollover (e.g. 30% -> 100%) from the
// gradual recovery of a rolling window (a few points per poll).
const RESET_JUMP_THRESHOLD = 50;

type NotifiedRecord = Record<string, Partial<Record<WindowKey, number>>>;

type LeaderRecord = {
  pid: number;
  hostname: string;
  heartbeatAt: number;
};

type SerializedQuotaState = {
  provider: QuotaState["provider"];
  fiveHourRemaining: number | null;
  fiveHourReset: string | null;
  sevenDayRemaining: number | null;
  sevenDayReset: string | null;
  resetsAvailable: number;
  lastUpdated: string;
};

const HEARTBEAT_INTERVAL_MS = 20_000;
const LEASE_STALE_MS = 60_000;

function nextMarkAfter(time: Date): Date {
  const next = new Date(time.getTime());
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  const bump = 10 - (minute % 10);
  next.setMinutes(minute + (bump === 0 ? 10 : bump));
  return next;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

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

async function loadConfig(): Promise<QuotaConfig | null> {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    return settings.quota ?? null;
  } catch {
    return null;
  }
}

function authPath() {
  return join(homedir(), ".pi", "agent", "auth.json");
}

async function loadAuth(): Promise<AuthFile | null> {
  try {
    return JSON.parse(await readFile(authPath(), "utf-8")) as AuthFile;
  } catch {
    return null;
  }
}

async function saveAuth(auth: AuthFile): Promise<void> {
  await writeFile(authPath(), JSON.stringify(auth, null, 2));
}

async function persistAuthRecord(provider: string, record: OAuthAuthRecord): Promise<void> {
  const current = await loadAuth() ?? {};
  current[provider] = record;
  await saveAuth(current);
}

function logPath() {
  return join(homedir(), ".pi", "agent", "pi-quota.log");
}

function notifiedPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-notified.json");
}

function lockPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-notified.lock");
}

function leaderPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-leader.json");
}

function statePath() {
  return join(homedir(), ".pi", "agent", "pi-quota-state.json");
}

function serializeStates(states: QuotaState[]): SerializedQuotaState[] {
  return states.map((s) => ({
    provider: s.provider,
    fiveHourRemaining: s.fiveHourRemaining,
    fiveHourReset: s.fiveHourReset ? s.fiveHourReset.toISOString() : null,
    sevenDayRemaining: s.sevenDayRemaining,
    sevenDayReset: s.sevenDayReset ? s.sevenDayReset.toISOString() : null,
    resetsAvailable: s.resetsAvailable,
    lastUpdated: s.lastUpdated.toISOString(),
  }));
}

function deserializeStates(raw: SerializedQuotaState[]): QuotaState[] {
  return raw.map((s) => ({
    provider: s.provider,
    fiveHourRemaining: s.fiveHourRemaining,
    fiveHourReset: s.fiveHourReset ? new Date(s.fiveHourReset) : null,
    sevenDayRemaining: s.sevenDayRemaining,
    sevenDayReset: s.sevenDayReset ? new Date(s.sevenDayReset) : null,
    resetsAvailable: s.resetsAvailable,
    lastUpdated: new Date(s.lastUpdated),
  }));
}

async function writeSharedState(states: QuotaState[]): Promise<void> {
  try {
    // Write to a temp file then atomically rename, so a standby watcher never
    // observes a truncated/partially-written state file.
    const tmp = `${statePath()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(serializeStates(states), null, 2));
    await rename(tmp, statePath());
  } catch (error) {
    await logError("Write shared state error:", error);
  }
}

async function readSharedState(): Promise<QuotaState[] | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf-8"));
    if (!Array.isArray(parsed)) return null;
    return deserializeStates(parsed as SerializedQuotaState[]);
  } catch {
    return null;
  }
}

async function loadNotified(): Promise<NotifiedRecord> {
  try {
    const parsed = JSON.parse(await readFile(notifiedPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as NotifiedRecord;
  } catch {
    return {};
  }
}

async function saveNotified(record: NotifiedRecord): Promise<void> {
  await writeFile(notifiedPath(), JSON.stringify(record, null, 2));
}

async function acquireLock(): Promise<boolean> {
  try {
    const handle = await open(lockPath(), "wx");
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      await logError("Lock acquire error:", error);
      return false;
    }
    try {
      const info = await stat(lockPath());
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath()).catch(() => {});
        const handle = await open(lockPath(), "wx");
        await handle.close();
        return true;
      }
    } catch {
    }
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(lockPath()).catch(() => {});
}

async function readLeader(): Promise<LeaderRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(leaderPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (typeof (parsed as LeaderRecord).heartbeatAt !== "number" || !Number.isFinite((parsed as LeaderRecord).heartbeatAt)) return null;
    return parsed as LeaderRecord;
  } catch {
    return null;
  }
}

async function writeLeader(record: LeaderRecord): Promise<void> {
  await writeFile(leaderPath(), JSON.stringify(record, null, 2));
}

// Try to atomically claim leadership. Returns true if this process now holds it.
async function claimLeader(record: LeaderRecord): Promise<boolean> {
  const payload = JSON.stringify(record, null, 2);
  try {
    await writeFile(leaderPath(), payload, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      await logError("Leader claim error:", error);
      return false;
    }
    const existing = await readLeader();
    const stale = !existing || Date.now() - existing.heartbeatAt > LEASE_STALE_MS;
    if (!stale) return false;
    await unlink(leaderPath()).catch(() => {});
    try {
      await writeFile(leaderPath(), payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

async function releaseLeader(pid: number, host: string): Promise<void> {
  const existing = await readLeader();
  if (existing && existing.pid === pid && existing.hostname === host) {
    await unlink(leaderPath()).catch(() => {});
  }
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await logError(`Telegram send failed: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    await logError("Telegram send error:", error);
    return false;
  }
}

function buildResetMessage(state: QuotaState, window: WindowKey): string {
  const label = PROVIDER_LABELS[state.provider];
  const lines = [`${label} ${WINDOW_LABELS[window]} window reset`];
  if (state.fiveHourRemaining !== null) {
    const reset = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
    lines.push(`5h: ${state.fiveHourRemaining}% left (${reset})`);
  }
  if (state.sevenDayRemaining !== null) {
    const reset = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
    lines.push(`7d: ${state.sevenDayRemaining}% left (${reset})`);
  }
  return lines.join("\n");
}

async function logError(message: string, error?: unknown): Promise<void> {
  const detail = error instanceof Error ? error.stack ?? error.message : error !== undefined ? String(error) : "";
  const line = `[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ""}\n`;
  try {
    await appendFile(logPath(), line);
  } catch {
  }
}

export default function (pi: ExtensionAPI) {
  const states: QuotaState[] = [];
  const refreshNotified = new Set<string>();
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let ctxRef: ExtensionContext | null = null;
  let codexRedeemAttempted = false;

  const lastSeenRemaining: Record<string, Record<WindowKey, number | null>> = {
    anthropic: { fiveHour: null, sevenDay: null },
    "openai-codex": { fiveHour: null, sevenDay: null },
  };
  let telegramEnabled = false;
  let cycleRunning = false;
  const resetTimers: ReturnType<typeof setTimeout>[] = [];
  let isMain = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let stateWatcher: FSWatcher | null = null;
  const selfPid = process.pid;
  const selfHost = hostname();
  let heartbeatGen = 0;

  function notifyRefreshOnce(provider: string, message: string) {
    if (refreshNotified.has(provider)) return;
    refreshNotified.add(provider);
    ctxRef?.ui.notify(message, "info");
  }

  function buildWidgetLines(): WidgetSegment[][] {
    const lines: WidgetSegment[][] = [];
    lines.push([{ role: "muted", text: `quota: ${isMain ? "main" : "standby"}` }]);
    for (const state of states) {
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
      if (state.resetsAvailable > 0) {
        parts.push(`${state.resetsAvailable} reset${state.resetsAvailable === 1 ? "" : "s"}`);
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
    }, { placement: "aboveEditor" });
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
    existing.resetsAvailable = parsed.resetsAvailable;
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    await persistAuthRecord("anthropic", auth.anthropic);
    notifyRefreshOnce("anthropic", "pi-quota: refreshed Anthropic auth");
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    await persistAuthRecord("openai-codex", auth["openai-codex"]);
    notifyRefreshOnce("openai-codex", "pi-quota: refreshed OpenAI Codex auth");
    return auth["openai-codex"];
  }

  async function listCodexResetCredits(accessToken: string): Promise<CodexResetCreditList | null> {
    try {
      const response = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "pi-quota/1.0",
          "accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        logError(`List reset credits failed: ${response.status}`);
        return null;
      }

      return await response.json() as CodexResetCreditList;
    } catch (error) {
      logError("List reset credits error:", error);
      return null;
    }
  }

  async function consumeCodexResetCredit(accessToken: string, creditId: string): Promise<CodexResetConsumeResponse | null> {
    try {
      const redeemRequestId = crypto.randomUUID();
      const response = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "pi-quota/1.0",
          "Content-Type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        logError(`Consume reset credit failed: ${response.status}`);
        return null;
      }

      return await response.json() as CodexResetConsumeResponse;
    } catch (error) {
      logError("Consume reset credit error:", error);
      return null;
    }
  }

  async function attemptNotify(
    state: QuotaState,
    window: WindowKey,
    newResetMs: number,
    botToken: string,
    chatId: string,
  ): Promise<boolean> {
    if (!(await acquireLock())) return false;
    try {
      const notified = await loadNotified();
      const prev = notified[state.provider]?.[window];
      if (prev !== undefined && prev >= newResetMs) return true;

      const ok = await sendTelegram(botToken, chatId, buildResetMessage(state, window));
      if (!ok) return false;

      notified[state.provider] = { ...notified[state.provider], [window]: newResetMs };
      try {
        await saveNotified(notified);
      } catch (error) {
        // Message was already sent; failing to record it must not cause a resend
        // storm on every cycle. Treat as handled and log.
        await logError("Failed to record notified reset:", error);
      }
      return true;
    } finally {
      await releaseLock();
    }
  }

  async function processResets() {
    const config = await loadConfig();
    telegramEnabled = !!(config?.telegramBotToken && config?.telegramChatId);
    if (!telegramEnabled || !config) return;

    const botToken = config.telegramBotToken!;
    const chatId = config.telegramChatId!;

    for (const state of states) {
      const seen = lastSeenRemaining[state.provider];
      if (!seen) continue;
      for (const window of ["fiveHour", "sevenDay"] as const) {
        const remaining = window === "fiveHour" ? state.fiveHourRemaining : state.sevenDayRemaining;
        if (remaining === null) continue;
        const prev = seen[window];
        seen[window] = remaining;
        if (prev === null) continue;
        // A reset is a large upward jump in remaining quota. Gradual recovery of
        // a rolling window (a few points per poll) stays below the threshold.
        if (remaining - prev < RESET_JUMP_THRESHOLD) continue;
        // reset_at is the dedup epoch: the notified record skips a (re)send when
        // it already holds a timestamp >= the current window's reset time.
        const resetDate = window === "fiveHour" ? state.fiveHourReset : state.sevenDayReset;
        const epochMs = resetDate ? resetDate.getTime() : Date.now();
        await attemptNotify(state, window, epochMs, botToken, chatId);
      }
    }
  }

  function clearResetTimers() {
    for (const timer of resetTimers) clearTimeout(timer);
    resetTimers.length = 0;
  }

  function scheduleResetTimers() {
    clearResetTimers();
    if (!telegramEnabled) return;

    const now = Date.now();
    const scheduled = new Set<number>();

    for (const state of states) {
      for (const window of ["fiveHour", "sevenDay"] as const) {
        const resetDate = window === "fiveHour" ? state.fiveHourReset : state.sevenDayReset;
        if (!resetDate) continue;
        const fireAt = resetDate.getTime() + RESET_TIMER_BUFFER_MS;
        if (fireAt <= now) continue;
        if (scheduled.has(fireAt)) continue;
        scheduled.add(fireAt);

        const timer = setTimeout(() => {
          void runCycle();
        }, fireAt - now);
        resetTimers.push(timer);
      }
    }
  }

  async function runCycle() {
    // Only the main instance polls providers; standbys render from shared state.
    if (!isMain) return;
    // Skip if a cycle is already in flight (e.g. a reset timer fires mid-poll).
    // The in-flight cycle fetches fresh data and re-arms timers when it finishes,
    // so detection is not missed; the 10-minute poll is the ultimate safety net.
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      await pollQuotaStatus();
      // Re-check leadership between each privileged step: a heartbeat may have
      // demoted us during network I/O, and only main may redeem/notify/persist.
      if (!isMain) return;
      await tryAutoRedeemCodexReset();
      if (!isMain) return;
      await processResets();
      if (!isMain) return;
      await writeSharedState(states);
      updateWidget();
      scheduleResetTimers();
    } catch (error) {
      // Never let a cycle throw: the poll loop re-arms itself after runCycle.
      await logError("Run cycle error:", error);
    } finally {
      cycleRunning = false;
    }
  }

  function stopWatcher() {
    if (stateWatcher) {
      stateWatcher.close();
      stateWatcher = null;
    }
  }

  async function refreshFromSharedState() {
    const shared = await readSharedState();
    if (!shared) return;
    states.length = 0;
    for (const s of shared) states.push(s);
    updateWidget();
  }

  function startWatcher() {
    stopWatcher();
    void refreshFromSharedState();
    // Watch the containing directory, not the state file itself: a fresh standby
    // may start before main has created the file, and watching a missing file
    // throws ENOENT. The agent dir always exists.
    try {
      const dir = join(homedir(), ".pi", "agent");
      stateWatcher = watch(dir, (_event, filename) => {
        if (!filename || filename === "pi-quota-state.json") {
          void refreshFromSharedState();
        }
      });
      stateWatcher.on("error", (error) => {
        void logError("State watcher error:", error);
      });
    } catch (error) {
      void logError("State watch error:", error);
    }
  }

  function scheduleCheck() {
    const next = nextMarkAfter(new Date());
    const delay = Math.max(0, next.getTime() - Date.now());
    checkTimer = setTimeout(async () => {
      await runCycle();
      if (isMain) scheduleCheck();
    }, delay);
  }

  async function becomeMain() {
    if (isMain) return;
    isMain = true;
    stopWatcher();
    updateWidget();
    void runCycle();
    scheduleCheck();
  }

  async function becomeStandby() {
    if (isMain) {
      isMain = false;
      if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
      clearResetTimers();
    }
    startWatcher();
    updateWidget();
  }

  async function heartbeatTick() {
    const record: LeaderRecord = { pid: selfPid, hostname: selfHost, heartbeatAt: Date.now() };
    if (isMain) {
      const existing = await readLeader();
      if (!existing || existing.pid !== selfPid || existing.hostname !== selfHost) {
        // Lost ownership (taken over, or our lease was cleared) — step down
        // rather than clobbering whoever now holds the lease.
        await becomeStandby();
        return;
      }
      // Note: there is a small TOCTOU window between this read and the write below
      // where a stale-takeover by another instance could be overwritten. That
      // instance will detect the lost ownership on its next heartbeat (<=20s) and
      // step down, so double-main is bounded — matching the design's accepted
      // sleep/wake tolerance. Notification idempotency covers duplicate sends; the
      // redeem risk is limited by the short window and leadership re-checks in runCycle.
      await writeLeader(record);
    } else {
      const won = await claimLeader(record);
      if (won) await becomeMain();
    }
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const gen = heartbeatGen;
    heartbeatTimer = setTimeout(async () => {
      if (gen !== heartbeatGen) return; // a newer session/shutdown superseded this loop
      try {
        await heartbeatTick();
      } catch (error) {
        await logError("Heartbeat error:", error);
      }
      if (gen === heartbeatGen) scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  async function pollQuotaStatus() {
    try {
      const auth = await loadAuth();
      if (!auth) return;

      const anthropicAuth = await ensureAnthropicAccess(auth);
      if (anthropicAuth?.access) {
        const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            "Authorization": `Bearer ${anthropicAuth.access}`,
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const data = await response.json() as AnthropicUsageResponse;
          const fiveHour = data.five_hour;
          const sevenDay = data.seven_day;
          updateState({
            provider: "anthropic",
            fiveHourRemaining: fiveHour ? clampPercent(100 - (fiveHour.utilization ?? 0)) : null,
            fiveHourReset: fiveHour?.resets_at ? new Date(fiveHour.resets_at) : null,
            sevenDayRemaining: sevenDay ? clampPercent(100 - (sevenDay.utilization ?? 0)) : null,
            sevenDayReset: sevenDay?.resets_at ? new Date(sevenDay.resets_at) : null,
            resetsAvailable: 0,
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const data = await response.json() as OpenAIUsageResponse;
          if (data.rate_limit) {
            const primary = data.rate_limit.primary_window;
            const secondary = data.rate_limit.secondary_window;
            const resetsAvailable = data.rate_limit_reset_credits?.available_count;
            updateState({
              provider: "openai-codex",
              fiveHourRemaining: primary ? clampPercent(100 - (primary.used_percent ?? 0)) : null,
              fiveHourReset: primary?.reset_at ? new Date(primary.reset_at * 1000) : null,
              sevenDayRemaining: secondary ? clampPercent(100 - (secondary.used_percent ?? 0)) : null,
              sevenDayReset: secondary?.reset_at ? new Date(secondary.reset_at * 1000) : null,
              resetsAvailable: resetsAvailable !== undefined ? Math.max(0, Math.trunc(resetsAvailable)) : 0,
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

  async function tryAutoRedeemCodexReset() {
    const config = await loadConfig();
    if (!config?.codexResets?.autoRedeem) return;

    const codexState = states.find(s => s.provider === "openai-codex");
    if (!codexState) return;

    // Reset the flag when the weekly window recovers
    if (codexState.sevenDayRemaining !== null && codexState.sevenDayRemaining > 0) {
      codexRedeemAttempted = false;
    }

    // Only redeem if weekly is exhausted and we haven't tried yet
    if (codexState.sevenDayRemaining !== 0) return;
    if (codexState.resetsAvailable === 0) return;
    if (codexRedeemAttempted) return;

    codexRedeemAttempted = true;

    const auth = await loadAuth();
    if (!auth) return;

    const openaiAuth = await ensureOpenAIAccess(auth);
    if (!openaiAuth?.access) return;

    ctxRef?.ui.notify("pi-quota: weekly limit exhausted, redeeming saved reset...", "info");

    const creditList = await listCodexResetCredits(openaiAuth.access);
    if (!creditList || creditList.credits.length === 0) {
      logError("No reset credits available despite reported count");
      return;
    }

    const availableCredit = creditList.credits.find(c => c.status === "available" || !c.status);
    if (!availableCredit) {
      logError("No available reset credit found");
      return;
    }

    const result = await consumeCodexResetCredit(openaiAuth.access, availableCredit.id);
    if (!result) {
      ctxRef?.ui.notify("pi-quota: failed to redeem reset", "warning");
      return;
    }

    if (result.code === "reset") {
      ctxRef?.ui.notify("pi-quota: saved reset redeemed successfully", "info");
      await pollQuotaStatus();
      updateWidget();
    } else {
      logError(`Reset redeem returned code: ${result.code}`);
      ctxRef?.ui.notify(`pi-quota: reset redeem failed (${result.code})`, "warning");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    clearResetTimers();
    states.length = 0;
    refreshNotified.clear();
    lastSeenRemaining.anthropic = { fiveHour: null, sevenDay: null };
    lastSeenRemaining["openai-codex"] = { fiveHour: null, sevenDay: null };
    ctxRef = ctx;
    codexRedeemAttempted = false;
    heartbeatGen++;
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    stopWatcher();
    // If this process was main in a previous session, drop our own lease so the
    // fresh election starts clean instead of seeing our stale self-owned record.
    await releaseLeader(selfPid, selfHost);
    isMain = false;

    scheduleHeartbeat();
    await heartbeatTick();
    if (!isMain) startWatcher();
  });

  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatGen++;
    clearResetTimers();
    stopWatcher();
    if (isMain) await releaseLeader(selfPid, selfHost);
    isMain = false; // ensure any in-flight check/cycle callback won't act as leader
  });
}
