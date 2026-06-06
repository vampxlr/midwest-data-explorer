/**
 * Seed Convex database from local store.json
 *
 * Usage (after running `npx convex dev` at least once):
 *   node scripts/seedConvex.mjs
 *
 * Requires CONVEX_URL in environment (or .env.local file).
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Load .env.local first, then .env
config({ path: path.join(root, ".env.local") });
config({ path: path.join(root, ".env") });

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error(
    "❌  CONVEX_URL not set. Add it to .env.local after running `npx convex dev`."
  );
  process.exit(1);
}

const STORE_PATH = path.join(root, "server", "data", "store.json");
if (!fs.existsSync(STORE_PATH)) {
  console.error("❌  store.json not found at", STORE_PATH);
  console.error("    Run the aggregation first to fetch data from SportsEngine.");
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
const client = new ConvexHttpClient(CONVEX_URL);

async function seed() {
  console.log("🌱  Starting Convex seed...");
  console.log(`    Events: ${Object.keys(store.events ?? {}).length}`);
  console.log(`    Results: ${(store.results ?? []).length}`);

  // ── 1. Seed events ─────────────────────────────────────────────────────────
  const eventsArr = Object.values(store.events ?? {}).map((e) => ({
    seId: String(e.id),
    name: String(e.name ?? ""),
    status: typeof e.status === "number" ? e.status : undefined,
    open: e.open || undefined,
    close: e.close || undefined,
    sport: e.sport || undefined,
    fetchedAt: e.fetchedAt || undefined,
    resultCount: typeof e.resultCount === "number" ? e.resultCount : undefined,
    resultsCompleted:
      typeof e.resultsCompleted === "number" ? e.resultsCompleted : undefined,
  }));

  if (eventsArr.length) {
    const r = await client.mutation(api.serverSync.batchUpsertEvents, {
      events: eventsArr,
    });
    console.log(`✅  Events: ${r.inserted} inserted, ${r.updated} updated`);
  }

  // ── 2. Seed results in batches of 50 ───────────────────────────────────────
  const results = store.results ?? [];
  const BATCH = 50;
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const r = await client.mutation(api.serverSync.batchUpsertResults, {
      results: batch,
    });
    totalInserted += r.inserted;
    totalUpdated += r.updated;
    process.stdout.write(
      `\r    Results: ${Math.min(i + BATCH, results.length)}/${results.length} processed...`
    );
  }
  console.log(
    `\n✅  Results: ${totalInserted} inserted, ${totalUpdated} updated`
  );

  // ── 3. Store metadata ───────────────────────────────────────────────────────
  await client.mutation(api.serverSync.updateStoreState, {
    orgId: store.meta?.orgId ?? "8008",
    lastRunAt: store.meta?.lastRunAt ?? undefined,
    totalResults: results.length,
    lastUpdatedAt: new Date().toISOString(),
  });
  console.log("✅  Store state saved");

  console.log("\n🎉  Seed complete!");
}

seed().catch((err) => {
  console.error("❌  Seed failed:", err.message);
  process.exit(1);
});
