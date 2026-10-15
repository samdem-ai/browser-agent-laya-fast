import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { RunTaskRequest, TaskRecord } from "./contracts.js";
import { getTaskPreview, removeTaskPreview, runTask } from "./task-runner.js";
import { layaHealth } from "./laya-client.js";
import { stopOwnedObscura } from "./browser.js";
import { redactSecrets } from "./resolver.js";

const app = express();
const tasks = new Map<string, TaskRecord>();
app.use(cors());
app.use(express.json({ limit: "128kb" }));

app.get("/health", (_request, response) => response.json({ ready: true, service: "browser-agent" }));
app.get("/health/laya", async (_request, response) => {
  try {
    response.json(await layaHealth());
  } catch (error) {
    response.status(503).json({ ready: false, error: error instanceof Error ? error.message : "Laya service unavailable" });
  }
});

app.post("/run-task", (request, response) => {
  const body = request.body as Partial<RunTaskRequest>;
  if (typeof body.url !== "string" || typeof body.goal !== "string" || !body.url.trim() || !body.goal.trim()) {
    response.status(400).json({ error: "url and goal are required strings." });
    return;
  }
  let parsed: URL;
  try { parsed = new URL(body.url); } catch { response.status(400).json({ error: "url must be a valid absolute URL." }); return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    response.status(400).json({ error: "Only http and https URLs are supported." });
    return;
  }
  const taskId = randomUUID();
  const safeGoal = redactSecrets(body.goal).slice(0, 2000);
  const record: TaskRecord = { taskId, status: "running", goal: safeGoal, history: [], stopRequested: false, startedAt: new Date().toISOString() };
  tasks.set(taskId, record);
  void runTask(record, parsed.toString(), safeGoal, body.task ?? {}).then(() => {
    if (tasks.size > 500) {
      for (const [id, task] of tasks) {
        if (task.status !== "running") {
          tasks.delete(id);
          removeTaskPreview(id);
        }
      }
    }
  });
  response.status(202).json({ taskId });
});

app.get("/status/:taskId", (request, response) => {
  const task = tasks.get(request.params.taskId);
  if (!task) { response.status(404).json({ error: "Task not found." }); return; }
  response.json(task);
});

app.get("/preview/:taskId", (request, response) => {
  if (!tasks.has(request.params.taskId)) { response.status(404).json({ error: "Task not found." }); return; }
  const preview = getTaskPreview(request.params.taskId);
  if (!preview) { response.status(404).json({ error: "Browser preview is not ready yet." }); return; }
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.send(Buffer.from(preview));
});

app.post("/stop/:taskId", (request, response) => {
  const task = tasks.get(request.params.taskId);
  if (!task) { response.status(404).json({ error: "Task not found." }); return; }
  if (task.status === "running") task.stopRequested = true;
  response.json({ taskId: task.taskId, stopRequested: task.stopRequested, status: task.status });
});

const server = app.listen(config.port, () => console.log(`Browser agent API listening on :${config.port}`));
const shutdown = () => {
  server.close(() => {
    stopOwnedObscura();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
