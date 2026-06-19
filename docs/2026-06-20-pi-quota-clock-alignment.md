# pi-quota Clock-Aligned Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the relative-interval polling in `pi-quota` with an absolute, wall-clock-aligned schedule that fires on every 10-minute mark of the local hour (`HH:00, HH:10, HH:20, HH:30, HH:40, HH:50`). Drop the now-redundant `pollIntervalMs` configuration field.

**Architecture:** A new `nextMarkAfter(time)` helper computes the next 10-minute wall-clock mark strictly after a given `Date`. The `session_start` handler still runs an immediate poll, then schedules subsequent polls with `setTimeout` for the duration from the post-poll time to the next mark. The 10-minute cadence becomes a fixed invariant — no longer configurable, no minimum-interval validation. The pre-existing single-`setTimeout` invariant is preserved, so a slow poll that crosses a mark naturally skips it without overlapping.

**Tech Stack:** TypeScript (Node ≥ 22, ESM, `strict` mode), `node --test` runner. No new dependencies.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `index.ts` | Modify | Add `nextMarkAfter`; drop `pollIntervalMs`, `MIN_POLL_INTERVAL_MS`, `DEFAULT_POLL_INTERVAL_MS`; rewire `session_start`'s `scheduleCheck` to align to marks. |
| `clock-alignment.test.mjs` | Create | Source-grep tests asserting the new helper, the absence of the old config plumbing, and the new `scheduleCheck` shape. Mirrors the style of `no-blocking-apis.test.mjs`. |
| `README.md` | Modify | Drop the `pollIntervalMs` row from the configuration table, drop it from the install-snippet example, update the "Behaviour" bullet. |

The single-file extension layout from the existing design (`docs/2026-06-13-pi-quota-design.md`) is preserved.

---

## Task 1: Add failing tests for clock-aligned scheduling

**Files:**
- Create: `clock-alignment.test.mjs`

- [ ] **Step 1: Create the new test file**

Create `clock-alignment.test.mjs` at the repository root with the following contents:

```javascript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

const sessionStartIdx = source.indexOf('pi.on("session_start"');
const sessionShutdownIdx = source.indexOf('pi.on("session_shutdown"');
assert.notStrictEqual(sessionStartIdx, -1, 'session_start handler must exist');
assert.notStrictEqual(sessionShutdownIdx, -1, 'session_shutdown handler must exist');
const sessionStartSource =
  sessionStartIdx < sessionShutdownIdx
    ? source.slice(sessionStartIdx, sessionShutdownIdx)
    : source.slice(sessionStartIdx);

test('nextMarkAfter helper is defined and has the expected signature', () => {
  assert.match(
    source,
    /function\s+nextMarkAfter\s*\(\s*time\s*:\s*Date\s*\)\s*:\s*Date/,
  );
});

test('pollIntervalMs has been removed from QuotaConfig and the session handler', () => {
  assert.doesNotMatch(source, /pollIntervalMs/);
});

test('legacy poll interval constants have been removed', () => {
  assert.doesNotMatch(source, /MIN_POLL_INTERVAL_MS/);
  assert.doesNotMatch(source, /DEFAULT_POLL_INTERVAL_MS/);
});

test('scheduleCheck aligns to the next wall-clock mark after each poll', () => {
  assert.match(
    sessionStartSource,
    /scheduleCheck[\s\S]{0,400}?nextMarkAfter\([\s\S]{0,80}?new Date\(\)[\s\S]{0,200}?Math\.max\(0,/,
  );
});

test('session_start still kicks off an immediate poll in the background', () => {
  assert.match(sessionStartSource, /void\s+refresh\(\)/);
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `node --test clock-alignment.test.mjs`
Expected: FAIL. Every test should report a failure because the source still references `pollIntervalMs`, lacks `nextMarkAfter`, and the `scheduleCheck` shape does not match the new regex.

- [ ] **Step 3: Commit the failing test**

```bash
git add clock-alignment.test.mjs
git -c user.name=ravshansbox -c user.email=ravshansbox@gmail.com commit -m "test: cover clock-aligned polling structure"
```

---

## Task 2: Implement clock-aligned scheduling in `index.ts`

**Files:**
- Modify: `index.ts` (drop `pollIntervalMs` config field, drop the two interval constants, add `nextMarkAfter`, rewire `scheduleCheck`)

- [ ] **Step 1: Drop `pollIntervalMs` from `QuotaConfig`**

In `index.ts`, locate the `QuotaConfig` interface and remove the `pollIntervalMs?: number;` line. The interface should now read:

```typescript
interface QuotaConfig {
  codexResets?: {
    autoRedeem?: boolean;
  };
}
```

- [ ] **Step 2: Drop the two interval constants**

In `index.ts`, locate the two lines:

```typescript
const DEFAULT_POLL_INTERVAL_MS = 600_000;
const MIN_POLL_INTERVAL_MS = 60_000;
```

Delete both lines. The `REQUEST_TIMEOUT_MS = 30_000` constant immediately above them stays.

- [ ] **Step 3: Add the `nextMarkAfter` helper**

Immediately after the deleted constant lines, add:

```typescript
function nextMarkAfter(time: Date): Date {
  const next = new Date(time.getTime());
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  const bump = 10 - (minute % 10);
  next.setMinutes(minute + (bump === 0 ? 10 : bump));
  return next;
}
```

- [ ] **Step 4: Rewire `session_start` to drop `pollIntervalMs` validation and use `nextMarkAfter`**

In the `pi.on("session_start", ...)` handler, locate the existing `loadConfig` / `intervalMs` / `MIN_POLL_INTERVAL_MS` validation block:

```typescript
    const config = await loadConfig();
    let intervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (typeof intervalMs !== "number" || intervalMs < MIN_POLL_INTERVAL_MS) {
      ctx.ui.notify(
        `pi-quota: pollIntervalMs must be a number >= ${MIN_POLL_INTERVAL_MS}; using default ${DEFAULT_POLL_INTERVAL_MS}`,
        "warning",
      );
      intervalMs = DEFAULT_POLL_INTERVAL_MS;
    }

    const scheduleCheck = () => {
      checkTimer = setTimeout(async () => {
        await pollQuotaStatus();
        await tryAutoRedeemCodexReset();
        updateWidget();
        scheduleCheck();
      }, intervalMs);
    };
```

Replace the entire block with the version below (the `config`/`loadConfig` call is no longer needed here; if no other config fields are referenced after this change, the call can be dropped entirely — see step 5):

```typescript
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
```

Leave the `void refresh();` and `scheduleCheck();` calls at the bottom of the handler untouched.

- [ ] **Step 5: Remove the now-unused `loadConfig` call if no other config fields are referenced**

After step 4, `loadConfig` is only called once, in `session_start`, and its return value is no longer used. Remove the `const config = await loadConfig();` line and, if `loadConfig` has no other call sites in the file, remove the `loadConfig` function definition as well. Confirm with:

Run: `grep -n "loadConfig" index.ts`
Expected: no matches.

If `loadConfig` is still referenced elsewhere, leave the function in place and only delete the `const config = ...` line in `session_start`.

- [ ] **Step 6: Run the tests to confirm they now pass**

Run: `node --test`
Expected: PASS for all tests in `no-blocking-apis.test.mjs` and `clock-alignment.test.mjs`. The package's `npm test` script runs `node --test`, which discovers all `*.test.mjs` files in the repository root.

- [ ] **Step 7: Type-check the file**

Run: `npx tsc --noEmit`
Expected: clean exit, no errors. The file is consumed by pi directly; a clean type-check confirms the strict-mode types (in particular the `nextMarkAfter` return type and the `setTimeout` callback) are sound.

- [ ] **Step 8: Commit**

```bash
git add index.ts
git -c user.name=ravshansbox -c user.email=ravshansbox@gmail.com commit -m "refactor: align polling to wall-clock 10-minute marks"
```

---

## Task 3: Update README to drop `pollIntervalMs` and document the new behaviour

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Drop `pollIntervalMs` from the install-snippet example**

In `README.md`, replace the install-snippet:

```json
{
  "packages": [
    "git:github.com/ravshansbox/pi-quota"
  ],
  "quota": {
    "pollIntervalMs": 600000
  }
}
```

with:

```json
{
  "packages": [
    "git:github.com/ravshansbox/pi-quota"
  ]
}
```

- [ ] **Step 2: Drop the `pollIntervalMs` row from the configuration table**

In `README.md`, replace the configuration table:

```markdown
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `pollIntervalMs` | No | 600000 | Quota polling interval in milliseconds, minimum 60000. Invalid values fall back to the default with a warning |
```

with the table header followed by an empty body (the extension no longer has user-facing configuration):

```markdown
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| _None_ | — | — | The extension has no user-facing configuration. The 10-minute polling cadence is fixed. |
```

- [ ] **Step 3: Update the "Behaviour" bullet**

In `README.md`, locate the line:

```markdown
- Polls Anthropic and OpenAI Codex usage endpoints every 10 minutes by default
```

Replace it with:

```markdown
- Polls Anthropic and OpenAI Codex usage endpoints at every 10-minute wall-clock mark (`HH:00`, `HH:10`, `HH:20`, `HH:30`, `HH:40`, `HH:50`); polls immediately on session start, then aligns to the next mark
```

- [ ] **Step 4: Re-read the README to confirm the change is internally consistent**

Run: `grep -n "pollIntervalMs" README.md`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add README.md
git -c user.name=ravshansbox -c user.email=ravshansbox@gmail.com commit -m "docs: document clock-aligned polling"
```

---

## Task 4: Final verification

**Files:** _none — verification only_

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: all tests in `no-blocking-apis.test.mjs` and `clock-alignment.test.mjs` pass.

- [ ] **Step 2: Type-check the extension**

Run: `npx tsc --noEmit`
Expected: clean exit, no errors.

- [ ] **Step 3: Confirm no stray references remain**

Run: `grep -rn "pollIntervalMs" .`
Expected: no matches in the tracked source (the test committed in Task 1 deliberately does not reference it).

- [ ] **Step 4: Inspect the resulting git history**

Run: `git log --oneline -5`
Expected: the most recent commits are the two from Tasks 2 and 3, sitting on top of the existing `3a67cd7` (or whatever the latest commit is at the time of execution).
