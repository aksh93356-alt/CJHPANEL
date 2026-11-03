// Remote node agent. Run on another VPS: CJH_TOKEN=secret node agent.js  (listens on 6768)
const express = require('express'), { fns } = require('./daemon');
const TOKEN = process.env.CJH_TOKEN;
if (!TOKEN || TOKEN.length < 16) { console.error('CJH_TOKEN (min 16 chars) is required'); process.exit(1); }
const app = express(); app.use(express.json());
app.post('/rpc', async (q, r) => {
  if (q.headers['x-token'] !== TOKEN) return r.status(401).json({ error: 'bad token' });
  const f = fns[q.body.fn];
  if (!Object.prototype.hasOwnProperty.call(fns, q.body.fn)) return r.status(400).json({ error: 'unknown fn' });
  try { r.json({ result: await f(...(q.body.args || [])) }); } catch (e) { r.status(500).json({ error: e.message }); }
});
const port = +process.env.AGENT_PORT || 6768;
app.listen(port, '0.0.0.0', () => console.log('CJH agent listening on ' + port));
