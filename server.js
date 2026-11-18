const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const W = 90, H = 50, N = W * H;
const TICK = 130;
const ROUND_MS = 180000;
const OVER_MS = 7000;
const MAXP = 10, MINP = 2;
const COLORS = ['#ff5fa2', '#3b82f6', '#22c55e', '#a855f7', '#facc15',
                '#fb923c', '#14b8a6', '#ef4444', '#84cc16', '#06b6d4'];
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
});
const wss = new WebSocketServer({ server });

let owner = new Uint8Array(N), trail = new Uint8Array(N);
const clients = new Set();
let state = 'waiting', endsAt = 0, resetAt = 0, winner = null;

const sendJSON = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const byId = id => { if (!id) return null; for (const p of clients) if (p.id === id) return p; return null; };
const alivePlayers = () => [...clients].filter(p => p.alive);

function freeSlot() {
  const used = new Set();
  for (const p of clients) if (p.id) used.add(p.id);
  for (let i = 1; i <= MAXP; i++) if (!used.has(i)) return i;
  return 0;
}

function spawn(p) {
  const id = freeSlot();
  if (!id) { sendJSON(p, { t: 'full' }); return false; }
  let x = 0, y = 0, ok = false;
  for (let k = 0; k < 300 && !ok; k++) {
    x = 4 + Math.floor(Math.random() * (W - 8));
    y = 4 + Math.floor(Math.random() * (H - 8));
    ok = true;
    for (let j = -3; j <= 3 && ok; j++)
      for (let i = -3; i <= 3; i++) {
        const c = (y + j) * W + (x + i);
        if (owner[c] || trail[c]) { ok = false; break; }
      }
  }
  p.id = id; p.x = x; p.y = y;
  p.dx = p.ndx = x < W / 2 ? 1 : -1; p.dy = p.ndy = 0;
  p.alive = true; p.trail = []; p.pending = false;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) owner[(y + j) * W + x + i] = id;
  sendJSON(p, { t: 'you', id });
  return true;
}

function kill(p) {
  if (!p || !p.alive) return;
  p.alive = false;
  for (const i of p.trail) trail[i] = 0;
  p.trail = [];
  for (let i = 0; i < N; i++) if (owner[i] === p.id) owner[i] = 0;
  p.id = 0;
  sendJSON(p, { t: 'dead' });
}

function capture(p) {
  const id = p.id;
  for (const i of p.trail) { owner[i] = id; trail[i] = 0; }
  p.trail = [];
  const seen = new Uint8Array(N), q = new Int32Array(N);
  let h = 0, t = 0;
  const push = i => { if (!seen[i] && owner[i] !== id) { seen[i] = 1; q[t++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (h < t) {
    const i = q[h++], x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  const victims = new Set();
  for (let i = 0; i < N; i++) {
    if (!seen[i] && owner[i] !== id) {
      if (trail[i]) { const v = byId(trail[i]); if (v && v !== p) victims.add(v); }
      owner[i] = id;
    }
  }
  for (const v of victims) kill(v);
}

function stepPlayers() {
  for (const p of alivePlayers()) {
    if (!p.alive) continue;
    p.dx = p.ndx; p.dy = p.ndy;
    const nx = p.x + p.dx, ny = p.y + p.dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) { kill(p); continue; }
    const i = ny * W + nx;
    if (trail[i]) {
      const v = byId(trail[i]);
      if (v === p) { kill(p); continue; }
      if (v) kill(v);
    }
    p.x = nx; p.y = ny;
    if (owner[i] === p.id) { if (p.trail.length) capture(p); }
    else { trail[i] = p.id; p.trail.push(i); }
  }
}

function counts() {
  const c = new Uint16Array(MAXP + 1);
  for (let i = 0; i < N; i++) c[owner[i]]++;
  return c;
}

function newRound() {
  const keep = [...clients].filter(p => p.alive || p.pending);
  owner = new Uint8Array(N); trail = new Uint8Array(N);
  for (const p of clients) { p.alive = false; p.id = 0; p.trail = []; }
  winner = null; state = 'waiting';
  for (const p of keep) spawn(p);
}

function tick() {
  const now = Date.now();
  if (state === 'waiting') {
    if (alivePlayers().length >= MINP) { state = 'running'; endsAt = now + ROUND_MS; }
  } else if (state === 'running') {
    stepPlayers();
    if (now >= endsAt) {
      const c = counts();
      let best = null;
      for (const p of alivePlayers()) if (!best || c[p.id] > c[best.id]) best = p;
      winner = best ? { name: best.name, pct: +(c[best.id] / N * 100).toFixed(1), color: COLORS[best.id - 1] } : null;
      state = 'over'; resetAt = now + OVER_MS;
    }
  } else if (state === 'over') {
    if (now >= resetAt) newRound();
  }
  broadcast(now);
}

function broadcast(now) {
  const c = counts();
  const players = alivePlayers().map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y,
    pct: +(c[p.id] / N * 100).toFixed(1), trail: p.trail
  }));
  const top = players.map(p => ({ id: p.id, name: p.name, pct: p.pct }))
    .sort((a, b) => b.pct - a.pct).slice(0, 5);
  const msg = JSON.stringify({
    t: 's', st: state, players, top, winner,
    left: state === 'running' ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : (state === 'waiting' ? 180 : 0),
    need: MINP, online: players.length
  });
  const buf = Buffer.from(owner);
  for (const p of clients) if (p.ws.readyState === 1) { p.ws.send(msg); p.ws.send(buf, { binary: true }); }
}

wss.on('connection', ws => {
  const p = { ws, id: 0, name: 'Player', alive: false, pending: false, trail: [], x: 0, y: 0, dx: 1, dy: 0, ndx: 1, ndy: 0 };
  clients.add(p);
  ws.send(JSON.stringify({ t: 'init', W, H, colors: COLORS }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      p.name = String(m.name || 'Player').replace(/[<>]/g, '').slice(0, 14) || 'Player';
      if (p.alive) return;
      if (state === 'over') p.pending = true; else spawn(p);
    } else if (m.t === 'dir' && p.alive) {
      const dx = m.dx | 0, dy = m.dy | 0;
      if (Math.abs(dx) + Math.abs(dy) === 1 && !(dx === -p.dx && dy === -p.dy)) { p.ndx = dx; p.ndy = dy; }
    }
  });
  ws.on('close', () => { kill(p); clients.delete(p); });
  ws.on('error', () => {});
});

setInterval(tick, TICK);
server.listen(PORT, () => console.log('Hudud server: http://localhost:' + PORT));
