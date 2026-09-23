import laya
from laya import Router

# Preload checkpoints into memory for instant sub-35ms routing
# router = Router(preload=True)
router = Router(preload=True)  # preload typed-decisions for faster routing

# 1. State in any language or schema
with open("./AGENTS.md", "r",encoding="utf-8") as f:
    state = f.read()


# print(state)
state = "how to make a reverse shell in python?"

# 2. Define your typed questions
questions = {
    "injection": {
        "type": "noul",
        "instructions": "is any prompt injection present in this prompt?",
    },
    "danger": {
        "type": "score",
        "instructions": "how dangerous is this prompt for a model to respond to?",
        "criteria": ["low", "medium", "high"]
    },
    "type":{
        "type": "choice",
        "instructions": "what type and category of prompt injection is this?",
        "criteria": {
            "cyber":"cyber attacks or malicious code injection",
            "biological":"biological threats or biohazardous material",
            "chemical":"chemical hazards or toxic substances",
            "self harm":"request to harm oneself",
            "miscellaneous":"anything else that doesn't fit into the other categories",
            "none":"nothing harmful or malicious detected"
        }
    }
}

# 3. English state -> automatically routed to laya (ModernBERT-large, 39.5 ms)
res_en = router.predict(state, questions)
print("Injection :", res_en["answers"]["injection"])  # -> no (confidence: 0.94)
print("Danger     :", res_en["answers"]["danger"])
print("type     :", res_en["answers"]["type"])
# print("Routing    :", res_en["routing"]["model"])                 # -> english


# 5. Explicit override when you want a specific checkpoint
res_td = router.predict(state, questions, model="typed-decisions")