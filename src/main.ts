/**
 * Reproduction: Effect Workflow crash recovery does not resume
 *
 * Setup:
 *   pnpm install
 *   pnpm run db:up
 *
 * Steps:
 *   1. pnpm start
 *   2. Wait for "[activity2] Sleeping 5s — KILL NOW"
 *   3. Ctrl+C
 *   4. pnpm start  (do NOT reset the DB)
 *   5. Observe: Activity1 replays from cache, Activity2 never executes
 *
 * To start fresh: pnpm run db:clean
 */

import { Effect, Layer, Option, Schema, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import {
	ClusterWorkflowEngine,
	RunnerHealth,
	Runners,
	RunnerStorage,
	Sharding,
	ShardingConfig,
	SqlMessageStorage,
} from "effect/unstable/cluster";
import { Activity, Workflow } from "effect/unstable/workflow";

// ---------------------------------------------------------------------------
// Workflow: two sequential Activities
// ---------------------------------------------------------------------------

const MyWorkflow = Workflow.make({
	name: "MyWorkflow",
	payload: { jobId: Schema.String },
	// Fixed key — same execution ID across restarts
	idempotencyKey: (payload) => payload.jobId,
});

const MyWorkflowLayer = MyWorkflow.toLayer(
	Effect.fn(function* (payload) {
		console.log(`\n[workflow] started for job ${payload.jobId}`);

		// Activity 1: fast
		const data = yield* Activity.make({
			name: "GatherData",
			success: Schema.Unknown,
			execute: Effect.gen(function* () {
				console.log("[activity1] GatherData executing...");
				yield* Effect.sleep("1 second");
				console.log("[activity1] GatherData done");
				return { items: ["a", "b", "c"] };
			}),
		}).asEffect();

		console.log(`[workflow] GatherData result: ${JSON.stringify(data)}`);

		// Activity 2: slow — kill the process here to test recovery
		const result = yield* Activity.make({
			name: "ProcessData",
			success: Schema.Unknown,
			execute: Effect.gen(function* () {
				console.log("\n[activity2] ProcessData executing...");
				console.log("[activity2] Sleeping 5s — KILL NOW (Ctrl+C)\n");
				yield* Effect.sleep("5 seconds");
				console.log("[activity2] ProcessData done");
				return { processed: true };
			}),
		}).asEffect();

		console.log(`[workflow] ProcessData result: ${JSON.stringify(result)}`);
		console.log("\n=== WORKFLOW COMPLETED SUCCESSFULLY ===\n");
	}),
);

// ---------------------------------------------------------------------------
// Cluster: single-runner, Postgres storage
// ---------------------------------------------------------------------------

const POSTGRES_URL =
	process.env.POSTGRES_URL ??
	"postgresql://postgres:dev@localhost:5432/repro";

const ClusterLive = ClusterWorkflowEngine.layer.pipe(
	Layer.provideMerge(Sharding.layer),
	Layer.provide(Runners.layerNoop),
	Layer.provideMerge(SqlMessageStorage.layer),
	Layer.provide(RunnerStorage.layerMemory),
	Layer.provide(RunnerHealth.layerNoop),
	Layer.provide(
		ShardingConfig.layer({
			shardsPerGroup: 10,
			entityMailboxCapacity: 50,
			entityMessagePollInterval: "5 seconds",
		}),
	),
);

const MainLayer = MyWorkflowLayer.pipe(
	Layer.provideMerge(ClusterLive),
	Layer.provide(PgClient.layer({ url: Redacted.make(POSTGRES_URL) })),
);

// ---------------------------------------------------------------------------
// Main: trigger workflow only if not already completed
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
	console.log("[main] Cluster initialized");

	// Check if this workflow already completed (fixed idempotency key)
	const existing = yield* MyWorkflow.poll("test-job-1");
	if (Option.isSome(existing)) {
		console.log("[main] Workflow already completed — run 'pnpm run db:reset' to start fresh");
		yield* Effect.never;
	}

	console.log("[main] Triggering workflow...");
	yield* MyWorkflow.execute({ jobId: "test-job-1" }, { discard: true });
	console.log("[main] Waiting for completion (or kill to test crash recovery)...\n");

	yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.provide(MainLayer)));
