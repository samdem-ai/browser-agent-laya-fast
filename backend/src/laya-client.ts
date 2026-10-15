import type { LayaRequest, LayaResponse } from "./contracts.js";
import { config } from "./config.js";

export async function decide(request: LayaRequest, signal?: AbortSignal): Promise<LayaResponse> {
  const response = await fetch(`${config.layaUrl}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Laya service returned ${response.status}: ${body.slice(0, 500)}`);
  }
  const value = await response.json() as Partial<LayaResponse>;
  if (typeof value.taskId !== "string" || typeof value.targetConfidence !== "number" || typeof value.goalMet !== "boolean" || typeof value.stuck !== "boolean") {
    throw new Error("Laya service response did not match the decision contract.");
  }
  if (value.backendNodeId !== null && typeof value.backendNodeId !== "number") throw new Error("Laya returned an invalid backendNodeId.");
  if (value.operation !== null && (typeof value.operation !== "string" || !["CLICK", "INPUT", "SELECT"].includes(value.operation))) throw new Error("Laya returned an invalid operation.");
  return value as LayaResponse;
}

export async function layaHealth(): Promise<{ ready: boolean; model: string }> {
  const response = await fetch(`${config.layaUrl}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Laya health check returned ${response.status}.`);
  return await response.json() as { ready: boolean; model: string };
}
