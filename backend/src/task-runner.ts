import type { Browser, Frame, Page } from "puppeteer-core";
import type { Candidate, LayaRequest, Operation, StepRecord, StructuredTask, TaskRecord } from "./contracts.js";
import { config } from "./config.js";
import { connectBrowser, launchChromiumFallback } from "./browser.js";
import { decide } from "./laya-client.js";
import { executeAction } from "./executor.js";
import { extractCandidates, readPageState, waitForPageStability } from "./extractor.js";
import { hasResolvableValue, operationFor, redactSecrets, resolveValue, MissingValueError } from "./resolver.js";

const modelNoAction = "NO_ACTION";
const taskPreviews = new Map<string, Uint8Array>();

export function getTaskPreview(taskId: string): Uint8Array | undefined {
  return taskPreviews.get(taskId);
}

export function removeTaskPreview(taskId: string): void {
  taskPreviews.delete(taskId);
}

export async function captureTaskPreview(page: Page, taskId: string): Promise<void> {
  const maskedFrames: Frame[] = [];
  const maskCss = `
    input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]),
    textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"] {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
    }
  `;
  const secrets = [config.username, config.password].filter((value): value is string => Boolean(value));
  let maskingFailed = false;
  try {
    for (const frame of page.frames()) {
      try {
        await frame.evaluate((values) => {
          type WindowWithPreviewBackup = Window & { __layaPreviewTextBackup?: Array<[Text, string]> };
          const backup: Array<[Text, string]> = [];
          const roots: Array<Document | ShadowRoot> = [document];
          while (roots.length) {
            const root = roots.pop()!;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node as Text;
              const original = text.nodeValue ?? "";
              let redacted = original;
              for (const secret of values) if (secret) redacted = redacted.split(secret).join("[REDACTED]");
              if (redacted !== original) {
                backup.push([text, original]);
                text.nodeValue = redacted;
              }
            }
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
          (window as WindowWithPreviewBackup).__layaPreviewTextBackup = backup;
        }, secrets);
        maskedFrames.push(frame);
        await frame.evaluate((css) => {
          const roots: Array<Document | ShadowRoot> = [document];
          while (roots.length) {
            const root = roots.pop()!;
            const style = document.createElement("style");
            style.setAttribute("data-laya-preview-mask", "");
            style.textContent = css;
            (root instanceof Document ? root.head ?? root.documentElement : root).appendChild(style);
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
        }, maskCss);
      } catch {
        maskingFailed = true;
        console.warn("Could not apply browser preview masking in one frame.");
      }
    }
    if (maskingFailed) throw new Error("Browser preview withheld because masking could not be applied to every frame.");
    taskPreviews.set(taskId, await page.screenshot({ type: "jpeg", quality: 65 }));
    while (taskPreviews.size > 500) {
      const oldest = taskPreviews.keys().next().value as string | undefined;
      if (!oldest) break;
      taskPreviews.delete(oldest);
    }
  } finally {
    await Promise.all(maskedFrames.map((frame) => frame.evaluate(() => {
      type WindowWithPreviewBackup = Window & { __layaPreviewTextBackup?: Array<[Text, string]> };
      const browserWindow = window as WindowWithPreviewBackup;
      for (const [node, value] of browserWindow.__layaPreviewTextBackup ?? []) node.nodeValue = value;
      delete browserWindow.__layaPreviewTextBackup;
      const roots: Array<Document | ShadowRoot> = [document];
      while (roots.length) {
        const root = roots.pop()!;
        for (const style of root.querySelectorAll('style[data-laya-preview-mask]')) style.remove();
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
    }).catch(() => undefined)));
  }
}

function decisionCandidates(candidates: Candidate[], goal: string): Candidate[] {
  if (candidates.length <= config.maxDecisionOptions) return candidates;
  const tokens = goal.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  return [...candidates]
    .map((candidate, index) => ({ candidate, index, score: tokens.reduce((total, token) => total + (candidate.name.toLowerCase().includes(token) ? 4 : 0), 0) + (candidate.role === "button" ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, config.maxDecisionOptions)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.candidate);
}

export async function autoScrollIfRequested(page: Page, goal: string, task: TaskRecord, step: number): Promise<boolean> {
  if (!/scroll|infinite|load more|below/i.test(goal) && !/infinite_scroll/i.test(page.url())) return false;
  const scrollCount = task.history.filter((entry) => entry.result.startsWith("Code-scrolled page")).length;
  if (scrollCount >= 3) return false;
  const before = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight, textLength: document.body?.innerText.length ?? 0, view: window.innerHeight }));
  const infiniteBehavior = /infinite/i.test(goal) || /\/infinite_scroll(?:\/|$)/.test(page.url());
  if (before.y + before.view >= before.height - 8 && !infiniteBehavior) return false;
  await page.mouse.move(Math.floor(before.view * 0.65), Math.floor(before.view * 0.75));
  await page.mouse.wheel({ deltaY: Math.max(600, Math.floor(before.view * 0.8)) });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const after = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight, textLength: document.body?.innerText.length ?? 0 }));
  const changed = after.y > before.y || after.height > before.height || after.textLength > before.textLength;
  task.history.push({ step, at: new Date().toISOString(), url: redactSecrets(page.url()), candidates: [], decision: null, action: { operation: "SCROLL", backendNodeId: 0, target: "page" }, result: `Code-scrolled page from ${before.y}px to ${after.y}px${changed ? "; page content changed" : "; no additional content detected"}.`, verified: false });
  return changed;
}

export async function verifyByCode(page: Page, task: StructuredTask): Promise<boolean> {
  const verify = task.verify;
  if (!verify) return false;
  const state = await readPageState(page);
  const checks = [
    verify.textIncludes ? state.pageText.includes(verify.textIncludes) : undefined,
    verify.urlIncludes ? state.url.includes(verify.urlIncludes) : undefined,
  ].filter((check): check is boolean => check !== undefined);
  return checks.length > 0 && checks.every(Boolean);
}

function setTerminal(task: TaskRecord, status: TaskRecord["status"]): void {
  task.status = status;
  task.completedAt = new Date().toISOString();
}

function safeHistory(history: StepRecord[]): LayaRequest["history"] {
  return history.slice(-4).map((step) => ({
    step: step.step,
    target: step.decision?.backendNodeId === null ? "NO_ACTION" : step.candidates.find((candidate) => candidate.backendNodeId === step.decision?.backendNodeId)?.formattedValue ?? "unknown target",
    operation: step.action?.operation ?? null,
    result: step.result,
  }));
}

function mapDecision(raw: Awaited<ReturnType<typeof decide>>, candidates: Candidate[]): { decision: typeof raw; target: Candidate | null; operation: Operation | null } {
  const target = raw.backendNodeId === null ? null : candidates.find((candidate) => candidate.backendNodeId === raw.backendNodeId) ?? null;
  const operation = target ? operationFor(target) : null;
  return { decision: { ...raw, operation }, target, operation };
}

export async function runTask(task: TaskRecord, url: string, goal: string, structured: StructuredTask): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let ownsBrowser = false;
  try {
    browser = await connectBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const compatibilityReason = await page.evaluate(() => {
      if (document.querySelectorAll("iframe").length > 0) return "iframes";
      const controls = 'a,button,input,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="slider"],[role="menuitem"]';
      for (const element of document.querySelectorAll("*")) if (element.shadowRoot?.querySelector(controls)) return "interactive open shadow DOM";
      return "";
    }).catch(() => "");
    const requiresScrolling = /scroll|infinite|load more|below/i.test(goal) || /\/infinite_scroll(?:\/|$)/.test(page.url());
    const fallbackReason = compatibilityReason || (requiresScrolling ? "wheel and infinite-scroll behavior" : "");
    if (fallbackReason) {
      await page.close();
      browser.disconnect();
      let fallbackBrowser: Browser | undefined;
      try {
        fallbackBrowser = await launchChromiumFallback();
        browser = fallbackBrowser;
        ownsBrowser = true;
        page = await browser.newPage();
        await page.setViewport({ width: 1365, height: 900 });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        console.log(JSON.stringify({ event: "browser-fallback", taskId: task.taskId, engine: "chromium", reason: fallbackReason }));
      } catch (fallbackError) {
        console.warn("Chromium frame fallback unavailable; continuing with Obscura:", fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
        await fallbackBrowser?.close().catch(() => undefined);
        ownsBrowser = false;
        browser = await connectBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1365, height: 900 });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
    }
    await waitForPageStability(page);
    await captureTaskPreview(page, task.taskId).catch((error) => console.warn("Could not capture browser preview:", error instanceof Error ? error.message : String(error)));

    const safeGoal = redactSecrets(goal).slice(0, 2000);
    for (let stepNumber = 1; stepNumber <= config.maxSteps; stepNumber += 1) {
      if (task.stopRequested) {
        setTerminal(task, "stopped");
        return;
      }
      if (await verifyByCode(page, structured)) {
        setTerminal(task, "done");
        return;
      }

      await autoScrollIfRequested(page, safeGoal, task, stepNumber);
      await captureTaskPreview(page, task.taskId).catch((error) => console.warn("Could not refresh browser preview:", error instanceof Error ? error.message : String(error)));

      const state = await readPageState(page);
      const extracted = await extractCandidates(page);
      const candidates = extracted.map((candidate) => ({
        ...candidate,
        ...(candidate.role === "textbox" || candidate.role === "searchbox" || candidate.role === "combobox"
          ? { valueAvailable: hasResolvableValue(candidate, structured) }
          : {}),
      }));
      const authIntent = /\b(log\s*in|login|sign\s*in|authenticate|credentials?)\b/i.test(safeGoal);
      const fillableInputs = candidates.filter((candidate) =>
        (candidate.role === "textbox" || candidate.role === "searchbox" || candidate.role === "combobox") &&
        candidate.inputState === "empty" && candidate.valueAvailable,
      );
      let eligible = candidates;
      if (authIntent && fillableInputs.length > 0) {
        // Do not ask Laya to submit a form while code can still fill its blank credential fields.
        eligible = fillableInputs;
      } else if (authIntent) {
        const submitControls = candidates.filter((candidate) =>
          (candidate.role === "button" || candidate.role === "link" || candidate.role === "menuitem") &&
          /\b(login|log\s*in|sign\s*in|continue|submit)\b/i.test(candidate.name),
        );
        if (submitControls.length > 0) eligible = submitControls;
      }
      const stateCandidates = decisionCandidates(eligible, safeGoal);
      console.log(JSON.stringify({ event: "extracted", taskId: task.taskId, step: stepNumber, candidates: candidates.map(({ backendNodeId, role, name, href, inputState, valueAvailable }) => ({ backendNodeId, role, name, ...(href ? { href } : {}), ...(inputState ? { inputState } : {}), ...(valueAvailable ? { valueAvailable } : {}) })) }));
      if (stateCandidates.length === 0) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision: null, action: null, result: "No visible interactive elements were found.", verified: false });
        setTerminal(task, "stopped");
        return;
      }

      const request: LayaRequest = {
        taskId: task.taskId,
        goal: safeGoal,
        state,
        components: stateCandidates,
        history: safeHistory(task.history),
      };
      const raw = await decide(request, AbortSignal.timeout(config.stepTimeoutMs));
      const { decision, target, operation } = mapDecision(raw, stateCandidates);
      console.log(JSON.stringify({ event: "decision", taskId: task.taskId, step: stepNumber, backendNodeId: decision.backendNodeId, operation, targetConfidence: decision.targetConfidence, goalMet: decision.goalMet, stuck: decision.stuck, probabilities: decision.probabilities }));

      if (task.stopRequested) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: "Stopped by request before executing the proposed action.", verified: false });
        setTerminal(task, "stopped");
        return;
      }

      const codeVerified = await verifyByCode(page, structured);
      if (codeVerified) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: "Goal verified by the configured page condition.", verified: true });
        setTerminal(task, "done");
        return;
      }
      if (decision.goalMet && decision.goalMetConfidence >= config.stopConfidenceThreshold && !structured.verify) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: "Laya estimates the goal is met, but this task has no code-verifiable condition. Add task.verify to confirm completion.", verified: false });
        setTerminal(task, "stopped");
        return;
      }
      if (decision.stuck && decision.stuckConfidence >= config.stopConfidenceThreshold) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: "Stopped: Laya reports no useful next action above the stop threshold.", verified: false });
        setTerminal(task, "stopped");
        return;
      }
      const resolvingFields = stateCandidates.length > 0 && stateCandidates.every((candidate) => candidate.valueAvailable && candidate.inputState === "empty");
      const confidenceThreshold = resolvingFields && stateCandidates.length > 1 ? 0.42 : config.targetConfidenceThreshold;
      if (!target || !operation || decision.targetConfidence < confidenceThreshold) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: `Stopped: no confident action (target confidence ${decision.targetConfidence.toFixed(3)}).`, verified: false });
        setTerminal(task, "stopped");
        return;
      }

      const repeatKey = `${operation}:${target.backendNodeId}`;
      const repeats = task.history.filter((entry) => entry.action && `${entry.action.operation}:${entry.action.backendNodeId}` === repeatKey).length;
      if (repeats >= 1) {
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: "Stopped: the same action was selected repeatedly.", verified: false });
        setTerminal(task, "stopped");
        return;
      }

      let resultText: string;
      try {
        if (operation === "INPUT" || operation === "SELECT") resolveValue(target, structured);
        const outcome = await executeAction(page, target, operation, structured);
        resultText = `Executed ${operation} on ${target.role} “${target.name}”${outcome.displayValue ? ` with ${outcome.displayValue}` : ""}.`;
      } catch (error) {
        resultText = error instanceof MissingValueError ? `Stopped: ${error.message}` : `Action failed: ${error instanceof Error ? redactSecrets(error.message) : "unknown error"}`;
        task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action: null, result: resultText, verified: false });
        setTerminal(task, "stopped");
        return;
      }

      const action = { operation, backendNodeId: target.backendNodeId, target: target.formattedValue };
      await waitForPageStability(page);
      await captureTaskPreview(page, task.taskId).catch((error) => console.warn("Could not refresh browser preview:", error instanceof Error ? error.message : String(error)));
      const verified = await verifyByCode(page, structured);
      task.history.push({ step: stepNumber, at: new Date().toISOString(), url: state.url, candidates, decision, action, result: verified ? `${resultText} Configured verification passed.` : resultText, verified });
      console.log(JSON.stringify({ event: "action", taskId: task.taskId, step: stepNumber, action: { operation, backendNodeId: target.backendNodeId, target: target.formattedValue }, result: verified ? "verified" : "completed" }));
      if (verified) {
        setTerminal(task, "done");
        return;
      }
    }
    setTerminal(task, "stopped");
    const last = task.history.at(-1);
    if (last) last.result = "Stopped: reached the configured maximum step count.";
  } catch (error) {
    task.error = error instanceof Error ? redactSecrets(error.message) : "Unknown task error.";
    setTerminal(task, "failed");
  } finally {
    await page?.close().catch(() => undefined);
    if (ownsBrowser) await browser?.close().catch(() => undefined);
    else browser?.disconnect();
  }
}

export const NO_ACTION = modelNoAction;
