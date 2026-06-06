/**
 * Implements Convex OAuth device flow, then deploys + wires up Vercel.
 * Run once: node scripts/convexLogin.mjs
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

loadEnv({ path: path.join(root, ".env.local"), override: false });
loadEnv({ path: path.join(root, ".env"), override: false });

const CLIENT_ID = "HFtA247jp9iNs08NTLIB7JsNPMmRIyfi";
const AUTH_URL = "https://auth.convex.dev";
const CONVEX_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME, ".convex", "config.json");
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID || "prj_uAeyHhKYfp7gAtNLCZv5FuoUvgCy";
const VERCEL_TEAM   = process.env.VERCEL_TEAM_ID || "team_eZ7JgqsIhaE4tj3sTjI4N0GW";

// ── 1. Check if already logged in ─────────────────────────────────────────

async function isLoggedIn(token) {
  if (!token) return false;
  try {
    const r = await fetch(`https://api.convex.dev/api/teams`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch { return false; }
}

function readToken() {
  try {
    const raw = fs.readFileSync(CONVEX_CONFIG, "utf8");
    return JSON.parse(raw).accessToken;
  } catch { return null; }
}

function saveToken(token) {
  fs.mkdirSync(path.dirname(CONVEX_CONFIG), { recursive: true });
  fs.writeFileSync(CONVEX_CONFIG, JSON.stringify({ accessToken: token }));
  console.log("✅  Token saved to ~/.convex/config.json");
}

// ── 2. Device flow ──────────────────────────────────────────────────────────

async function startDeviceFlow() {
  const r = await fetch(`${AUTH_URL}/oauth2/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: "openid profile email" }),
  });
  if (!r.ok) throw new Error(`Device authorization failed: ${r.status}`);
  return await r.json();
}

async function pollForToken(deviceCode, interval) {
  const delay = Math.max(interval * 1000, 3000);
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, delay));
    const r = await fetch(`${AUTH_URL}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await r.json();
    if (data.access_token) return data.access_token;
    if (data.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (data.error === "slow_down") { await new Promise((res) => setTimeout(res, 3000)); continue; }
    throw new Error(`Token poll error: ${data.error}`);
  }
  throw new Error("Device flow timed out (5 min).");
}

// ── 3. Vercel env helpers ───────────────────────────────────────────────────

async function vercelSetEnv(key, value) {
  const base = `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}`;
  const auth = { Authorization: `Bearer ${VERCEL_TOKEN}` };
  const list = await (await fetch(base, { headers: auth })).json();
  for (const e of (list.envs || []).filter((e) => e.key === key)) {
    await fetch(`${base.replace("?", `/${e.id}?`)}`, { method: "DELETE", headers: auth });
  }
  const r = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, type: "plain", target: ["production", "preview"] }),
  });
  if (!r.ok) throw new Error(`Vercel env set failed for ${key}: ${await r.text()}`);
  console.log(`✅  Vercel env: ${key} set`);
}

// ── 4. Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Check existing token
  let token = readToken();
  if (await isLoggedIn(token)) {
    console.log("✅  Already logged in to Convex cloud");
  } else {
    // Device flow
    console.log("🔑  Starting Convex OAuth device flow...\n");
    const flow = await startDeviceFlow();
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Open this URL in your browser:`);
    console.log(`  ${flow.verification_uri_complete || `${flow.verification_uri}?user_code=${flow.user_code}`}`);
    console.log(`  Code: ${flow.user_code}  (expires in ${flow.expires_in}s)`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Waiting for you to authenticate");
    process.stdout.write("Polling ");
    token = await pollForToken(flow.device_code, flow.interval || 5);
    console.log(" done!");
    saveToken(token);
  }

  // ── Deploy to cloud ───────────────────────────────────────────────────────
  console.log("\n🚀  Deploying Convex functions to cloud...");
  try {
    execSync("npx convex deploy --yes", {
      cwd: root, stdio: "inherit", env: { ...process.env }
    });
  } catch (e) {
    // Non-zero exit but might still have worked; check .env.local
  }

  // Re-read CONVEX_URL written by convex deploy
  loadEnv({ path: path.join(root, ".env.local"), override: true });
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl || convexUrl.includes("127.0.0.1")) {
    console.error("❌  Cloud CONVEX_URL not found. convex deploy may have failed.");
    process.exit(1);
  }
  console.log(`✅  Cloud Convex URL: ${convexUrl}`);

  // ── Vercel env vars ───────────────────────────────────────────────────────
  if (VERCEL_TOKEN) {
    console.log("\n📦  Setting Vercel environment variables...");
    await vercelSetEnv("CONVEX_URL", convexUrl);
    await vercelSetEnv("VITE_CONVEX_URL", convexUrl);
  } else {
    console.log("\n⚠️   VERCEL_TOKEN not set — skipping Vercel env setup.");
    console.log(`    Manually add to Vercel: CONVEX_URL=${convexUrl}`);
  }

  // ── Seed ─────────────────────────────────────────────────────────────────
  const storePath = path.join(root, "server", "data", "store.json");
  if (fs.existsSync(storePath)) {
    console.log("\n🌱  Seeding cloud Convex database...");
    const { spawnSync } = await import("child_process");
    const r = spawnSync("node", [path.join(root, "scripts", "seedConvex.mjs")], {
      cwd: root, stdio: "inherit",
      env: { ...process.env, CONVEX_URL: convexUrl },
    });
    if (r.status !== 0) console.warn("⚠️   Seed failed — retry with: CONVEX_URL=<url> node scripts/seedConvex.mjs");
  }

  // ── Trigger Vercel redeploy ───────────────────────────────────────────────
  if (VERCEL_TOKEN) {
    console.log("\n🔁  Triggering Vercel redeploy...");
    const r = await fetch(
      `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "midwest-data-explorer",
          gitSource: { type: "github", repoId: "1240916747", ref: "main" },
        }),
      }
    );
    console.log(r.ok ? "✅  Vercel redeploy triggered" : "⚠️   Could not trigger redeploy — push any commit to deploy");
  }

  console.log(`\n🎉  Done! Convex is live at: ${convexUrl}\n`);
}

main().catch((e) => { console.error("\n❌ ", e.message); process.exit(1); });
