import laya

agent = laya.load("convaiinnovations/laya")

state = {
    "subject": "Server is down",
    "body": "Our production server has been unavailable for 30 minutes."
}

questions = {
    "urgency": {
        "type": "score",
        "instructions": "How urgent is this request?",
        "criteria": [
            "not urgent",
            "needs attention soon",
            "critical deadline or blocking issue"
        ]
    }
}

result = agent.predict(state, questions)

print(result["answers"]["urgency"])