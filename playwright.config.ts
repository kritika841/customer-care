import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const envLocal: Record<string, string> = {};
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    envLocal[k] = v;
  }
}

const PORT = Number(process.env.PLAYWRIGHT_PORT || 5020);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: /e2e\.spec\.ts$/,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${BASE_URL}/auth/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ...envLocal,
      ...process.env,
      NODE_ENV: "production",
      AI_LIVE_OUTBOUND_ENABLED: "false",
      SUPPORT_TEST_DRY_RUN: "true",
      NEXT_PUBLIC_APP_URL: BASE_URL,
    },
  },
});
