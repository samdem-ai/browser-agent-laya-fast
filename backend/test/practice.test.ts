import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Browser } from "puppeteer-core";
import { connectBrowser, launchChromiumFallback, stopOwnedObscura } from "../src/browser.js";
import { extractCandidates, waitForPageStability } from "../src/extractor.js";
import { executeAction } from "../src/executor.js";
import { autoScrollIfRequested, captureTaskPreview, getTaskPreview, verifyByCode } from "../src/task-runner.js";
import { config } from "../src/config.js";
import type { TaskRecord } from "../src/contracts.js";

const browsers: Array<{ browser: Browser; owned: boolean }> = [];
after(async () => {
  const childProcesses = browsers.flatMap(({ browser, owned }) => {
    const child = owned ? browser.process() : null;
    browser.disconnect();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      return [child];
    }
    return [];
  });
  await Promise.all(childProcesses.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, 1000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  })));
  stopOwnedObscura();
});

function taskRecord(): TaskRecord {
  return { taskId: "practice-test", status: "running", goal: "", history: [], stopRequested: false, startedAt: new Date().toISOString() };
}

async function openPracticePage(page: import("puppeteer-core").Page, url: string, readySelector: string): Promise<void> {
  let navigationError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 }).catch((error: unknown) => { navigationError = error; });
    const ready = await page.waitForSelector(readySelector, { timeout: 8000 }).catch(() => null);
    if (ready) { await ready.dispose(); return; }
    if (attempt === 0) await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => undefined);
  }
  throw navigationError ?? new Error(`Practice page did not show ${readySelector}.`);
}

test("Obscura extracts the practice login controls", async () => {
  const browser = await connectBrowser();
  browsers.push({ browser, owned: false });
  const page = await browser.newPage();
  try {
    await page.evaluate((html) => { document.open(); document.write(html); document.close(); }, '<main><form><label for="username">Username</label><input id="username" name="username"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Login</button></form></main>');
    const candidates = await extractCandidates(page);
    assert.ok(candidates.some((candidate) => candidate.role === "textbox" && /username/i.test(candidate.name)));
    assert.ok(candidates.some((candidate) => candidate.role === "textbox" && /password/i.test(candidate.name)));
    assert.ok(candidates.some((candidate) => candidate.role === "button" && /login/i.test(candidate.name)));
  } finally {
    await page.close();
  }
});

test("Obscura waits for the dynamic loading example to reveal its content", async () => {
  const browser = await connectBrowser();
  browsers.push({ browser, owned: false });
  const page = await browser.newPage();
  try {
    await openPracticePage(page, "https://the-internet.herokuapp.com/dynamic_loading/1", "#start");
    const candidates = await extractCandidates(page);
    const start = candidates.find((candidate) => candidate.role === "button" && /^start$/i.test(candidate.name));
    assert.ok(start, "Start button should be extracted");
    await executeAction(page, start, "CLICK", {});
    await page.waitForFunction(() => document.body.innerText.includes("Hello World!"), { timeout: 15000 });
    await waitForPageStability(page);
    assert.match(await page.evaluate(() => document.body.innerText), /Hello World!/);
  } finally {
    await page.close();
  }
});

test("Chromium fallback extracts and edits a contenteditable iframe", async () => {
  const browser = await launchChromiumFallback();
  browsers.push({ browser, owned: true });
  const page = await browser.newPage();
  try {
    await openPracticePage(page, "https://the-internet.herokuapp.com/iframe", "iframe");
    await page.waitForFunction(() => document.querySelectorAll("iframe").length > 0 && document.querySelector("iframe")?.contentDocument?.body?.isContentEditable === true, { timeout: 15000 });
    const candidates = await extractCandidates(page);
    const editor = candidates.find((candidate) => candidate.role === "textbox" && /rich text area/i.test(candidate.name));
    assert.ok(editor, "TinyMCE contenteditable body should be extracted from the child frame");
    await executeAction(page, editor, "INPUT", { values: { [editor.name]: "Frame extraction verified" } });
    assert.equal(await page.frames()[1]?.evaluate(() => document.body.textContent), "Frame extraction verified");
  } finally {
    await page.close();
  }
});

test("DOM supplement discovers controls inside an open shadow root", async () => {
  const browser = await launchChromiumFallback();
  browsers.push({ browser, owned: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<button id=outer>Outer</button><x-test></x-test>");
    await page.evaluate(() => {
      customElements.define("x-test", class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.setAttribute("aria-label", "Shadow action");
          button.addEventListener("click", () => button.setAttribute("data-clicked", "yes"));
          button.textContent = "Do";
          root.append(button);
        }
      });
    });
    const candidates = await extractCandidates(page);
    const shadow = candidates.find((candidate) => candidate.role === "button" && candidate.name === "Shadow action");
    assert.ok(shadow, "button in open shadow root should be extracted alongside AX results");
    await executeAction(page, shadow, "CLICK", {});
    assert.equal(await page.evaluate(() => document.querySelector("x-test")?.shadowRoot?.querySelector("button")?.getAttribute("data-clicked")), "yes");
  } finally {
    await page.close();
  }
});

test("verifier requires every configured condition to pass", async () => {
  const browser = await launchChromiumFallback();
  browsers.push({ browser, owned: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<main>Verified output</main>");
    assert.equal(await verifyByCode(page, { verify: { textIncludes: "Verified output", urlIncludes: "unrelated" } }), false);
    assert.equal(await verifyByCode(page, { verify: { textIncludes: "Verified output", urlIncludes: "about:blank" } }), true);
    assert.equal(await verifyByCode(page, { verify: {} }), false);
  } finally {
    await page.close();
  }
});

test("browser preview captures a frame, masks form text, and removes the temporary mask", async () => {
  const browser = await launchChromiumFallback();
  browsers.push({ browser, owned: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><h1>Preview test</h1><input value="private value"><p id="credentials"></p></main>');
    const originalText = `Sample login: ${config.username ?? "sample-user"} / ${config.password ?? "sample-password"}`;
    await page.$eval("#credentials", (element, value) => { element.textContent = value; }, originalText);
    const originalScreenshot = page.screenshot.bind(page);
    let textDuringCapture = "";
    let fieldColorDuringCapture = "";
    page.screenshot = (async (options?: Parameters<typeof page.screenshot>[0]) => {
      const masked = await page.evaluate(() => ({
        text: document.body.innerText,
        fieldColor: getComputedStyle(document.querySelector("input")!).color,
      }));
      textDuringCapture = masked.text;
      fieldColorDuringCapture = masked.fieldColor;
      return originalScreenshot(options);
    }) as typeof page.screenshot;
    await captureTaskPreview(page, "preview-practice-test");
    const image = getTaskPreview("preview-practice-test");
    assert.ok(image && image[0] === 0xff && image[1] === 0xd8, "preview should be a JPEG frame");
    assert.ok(textDuringCapture.includes("[REDACTED]"));
    assert.ok(!config.password || !textDuringCapture.includes(config.password));
    assert.equal(fieldColorDuringCapture, "rgba(0, 0, 0, 0)");
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-laya-preview-mask]').length), 0);
    assert.equal(await page.$eval("input", (input) => (input as HTMLInputElement).value), "private value");
    assert.equal(await page.$eval("#credentials", (element) => element.textContent), originalText, "page text should be restored after the capture");
  } finally {
    await page.close();
  }
});

test("bounded wheel scrolling reveals infinite-scroll content and records each scroll", async () => {
  const browser = await launchChromiumFallback();
  browsers.push({ browser, owned: true });
  const page = await browser.newPage();
  try {
    await openPracticePage(page, "https://the-internet.herokuapp.com/infinite_scroll", ".jscroll-added");
    const initial = await page.$$eval(".jscroll-added", (items) => items.length);
    const task = taskRecord();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await autoScrollIfRequested(page, "Scroll through the infinite page", task, attempt);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await page.$$eval(".jscroll-added", (items) => items.length) > initial) break;
    }
    const final = await page.$$eval(".jscroll-added", (items) => items.length);
    assert.ok(final > initial, `expected infinite-scroll items to grow, started ${initial}, ended ${final}`);
    assert.ok(task.history.length >= 1 && task.history.length <= 3);
    assert.ok(task.history.every((entry) => entry.result.startsWith("Code-scrolled page")));
  } finally {
    await page.close();
  }
});
