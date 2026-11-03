const express = require('express'), session = require('express-session'), bcrypt = require('bcryptjs'),
  Database = require('better-sqlite3'), fs = require('fs'), path = require('path'), crypto = require('crypto'),
  net = require('net'), http = require('http'), https = require('https'), { execSync } = require('child_process');
const { fns } = require('./daemon');

const PORT = +process.env.PORT || 6767;
const DATA = path.join(__dirname, 'data'); fs.mkdirSync(DATA, { recursive: true });
const db = new Database(path.join(DATA, 'cjh.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY, name TEXT, address TEXT, port INTEGER DEFAULT 6768, token TEXT, is_local INTEGER DEFAULT 0, public_host TEXT);
CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY, user_id INTEGER, node_id INTEGER, name TEXT, version TEXT, memory INTEGER, port INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, d TEXT, exp INTEGER);`);

// Seed default admin + local node
if (!db.prepare('SELECT 1 FROM users').get())
  db.prepare('INSERT INTO users(username,password,is_admin) VALUES(?,?,1)').run('admin', bcrypt.hashSync('admin', 10));
if (!db.prepare('SELECT 1 FROM nodes WHERE is_local=1').get())
  db.prepare('INSERT INTO nodes(name,address,is_local) VALUES(?,?,1)').run('Local Node', '127.0.0.1');

const DEF = { name: 'CJH Panel', icon: '⛏️', accent: '#7c5cff', bg: '#0b0d12', panel: '#141821', bgimage: '', blur: '0' };
const getS = () => ({ ...DEF, ...Object.fromEntries(db.prepare('SELECT k,v FROM settings').all().map(r => [r.k, r.v])) });
const nodeById = id => db.prepare('SELECT * FROM nodes WHERE id=?').get(id);

// ---- node RPC: local = in-process, remote = HTTP to agent ----
async function rpc(node, fn, ...args) {
  if (!Object.prototype.hasOwnProperty.call(fns, fn)) throw new Error('unknown fn');
  if (node.is_local) return await fns[fn](...args);
  const base = /^https?:\/\//.test(node.address) ? node.address : `http://${node.address}:${node.port}`;
  const r = await fetch(base + '/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': node.token },
    body: JSON.stringify({ fn, args }), signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Node responded ' + r.status);
  return j.result;
}

// ---- sessions stored in SQLite ----
class Store extends session.Store {
  get(sid, cb) { try { const r = db.prepare('SELECT d FROM sessions WHERE sid=? AND exp>?').get(sid, Date.now()); cb(null, r ? JSON.parse(r.d) : null); } catch (e) { cb(e); } }
  set(sid, s, cb) { try { db.prepare('REPLACE INTO sessions VALUES(?,?,?)').run(sid, JSON.stringify(s), Date.now() + 6048e5); cb && cb(); } catch (e) { cb && cb(e); } }
  destroy(sid, cb) { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb && cb(); }
}
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

const app = express();
app.set('view engine', 'ejs'); app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false })); app.use(express.json());
app.use(session({
  store: new Store(), secret: fs.readFileSync(secretFile, 'utf8'), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 6048e5 } // works on both HTTP and HTTPS
}));
app.use((q, r, n) => {
  q.session.csrf = q.session.csrf || crypto.randomBytes(16).toString('hex');
  if (q.method === 'POST' && (q.body && q.body._csrf || q.headers['x-csrf']) !== q.session.csrf) return r.status(403).send('Invalid CSRF token. Reload the page.');
  q.user = q.session.uid ? db.prepare('SELECT id,username,is_admin FROM users WHERE id=?').get(q.session.uid) : null;
  r.locals.user = q.user; r.locals.csrf = q.session.csrf; r.locals.S = getS(); n();
});

const A = f => (q, r, n) => Promise.resolve(f(q, r, n)).catch(e => { console.error(e); r.status(500).json({ error: e.message }); });
const need = (q, r, n) => q.user ? n() : r.redirect('/login');
const adminOnly = (q, r, n) => q.user.is_admin ? n() : r.status(403).send('Forbidden');
const own = A((q, r, n) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(q.params.id);
  if (!s || (s.user_id !== q.user.id && !q.user.is_admin)) return r.status(404).send('Server not found');
  q.srv = s; q.node = nodeById(s.node_id); n();
});

// ---- auth ----
app.get('/login', (q, r) => r.render('login', { mode: 'login', error: null }));
app.post('/login', (q, r) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(q.body.username || '').trim());
  if (u && bcrypt.compareSync(String(q.body.password || ''), u.password)) { q.session.uid = u.id; return r.redirect('/'); }
  r.render('login', { mode: 'login', error: 'Wrong username or password.' });
});
app.get('/register', (q, r) => r.render('login', { mode: 'register', error: null }));
app.post('/register', (q, r) => {
  const un = String(q.body.username || '').trim(), pw = String(q.body.password || '');
  const fail = e => r.render('login', { mode: 'register', error: e });
  if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return fail('Username must be 3-20 letters, numbers or underscores.');
  if (pw.length < 6) return fail('Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(un)) return fail('That username is taken.');
  q.session.uid = db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(un, bcrypt.hashSync(pw, 10)).lastInsertRowid;
  r.redirect('/');
});
app.post('/logout', (q, r) => q.session.destroy(() => r.redirect('/login')));
app.post('/account/password', need, (q, r) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(q.user.id);
  if (!bcrypt.compareSync(String(q.body.old || ''), u.password) || String(q.body.new || '').length < 6) return r.status(400).send('Wrong current password, or new password shorter than 6 characters.');
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(q.body.new, 10), u.id); r.redirect('/admin');
});

// ---- dashboard & servers ----
app.get('/', need, A(async (q, r) => {
  const sql = 'SELECT s.*, n.name AS node FROM servers s JOIN nodes n ON n.id=s.node_id ' + (q.user.is_admin ? '' : 'WHERE s.user_id=? ') + 'ORDER BY s.id';
  const list = q.user.is_admin ? db.prepare(sql).all() : db.prepare(sql).all(q.user.id);
  await Promise.all(list.map(async s => { try { s.status = await rpc(nodeById(s.node_id), 'status', s.id); } catch { s.status = 'unreachable'; } }));
  r.render('dashboard', { list, nodes: db.prepare('SELECT id,name FROM nodes').all() });
}));
app.post('/servers', need, A(async (q, r) => {
  const name = String(q.body.name || '').trim().slice(0, 40), version = String(q.body.version || '');
  const mem = Math.min(32768, Math.max(512, +q.body.memory || 1024)), node = nodeById(+q.body.node_id);
  if (!name || !/^[0-9.]+$/.test(version) || !node) return r.status(400).send('Invalid input');
  const port = (db.prepare('SELECT MAX(port) m FROM servers WHERE node_id=?').get(node.id).m || 25564) + 1;
  const id = db.prepare('INSERT INTO servers(user_id,node_id,name,version,memory,port) VALUES(?,?,?,?,?,?)').run(q.user.id, node.id, name, version, mem, port).lastInsertRowid;
  try { await rpc(node, 'install', id, version); } catch (e) { db.prepare('DELETE FROM servers WHERE id=?').run(id); throw e; }
  r.redirect('/servers/' + id);
}));
app.get('/servers/:id', need, own, A(async (q, r) => {
  const host = q.node.public_host || (q.node.is_local ? q.hostname : q.node.address.replace(/^https?:\/\//, ''));
  r.render('console', { server: q.srv, node: q.node, address: host + ':' + q.srv.port });
}));
app.get('/servers/:id/logs', need, own, A(async (q, r) => {
  const l = await rpc(q.node, 'logs', q.query.src === 'playit' ? 'playit' : q.srv.id, q.query.since);
  r.json({ ...l, status: await rpc(q.node, 'status', q.srv.id), playit: await rpc(q.node, 'playitStatus') });
}));
app.post('/servers/:id/power', need, own, A(async (q, r) => {
  const a = q.body.action; if (!['start', 'stop', 'kill'].includes(a)) return r.status(400).json({ error: 'Bad action' });
  r.json({ result: await rpc(q.node, a, q.srv.id, q.srv.memory, q.srv.port) });
}));
app.post('/servers/:id/command', need, own, A(async (q, r) => r.json({ result: await rpc(q.node, 'cmd', q.srv.id, String(q.body.cmd || '').slice(0, 500)) })));
app.post('/servers/:id/playit', need, own, A(async (q, r) => {
  if (q.body.action === 'start') return r.json({ result: await rpc(q.node, 'playitStart', String(q.body.secret || '')) });
  r.json({ result: await rpc(q.node, 'playitStop') });
}));
app.post('/servers/:id/delete', need, own, A(async (q, r) => {
  try { await rpc(q.node, 'remove', q.srv.id); } catch (e) { if (!q.user.is_admin) throw e; }
  db.prepare('DELETE FROM servers WHERE id=?').run(q.srv.id); r.json({ ok: 1 });
}));

// ---- admin ----
app.get('/admin', need, adminOnly, A(async (q, r) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  await Promise.all(nodes.map(async n => { try { await rpc(n, 'ping'); n.online = true; } catch { n.online = false; } }));
  r.render('admin', { nodes, users: db.prepare('SELECT id,username,is_admin FROM users').all(), token: crypto.randomBytes(24).toString('hex') });
}));
app.post('/admin/nodes', need, adminOnly, A(async (q, r) => {
  const b = q.body, port = +b.port || 6768;
  if (!b.name || !b.address || String(b.token || '').length < 16) return r.status(400).send('Name, address and a token of 16+ characters are required.');
  db.prepare('INSERT INTO nodes(name,address,port,token,public_host) VALUES(?,?,?,?,?)').run(String(b.name).slice(0, 40), String(b.address).trim(), port, b.token, String(b.public_host || '').trim());
  r.redirect('/admin');
}));
app.post('/admin/nodes/:id/delete', need, adminOnly, (q, r) => {
  const n = nodeById(q.params.id);
  if (!n || n.is_local) return r.status(400).send('The local node cannot be removed.');
  if (db.prepare('SELECT 1 FROM servers WHERE node_id=?').get(n.id)) return r.status(400).send('Delete this node\'s servers first.');
  db.prepare('DELETE FROM nodes WHERE id=?').run(n.id); r.redirect('/admin');
});
app.post('/admin/users/:id/delete', need, adminOnly, A(async (q, r) => {
  const id = +q.params.id; if (id === q.user.id) return r.status(400).send('You cannot delete yourself.');
  for (const s of db.prepare('SELECT * FROM servers WHERE user_id=?').all(id)) { try { await rpc(nodeById(s.node_id), 'remove', s.id); } catch {} }
  db.prepare('DELETE FROM servers WHERE user_id=?').run(id); db.prepare('DELETE FROM users WHERE id=?').run(id); r.redirect('/admin');
}));
app.post('/admin/settings', need, adminOnly, (q, r) => {
  const b = q.body, hex = /^#[0-9a-fA-F]{6}$/, url = /^(https?:\/\/|\/)[^\s"'()<>\\]+$/;
  const v = {
    name: String(b.name || '').trim().slice(0, 30) || DEF.name,
    icon: (url.test(b.icon) || String(b.icon || '').length <= 8) && b.icon ? b.icon : DEF.icon,
    accent: hex.test(b.accent) ? b.accent : DEF.accent, bg: hex.test(b.bg) ? b.bg : DEF.bg, panel: hex.test(b.panel) ? b.panel : DEF.panel,
    bgimage: !b.bgimage ? '' : url.test(b.bgimage) ? b.bgimage : '', blur: String(Math.min(20, Math.max(0, parseInt(b.blur, 10) || 0)))
  };
  for (const k in v) db.prepare('REPLACE INTO settings VALUES(?,?)').run(k, v[k]);
  r.redirect('/admin');
});

// ---- HTTP + HTTPS on the same port (sniffs the first byte: 0x16 = TLS handshake) ----
function tls() {
  try {
    const d = path.join(DATA, 'certs'), k = path.join(d, 'key.pem'), c = path.join(d, 'cert.pem'); fs.mkdirSync(d, { recursive: true });
    if (!fs.existsSync(c)) execSync(`openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=cjh-panel" -keyout "${k}" -out "${c}"`, { stdio: 'ignore' });
    return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
  } catch (e) { console.warn('HTTPS disabled:', e.message); return null; }
}
const httpSrv = http.createServer(app), t = tls(), httpsSrv = t && https.createServer(t, app);
net.createServer(sock => {
  sock.on('error', () => {});
  sock.once('data', b => {
    sock.pause(); sock.unshift(b);
    (b[0] === 0x16 && httpsSrv ? httpsSrv : httpSrv).emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
}).listen(PORT, '0.0.0.0', () => console.log(`CJH Panel on :${PORT} (HTTP${httpsSrv ? ' + HTTPS' : ''})`));
