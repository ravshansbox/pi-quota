# Telegram Quota-Reset Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a Telegram message whenever an Anthropic or OpenAI Codex usage window (5h or 7d) resets, deduplicated across multiple pi instances.

**Architecture:** All work lives in the single-file extension `index.ts` (the package ships only this file). Detection compares the per-window reset timestamp across polls; a precise per-reset timer fires near the actual reset time, with the 10-minute poll as a safety net. Cross-instance duplicates are prevented by a persistent notified-record file guarded by a short-lived lockfile; the message is sent while holding the lock and the record is written only after a confirmed HTTP success.

**Tech Stack:** TypeScript, Node `fs/promises`, global `fetch`, pi extension API. Reference spec: `docs/2026-06-27-telegram-quota-reset-notifications-design.md`.

**Testing note:** Per project decision, **no test files are added to the repo**. Each task is verified with `npx tsc --noEmit` (must exit 0) plus targeted reading. Run `npm install` once before starting if `node_modules` is absent.

---

## File Structure

- Modify: `index.ts` — all new types, helpers, detection, timers, and wiring.
- Modify: `README.md` — document the new `telegramBotToken` / `telegramChatId` config and behavior.

All new code is added inside the existing single default-export function unless noted as module-level (imports, constants, pure helpers).

---

### Task 1: Imports, config types, and path/constant helpers

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Extend the `node:fs/promises` import**

Find the existing import line near the top of `index.ts`:

```ts
import { readFile, writeFile, appendFile } from "node:fs/promises";
```

Replace it with:

```ts
import { readFile, writeFile, appendFile, open, unlink, stat } from "node:fs/promises";
```

- [ ] **Step 2: Add Telegram fields to `QuotaConfig`**

Find:

```ts
interface QuotaConfig {
  codexResets?: {
    autoRedeem?: boolean;
  };
}
```

Replace with:

```ts
interface QuotaConfig {
  codexResets?: {
    autoRedeem?: boolean;
  };
  telegramBotToken?: string;
  telegramChatId?: string;
}
```

- [ ] **Step 3: Add a window-key type and reset-notification constants (module level)**

Immediately after the `REQUEST_TIMEOUT_MS` constant:

```ts
const REQUEST_TIMEOUT_MS = 30_000;
```

add:

```ts
type WindowKey = "fiveHour" | "sevenDay";

const WINDOW_LABELS: Record<WindowKey, string> = {
  fiveHour: "5h",
  sevenDay: "7d",
};

const RESET_TIMER_BUFFER_MS = 30_000;
const LOCK_STALE_MS = 60_000;

type NotifiedRecord = Record<string, Partial<Record<WindowKey, number>>>;
```

- [ ] **Step 4: Add path helpers next to the existing `logPath` helper (module level)**

Find:

```ts
function logPath() {
  return join(homedir(), ".pi", "agent", "pi-quota.log");
}
```

Add directly below it:

```ts
function notifiedPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-notified.json");
}

function lockPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-notified.lock");
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: add telegram config and reset-notification scaffolding"
```

---

### Task 2: Notified-record and lockfile helpers

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add notified-record load/save helpers (module level)**

Directly below the `lockPath()` helper added in Task 1:

```ts
async function loadNotified(): Promise<NotifiedRecord> {
  try {
    return JSON.parse(await readFile(notifiedPath(), "utf-8")) as NotifiedRecord;
  } catch {
    return {};
  }
}

async function saveNotified(record: NotifiedRecord): Promise<void> {
  await writeFile(notifiedPath(), JSON.stringify(record, null, 2));
}
```

- [ ] **Step 2: Add lock acquire/release helpers (module level)**

Directly below `saveNotified`:

```ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add notified-record and lockfile helpers"
```

---

### Task 3: Telegram send helper and message builder

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add the Telegram send helper (module level)**

Directly below `releaseLock`:

```ts
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
```

- [ ] **Step 2: Add the message builder (module level)**

This depends on `QuotaState` (already defined above in the file) and the existing `PROVIDER_LABELS` and `formatResetTime`. Add directly below `sendTelegram`:

```ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add telegram send helper and reset message builder"
```

---

### Task 4: Reset detection state and notify orchestration

**Files:**
- Modify: `index.ts`

These additions go **inside** the default export function (the one that starts `export default function (pi: ExtensionAPI) {`), alongside the existing `const states: QuotaState[] = []` declarations.

- [ ] **Step 1: Add in-memory detection state**

Find:

```ts
  const states: QuotaState[] = [];
  const refreshNotified = new Set<string>();
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let ctxRef: ExtensionContext | null = null;
  let codexRedeemAttempted = false;
```

Replace with:

```ts
  const states: QuotaState[] = [];
  const refreshNotified = new Set<string>();
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let ctxRef: ExtensionContext | null = null;
  let codexRedeemAttempted = false;

  const lastSeenReset: Record<string, Record<WindowKey, number | null>> = {
    anthropic: { fiveHour: null, sevenDay: null },
    "openai-codex": { fiveHour: null, sevenDay: null },
  };
  let telegramEnabled = false;
  const resetTimers: ReturnType<typeof setTimeout>[] = [];
```

- [ ] **Step 2: Add the per-reset notify orchestration function**

Add this function inside the default export function, directly above the existing `async function pollQuotaStatus()`:

```ts
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
      await saveNotified(notified);
      return true;
    } finally {
      await releaseLock();
    }
  }
```

- [ ] **Step 3: Add the detection loop**

Add this function inside the default export function, directly below `attemptNotify`:

```ts
  async function processResets() {
    const config = await loadConfig();
    telegramEnabled = !!(config?.telegramBotToken && config?.telegramChatId);
    if (!telegramEnabled || !config) return;

    const botToken = config.telegramBotToken!;
    const chatId = config.telegramChatId!;

    for (const state of states) {
      const seen = lastSeenReset[state.provider];
      if (!seen) continue;
      for (const window of ["fiveHour", "sevenDay"] as const) {
        const resetDate = window === "fiveHour" ? state.fiveHourReset : state.sevenDayReset;
        if (!resetDate) continue;
        const newResetMs = resetDate.getTime();
        const prev = seen[window];
        if (prev === null) {
          seen[window] = newResetMs;
          continue;
        }
        if (newResetMs > prev) {
          const handled = await attemptNotify(state, window, newResetMs, botToken, chatId);
          if (handled) seen[window] = newResetMs;
        }
      }
    }
  }
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: detect window resets and notify via telegram with cross-instance dedup"
```

---

### Task 5: Scheduled reset timers

**Files:**
- Modify: `index.ts`

These additions go inside the default export function.

- [ ] **Step 1: Add timer clear/schedule helpers**

Add directly below the `processResets` function from Task 4:

```ts
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
```

> Note: `runCycle` is defined in Task 6. TypeScript hoists function declarations, so referencing it here is fine as long as both live in the same scope.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output. (If `runCycle` is reported as not found, complete Task 6 Step 1 first, then re-run — these two tasks form one compilable unit.)

- [ ] **Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: schedule precise per-window reset timers"
```

---

### Task 6: Wire detection and timers into the poll cycle and lifecycle

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add a unified `runCycle` function**

Add directly below `scheduleResetTimers` from Task 5 (inside the default export function):

```ts
  async function runCycle() {
    await pollQuotaStatus();
    await tryAutoRedeemCodexReset();
    await processResets();
    updateWidget();
    scheduleResetTimers();
  }
```

- [ ] **Step 2: Replace the `session_start` scheduling body to use `runCycle`**

Find this block inside the `pi.on("session_start", ...)` handler:

```ts
    const scheduleCheck = () => {
      const next = nextMarkAfter(new Date());
      const delay = Math.max(0, next.getTime() - Date.now());
      checkTimer = setTimeout(async () => {
        await pollQuotaStatus();
        await tryAutoRedeemCodexReset();
        updateWidget();
        scheduleCheck();
      }, delay);
    };

    const refresh = async () => {
      await pollQuotaStatus();
      await tryAutoRedeemCodexReset();
      updateWidget();
    };

    void refresh();
    scheduleCheck();
```

Replace with:

```ts
    const scheduleCheck = () => {
      const next = nextMarkAfter(new Date());
      const delay = Math.max(0, next.getTime() - Date.now());
      checkTimer = setTimeout(async () => {
        await runCycle();
        scheduleCheck();
      }, delay);
    };

    void runCycle();
    scheduleCheck();
```

- [ ] **Step 3: Reset detection state on `session_start`**

Find this block at the start of the `pi.on("session_start", ...)` handler:

```ts
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    states.length = 0;
    refreshNotified.clear();
    ctxRef = ctx;
    codexRedeemAttempted = false;
```

Replace with:

```ts
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    clearResetTimers();
    states.length = 0;
    refreshNotified.clear();
    lastSeenReset.anthropic = { fiveHour: null, sevenDay: null };
    lastSeenReset["openai-codex"] = { fiveHour: null, sevenDay: null };
    ctxRef = ctx;
    codexRedeemAttempted = false;
```

- [ ] **Step 4: Clear reset timers on `session_shutdown`**

Find:

```ts
  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  });
```

Replace with:

```ts
  pi.on("session_shutdown", async () => {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    clearResetTimers();
  });
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: wire reset detection and timers into poll cycle and lifecycle"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the configuration**

Find the configuration table in `README.md`:

```markdown
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| _None_ | — | — | The extension has no user-facing configuration. The 10-minute polling cadence is fixed. |
```

Replace with:

```markdown
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `quota.telegramBotToken` | No | — | Telegram bot token. Required (with `telegramChatId`) to enable reset notifications. |
| `quota.telegramChatId` | No | — | Telegram chat ID that receives reset notifications. |

If both `quota.telegramBotToken` and `quota.telegramChatId` are set in `~/.pi/agent/settings.json`, the extension sends a Telegram message whenever a 5-hour or 7-day window resets. If either is missing, notifications are disabled and behavior is unchanged. The 10-minute polling cadence is fixed.

```json
{
  "quota": {
    "telegramBotToken": "123456:ABC-...",
    "telegramChatId": "987654321"
  }
}
```
```

- [ ] **Step 2: Document the behavior**

Find the `## Behaviour` list in `README.md` and add these bullets at the end of that list:

```markdown
- When Telegram is configured, sends a message whenever a 5h or 7d window resets (one message per window), naming the window that reset and showing both windows' current state, e.g. `claude 5h window reset\n5h: 100% left (5h 0m)\n7d: 89% left (1d 13h)`
- Fires near the actual reset time via a scheduled timer (~30s buffer), with the 10-minute poll as a safety net
- Deduplicates notifications across multiple pi instances using `~/.pi/agent/pi-quota-notified.json` guarded by a short-lived lockfile; the message is sent while the lock is held and the record is written only after a confirmed send, so concurrent instances never send duplicates and transient failures are retried
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document telegram reset notifications"
```

---

## Self-Review

**Spec coverage:**
- Config `telegramBotToken`/`telegramChatId` under `quota`, silent-disable → Task 1 Step 2, Task 4 Step 3.
- Detection (baseline → rollover → unchanged) → Task 4 Step 3.
- Scheduled reset timers with +30s buffer, skip past/duplicate, 10-min safety net → Task 5; safety net via `runCycle` on the 10-min timer → Task 6 Step 2.
- Message format (which window + both windows) → Task 3 Step 2.
- Delivery via Telegram `sendMessage`, 30s timeout, log on failure, never throw → Task 3 Step 1.
- Concurrency: notified-file + lockfile, send-under-lock, mark-on-success-only, 60s stale TTL → Task 2, Task 4 Step 2.
- Lifecycle: clear in-memory state + timers on start (notified file persists), clear timers on shutdown → Task 6 Steps 3–4.
- Edge cases: disabled → no timers/sends (Task 4 Step 3, Task 5 Step 1); null reset time skipped (Task 4 Step 3, Task 5 Step 1).

**Placeholder scan:** No TBD/TODO; all code blocks are complete.

**Type consistency:** `WindowKey` (`fiveHour`/`sevenDay`), `NotifiedRecord`, `lastSeenReset`, `attemptNotify`, `processResets`, `scheduleResetTimers`, `clearResetTimers`, `runCycle`, `buildResetMessage`, `sendTelegram`, `acquireLock`, `releaseLock`, `loadNotified`, `saveNotified` are used consistently across tasks. `runCycle` forward-reference handled by hoisting (noted in Task 5).
