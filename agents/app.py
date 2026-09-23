import flask
from laya_agent import run_agent
app = flask.Flask(__name__)
app.config["DEBUG"] = True


@app.route('/agent', methods=['POST'])
def run_task():
    data = flask.request.get_json()
    task_id = data.get('taskId')
    components = data.get('components')
    goal = data.get('goal')
    print(f"Received request with Task ID: {task_id}, Components: {components}, and Goal: {goal}")
    if not components or not goal:
        return flask.jsonify({'error': 'Missing components or goal'}), 400

    # Here you would call your backend function to run the task
    # For example, you might use a function like runTask(url, goal)
    # Assuming runTask is an async function, you might need to handle it accordingly

    # For demonstration purposes, let's just return a success message
    return flask.jsonify({'message': 'Task started successfully', 'components': components, 'goal': goal}), 200

