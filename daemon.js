// CJH daemon: manages Minecraft processes + Playit agent on the machine it runs on.
// Used in-process by the panel (local node) and exposed over HTTP by agent.js (remote nodes).
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const BASE = process.env.CJH_DATA || path.join(__dirname, 'data');
const ROOT = path.join(BASE, 'servers'), BIN = path.join(BASE, 'bin');
fs.mkdirSync(ROOT, { recursive: true }); fs.mkdirSync(BIN, { recursive: true });

const procs = {}, state = {}, buf = {};
let playit = null;
const dir = id => path.join(ROOT, String(parseInt(id, 10)));

function push(k, text) {
  const b = (buf[k] = buf[k] || { n: 0, l: [] });
  for (const s of String(text).split(/\r?\n/)) if (s.trim()) b.l.push({ i: ++b.n, t: s });
  if (b.l.length > 1500) b.l.splice(0, b.l.length - 1500);
}
const pipe = (k, p) => { p.stdout.on('data', d => push(k, d)); p.stderr.on('data', d => push(k, d)); };

const fns = {
  ping: () => 'pong',

  install(id, version) {
    if (!/^[0-9.]+$/.test(String(version))) throw new Error('Invalid version');
    id = +id; state[id] = 'installing'; fs.mkdirSync(dir(id), { recursive: true });
    push(id, `[CJH] Downloading Paper ${version}...`);
    (async () => {
      try {
        const H = { 'User-Agent': 'CJH-Panel/1.0' };
        const m = await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/latest`, { headers: H });
        if (!m.ok) throw new Error(`Paper version ${version} not found (HTTP ${m.status})`);
        const d = (await m.json()).downloads['server:default'];
        const j = await fetch(d.url, { headers: H });
        if (!j.ok) throw new Error('Jar download failed: HTTP ' + j.status);
        fs.writeFileSync(path.join(dir(id), 'server.jar'), Buffer.from(await j.arrayBuffer()));
        fs.writeFileSync(path.join(dir(id), 'eula.txt'), 'eula=true\n');
        state[id] = 'offline'; push(id, '[CJH] Install complete. Press Start.');
      } catch (e) { state[id] = 'error'; push(id, '[CJH] Install failed: ' + e.message); }
    })();
    return 'installing';
  },

  start(id, mem, port) {
    id = +id; mem = Math.max(512, +mem || 1024); port = +port || 25565;
    if (procs[id]) return 'already running';
    const d = dir(id);
    if (!fs.existsSync(path.join(d, 'server.jar'))) throw new Error('Server files are not installed yet');
    const pf = path.join(d, 'server.properties');
    let p = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '';
    p = /^server-port=/m.test(p) ? p.replace(/^server-port=.*/m, 'server-port=' + port)
      : p + (p && !p.endsWith('\n') ? '\n' : '') + 'server-port=' + port + '\n';
    fs.writeFileSync(pf, p);
    const c = spawn('java', ['-Xms' + Math.min(mem, 512) + 'M', '-Xmx' + mem + 'M', '-jar', 'server.jar', 'nogui'], { cwd: d });
    procs[id] = c; pipe(id, c); push(id, '[CJH] Starting server on port ' + port + '...');
    c.on('error', e => { push(id, '[CJH] Cannot launch Java: ' + e.message); delete procs[id]; });
    c.on('close', code => { push(id, '[CJH] Server stopped (exit ' + code + ')'); delete procs[id]; });
    return 'starting';
  },

  stop(id) {
    id = +id; const c = procs[id]; if (!c) return 'not running';
    c.stdin.write('stop\n'); setTimeout(() => { if (procs[id]) procs[id].kill('SIGKILL'); }, 30000);
    return 'stopping';
  },
  kill(id) { const c = procs[+id]; if (c) c.kill('SIGKILL'); return 'killed'; },
  cmd(id, c) { const p = procs[+id]; if (!p) throw new Error('Server is not running'); p.stdin.write(String(c).replace(/[\r\n]/g, ' ') + '\n'); return 'ok'; },
  status(id) {
    id = +id; if (procs[id]) return 'running';
    return state[id] || (fs.existsSync(path.join(dir(id), 'server.jar')) ? 'offline' : 'error');
  },
  logs(key, since) {
    const b = buf[key]; since = +since || 0;
    return { lines: b ? b.l.filter(x => x.i > since) : [], last: b ? b.n : 0 };
  },
  remove(id) {
    id = +id; if (procs[id]) procs[id].kill('SIGKILL');
    fs.rmSync(dir(id), { recursive: true, force: true }); delete buf[id]; delete state[id]; return 'removed';
  },

  // ---- Playit.gg tunnel agent ----
  async playitStart(secret) {
    if (playit) return 'already running';
    const bin = path.join(BIN, 'playit');
    if (!fs.existsSync(bin)) {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'amd64';
      push('playit', '[CJH] Downloading Playit.gg agent (' + arch + ')...');
      const r = await fetch(`https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${arch}`);
      if (!r.ok) throw new Error('Playit download failed: HTTP ' + r.status);
      fs.writeFileSync(bin, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
    }
    const args = secret && /^[A-Za-z0-9_-]+$/.test(secret) ? ['--secret', secret] : [];
    playit = spawn(bin, args, { cwd: BIN, env: { ...process.env, TERM: 'dumb' } });
    pipe('playit', playit); push('playit', '[CJH] Playit agent started. Open the claim link below if one appears.');
    playit.on('error', e => { push('playit', '[CJH] ' + e.message); playit = null; });
    playit.on('close', c => { push('playit', '[CJH] Playit agent exited (' + c + ')'); playit = null; });
    return 'started';
  },
  playitStop() { if (playit) playit.kill('SIGTERM'); return 'stopped'; },
  playitStatus() { return playit ? 'running' : 'offline'; }
};

module.exports = { fns };
