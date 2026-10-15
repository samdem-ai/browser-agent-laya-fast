import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });

export const config = {
  port: Number(process.env.PORT ?? 8080),
  layaUrl: process.env.LAYA_URL ?? "http://127.0.0.1:5000",
  browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT ?? "ws://127.0.0.1:9222/devtools/browser",
  obscuraPath: process.env.OBSCURA_BIN ?? path.resolve(here, "../../obscura/obscura-x86_64-linux/obscura"),
  chromiumPath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
  browserPort: Number(process.env.BROWSER_PORT ?? 9222),
  maxSteps: Number(process.env.MAX_STEPS ?? 10),
  targetConfidenceThreshold: Number(process.env.TARGET_CONFIDENCE_THRESHOLD ?? 0.58),
  stopConfidenceThreshold: Number(process.env.STOP_CONFIDENCE_THRESHOLD ?? 0.72),
  maxCandidates: 40,
  maxDecisionOptions: 18,
  maxPageTextChars: 1400,
  pageStableTimeoutMs: 5000,
  stepTimeoutMs: 30000,
  username: process.env.AUTOMATION_USERNAME,
  password: process.env.AUTOMATION_PASSWORD,
};
