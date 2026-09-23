import laya
from laya import Router

# Preload checkpoints into memory for instant sub-35ms routing
# router = Router(preload=True)
router = Router(preload=True)  # preload typed-decisions for faster routing



def run_agent(components, goal):
    # Define typed questions
    questions = {
        "needed": {
            "type":"noul",
            "instructions":"is this component needed to achieve the goal?",
            },
        "action": {
            type: "choice",
            "instructions": "what action should be taken with this component to achieve the goal?",
            "criteria":{
                "CLICK": "click on the component",
                "SELECT": "select the component",
                "INPUT": "input text into the component",
                "NAVIGATE": "navigate to the component",
                "IGNORE": "ignore this component and do not use it to achieve the goal"
                }
        },
        "confidence": {
            "type": "score",
            "instructions": "how confident are you that this component is needed to achieve the goal? low to high",
            "criteria": ["low", "medium", "high"]
        }


    }

    answers = []
    for component in components:
        print(component)
        formatted_component = f'[{component["backendDOMNodeId"]} {component["role"]}: {component["name"]}]'
        print(formatted_component)
        state = f'we are navigating a website and we need to find the steps to follow to achieve the goal: {goal} using the following component: {component}'
        print(state)
        # 3. English state -> automatically routed to laya (ModernBERT-large, 39.5 ms)
        res_en = router.predict(state, questions)
        print(res_en["answers"])



    # res_td = router.predict(state, questions, model="typed-decisions")
    # return res_en
    return None