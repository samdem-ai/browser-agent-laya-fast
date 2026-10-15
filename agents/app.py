from __future__ import annotations

import os
from typing import Any

from flask import Flask, jsonify, request
import laya

MODEL_ID = "convaiinnovations/laya-typed-decisions"
MAX_OPTIONS = 18

# Load once before the service accepts requests.
agent = laya.load(MODEL_ID)
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024


def _probabilities(answer: dict[str, Any]) -> dict[str, float]:
    raw = answer.get("probabilities", {})
    if not isinstance(raw, dict):
        raise ValueError("Laya choice answer did not include a probability map")
    return {str(key): float(value) for key, value in raw.items()}


def make_questions(components: list[dict[str, Any]]) -> dict[str, Any]:
    criteria = {
        str(component["backendNodeId"]): (
            f'{component.get("role", "control")}: {component.get("name", "")}. '
            f'{"Current field is empty. " if component.get("inputState") == "empty" else "Current field already contains a value. " if component.get("inputState") == "populated" else ""}'
            f'{"A value is available from the local resolver; do not generate or request text. " if component.get("valueAvailable") else ""}'
            f'{"Required field. " if component.get("required") else ""}'
            f'{"Link destination: " + component["href"] + ". " if component.get("href") else ""}'
            f'{"Nearby section: " + component["nearbyHeading"] + ". " if component.get("nearbyHeading") else ""}'
        )
        for component in components[:MAX_OPTIONS]
    }
    criteria["NO_ACTION"] = "No listed control is a clear next action that advances the stated goal; abstain."
    return {
        "target": {
            "type": "choice",
            "instructions": "Which single visible control is the best next action for this browser task? Compare every listed control against the goal, current page, and action history. Choose NO_ACTION when none is clearly relevant.",
            "criteria": criteria,
        },
        "goal_met": {
            "type": "noul",
            "instructions": "Does the current visible browser page already satisfy the user's requested goal?",
            "criteria": {
                "true": "yes, the visible current page shows the requested outcome is complete",
                "false": "no, the visible current page does not yet show the requested outcome as complete",
            },
        },
        "stuck": {
            "type": "noul",
            "instructions": "Is the browser task currently stuck, with no useful available control for making progress?",
            "criteria": {
                "true": "yes, there is no useful visible control that can advance the task",
                "false": "no, at least one visible control can reasonably advance the task",
            },
        },
    }


@app.get("/health")
def health():
    return jsonify({"ready": True, "model": MODEL_ID})


@app.post("/decide")
def decide():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object required"}), 400
    task_id = data.get("taskId")
    goal = data.get("goal")
    components = data.get("components")
    state = data.get("state")
    history = data.get("history", [])
    if not isinstance(task_id, str) or not isinstance(goal, str) or not isinstance(components, list) or not isinstance(state, dict):
        return jsonify({"error": "taskId, goal, components, and state are required"}), 400
    if not components:
        return jsonify({"error": "components must not be empty"}), 400
    if len(components) > MAX_OPTIONS:
        return jsonify({"error": f"at most {MAX_OPTIONS} components may be sent to Laya"}), 400
    if not all(isinstance(item, dict) and isinstance(item.get("backendNodeId"), int) for item in components):
        return jsonify({"error": "every component must have an integer backendNodeId"}), 400

    questions = make_questions(components)
    model_state = {
        "task_goal": goal,
        "page_url": str(state.get("url", ""))[:500],
        "page_title": str(state.get("title", ""))[:300],
        "visible_page_text": str(state.get("pageText", ""))[:1400],
        "available_controls": [item.get("formattedValue", "") for item in components],
        "recent_actions": history[-4:] if isinstance(history, list) else [],
    }
    try:
        result = agent.predict(model_state, questions)
        answers = result["answers"]
        target_answer = answers["target"]
        goal_answer = answers["goal_met"]
        stuck_answer = answers["stuck"]

        selected = str(target_answer["choice"])
        probabilities = _probabilities(target_answer)
        if selected == "NO_ACTION":
            backend_node_id = None
            operation = None
        else:
            backend_node_id = int(selected)
            matching = next((item for item in components if item["backendNodeId"] == backend_node_id), None)
            if matching is None:
                raise ValueError(f"Laya selected unknown backendNodeId {selected}")
            role = matching.get("role")
            operation = "INPUT" if role in ("textbox", "searchbox") else "SELECT" if role in ("combobox", "checkbox", "radio", "slider") else "CLICK" if role in ("link", "button", "menuitem") else None
        selected_probability = float(probabilities.get(selected, 0.0))
        goal_met_probability = float(goal_answer["noul"])
        stuck_probability = float(stuck_answer["noul"])
        payload = {
            "taskId": task_id,
            "backendNodeId": backend_node_id,
            "operation": operation,
            "targetConfidence": selected_probability,
            "goalMet": goal_met_probability >= 0.5,
            "goalMetConfidence": max(goal_met_probability, 1.0 - goal_met_probability),
            "stuck": stuck_probability >= 0.5,
            "stuckConfidence": max(stuck_probability, 1.0 - stuck_probability),
            "probabilities": probabilities,
            "rationale": f"Laya selected {selected} from {len(components)} controls.",
        }
        print({"taskId": task_id, "selected": selected, "confidence": selected_probability, "goalMet": payload["goalMet"], "stuck": payload["stuck"]}, flush=True)
        return jsonify(payload)
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        app.logger.exception("Laya response contract or inference error for task %s", task_id)
        return jsonify({"error": f"Laya decision failed: {exc}"}), 502


if __name__ == "__main__":
    app.run(host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=int(os.environ.get("LAYA_PORT", "5000")), debug=False, threaded=True)
