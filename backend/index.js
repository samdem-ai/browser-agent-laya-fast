import puppeteer from 'puppeteer-core';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const tasks = {}

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/status/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  if (tasks[taskId]) {
    res.json({ status: tasks[taskId].status });
  } else {
    res.status(404).json({ error: 'Task not found' });
  }
});

app.post('/run-task', async (req, res) => {
  console.log(req.body);
  const {url, goal} = req.body;
  const taskId = Date.now().toString();
  tasks[taskId] = { status: 'running' };
  runTask(url, goal, taskId).then((history) => {
    console.log(`Task ${taskId} completed successfully.`);
    console.log(history);
    tasks[taskId].status = 'done';
    // tasks[taskId].history = history;
    res.status(200).json({ taskId, history });

  }).catch((error) => {
    tasks[taskId].status = 'error';
    tasks[taskId].error = error.message;
  })
});



app.post('/stop/:taskId', (req, res) => {
  // hook this into your agent loop's stop flag
  if (tasks[req.params.taskId]) tasks[req.params.taskId].status = 'stopped';
  res.json({ stopped: true });
});


const runTask = async (url, goal, taskId) => {

  const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser',
  });

  const page = await browser.newPage();
  await page.goto(url);

    const client = await page.target().createCDPSession();

    await client.send('Accessibility.enable');
    const { nodes } = await client.send('Accessibility.getFullAXTree');

    const interactiveRoles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio','label']);
    console.log(nodes)
    const candidates = nodes
      .filter(n => interactiveRoles.has(n.role?.value) && !n.ignored)
      .map(n => ({
        backendNodeId: n.backendDOMNodeId,
        role: n.role.value,
        name: n.name?.value || '',
      }));

    console.log(candidates);
    console.log(`Found ${candidates.length} interactive elements on the page.`);


  await browser.disconnect();
  console.log(candidates);
  return candidates;

};


app.listen(8080, () => console.log('API running on :8080'));