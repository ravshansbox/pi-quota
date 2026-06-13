import { formatQuotaStatus } from "./quota-tracker.ts";
import type { QuotaConfig, QuotaState } from "./quota-tracker.ts";

export type ResetWindow = "5h" | "7d";

type TimerHandle = unknown;

type TimerRecord = {
  resetAt: number;
  handle: TimerHandle;
};

export type TimerMap = Map<string, TimerRecord>;

export type TimerDeps = {
  setTimer: (fn: () => void | Promise<void>, delay: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  notify: (provider: "anthropic" | "openai", window: ResetWindow, state: QuotaState, config: QuotaConfig) => Promise<boolean>;
  now?: () => number;
};

export function scheduleResetTimers(states: QuotaState[], config: QuotaConfig, deps: TimerDeps): TimerMap {
  const timers: TimerMap = new Map();
  for (const state of states) {
    syncResetTimers(state, config, timers, deps);
  }
  return timers;
}

export function syncResetTimers(state: QuotaState, config: QuotaConfig, timers: TimerMap, deps: TimerDeps) {
  syncWindowTimer(state, "5h", state.fiveHourReset, config, timers, deps);
  syncWindowTimer(state, "7d", state.sevenDayReset, config, timers, deps);
}

export function clearResetTimers(timers: TimerMap, clearTimer: (handle: TimerHandle) => void) {
  for (const timer of timers.values()) {
    clearTimer(timer.handle);
  }
  timers.clear();
}

export async function sendResetNotification(
  provider: "anthropic" | "openai",
  window: ResetWindow,
  state: QuotaState,
  config: QuotaConfig,
  sendTelegram: (config: QuotaConfig, text: string) => Promise<boolean>,
) {
  const label = provider === "openai" ? "openai-codex" : provider;
  const message = `🔄 ${label} ${window} quota reset\n\n${formatQuotaStatus([state])}`;
  return sendTelegram(config, message);
}

function syncWindowTimer(
  state: QuotaState,
  window: ResetWindow,
  reset: Date | null,
  config: QuotaConfig,
  timers: TimerMap,
  deps: TimerDeps,
) {
  const key = `${state.provider}:${window}`;
  const existing = timers.get(key);

  if (!reset) {
    if (existing) {
      deps.clearTimer(existing.handle);
      timers.delete(key);
    }
    return;
  }

  const resetAt = reset.getTime();
  if (existing && existing.resetAt === resetAt) {
    return;
  }

  if (existing) {
    deps.clearTimer(existing.handle);
  }

  const now = deps.now?.() ?? Date.now();
  const delay = Math.max(0, resetAt - now);
  const handle = deps.setTimer(async () => {
    const ok = await deps.notify(state.provider, window, state, config);
    if (ok) {
      timers.delete(key);
    }
  }, delay);

  timers.set(key, { resetAt, handle });
}
