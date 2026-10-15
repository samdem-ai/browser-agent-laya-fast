# Laya Browser Agent

Browser tasks run as a code-owned loop: Obscura opens the page, the extractor returns visible controls, Laya ranks the eligible controls, the Node resolver supplies configured values, and a verifier checks the requested result. The React UI only calls the Express API.

## Run locally

### 1. Start the Laya service

```bash
cd agents
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
USE_TF=0 .venv/bin/python app.py
```

The first model load downloads and initializes `convaiinnovations/laya-typed-decisions`; later starts reuse the Hugging Face cache. The CPU-only PyTorch wheel keeps the service from installing CUDA libraries.

### 2. Start the Node API

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Set `AUTOMATION_USERNAME` and `AUTOMATION_PASSWORD` in `backend/.env` when a task needs credentials. Those values stay in the Node resolver and are redacted from task goals, page text, logs, and history. Obscura starts automatically from the bundled Linux executable when the configured CDP endpoint is not already running. Set `OBSCURA_BIN` if the executable is elsewhere.

### 3. Start the frontend

```bash
cd frontend/my-app
npm install
npm run dev
```

Open the local Next.js address printed by the dev server. `NEXT_PUBLIC_API_URL` can point the UI at a different API host; it defaults to `http://localhost:8080`.

## API

Start an asynchronous task:

```http
POST /run-task
Content-Type: application/json

{
  "url": "https://the-internet.herokuapp.com/login",
  "goal": "Enter the practice login credentials and sign into the secure area.",
  "task": {
    "verify": { "textIncludes": "You logged into a secure area!" }
  }
}
```

The response contains a `taskId`. Poll `GET /status/:taskId` for status and step history, or send `POST /stop/:taskId` to request a stop. `GET /preview/:taskId` returns the latest JPEG viewport capture while a task is running and after it ends. Captures are held in memory; text fields, selects, editable areas, and configured credential strings are masked in the preview. If masking cannot be applied to every frame, that capture is withheld. For structured form tasks, provide `task.from`, `task.to`, `task.date`, `task.search`, or exact field values in `task.values`. Completion is marked `done` only when a configured `task.verify.textIncludes` or `task.verify.urlIncludes` condition passes; when both are supplied, both must pass. Without a verification condition, Laya can suggest that the task is done, but the service will not report it as verified.

## Decision and stop policy

- The extractor retains at most 40 visible interactive controls. A single Laya choice question compares up to 18 controls plus an explicit `NO_ACTION` option, within the model's documented small-choice guidance.
- Laya returns a backend node ID; Node maps that ID directly to the stored candidate and derives the operation from its role. Laya never supplies typed text.
- Username and password values come from environment variables. Other form values come from the structured task object.
- The loop owns confidence gates, repeated-action detection, maximum steps, explicit stop requests, and verification. Default limits are in `backend/src/config.ts`.
- The current Laya typed-decisions checkpoint is specialized and its packaged choice calibration is invalid for some option counts. Treat its scores as routing evidence, not a proof of correctness; a passing code verifier is the completion signal.

## Browser compatibility

Obscura is the default browser. It supports `Accessibility.getFullAXTree` and the extractor falls back to DOM inspection when the AX domain is unavailable. In the bundled Obscura 0.2.4 build, frame-specific AX requests return the parent tree and frame runtime contexts are not exposed. When a page contains an iframe, the task runner therefore reopens it in local Chromium if `CHROMIUM_EXECUTABLE_PATH` is available. The browser switch is logged. Pages without frames continue using Obscura.

Dynamic page changes are given a stability wait; visible “Loading…” states are awaited before the next extraction. For explicit scroll or infinite-scroll goals, the task runner uses bounded mouse-wheel steps and records each step in history. Pages with interactive open shadow roots also switch to Chromium; the extractor supplements accessibility results with DOM inspection so shadow-root controls are retained.

## Checks

```bash
cd backend && npm run build && npm run test:practice
cd frontend/my-app && npm run lint && npm run build
```

The staged practice checks used `https://the-internet.herokuapp.com/login`, `/iframe`, `/dynamic_loading/1`, `/shadowdom`, and `/infinite_scroll`.
