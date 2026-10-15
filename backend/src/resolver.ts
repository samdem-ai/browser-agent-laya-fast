import type { Candidate, Operation, StructuredTask } from "./contracts.js";
import { config } from "./config.js";

export class MissingValueError extends Error {}

export function hasResolvableValue(candidate: Candidate, task: StructuredTask): boolean {
  try {
    resolveValue(candidate, task);
    return true;
  } catch {
    return false;
  }
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function operationFor(candidate: Candidate): Operation | null {
  switch (candidate.role) {
    case "textbox":
    case "searchbox":
      return "INPUT";
    case "combobox":
    case "checkbox":
    case "radio":
    case "slider":
      return "SELECT";
    case "link":
    case "button":
    case "menuitem":
      return "CLICK";
    default:
      return null;
  }
}

export function resolveValue(candidate: Candidate, task: StructuredTask): string {
  const name = normalized(candidate.name);
  if (candidate.inputType === "password" || /\bpassword\b|\bpasscode\b|\bsecret\b/.test(name)) {
    if (config.password) return config.password;
    throw new MissingValueError("Password value is missing from AUTOMATION_PASSWORD.");
  }
  if (/\buser(name)?\b|\blogin\b/.test(name)) {
    if (config.username) return config.username;
    throw new MissingValueError("Username value is missing from AUTOMATION_USERNAME.");
  }

  const supplied = task.values ?? {};
  const exact = Object.entries(supplied).find(([key]) => normalized(key) === name)?.[1];
  if (exact !== undefined) return exact;
  if (/\b(from|origin|departure|leaving)\b/.test(name) && task.from) return task.from;
  if (/\b(to|destination|arrival|going)\b/.test(name) && task.to) return task.to;
  if (/\b(date|depart|when)\b/.test(name) && task.date) return task.date;
  if (/\b(search|query|find)\b/.test(name) && task.search) return task.search;
  throw new MissingValueError(`No structured value is configured for the ${candidate.role} “${candidate.name}”.`);
}

export function redactSecrets(text: string): string {
  let output = text;
  for (const secret of [config.password, config.username]) {
    if (secret && secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}
