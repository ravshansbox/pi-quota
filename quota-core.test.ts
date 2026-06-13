import test from "node:test";
import assert from "node:assert/strict";
import { scheduleResetTimers, syncResetTimers } from "./quota-core.ts";
import type { QuotaConfig, QuotaState } from "./quota-tracker.ts";

const config: QuotaConfig = {
  botToken: "token",
  chatId: "chat",
};

function makeState(overrides: Partial<QuotaState> = {}): QuotaState {
  return {
    provider: "anthropic",
    fiveHourRemaining: 50,
    fiveHourReset: null,
    sevenDayRemaining: 90,
    sevenDayReset: null,
    lastUpdated: new Date(),
    ...overrides,
  };
}

test("scheduleResetTimers schedules 5h and 7d timers", async () => {
  const calls: Array<{ provider: string; window: string }> = [];
  const scheduled: Array<{ delay: number; fn: () => void }> = [];

  const state = makeState({
    fiveHourReset: new Date(Date.now() + 5_000),
    sevenDayReset: new Date(Date.now() + 10_000),
  });

  const timers = scheduleResetTimers([state], config, {
    setTimer(fn, delay) {
      scheduled.push({ fn, delay });
      return delay;
    },
    clearTimer() {},
    async notify(provider, window) {
      calls.push({ provider, window });
      return true;
    },
  });

  assert.equal(scheduled.length, 2);
  assert.equal(timers.size, 2);

  await scheduled[0]!.fn();
  await scheduled[1]!.fn();

  assert.deepEqual(calls, [
    { provider: "anthropic", window: "5h" },
    { provider: "anthropic", window: "7d" },
  ]);
});

test("syncResetTimers does not reschedule unchanged reset timestamps", () => {
  const scheduled: number[] = [];
  const state = makeState({
    fiveHourReset: new Date("2026-06-13T10:00:00.000Z"),
    sevenDayReset: new Date("2026-06-20T10:00:00.000Z"),
  });

  const timers = scheduleResetTimers([state], config, {
    setTimer(_fn, delay) {
      scheduled.push(delay);
      return delay;
    },
    clearTimer() {},
    async notify() {
      return true;
    },
  });

  syncResetTimers(state, config, timers, {
    setTimer(_fn, delay) {
      scheduled.push(delay);
      return delay;
    },
    clearTimer() {},
    async notify() {
      return true;
    },
  });

  assert.equal(scheduled.length, 2);
});

test("failed notification keeps timer entry for later resync", async () => {
  const scheduled: Array<() => void | Promise<void>> = [];
  const state = makeState({
    fiveHourReset: new Date(Date.now() + 1_000),
  });

  const timers = scheduleResetTimers([state], config, {
    setTimer(fn) {
      scheduled.push(fn);
      return fn;
    },
    clearTimer() {},
    async notify() {
      return false;
    },
  });

  assert.equal(timers.size, 1);
  await scheduled[0]!();
  assert.equal(timers.size, 1);
});
