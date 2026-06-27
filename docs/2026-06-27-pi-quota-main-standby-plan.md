# pi-quota main/standby coordination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exactly one pi-quota instance (main) poll providers, refresh auth, auto-redeem, and notify; other instances (standby) render the same widget from a shared state file. Show the role in the widget.

**Architecture:** A file-based leader lease (`pi-quota-leader.json`) elected via exclusive-create with 60s staleness and a 20s heartbeat. Main writes quota results to a shared state file (`pi-quota-state.json`); standbys `fs.watch` it and render. All work in the existing single file `index.ts`.

**Tech Stack:** TypeScript, Node `fs/promises`, pi extension API, pi-tui.

**Testing note:** This extension has no automated test suite by design (external HTTP APIs + pi runtime events). Each task ends with a manual verification step and a commit.

Reference spec: `docs/2026-06-27-pi-quota-main-standby-design.md`

---

### Task 1: Leader lease primitives

**Files:**
- Modify: `index.ts` (add path helper near `lockPath()`, ~line 175; add lease helpers near `acquireLock`, ~line 195)

- [ ] **Step 1: Add the leader file path helper**

Add next to the other path helpers (after `lockPath()`):

```ts
function leaderPath() {
  return join(homedir(), ".pi", "agent", "pi-quota-leader.json");
}
```

- [ ] **Step 2: Add the lease record type**

Add near the other top-level types (after `NotifiedRecord`, ~line 105):

```ts
type LeaderRecord = {
  pid: number;
  hostname: string;
  heartbeatAt: number;
};

const HEARTBEAT_INTERVAL_MS = 20_000;
const LEASE_STALE_MS = 60_000;
```

- [ ] **Step 3: Add lease read/claim/renew/release helpers**

Add after `releaseLock()` (module scope, alongside the other file helpers):

```ts
async function readLeader(): Promise<LeaderRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(leaderPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
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
  try {
    const handle = await open(leaderPath(), "wx");
    await handle.close();
    await writeLeader(record);
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
      const handle = await open(leaderPath(), "wx");
      await handle.close();
      await writeLeader(record);
      return true;
    } catch {
      return false;
    }
  }
}

async function releaseLeader(pid: number): Promise<void> {
  const existing = await readLeader();
  if (existing && existing.pid === pid) {
    await unlink(leaderPath()).catch(() => {});
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/ravshan/Projects/pi-quota && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: add leader lease primitives for pi-quota"
```

---

### Task 2: Shared state serialization

**Files:**
- Modify: `index.ts` (add path helper + serialize/deserialize near the other file helpers)

- [ ] **Step 1: Add the state file path helper**

Add next to `leaderPath()`:

```ts
function statePath() {
  return join(homedir(), ".pi", "agent", "pi-quota-state.json");
}
```

- [ ] **Step 2: Add the serialized state type**

Add near `LeaderRecord`:

```ts
type SerializedQuotaState = {
  provider: QuotaState["provider"];
  fiveHourRemaining: number | null;
  fiveHourReset: string | null;
  sevenDayRemaining: number | null;
  sevenDayReset: string | null;
  resetsAvailable: number;
  lastUpdated: string;
};
```

- [ ] **Step 3: Add write + read helpers (module scope)**

```ts
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
    await writeFile(statePath(), JSON.stringify(serializeStates(states), null, 2));
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
```

- [ ] **Step 2 check + Commit**

Run: `cd /Users/ravshan/Projects/pi-quota && npx tsc --noEmit` (expect no errors), then:

```bash
git add index.ts
git commit -m "feat: add shared quota state serialization"
```

---

### Task 3: Role state and election loop

**Files:**
- Modify: `index.ts` inside the default export closure (state vars near top of `export default function`, ~line 248; new functions; `session_start`/`session_shutdown` handlers)

- [ ] **Step 1: Add role state variables**

Inside the default export closure, alongside the existing `let` declarations (near `let cycleRunning = false;`):

```ts
let isMain = false;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let stateWatcher: import("node:fs").FSWatcher | null = null;
const selfPid = process.pid;
const selfHost = require("node:os").hostname();
```

Note: `hostname` is already importable; replace the `require` with a top-of-file import if preferred:
add `hostname` to the existing `import { homedir } from "node:os";` → `import { homedir, hostname } from "node:os";` and use `const selfHost = hostname();`.

- [ ] **Step 2: Add the election + heartbeat function**

Inside the closure:

```ts
async function heartbeatTick() {
  const record: LeaderRecord = { pid: selfPid, hostname: selfHost, heartbeatAt: Date.now() };
  if (isMain) {
    const existing = await readLeader();
    if (existing && existing.pid !== selfPid) {
      await becomeStandby();
      return;
    }
    await writeLeader(record);
  } else {
    const won = await claimLeader(record);
    if (won) await becomeMain();
  }
}

function scheduleHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(async () => {
    await heartbeatTick();
    scheduleHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}
```

`becomeMain` and `becomeStandby` are defined in Task 5. Leave a forward reference; they live in the same closure so ordering is fine at call time.

- [ ] **Step 3: Verify compile + Commit**

Run: `cd /Users/ravshan/Projects/pi-quota && npx tsc --noEmit`
Expected: errors only for not-yet-defined `becomeMain`/`becomeStandby` (added next task). If you implement Task 4–5 in the same session, run the check after Task 5.

```bash
git add index.ts
git commit -m "feat: add role state and heartbeat election loop"
```

---

### Task 4: Gate work behind main role and write shared state

**Files:**
- Modify: `index.ts` — `runCycle()` (~line 425)

- [ ] **Step 1: Guard runCycle and persist state on main**

Change `runCycle` so only main does work and writes the state file:

```ts
async function runCycle() {
  if (!isMain) return;            // standbys never poll
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await pollQuotaStatus();
    await tryAutoRedeemCodexReset();
    await processResets();
    await writeSharedState(states);
    updateWidget();
    scheduleResetTimers();
  } catch (error) {
    await logError("Run cycle error:", error);
  } finally {
    cycleRunning = false;
  }
}
```

- [ ] **Step 2: Verify compile (after Task 5) + Commit**

```bash
git add index.ts
git commit -m "feat: restrict polling and reset work to the main instance"
```

---

### Task 5: Standby watcher, transitions, and widget header

**Files:**
- Modify: `index.ts` — add `becomeMain`/`becomeStandby`/`startWatcher`/`stopWatcher` in the closure; modify `buildWidgetLines()` (~line 270); modify `session_start`/`session_shutdown` (~line 540).

- [ ] **Step 1: Add transition + watcher functions**

Inside the closure (needs `import { watch } from "node:fs";` added to the top-of-file imports):

```ts
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
  try {
    stateWatcher = watch(statePath(), () => { void refreshFromSharedState(); });
  } catch (error) {
    void logError("State watch error:", error);
  }
}

async function becomeMain() {
  if (isMain) return;
  isMain = true;
  stopWatcher();
  updateWidget();
  void runCycle();
}

async function becomeStandby() {
  if (!isMain) {
    startWatcher();
    return;
  }
  isMain = false;
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  clearResetTimers();
  startWatcher();
  updateWidget();
}
```

Note: the 10-minute poll loop (`checkTimer` via `scheduleCheck`) must only run on main. In `session_start`, move `scheduleCheck()` so it is started inside `becomeMain` instead of unconditionally (see Step 3).

- [ ] **Step 2: Add the role header to the widget**

In `buildWidgetLines()`, prepend a header line before the provider loop. Replace the start of the function:

```ts
  function buildWidgetLines(): WidgetSegment[][] {
    const lines: WidgetSegment[][] = [];
    lines.push([{ role: "muted", text: `quota: ${isMain ? "main" : "standby"}` }]);
    if (states.length === 0 && !isMain) return lines;  // standby header even before first data
    for (const state of states) {
```

Remove the old early `if (states.length === 0) return [];` line. Then in `updateWidget()`, change the empty check so the header still renders:

```ts
    const lines = buildWidgetLines();
    if (lines.length === 0) {
      ctxRef.ui.setWidget("pi-quota", undefined);
      return;
    }
```

(`lines` now always has at least the header, so the widget always shows the role.)

- [ ] **Step 3: Wire scheduleCheck into main only**

In `session_start`, change the poll scheduling. The `scheduleCheck` definition stays, but instead of calling `void runCycle(); scheduleCheck();` at the end, call:

```ts
    scheduleHeartbeat();
    await heartbeatTick();   // immediate election attempt
    if (!isMain) startWatcher();
```

And move `scheduleCheck()` to be invoked from inside `becomeMain` (after `void runCycle();`):

```ts
async function becomeMain() {
  if (isMain) return;
  isMain = true;
  stopWatcher();
  updateWidget();
  void runCycle();
  scheduleCheck();
}
```

For this to compile, hoist `scheduleCheck` so it is defined before `becomeMain` uses it (move the `const scheduleCheck = ...` definition out of the `session_start` handler to the closure scope, capturing `checkTimer`).

- [ ] **Step 4: Release leadership and clean timers on shutdown**

In `session_shutdown`:

```ts
  pi.on("session_shutdown", async () => {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    clearResetTimers();
    stopWatcher();
    if (isMain) await releaseLeader(selfPid);
  });
```

Also reset `isMain = false;` in the `session_start` reset block alongside the other state resets.

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/ravshan/Projects/pi-quota && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification**

1. Start one pi instance → widget shows `quota: main` and provider lines populate.
2. Start a second pi instance → it shows `quota: standby` with the same provider data; `pi-quota.log` / network shows no second poller.
3. Confirm `~/.pi/agent/pi-quota-leader.json` and `pi-quota-state.json` exist.
4. Quit the main instance → within ~60s the standby flips to `quota: main` and begins polling.
5. While both run, confirm a window reset produces exactly one Telegram message.

- [ ] **Step 7: Commit**

```bash
git add index.ts
git commit -m "feat: standby file watcher, role transitions, and widget role header"
```

---

## Self-Review

- **Spec coverage:** leader lease (Task 1, 3), shared state + watch (Task 2, 5), main-only polling/redeem/notify (Task 4), widget header (Task 5), shutdown release/failover (Task 5). All spec sections covered.
- **Placeholder scan:** none — every code step is concrete.
- **Type consistency:** `LeaderRecord`, `SerializedQuotaState`, `QuotaState` used consistently; `isMain`, `claimLeader`, `releaseLeader`, `readLeader`, `writeLeader`, `writeSharedState`, `readSharedState`, `becomeMain`, `becomeStandby`, `startWatcher`, `stopWatcher`, `scheduleHeartbeat`, `heartbeatTick` names match across tasks.
- **Note for implementer:** `scheduleCheck` must be hoisted to closure scope (Task 5 Step 3) so `becomeMain` can call it; do this before running the final `tsc` check.
