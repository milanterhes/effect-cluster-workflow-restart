# Effect Workflow Crash Recovery — Reproduction

In-progress `effect/unstable/workflow` backed by `SqlMessageStorage` does **not** resume after a process restart.

## Setup

```bash
pnpm install
pnpm run db:up
```

## Reproduce

```bash
# 1. Start — wait for Activity2 to begin
pnpm start

# 2. Kill during "Sleeping 5s — KILL NOW"
#    Ctrl+C

# 3. Restart — observe Activity2 never resumes
pnpm start
```

## Expected

```
[workflow] started for job test-job-1
[workflow] GatherData result: {"items":["a","b","c"]}   ← replayed from Postgres
[activity2] ProcessData executing...                     ← re-executed
[activity2] ProcessData done
=== WORKFLOW COMPLETED SUCCESSFULLY ===
```

## Actual

```
[main] Cluster initialized
[main] Triggering workflow...

[workflow] started for job test-job-1
[workflow] GatherData result: {"items":["a","b","c"]}   ← replayed from Postgres
[main] Waiting for completion (or kill to test crash recovery)...
                                                         ← hangs forever
```

## Commands

```bash
pnpm run db:up      # start Postgres
pnpm run db:down    # stop Postgres
pnpm run db:reset   # clear workflow state (keep tables)
pnpm run db:clean   # nuke volume and recreate
```

## Versions

- `effect@4.0.0-beta.52`
- `@effect/sql-pg@4.0.0-beta.52`
- Postgres 17, Node.js 22+


Based on Claude's findings (which I didn't verify):

**On restart, the storage poll fetches both unprocessed messages (`run` + `ProcessData` activity) in a single query and delivers them to the entity sequentially.**

The intended crash recovery flow:
1. `run` message delivered → workflow handler starts as a fiber
2. `ProcessData` activity message delivered → activity handler starts as a forked fiber, creates a latch, waits for the in-memory `activities` map entry
3. Workflow handler replays `GatherData` from cached reply (instant)
4. Workflow handler calls `activityExecute` for `ProcessData` → sets entry in `activities` map, opens latch
5. Activity handler wakes up → executes `ProcessData`

**Where it breaks — step 4:**

`activityExecute` does two things in sequence:
```typescript
// 1. Set entry + open latch (wakes the waiting handler)
activities.set(activityId, { activity, context: services })
latch.release

// 2. Send RPC call and wait for reply
const result = yield* client.activity({ name: "ProcessData", attempt: 1 })
```

`client.activity()` sends a NEW activity message to storage. Storage detects it as a **Duplicate** (same primaryKey `ProcessData/1` from the crashed run). The duplicate handler rewrites the requestId to the original and tries to notify the entity. But the entity already has the OLD activity message in its `activeRequests` → **`AlreadyProcessingMessage` → silently dropped**.

Now `client.activity()` is waiting for a reply. The reply should come from the OLD activity handler (which was woken by the latch at step 4). The OLD handler executes `ProcessData`, writes its reply to storage under the OLD requestId.

But **`client.activity()` is waiting for a reply on the NEW requestId**. The `requestIdRewrites` map bridges new→old for outgoing messages, but the reply routing from the OLD handler back to the NEW client's waiting fiber appears broken — the reply is written to storage under the OLD requestId, and the client's reply polling can't find it under the rewritten ID.

**Result**: `client.activity()` hangs forever. The OLD handler may or may not execute (we don't see its log, suggesting the latch/fiber scheduling may also not work as expected), but even if it does, the reply never reaches the waiting client.

**In short**: the `SaveResult.Duplicate` + `AlreadyProcessingMessage` + `requestIdRewrites` interaction has a bug where the reply from the original message handler never reaches the duplicate message's RPC client.