import flask
app = flask.Flask(__name__)
app.config["DEBUG"] = True

app.run(host='0.0.0.0', port=5000)
app.route('/api/run_task', methods=['POST'])
def run_task():
    data = flask.request.get_json()
    url = data.get('url')
    goal = data.get('goal')

    if not url or not goal:
        return flask.jsonify({'error': 'Missing url or goal'}), 400

    # Here you would call your backend function to run the task
    # For example, you might use a function like runTask(url, goal)
    # Assuming runTask is an async function, you might need to handle it accordingly

    # For demonstration purposes, let's just return a success message
    return flask.jsonify({'message': 'Task started successfully', 'url': url, 'goal': goal}), 200
