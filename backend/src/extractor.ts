import type { CDPSession, Page } from "puppeteer-core";
import type { Candidate } from "./contracts.js";
import { config } from "./config.js";
import { redactSecrets } from "./resolver.js";

const interactiveRoles = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "menuitem",
]);

type AxNode = {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  frameId?: string;
};

function visibleAndMetadataFunction(): string {
  return `function(){
    const r=this.getBoundingClientRect(),s=getComputedStyle(this);
    const visible=r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;
    const a=this.getAttribute('aria-label')||this.getAttribute('title')||'';
    const href=this instanceof HTMLAnchorElement?this.href:undefined;
    let h=this;
    while(h&&!(h.matches&&h.matches('h1,h2,h3,h4,h5,h6')))h=h.previousElementSibling;
    const isValueField=this instanceof HTMLInputElement||this instanceof HTMLTextAreaElement||this instanceof HTMLSelectElement;
    const inputState=isValueField?(this.type==='checkbox'||this.type==='radio'?(this.checked?'checked':'empty'):((this.value||'').length?'populated':'empty')):undefined;
    return {visible,ariaName:a,href,nearbyHeading:h?.innerText?.trim()||'',inputType:this instanceof HTMLInputElement?this.type:'',inputState,required:Boolean(this.required||this.getAttribute('aria-required')==='true')};
  }`;
}

async function visibleMetadata(client: CDPSession, backendNodeId: number): Promise<{ visible: boolean; href?: string; nearbyHeading?: string; inputType?: string; inputState?: "empty" | "populated" | "checked"; required?: boolean }> {
  const { object } = await client.send("DOM.resolveNode", { backendNodeId });
  if (!object.objectId) return { visible: false };
  try {
    const { result } = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: visibleAndMetadataFunction(),
      returnByValue: true,
    });
    const value = result.value as { visible?: boolean; href?: string; nearbyHeading?: string; inputType?: string; inputState?: "empty" | "populated" | "checked"; required?: boolean } | undefined;
    return {
      visible: Boolean(value?.visible),
      ...(typeof value?.href === "string" ? { href: value.href } : {}),
      ...(typeof value?.nearbyHeading === "string" ? { nearbyHeading: value.nearbyHeading } : {}),
      ...(typeof value?.inputType === "string" && value.inputType ? { inputType: value.inputType } : {}),
      ...(value?.inputState ? { inputState: value.inputState } : {}),
      ...(value?.required ? { required: true } : {}),
    };
  } finally {
    await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
  }
}

async function fromAccessibilityTree(client: CDPSession): Promise<Candidate[]> {
  await client.send("Accessibility.enable");
  const output: Candidate[] = [];
  const seen = new Set<number>();
  const { frameTree } = await client.send("Page.getFrameTree") as { frameTree: { frame: { id: string }; childFrames?: Array<{ frame: { id: string }; childFrames?: unknown[] }> } };
  const frameIds: string[] = [];
  const visitFrame = (frame: { frame: { id: string }; childFrames?: Array<{ frame: { id: string }; childFrames?: unknown[] }> }) => {
    frameIds.push(frame.frame.id);
    for (const child of frame.childFrames ?? []) visitFrame(child as typeof frame);
  };
  visitFrame(frameTree);
  for (const frameId of frameIds) {
    let nodes: AxNode[];
    try {
      ({ nodes } = await (frameId === frameTree.frame.id
        ? client.send("Accessibility.getFullAXTree")
        : client.send("Accessibility.getFullAXTree", { frameId })) as { nodes: AxNode[] });
    } catch (error) {
      if (frameId === frameTree.frame.id) throw error;
      console.warn(`Could not read accessibility tree for frame ${frameId}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const node of nodes) {
      const role = node.role?.value;
      const backendNodeId = node.backendDOMNodeId;
      if (node.ignored || !role || !interactiveRoles.has(role) || !backendNodeId) continue;
      const name = (node.name?.value ?? "").trim();
      if (seen.has(backendNodeId)) continue;
      const metadata: { visible: boolean; href?: string; nearbyHeading?: string; inputType?: string; inputState?: "empty" | "populated" | "checked"; required?: boolean } = await visibleMetadata(client, backendNodeId).catch(() => ({ visible: false }));
      if (!metadata.visible) continue;
      seen.add(backendNodeId);
      output.push({
        backendNodeId,
        role,
        name,
        formattedValue: `[${backendNodeId}] ${role}: ${name}`,
        ...(frameId !== frameTree.frame.id ? { frameId } : {}),
        ...(metadata.href ? { href: metadata.href } : {}),
        ...(metadata.nearbyHeading ? { nearbyHeading: metadata.nearbyHeading } : {}),
        ...(metadata.inputType ? { inputType: metadata.inputType } : {}),
        ...(metadata.inputState ? { inputState: metadata.inputState } : {}),
        ...(metadata.required ? { required: true } : {}),
      });
      if (output.length >= config.maxCandidates) return output;
    }
  }
  return output;
}

async function fromDom(client: CDPSession): Promise<Candidate[]> {
  const { result: array } = await client.send("Runtime.evaluate", {
    expression: `(()=>{const s='a,button,input,select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="slider"],[role="menuitem"]';const out=[];const walk=r=>{for(const e of r.querySelectorAll('*')){if(e.matches(s))out.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);return out})()`,
    returnByValue: false,
  }) as { result: { objectId?: string } };
  if (!array.objectId) return [];
  const { result: properties } = await client.send("Runtime.getProperties", { objectId: array.objectId, ownProperties: true }) as { result: Array<{ name: string; value?: { objectId?: string; subtype?: string } }> };
  const elementIds = properties.filter((property) => /^\d+$/.test(property.name) && property.value?.subtype === "node").flatMap((property) => property.value?.objectId ? [property.value.objectId] : []);
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (const sourceObjectId of elementIds) {
    const { node } = await client.send("DOM.describeNode", { objectId: sourceObjectId }) as { node: { backendNodeId: number; nodeName: string; attributes?: string[] } };
    const { object } = await client.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
    if (!object.objectId) continue;
    const attrs = node.attributes ?? [];
    const attribute = (key: string) => {
      const index = attrs.indexOf(key);
      return index < 0 ? "" : attrs[index + 1] ?? "";
    };
    let meta: { visible?: boolean; name?: string; href?: string; nearbyHeading?: string; inputType?: string; inputState?: "empty" | "populated" | "checked"; required?: boolean } = {};
    try {
      const { result } = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(){const r=this.getBoundingClientRect(),s=getComputedStyle(this),v=this instanceof HTMLInputElement||this instanceof HTMLTextAreaElement||this instanceof HTMLSelectElement||this.isContentEditable;return {visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0,name:(this.getAttribute('aria-label')||this.labels?.[0]?.innerText||this.innerText||this.value||this.getAttribute('placeholder')||this.getAttribute('title')||'').trim(),href:this instanceof HTMLAnchorElement?this.href:undefined,nearbyHeading:this.closest('section,form,fieldset')?.querySelector('h1,h2,h3,h4')?.innerText?.trim()||'',inputType:this instanceof HTMLInputElement?this.type:'',inputState:v?(this.type==='checkbox'||this.type==='radio'?(this.checked?'checked':'empty'):((this.value||this.textContent||'').length?'populated':'empty')):undefined,required:Boolean(this.required||this.getAttribute('aria-required')==='true')}}`,
        returnByValue: true,
      });
      meta = (result.value ?? {}) as typeof meta;
    } finally {
      await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
      await client.send("Runtime.releaseObject", { objectId: sourceObjectId }).catch(() => undefined);
    }
    if (!meta.visible) continue;
    const tag = node.nodeName.toLowerCase();
    const type = attribute("type").toLowerCase();
    const role = attribute("role") || (tag === "a" ? "link" : tag === "button" || type === "submit" || type === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? ({ search: "searchbox", checkbox: "checkbox", radio: "radio", range: "slider" }[type] ?? "textbox") : attribute("contenteditable") === "true" ? "textbox" : "");
    if (!interactiveRoles.has(role)) continue;
    const name = String(meta.name ?? "").trim();
    const id = node.backendNodeId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ backendNodeId: id, role, name, formattedValue: `[${id}] ${role}: ${name}`, ...(meta.inputType ? { inputType: meta.inputType } : {}), ...(meta.inputState ? { inputState: meta.inputState } : {}), ...(meta.required ? { required: true } : {}), ...(meta.href ? { href: meta.href } : {}), ...(meta.nearbyHeading ? { nearbyHeading: meta.nearbyHeading } : {}) });
    if (out.length >= config.maxCandidates) break;
  }
  return out;
}

async function fromChildFrames(page: Page, existing: Candidate[]): Promise<Candidate[]> {
  const output: Candidate[] = [];
  const seen = new Set(existing.map((candidate) => candidate.backendNodeId));
  const selector = 'a,button,input,select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="slider"],[role="menuitem"]';
  for (const frame of page.frames().slice(1)) {
    try {
      const handles = await frame.$$(selector);
      for (const handle of handles) {
        try {
          const metadata = await handle.evaluate((element) => {
            const el = element as HTMLElement;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const tag = el.tagName.toLowerCase();
            const input = el as HTMLInputElement;
            const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" || input.type === "submit" || input.type === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" || el.isContentEditable ? "textbox" : tag === "input" ? ({ search: "searchbox", checkbox: "checkbox", radio: "radio", range: "slider" } as Record<string, string>)[input.type] || "textbox" : "");
            const frameTitle = window.frameElement?.getAttribute("title") || "";
            const name = el.getAttribute("aria-label") || el.getAttribute("title") || ("labels" in el ? (el as HTMLInputElement).labels?.[0]?.innerText : "") || el.getAttribute("placeholder") || (tag === "a" || tag === "button" ? el.innerText : "") || (el.isContentEditable ? frameTitle : "");
            const valueField = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
            return {
              visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0,
              role,
              name: (name || "").trim(),
              href: el instanceof HTMLAnchorElement ? el.href : "",
              inputType: tag === "input" ? input.type : "",
              inputState: valueField ? ((tag === "input" && (input.type === "checkbox" || input.type === "radio")) ? (input.checked ? "checked" : "empty") : (("value" in el ? String((el as HTMLInputElement).value) : el.textContent || "").length ? "populated" : "empty")) : "",
              required: Boolean(("required" in el && (el as HTMLInputElement).required) || el.getAttribute("aria-required") === "true"),
            };
          });
          if (!metadata.visible || !interactiveRoles.has(metadata.role)) continue;
          const backendNodeId = await handle.backendNodeId();
          const key = backendNodeId;
          if (seen.has(key)) continue;
          seen.add(key);
          output.push({
            backendNodeId,
            role: metadata.role,
            name: metadata.name,
            formattedValue: `[${backendNodeId}] ${metadata.role}: ${metadata.name}`,
            ...(metadata.href ? { href: metadata.href } : {}),
            ...(metadata.inputType ? { inputType: metadata.inputType } : {}),
            ...(metadata.inputState ? { inputState: metadata.inputState as "empty" | "populated" | "checked" } : {}),
            ...(metadata.required ? { required: true } : {}),
          });
          if (output.length >= config.maxCandidates - existing.length) break;
        } finally {
          await handle.dispose();
        }
      }
      if (output.length >= config.maxCandidates - existing.length) break;
    } catch (error) {
      console.warn(`Could not inspect child frame ${frame.url()}:`, error instanceof Error ? error.message : String(error));
    }
  }
  return output;
}

export async function extractCandidates(page: Page): Promise<Candidate[]> {
  const client = await page.target().createCDPSession();
  try {
    try {
      const axCandidates = await fromAccessibilityTree(client);
      const domCandidates = await fromDom(client).catch((error) => {
        console.warn("DOM supplement could not extract controls:", error instanceof Error ? error.message : String(error));
        return [];
      });
      const byNode = new Map<number, Candidate>();
      for (const candidate of [...axCandidates, ...domCandidates]) byNode.set(candidate.backendNodeId, candidate);
      const rootCandidates = [...byNode.values()].slice(0, config.maxCandidates);
      const candidates = page.frames().length > 1 ? [...rootCandidates, ...await fromChildFrames(page, rootCandidates)] : rootCandidates;
      return candidates.slice(0, config.maxCandidates);
    } catch (error) {
      console.warn("Accessibility.getFullAXTree unavailable; using DOM fallback:", error instanceof Error ? error.message : String(error));
      return await fromDom(client);
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export async function readPageState(page: Page): Promise<{ url: string; title: string; pageText: string }> {
  const pageText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return {
    url: redactSecrets(page.url()),
    title: await page.title().catch(() => ""),
    pageText: redactSecrets(pageText.replace(/\s+/g, " ").trim()).slice(0, config.maxPageTextChars),
  };
}

export async function waitForPageStability(page: Page, timeoutMs = config.pageStableTimeoutMs): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 1800 }).catch(() => undefined);
  const initialText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (/\bloading\s*(?:\.{3}|…)?\b/i.test(initialText)) {
    await page.waitForFunction(() => !/\bloading\s*(?:\.{3}|…)?\b/i.test(document.body?.innerText ?? ""), { timeout: Math.max(timeoutMs, 12000) }).catch(() => undefined);
  }
  const started = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const current = await page.evaluate(() => `${location.href}\n${document.body?.innerText?.slice(0, 4000) ?? ""}`).catch(() => page.url());
    if (current === last) stable += 1; else stable = 0;
    if (stable >= 2) return;
    last = current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
