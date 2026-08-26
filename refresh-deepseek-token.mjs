/**
 * Refresh DeepSeek Web bearer token by connecting to existing Chrome
 * and navigating to chat.deepseek.com to capture fresh auth headers.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUTH_FILE = path.join(
  process.env.HOME || "/Users/cml",
  "openclaw-zero-token-main/.openclaw-upstream-state/agents/main/agent/auth-profiles.json"
);
const CDP_URL = "http://127.0.0.1:9222";

async function getWsUrl() {
  const res = await fetch(`${CDP_URL}/json/version`);
  const json = await res.json();
  return json.webSocketDebuggerUrl;
}

async function main() {
  console.log("1. Connecting to existing Chrome...");
  const wsUrl = await getWsUrl();
  console.log(`   CDP URL: ${CDP_URL}`);

  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  console.log(`   Connected. ${context.pages().length} pages open.`);

  // Find or open DeepSeek page
  let page = context.pages().find(p => p.url().includes("chat.deepseek.com") || p.url().includes("deepseek.com"));
  if (!page) {
    console.log("2. Opening chat.deepseek.com...");
    page = await context.newPage();
    await page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  } else {
    console.log("2. Found existing DeepSeek page, refreshing...");
    await page.bringToFront();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  }

  // Read existing auth
  let existingProfile;
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    existingProfile = raw.profiles?.["deepseek-web:default"];
  } catch {}

  // Capture new bearer by intercepting requests
  console.log("3. Waiting for auth token from API requests...");
  let newBearer = "";
  let capturedCookie = "";

  const bearerPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for bearer token (60s). Please make sure you are logged in."));
    }, 60000);

    page.on("request", async (request) => {
      const url = request.url();
      if (url.includes("/api/v0/")) {
        const headers = request.headers();
        const auth = headers["authorization"];
        if (auth?.startsWith("Bearer ") && !newBearer) {
          newBearer = auth.slice(7);
          console.log(`   Captured Bearer: ${newBearer.substring(0, 30)}...`);
        }
      }
    });

    // Also try to trigger a request
    const checkInterval = setInterval(async () => {
      if (newBearer) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        resolve(newBearer);
      }
    }, 500);

    // Try clicking or interacting to trigger API calls
    setTimeout(async () => {
      try {
        // Just wait for natural API calls from the page
        if (!newBearer) {
          console.log("   No bearer captured yet, trying to trigger API...");
          // Reload might trigger auth check
          await page.evaluate(() => {
            // Trigger a light interaction
            const input = document.querySelector('textarea, [contenteditable], input[type="text"]');
            if (input) {
              input.focus();
              input.blur();
            }
          });
        }
      } catch {}
    }, 5000);
  });

  try {
    await bearerPromise;
  } catch (e) {
    console.error(`   Error: ${e.message}`);

    // Check cookies as fallback
    const cookies = await context.cookies(["https://chat.deepseek.com", "https://deepseek.com"]);
    capturedCookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    if (capturedCookie.length > 10) {
      console.log("   No bearer captured, but cookies are available.");
      console.log(`   Cookie preview: ${capturedCookie.substring(0, 80)}...`);
    }

    if (!newBearer) {
      console.log("\n   ✗ Could not capture bearer token.");
      console.log("   Please manually log in to https://chat.deepseek.com in the Chrome window,");
      console.log("   then run this script again.");
      process.exit(1);
    }
  }

  // Get cookies
  console.log("4. Capturing cookies...");
  const cookies = await context.cookies(["https://chat.deepseek.com", "https://deepseek.com"]);
  capturedCookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  // Get user agent
  const userAgent = await page.evaluate(() => navigator.userAgent);

  // Build new token JSON
  const newTokenData = {
    cookie: capturedCookie,
    bearer: newBearer,
    userAgent,
  };

  console.log(`   Cookie length: ${capturedCookie.length}`);
  console.log(`   Bearer: ${newBearer.substring(0, 30)}...`);

  // Update auth-profiles.json
  console.log("5. Updating auth-profiles.json...");
  let store;
  try {
    store = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    store = { version: 1, profiles: {} };
  }

  store.profiles["deepseek-web:default"] = {
    type: "token",
    provider: "deepseek-web",
    token: JSON.stringify(newTokenData),
  };

  if (!store.lastGood) store.lastGood = {};
  store.lastGood["deepseek-web"] = "deepseek-web:default";

  // Backup
  const bakPath = AUTH_FILE + `.bak.${Date.now()}`;
  try { fs.copyFileSync(AUTH_FILE, bakPath); } catch {}

  fs.writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), "utf8");
  console.log(`   ✓ Saved. Backup: ${path.basename(bakPath)}`);
  console.log("\n✓ Token refreshed! Restart the gateway for changes to take effect.");
  console.log("  Run: bash server.sh restart");

  await browser.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
