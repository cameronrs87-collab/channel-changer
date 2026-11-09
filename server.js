#!/usr/bin/env node
'use strict';
/*
  Channel Changer - live vote server
  Run on the show laptop:   node server.js
  Big screen (laptop only): http://localhost:3000/screen
  Audience phones:          scan the QR code on the screen (http://<laptop-ip>:3000/)

  Hosted online (e.g. Render): set the environment variable HOST_PASSWORD.
  Then the big screen is at https://<your-address>/screen and asks for that password.
  Optional: PUBLIC_URL (address for the QR code), CHANNEL_NAMES (seven names, comma separated),
  CHANNEL_PROMPTS (seven audience prompts, separated by | ).

  No packages to install. Needs Node.js 18 or newer.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const qr = require('./lib/qr');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = __dirname;
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

// Hosted mode: anyone on the internet can reach the server, so the host signs in.
const HOST_PASSWORD = String(process.env.HOST_PASSWORD || '');
const ON_CLOUD = !!(process.env.RENDER || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL);
const PUBLIC_URL = (() => {
  let u = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.endsWith('/') ? u : u + '/';
})();
const MAX_PHONES = 300;

/* ---------------------------------------------------------------- settings */

const DEFAULTS = {
  threshold: 50,      // a channel needs MORE than this % of the room
  hold: 3,            // seconds the majority must last
  cooldown: 60,       // seconds of guaranteed airtime after each change
  stale: 'stay',      // votes not touched since the last change: 'stay' or 'keep'
  dropAfter: 120,     // seconds before a silent phone stops counting
  startChannel: 1,
  names: ['Rolling News', 'Cooking Show', 'Soap Opera', 'Wildlife Doc', 'Home Shopping', "Kids' TV", 'Live Sport'],
  prompts: ['', '', '', '', '', '', ''],   // audience prompt shown while each channel is on air
  promptsOnPhones: true,
};
// Online hosts forget settings.json on every restart, so names can also come from an environment variable.
if (process.env.CHANNEL_NAMES) {
  const n = String(process.env.CHANNEL_NAMES).split(',').map(x => x.trim());
  DEFAULTS.names = DEFAULTS.names.map((d, i) => n[i] || d);
}
if (process.env.CHANNEL_PROMPTS) {
  const n = String(process.env.CHANNEL_PROMPTS).split('|');
  DEFAULTS.prompts = DEFAULTS.prompts.map((d, i) => cleanPrompt(n[i]));
}

let settingsEdited = false;   // false until settings are loaded from file or changed by the host
function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settingsEdited = true;
    return sanitizeSettings(Object.assign({}, DEFAULTS, j));
  } catch (e) {
    return sanitizeSettings(DEFAULTS);
  }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(S, null, 2)); } catch (e) { console.warn('Could not save settings:', e.message); }
}
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function cleanPrompt(t) {
  return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 240);
}
const cleanText = (t, d) => { t = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28); return t || d; };
function sanitizeSettings(s) {
  return {
    threshold: clamp(s.threshold, 50, 90, DEFAULTS.threshold),
    hold: clamp(s.hold, 0, 15, DEFAULTS.hold),
    cooldown: clamp(s.cooldown, 0, 600, DEFAULTS.cooldown),
    stale: s.stale === 'keep' ? 'keep' : 'stay',
    dropAfter: clamp(s.dropAfter, 15, 900, DEFAULTS.dropAfter),
    startChannel: clamp(s.startChannel, 1, 7, 1) | 0,
    names: DEFAULTS.names.map((d, i) => cleanText(Array.isArray(s.names) ? s.names[i] : '', d)),
    prompts: DEFAULTS.prompts.map((d, i) => Array.isArray(s.prompts) ? cleanPrompt(s.prompts[i]) : d),
    promptsOnPhones: s.promptsOnPhones !== false,
  };
}
let S = loadSettings();

/* ------------------------------------------------------------- show state */

const now = () => Date.now();
const st = {
  current: S.startChannel,
  epoch: 0,                 // counts channel changes; phones use it to spot old votes
  lastSwitch: now() - S.cooldown * 1000,
  holdCh: 0, holdStart: 0,
  frozen: false,
  log: [],
  voters: new Map(),        // id -> {kind, label, pos, active, seen}
  phoneCount: 0, botCount: 0,
  joinIndex: 0,
  customJoin: '',
  showQr: true,
  restless: null, trend: 4, trendAt: 0,
  swing: null,
  mode: 'open', leader: 0, pct: 0, holdP: 0,
};

function present(v) {
  if (v.kind === 'bot') return true;
  if (v.kind === 'knob') return v.pos > 0;
  return v.conns > 0 || now() - v.seen < S.dropAfter * 1000;
}
function voteOf(v) {
  return (v.pos && (S.stale === 'keep' || v.active)) ? v.pos : st.current;
}
function tally() {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  const kinds = {phone: 0, knob: 0, bot: 0};
  let connected = 0, fresh = 0;
  for (const v of st.voters.values()) {
    if (!present(v)) continue;
    connected++; kinds[v.kind]++;
    if (v.active && v.pos) fresh++;
    counts[voteOf(v)]++;
  }
  return {counts, connected, fresh, kinds};
}

function tick() {
  const t = tally();
  const n = now();
  const cdLeft = Math.max(0, S.cooldown - (n - st.lastSwitch) / 1000);
  let leader = 0, lc = 0;
  for (let c = 1; c <= 7; c++) {
    if (c !== st.current && t.counts[c] > lc) { lc = t.counts[c]; leader = c; }
  }
  const pct = t.connected ? lc / t.connected * 100 : 0;
  const qualifies = leader > 0 && pct > S.threshold;
  let mode = 'open', holdP = 0;
  if (st.frozen) { st.holdCh = 0; mode = 'frozen'; }
  else if (cdLeft > 0) { st.holdCh = 0; mode = 'cool'; }
  else if (qualifies) {
    if (st.holdCh !== leader) { st.holdCh = leader; st.holdStart = n; }
    holdP = S.hold > 0 ? (n - st.holdStart) / 1000 / S.hold : 1;
    if (holdP >= 1) { switchTo(leader, 'vote', pct); return; }
    mode = 'hold';
  } else st.holdCh = 0;
  Object.assign(st, {mode, leader, pct, holdP, cdLeft, tally: t});
}

function switchTo(ch, why, pct) {
  if (ch === st.current || ch < 1 || ch > 7) return;
  const from = st.current;
  st.current = ch; st.epoch++; st.lastSwitch = now(); st.holdCh = 0;
  for (const v of st.voters.values()) v.active = false;
  st.log.unshift({at: new Date().toISOString(), from, to: ch, why, pct: Math.round(pct || 0)});
  st.log.length = Math.min(st.log.length, 50);
  console.log(`[${new Date().toLocaleTimeString()}] CH ${from} -> CH ${ch} ${S.names[ch - 1]} (${why === 'vote' ? 'vote ' + Math.round(pct) + '%' : 'host cut'})`);
  tick();
}

/* ------------------------------------------------------------------ voters */

function phoneCount() { let n = 0; for (const v of st.voters.values()) if (v.kind === 'phone') n++; return n; }
function phoneVoter(id) {
  let v = st.voters.get(id);
  if (!v) {
    if (phoneCount() >= MAX_PHONES) {
      // make room by forgetting phones that have gone quiet, then give up
      for (const [vid, x] of st.voters) if (x.kind === 'phone' && !x.conns && !present(x)) st.voters.delete(vid);
      if (phoneCount() >= MAX_PHONES) return null;
    }
    st.phoneCount++;
    v = {kind: 'phone', label: 'P' + st.phoneCount, pos: 0, active: false, seen: now(), conns: 0};
    st.voters.set(id, v);
  }
  return v;
}
function phoneVote(id, pos) {
  const v = phoneVoter(id);
  if (!v) return null;
  v.seen = now();
  v.pos = pos;
  v.active = true;     // any deliberate turn counts as a fresh vote
  return v;
}
function hubPositions(arr) {
  arr.forEach((p, i) => {
    const id = 'knob-' + (i + 1);
    let v = st.voters.get(id);
    if (!v) { v = {kind: 'knob', label: 'K' + (i + 1), pos: p, last: p, active: false, seen: now()}; st.voters.set(id, v); return; }
    if (p > 0 && v.last && p !== v.last) v.active = true;
    v.pos = p; if (p > 0) v.last = p; v.seen = now();
  });
}

/* ---------------------------------------------------------- rehearsal bots */

function addBots(n) {
  const have = [...st.voters.values()].filter(v => v.kind === 'bot').length;
  n = Math.max(0, Math.min(n, 60 - have));
  for (let i = 0; i < n; i++) {
    st.botCount++;
    const p = st.current;
    st.voters.set('bot-' + st.botCount, {kind: 'bot', label: 'T' + st.botCount, pos: p, active: false, seen: now()});
  }
}
function bots() { return [...st.voters.values()].filter(v => v.kind === 'bot'); }
function clearBots() {
  for (const [id, v] of st.voters) if (v.kind === 'bot') st.voters.delete(id);
  stopSwing(); stopRestless(); st.botCount = 0;
}
function turnBot(v, p) { v.pos = p; v.active = true; }
function stopSwing() { if (st.swing) { clearInterval(st.swing); st.swing = null; } }
function swing(target) {
  stopSwing();
  st.swing = setInterval(() => {
    const t = tally();
    const share = t.connected ? t.counts[target] / t.connected * 100 : 0;
    const movable = bots().filter(v => !(v.pos === target && v.active));
    if (st.current === target || share > Math.min(95, S.threshold + 12) || !movable.length) { stopSwing(); return; }
    turnBot(movable[Math.random() * movable.length | 0], target);
  }, 220);
}
function scatter() { bots().forEach(v => turnBot(v, 1 + (Math.random() * 7 | 0))); }
function stopRestless() { if (st.restless) { clearInterval(st.restless); st.restless = null; } }
function restless(on) {
  stopRestless();
  if (!on) return;
  st.restless = setInterval(() => {
    if (now() - st.trendAt > 22000) { st.trendAt = now(); do { st.trend = 1 + (Math.random() * 7 | 0); } while (st.trend === st.current); }
    const b = bots(); if (!b.length) return;
    turnBot(b[Math.random() * b.length | 0], Math.random() < 0.62 ? st.trend : 1 + (Math.random() * 7 | 0));
  }, 700);
}

/* ------------------------------------------------------------- addresses */

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      const fam = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : 'IPv6');
      if (fam === 'IPv4' && !a.internal) out.push({name, address: a.address});
    }
  }
  const rank = a => /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  out.sort((x, y) => rank(x.address) - rank(y.address));
  return out;
}
function joinUrls() {
  const list = [];
  if (st.customJoin) list.push({name: 'Online (custom)', url: st.customJoin});
  if (PUBLIC_URL) list.push({name: 'Online', url: PUBLIC_URL});
  else if (st.seenOrigin) list.push({name: 'Online', url: st.seenOrigin});
  if (process.env.JOIN_URL) list.push({name: 'JOIN_URL', url: process.env.JOIN_URL});
  if (!ON_CLOUD && !st.seenOrigin) lanAddresses().forEach(a => list.push({name: a.name, url: 'http://' + a.address + ':' + PORT + '/'}));
  return list.length ? list : [{name: 'this computer only', url: 'http://localhost:' + PORT + '/'}];
}
let qrCache = {url: '', svg: ''};
function qrFor(url) {
  if (qrCache.url !== url) qrCache = {url, svg: qr.toSvg(url, {dark: '#0a0c14', light: '#ffffff'})};
  return qrCache.svg;
}

/* --------------------------------------------------------- state payloads */

function publicState() {
  const t = st.tally || tally();
  return {
    current: st.current, epoch: st.epoch, names: S.names,
    prompt: S.promptsOnPhones ? S.prompts[st.current - 1] : '',
    threshold: S.threshold, hold: S.hold, cooldown: S.cooldown, stale: S.stale,
    counts: t.counts, connected: t.connected, fresh: t.fresh, kinds: t.kinds,
    mode: st.mode, leader: st.leader, pct: Math.round(st.pct * 10) / 10,
    holdP: Math.round(st.holdP * 100) / 100, holdCh: st.holdCh,
    cdLeft: Math.round((st.cdLeft || 0) * 10) / 10,
    onAirFor: Math.floor((now() - st.lastSwitch) / 1000),
    frozen: st.frozen,
  };
}
function screenState() {
  const urls = joinUrls();
  if (st.joinIndex >= urls.length) st.joinIndex = 0;
  const join = urls[st.joinIndex].url;
  const voters = [];
  for (const v of st.voters.values()) {
    voters.push({label: v.label, kind: v.kind, pos: v.pos, active: !!v.active, present: present(v)});
  }
  return Object.assign(publicState(), {
    voters, log: st.log.slice(0, 20), urls, joinIndex: st.joinIndex, join, qr: qrFor(join),
    showQr: st.showQr, customJoin: st.customJoin, restless: !!st.restless, swinging: !!st.swing,
    dropAfter: S.dropAfter, startChannel: S.startChannel,
    prompts: S.prompts, promptsOnPhones: S.promptsOnPhones,
    settings: S, settingsEdited,
  });
}

/* --------------------------------------------------------- live streaming */

const screens = new Set();   // res
const phones = new Set();    // {res, id}

function sseOpen(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  req.socket.setKeepAlive(true);
  req.socket.setNoDelay(true);
}
const sseSend = (res, obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };

function broadcast() {
  const pub = publicState();
  for (const p of phones) {
    const v = st.voters.get(p.id);
    if (v) v.seen = now();
    sseSend(p.res, Object.assign({me: v ? {label: v.label, pos: v.pos, active: v.active} : null}, pub));
  }
  if (screens.size) {
    const scr = screenState();
    for (const res of screens) sseSend(res, scr);
  }
}

/* -------------------------------------------------------------- http glue */

const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};

// Host-only means: a browser on this laptop, typing localhost.
// A tunnel (Cloudflare, ngrok...) also connects from this laptop, so requests
// carrying proxy headers or a public Host name are always treated as audience.
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'ngrok-trace-id'];
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return false;
  if (PROXY_HEADERS.some(h => req.headers[h] !== undefined)) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
/* ---------------------------------------------------------- host sign-in */

const COOKIE = 'cc_host';
const hostToken = () => crypto.createHmac('sha256', HOST_PASSWORD).update('channel-changer-host-v1').digest('hex');
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
  return out;
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function signedIn(req) {
  if (!HOST_PASSWORD) return false;
  const c = cookies(req)[COOKIE];
  return !!c && safeEqual(c, hostToken());
}
// The host is either a browser on the show laptop (localhost) or someone signed in with HOST_PASSWORD.
function isHost(req) { return isLocal(req) || signedIn(req); }
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === String(req.headers.host || ''); } catch (e) { return false; }
}
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function rememberOrigin(req) {
  if (PUBLIC_URL || isLocal(req)) return;
  const host = String(req.headers.host || '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) || /^(localhost|127\.|\[?::1)/i.test(host)) return;
  st.seenOrigin = (isHttps(req) ? 'https://' : 'http://') + host + '/';
}
const failures = new Map(); // ip -> [timestamps]
function tooManyFailures(key, limit = 8) {
  const t = (failures.get(key) || []).filter(x => now() - x < 10 * 60 * 1000);
  failures.set(key, t);
  return t.length >= limit;
}
function loginPage(msg) {
  const note = !HOST_PASSWORD
    ? '<p class="err">Host sign-in is switched off. Set HOST_PASSWORD on the server (in your hosting dashboard) and restart it.</p>'
    : (msg ? '<p class="err">' + msg + '</p>' : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Channel Changer Host</title>
<style>
:root{--bg:#0a0c14;--panel:#121522;--line:#262b41;--fg:#eceef6;--dim:#8a90aa;--accent:#f3c64b;--live:#ff4d5e;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;min-height:100vh;display:grid;place-items:center;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}
.bars{display:flex;height:18px;width:42px;border-radius:3px;overflow:hidden}.bars i{flex:1}
h1{margin:0;font-family:Impact,'Arial Black',sans-serif;font-weight:400;font-size:24px;letter-spacing:.02em}
p{margin:0;color:var(--dim);font-size:14px}
label{font-size:14px}
input{font:inherit;color:inherit;background:#181c2c;border:1px solid var(--line);border-radius:8px;padding:10px 12px}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:700;background:var(--accent);color:#1b1606;border:0;border-radius:8px;padding:10px 12px;cursor:pointer}
.err{color:var(--live)}
</style></head><body>
<form method="post" action="/login">
<div class="bars" aria-hidden="true"><i style="background:#c9c9c9"></i><i style="background:#e9dd45"></i><i style="background:#3fd3dc"></i><i style="background:#47cc68"></i><i style="background:#d553cf"></i><i style="background:#e9474f"></i><i style="background:#5577f2"></i></div>
<h1>Channel Changer</h1>
<p>Host sign-in for the big screen and controls. Audience members don't need this; they scan the QR code.</p>
${note}
<label for="pw">Host password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open the big screen</button>
</form></body></html>`;
}
function readForm(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', () => {
    const ct = String(req.headers['content-type'] || '');
    try {
      if (ct.includes('application/json')) return cb(JSON.parse(body || '{}'));
      cb(Object.fromEntries(new URLSearchParams(body)));
    } catch (e) { cb({}); }
  });
}

function sendFile(res, file) {
  fs.readFile(path.join(ROOT, 'public', file), (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(buf);
  });
}
function readJson(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); } });
}
const json = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); };
const ID_RE = /^[a-z0-9]{8,40}$/;

function hostAction(a) {
  switch (a && a.action) {
    case 'cut': switchTo(clamp(a.ch, 1, 7, 0) | 0, 'host'); break;
    case 'freeze': st.frozen = typeof a.on === 'boolean' ? a.on : !st.frozen; break;
    case 'endCooldown': st.lastSwitch = now() - S.cooldown * 1000; break;
    case 'restartCooldown': st.lastSwitch = now(); break;
    case 'settings': S = sanitizeSettings(Object.assign({}, S, a.settings || {})); settingsEdited = true; saveSettings(); break;
    case 'join': st.joinIndex = clamp(a.index, 0, 20, 0) | 0; break;
    case 'customJoin': {
      let u = String(a.url || '').trim();
      if (!u) { st.customJoin = ''; st.joinIndex = 0; break; }
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (!/^https?:\/\/[^\s"'<>]{3,200}$/i.test(u)) return false;
      if (!u.endsWith('/')) u += '/';
      st.customJoin = u; st.joinIndex = 0; break;
    }
    case 'showQr': st.showQr = !!a.on; break;
    case 'addBots': addBots(clamp(a.n, 1, 60, 10) | 0); break;
    case 'clearBots': clearBots(); break;
    case 'swing': swing(clamp(a.ch, 1, 7, 4) | 0); break;
    case 'scatter': scatter(); break;
    case 'restless': restless(!!a.on); break;
    case 'forgetPhones': for (const [id, v] of st.voters) if (v.kind === 'phone' && !v.conns) st.voters.delete(id); break;
    case 'clearLog': st.log = []; break;
    default: return false;
  }
  tick();
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET') {
    if (p === '/') return isLocal(req) && !url.searchParams.has('phone') ? (res.writeHead(302, {Location: '/screen'}), res.end()) : sendFile(res, 'remote.html');
    if (p === '/remote') return sendFile(res, 'remote.html');
    if (p === '/screen') {
      if (!isHost(req)) {
        if (HOST_PASSWORD) { res.writeHead(302, {Location: '/login'}); return res.end(); }
        res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
        return res.end(ON_CLOUD
          ? 'The big screen is locked. Set HOST_PASSWORD in your hosting dashboard, restart, then open /screen again.'
          : 'The big screen only opens on the show laptop (http://localhost:' + PORT + '/screen).');
      }
      rememberOrigin(req);
      return sendFile(res, 'screen.html');
    }
    if (p === '/login') {
      if (signedIn(req)) { res.writeHead(302, {Location: '/screen'}); return res.end(); }
      res.writeHead(HOST_PASSWORD ? 200 : 503, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      return res.end(loginPage(''));
    }
    if (p === '/logout') {
      res.writeHead(302, {Location: '/login', 'Set-Cookie': COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});
      return res.end();
    }
    if (p === '/api/ping') { res.writeHead(204, {'Cache-Control': 'no-store'}); return res.end(); }
    if (p === '/events/phone') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return json(res, 400, {error: 'bad id'});
      const v = phoneVoter(id);
      if (!v) return json(res, 503, {error: 'The room is full.'});
      v.conns = (v.conns || 0) + 1; v.seen = now();
      sseOpen(req, res);
      const c = {res, id};
      phones.add(c);
      sseSend(res, Object.assign({me: {label: v.label, pos: v.pos, active: v.active}}, publicState()));
      req.on('close', () => { phones.delete(c); v.conns = Math.max(0, v.conns - 1); v.seen = now(); });
      return;
    }
    if (p === '/api/state') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return json(res, 400, {error: 'bad id'});
      const v = phoneVoter(id);
      if (!v) return json(res, 503, {error: 'The room is full.'});
      v.seen = now();
      return json(res, 200, Object.assign({me: {label: v.label, pos: v.pos, active: v.active}}, publicState()));
    }
    if (p === '/events/screen') {
      if (!isHost(req)) return json(res, 403, {error: 'host only'});
      sseOpen(req, res);
      screens.add(res);
      sseSend(res, screenState());
      req.on('close', () => screens.delete(res));
      return;
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('Not found');
  }

  if (req.method === 'POST') {
    if (p === '/login') {
      const ip = clientIp(req);
      return readForm(req, b => {
        const page = (code, msg) => { res.writeHead(code, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(loginPage(msg)); };
        if (!HOST_PASSWORD) return page(503, '');
        // per-device limit, plus a limit across everyone in case the address is faked
        if (tooManyFailures(ip) || tooManyFailures('*all*', 40)) return page(429, 'Too many wrong passwords. Wait 10 minutes and try again.');
        if (!safeEqual(String(b.password || ''), HOST_PASSWORD)) {
          failures.get(ip).push(now()); failures.get('*all*').push(now());
          return page(401, 'That password is not right.');
        }
        failures.delete(ip);
        const cookie = COOKIE + '=' + hostToken() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 60 * 60 * 24 * 30 + (isHttps(req) ? '; Secure' : '');
        res.writeHead(303, {Location: '/screen', 'Set-Cookie': cookie});
        res.end();
      });
    }
    if (p === '/api/vote') {
      return readJson(req, b => {
        if (!b || !ID_RE.test(b.id || '') || !(b.pos >= 1 && b.pos <= 7)) return json(res, 400, {error: 'Send an id and a channel from 1 to 7.'});
        const v = phoneVote(b.id, b.pos | 0);
        if (!v) return json(res, 503, {error: 'The room is full.'});
        tick(); broadcast();
        json(res, 200, {ok: true, me: {label: v.label, pos: v.pos, active: v.active}});
      });
    }
    if (p === '/api/host' || p === '/api/hub') {
      if (!isHost(req) || !sameOrigin(req)) return json(res, 403, {error: HOST_PASSWORD ? 'Sign in as host first.' : 'Host controls only work on the show laptop.'});
      return readJson(req, b => {
        if (p === '/api/hub') {
          if (!b || !Array.isArray(b.positions) || b.positions.length > 64 || !b.positions.every(n => Number.isInteger(n) && n >= 0 && n <= 7)) return json(res, 400, {error: 'bad positions'});
          hubPositions(b.positions); tick(); return json(res, 200, {ok: true});
        }
        if (b && b.action === 'clearHub') { for (const [id, v] of st.voters) if (v.kind === 'knob') st.voters.delete(id); tick(); return json(res, 200, {ok: true}); }
        if (!hostAction(b)) return json(res, 400, {error: 'Unknown host action'});
        broadcast(); json(res, 200, {ok: true});
      });
    }
  }
  res.writeHead(405); res.end();
});

setInterval(tick, 100);
setInterval(broadcast, 250);
// keep connections alive through Wi-Fi power saving
setInterval(() => { for (const r of screens) { try { r.write(': ping\n\n'); } catch (e) {} } for (const c of phones) { try { c.res.write(': ping\n\n'); } catch (e) {} } }, 15000);
// forget phones that left long ago so the room list stays tidy
setInterval(() => { for (const [id, v] of st.voters) if (v.kind === 'phone' && !v.conns && now() - v.seen > Math.max(600, S.dropAfter * 3) * 1000) st.voters.delete(id); }, 60000);

function openBrowser(url) {
  if (process.env.NO_OPEN || ON_CLOUD || !process.stdout.isTTY) return;
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = require('child_process').spawn(cmd[0], cmd[1], {stdio: 'ignore', detached: true});
    child.on('error', () => {});
    child.unref();
  } catch (e) {}
}

server.listen(PORT, '0.0.0.0', () => {
  tick();
  if (ON_CLOUD) {
    console.log('Channel Changer is running online on port ' + PORT + '.');
    console.log(PUBLIC_URL ? 'Phones join at ' + PUBLIC_URL + ' ; the host opens ' + PUBLIC_URL + 'screen' : 'Open /screen on your public address to run the show.');
    if (!HOST_PASSWORD) console.log('WARNING: HOST_PASSWORD is not set, so nobody can open the big screen. Set it in your hosting dashboard.');
    return;
  }
  setTimeout(() => openBrowser('http://localhost:' + PORT + '/screen'), 400);
  const urls = joinUrls();
  const line = '-'.repeat(60);
  console.log('\n' + line);
  console.log('  CHANNEL CHANGER is running');
  console.log(line);
  console.log('  Big screen (open on THIS laptop):  http://localhost:' + PORT + '/screen');
  console.log('  Phones join at:');
  urls.forEach(u => console.log('     ' + u.url + '   (' + u.name + ')'));
  console.log('  The screen shows a QR code for the phones to scan.');
  console.log('  Press Ctrl+C to stop.');
  console.log(line + '\n');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Close the other copy, or run with another port, e.g.  PORT=3001 node server.js');
  else console.error(e);
  process.exit(1);
});
