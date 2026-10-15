import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { config } from "./config.js";

let obscuraProcess: ChildProcess | undefined;

async function canConnect(): Promise<boolean> {
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: config.browserWSEndpoint, protocolTimeout: 5000 });
    browser.disconnect();
    return true;
  } catch {
    return false;
  }
}

async function ensureObscura(): Promise<void> {
  if (await canConnect()) return;
  await access(config.obscuraPath, constants.X_OK).catch(() => {
    throw new Error(`Obscura executable is unavailable at ${config.obscuraPath}. Set OBSCURA_BIN to its executable path.`);
  });
  obscuraProcess = spawn(config.obscuraPath, ["serve", "--host", "127.0.0.1", "--port", String(config.browserPort), "--quiet"], {
    stdio: "ignore",
    detached: false,
  });
  obscuraProcess.once("error", (error) => console.error("Obscura process error:", error.message));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await canConnect()) return;
    if (obscuraProcess.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Obscura did not become ready on the configured CDP endpoint.");
}

export async function connectBrowser(): Promise<Browser> {
  await ensureObscura();
  return puppeteer.connect({ browserWSEndpoint: config.browserWSEndpoint, protocolTimeout: 30000 });
}

export async function launchChromiumFallback(): Promise<Browser> {
  await access(config.chromiumPath, constants.X_OK).catch(() => {
    throw new Error(`Chromium fallback is unavailable at ${config.chromiumPath}. Set CHROMIUM_EXECUTABLE_PATH.`);
  });
  return puppeteer.launch({
    executablePath: config.chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    protocolTimeout: 30000,
  });
}

export function stopOwnedObscura(): void {
  if (obscuraProcess && obscuraProcess.exitCode === null) obscuraProcess.kill("SIGTERM");
}
