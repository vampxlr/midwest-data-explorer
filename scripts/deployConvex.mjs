/**
 * One-shot Convex cloud deploy + Vercel env var setup.
 *
 * Run ONCE after `npx convex login` (which requires a browser):
 *   node scripts/deployConvex.mjs
 *
 * What it does:
 *  1. Deploys Convex schema + functions to the cloud
 *  2. Reads the deployment URL
 *  3. Sets CONVEX_URL and VITE_CONVEX_URL on Vercel
 *  4. Seeds the cloud database from local store.json
 *  5. Prints next steps
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

config({ path: path.join(root, ".env.local") });
config({ path: path.join(root, ".env") });

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID || "prj_uAeyHhKYfp7gAtNLCZv5FuoUvgCy";
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID || "team_eZ7JgqsIhaE4tj3sTjI4N0GW";

if (!VERCEL_TOKEN) {
  console.error("❌  VERCEL_TOKEN env var is required.");
  console.error("    Set it in your .env file or pass inline: VERCEL_TOKEN=vcp_... node scripts/deployConvex.mjs");
  process.exit(1);
}

async function vercelSetEnv(key, value, targets = ["production", "preview"]) {
  const url = `https://api.vercel.com/v10/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}`;

  // Delete existing if present
  const listRes = await fetch(
    `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );
  const list = await listRes.json();
  const existing = (list.envs || []).filter((e) => e.key === key);
  for (const e of existing) {
    await fetch(
      `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env/${e.id}?teamId=${VERCEL_TEAM}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ key, value, type: "plain", target: targets }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Vercel env set failed: ${JSON.stringify(err)}`);
  }
  console.log(`✅  Vercel env set: ${key}`);
}

async function main() {
  // ── 1. Deploy to Convex cloud ─────────────────────────────────────────────
  console.log("🚀  Deploying Convex functions to cloud...");
  let deployOutput;
  try {
    deployOutput = execSync("npx convex deploy --yes", {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // stdout might be in err.stdout even on non-zero exit
    deployOutput = err.stdout || "";
    if (!deployOutput.includes("convex.cloud")) {
      console.error("❌  convex deploy failed:\n", err.stderr || err.message);
      console.error(
        "\nMake sure you are logged in first: npx convex login"
      );
      process.exit(1);
    }
  }

  // ── 2. Read deployment URL from .env.local (written by convex deploy) ─────
  config({ path: path.join(root, ".env.local"), override: true });
  const convexUrl = process.env.CONVEX_URL;

  if (!convexUrl || !convexUrl.includes("convex.cloud")) {
    console.error("❌  Could not read CONVEX_URL from .env.local after deploy.");
    console.error("    Output was:", deployOutput);
    process.exit(1);
  }

  console.log(`✅  Convex cloud URL: ${convexUrl}`);

  // ── 3. Set env vars on Vercel ─────────────────────────────────────────────
  console.log("\n📦  Setting Vercel environment variables...");
  await vercelSetEnv("CONVEX_URL", convexUrl);
  await vercelSetEnv("VITE_CONVEX_URL", convexUrl);

  // ── 4. Seed the cloud database ────────────────────────────────────────────
  const storePath = path.join(root, "server", "data", "store.json");
  if (fs.existsSync(storePath)) {
    console.log("\n🌱  Seeding cloud Convex database from store.json...");
    const seedResult = spawnSync(
      "node",
      [path.join(root, "scripts", "seedConvex.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CONVEX_URL: convexUrl },
        stdio: "inherit",
      }
    );
    if (seedResult.status !== 0) {
      console.error("⚠️   Seed failed — you can retry with:");
      console.error(`    CONVEX_URL=${convexUrl} node scripts/seedConvex.mjs`);
    }
  } else {
    console.log("⚠️   store.json not found locally — skipping seed.");
    console.log("    After fetching data, run:");
    console.log(`    CONVEX_URL=${convexUrl} node scripts/seedConvex.mjs`);
  }

  // ── 5. Trigger Vercel redeploy ─────────────────────────────────────────────
  console.log("\n🔁  Triggering Vercel redeploy with new env vars...");
  const redeployRes = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "midwest-data-explorer",
        gitSource: {
          type: "github",
          repoId: "vampxlr/midwest-data-explorer",
          ref: "main",
        },
      }),
    }
  );

  if (redeployRes.ok) {
    console.log("✅  Redeploy triggered on Vercel");
  } else {
    console.log(
      "⚠️   Could not auto-trigger redeploy — push any commit to GitHub to redeploy"
    );
  }

  console.log(`
🎉  Done! Your Convex cloud is live.

    Convex URL  : ${convexUrl}
    Dashboard   : https://dashboard.convex.dev

Next: Vercel will rebuild automatically. In ~2 min your site will have live Convex data.
`);
}

main().catch((err) => {
  console.error("❌  Deploy failed:", err.message);
  process.exit(1);
});
