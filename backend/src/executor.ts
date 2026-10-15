import type { Page } from "puppeteer-core";
import type { Candidate, Operation, StructuredTask } from "./contracts.js";
import { resolveValue } from "./resolver.js";

export async function executeAction(page: Page, candidate: Candidate, operation: Operation, task: StructuredTask): Promise<{ displayValue?: string }> {
  const client = await page.target().createCDPSession();
  try {
    const { object } = await client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!object.objectId) throw new Error(`Could not resolve backendNodeId ${candidate.backendNodeId}.`);
    try {
      if (operation === "CLICK") {
        await client.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});this.click()}",
          awaitPromise: true,
        });
        return {};
      }

      const value = resolveValue(candidate, task);
      if (operation === "INPUT") {
        await client.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function(value){
            this.scrollIntoView({block:'center'});this.focus();
            if(this.isContentEditable){this.textContent=value;this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}));return;}
            const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
            const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
            setter?setter.call(this,value):this.value=value;
            this.dispatchEvent(new Event('input',{bubbles:true}));
            this.dispatchEvent(new Event('change',{bubbles:true}));
          }`,
          arguments: [{ value }],
          awaitPromise: true,
        });
      } else {
        const { result } = await client.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function(value){
            this.scrollIntoView({block:'center'});
            if(this instanceof HTMLSelectElement){
              const option=Array.from(this.options).find(o=>o.value===value||o.label===value||o.textContent?.trim()===value);
              if(!option) return {ok:false,error:'No option matched the configured value'};
              this.value=option.value;
              this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
              return {ok:true};
            }
            if(this instanceof HTMLInputElement&&(this.type==='checkbox'||this.type==='radio')){
              if(!this.checked)this.click();
              return {ok:true};
            }
            return {ok:false,error:'Target is not a supported select control'};
          }`,
          arguments: [{ value }],
          returnByValue: true,
          awaitPromise: true,
        });
        if (!(result.value as { ok?: boolean } | undefined)?.ok) {
          throw new Error((result.value as { error?: string } | undefined)?.error ?? "Could not select the requested value.");
        }
      }
      // Keep the actual input value out of logs and task history.
      const sensitive = /password|username|login|email/i.test(candidate.name);
      return { displayValue: sensitive ? "[REDACTED]" : "[configured value]" };
    } finally {
      await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
}
