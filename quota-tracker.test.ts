import test from "node:test";
import assert from "node:assert/strict";
import { formatQuotaStatus } from "./quota-tracker.ts";
import type { QuotaState } from "./quota-tracker.ts";

function makeState(overrides: Partial<QuotaState> = {}): QuotaState {
  return {
    provider: "openai",
    fiveHourRemaining: 30,
    fiveHourReset: new Date(Date.now() + 4 * 60 * 60 * 1000 + 39 * 60 * 1000),
    sevenDayRemaining: 89,
    sevenDayReset: new Date(Date.now() + 37 * 60 * 60 * 1000),
    lastUpdated: new Date(),
    ...overrides,
  };
}

test("formatQuotaStatus uses compact one-line format", () => {
  const text = formatQuotaStatus([makeState()]);
  assert.match(text, /^openai-codex: 7d: 89% left \(.+\), 5h: 30% left \(.+\)$/);
  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes("█"), false);
});
