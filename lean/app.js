// 家庭成长计划 API — LeanCloud 云引擎版
// 与 Cloudflare Worker 版（api/worker.js）保持完全相同的接口契约，前端只换 API 地址。
// 存储：LeanCloud 数据存储 class「State」，一行一个 key，value 存 JSON 字符串（等价于原 KV）。
// 环境变量：LEANCLOUD_APP_ID / LEANCLOUD_APP_KEY / LEANCLOUD_APP_MASTER_KEY（云引擎自带注入 AppId 等）、SLIP_CODE（工资条编码，云引擎环境变量里设置）。

const AV = require('leancloud-storage');
const express = require('express');
const leanengine = require('leanengine');

AV.init({
  appId: process.env.LEANCLOUD_APP_ID,
  appKey: process.env.LEANCLOUD_APP_KEY,
  masterKey: process.env.LEANCLOUD_APP_MASTER_KEY,
  serverURL: process.env.LEANCLOUD_SERVER_URL, // 国内节点必填：应用控制台「设置→应用凭证」里的 REST API 域名
});
AV.Cloud.useMasterKey();

const CAP = 3000;
const ALLOWED_TARGETS = ['白熊', '鲨鱼', '暮鱼'];
const ALLOWED_REASONS = ['情感', '工作', '认知'];
const ALLOWED_ORIGIN = 'https://xiaoxue221323156-arch.github.io';

const State = AV.Object.extend('State');

async function readJSON(key, fallback) {
  const q = new AV.Query('State');
  q.equalTo('key', key);
  const row = await q.first();
  if (!row) return fallback;
  try { return JSON.parse(row.get('value')); } catch (e) { return fallback; }
}
async function writeJSON(key, obj) {
  const q = new AV.Query('State');
  q.equalTo('key', key);
  let row = await q.first();
  if (!row) { row = new State(); row.set('key', key); }
  row.set('value', JSON.stringify(obj));
  await row.save();
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function checkSession(token) {
  if (!token) return false;
  const exp = await readJSON('sess:' + token, 0);
  return typeof exp === 'number' && exp > Date.now();
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(leanengine.express());

app.use((req, res, next) => {
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function wrap(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    res.status(500).json({ ok: false, error: 'server_error' });
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, backend: 'leancloud' }));

app.post('/api/unlock', wrap(async (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (!process.env.SLIP_CODE || code !== process.env.SLIP_CODE) {
    return res.status(403).json({ ok: false, error: 'bad_code' });
  }
  const token = newId() + newId() + Math.random().toString(36).slice(2, 10);
  await writeJSON('sess:' + token, Date.now() + 12 * 3600 * 1000);
  res.json({ ok: true, token });
}));

async function wageState(month) {
  const items = await readJSON('wage', {});
  const mine = (items[month] || []).slice().sort((a, b) => a.time - b.time);
  const total = mine.reduce((s, x) => s + x.amount, 0);
  return { items: mine, total, balance: CAP - total };
}
app.get('/api/wage', wrap(async (req, res) => {
  if (!(await checkSession(bearer(req)))) return res.status(401).json({ ok: false, error: 'locked' });
  const month = req.query.month || '';
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: 'bad_month' });
  const s = await wageState(month);
  res.json({ ok: true, month, cap: CAP, items: s.items, total: s.total, balance: s.balance });
}));
app.post('/api/wage', wrap(async (req, res) => {
  if (!(await checkSession(bearer(req)))) return res.status(401).json({ ok: false, error: 'locked' });
  const { month, amount } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ ok: false, error: 'bad_month' });
  const amt = Math.floor(Number(amount));
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'bad_amount' });
  const data = await readJSON('wage', {});
  const mine = data[month] || [];
  const total = mine.reduce((s, x) => s + x.amount, 0);
  if (total + amt > CAP) return res.status(400).json({ ok: false, error: 'exceeds', balance: CAP - total });
  mine.push({ id: newId(), amount: amt, time: Date.now() });
  data[month] = mine;
  await writeJSON('wage', data);
  const s = await wageState(month);
  res.json({ ok: true, month, cap: CAP, items: s.items, total: s.total, balance: s.balance });
}));
app.delete('/api/wage', wrap(async (req, res) => {
  if (!(await checkSession(bearer(req)))) return res.status(401).json({ ok: false, error: 'locked' });
  const { month, id } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ ok: false, error: 'bad_month' });
  const data = await readJSON('wage', {});
  data[month] = (data[month] || []).filter((x) => x.id !== id);
  await writeJSON('wage', data);
  const s = await wageState(month);
  res.json({ ok: true, month, cap: CAP, items: s.items, total: s.total, balance: s.balance });
}));

app.get('/api/todos', wrap(async (req, res) => {
  res.json({ ok: true, items: await readJSON('todos', []) });
}));
app.post('/api/todos', wrap(async (req, res) => {
  const body = req.body || {};
  let items = await readJSON('todos', []);
  if (body.action === 'add') {
    const text = String(body.text || '').trim().slice(0, 200);
    if (!text) return res.status(400).json({ ok: false, error: 'empty' });
    items.unshift({ id: newId(), text, done: false, time: Date.now() });
  } else if (body.action === 'toggle') {
    items = items.map((x) => (x.id === body.id ? { ...x, done: !x.done } : x));
  } else {
    return res.status(400).json({ ok: false, error: 'bad_action' });
  }
  await writeJSON('todos', items);
  res.json({ ok: true, items });
}));
app.delete('/api/todos', wrap(async (req, res) => {
  const items = (await readJSON('todos', [])).filter((x) => x.id !== (req.body || {}).id);
  await writeJSON('todos', items);
  res.json({ ok: true, items });
}));

app.get('/api/complaints', wrap(async (req, res) => {
  res.json({ ok: true, items: await readJSON('complaints', []) });
}));
app.post('/api/complaints', wrap(async (req, res) => {
  const body = req.body || {};
  const target = String(body.target || '');
  const reason = String(body.reason || '');
  const text = String(body.text || '').trim().slice(0, 500);
  if (!ALLOWED_TARGETS.includes(target)) return res.status(400).json({ ok: false, error: 'bad_target' });
  if (!ALLOWED_REASONS.includes(reason)) return res.status(400).json({ ok: false, error: 'bad_reason' });
  if (!text) return res.status(400).json({ ok: false, error: 'empty' });
  const items = await readJSON('complaints', []);
  items.unshift({ id: newId(), target, reason, text, time: Date.now() });
  await writeJSON('complaints', items);
  res.json({ ok: true, items });
}));
app.delete('/api/complaints', wrap(async (req, res) => {
  const items = (await readJSON('complaints', [])).filter((x) => x.id !== (req.body || {}).id);
  await writeJSON('complaints', items);
  res.json({ ok: true, items });
}));

app.get('/api/schedule', wrap(async (req, res) => {
  const date = req.query.date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad_date' });
  res.json({ ok: true, date, checks: await readJSON('sched:' + date, {}) });
}));
app.post('/api/schedule', wrap(async (req, res) => {
  const body = req.body || {};
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad_date' });
  let checks = await readJSON('sched:' + date, {});
  if (body.action === 'set') {
    const task = String(body.task || '');
    if (!task) return res.status(400).json({ ok: false, error: 'bad_task' });
    if (body.done) checks[task] = true; else delete checks[task];
  } else if (body.action === 'setAll') {
    const raw = body.checks && typeof body.checks === 'object' ? body.checks : {};
    checks = {};
    Object.keys(raw).forEach((k) => { if (raw[k]) checks[k] = true; });
  } else if (body.action === 'clear') {
    checks = {};
  } else {
    return res.status(400).json({ ok: false, error: 'bad_action' });
  }
  await writeJSON('sched:' + date, checks);
  res.json({ ok: true, date, checks });
}));
app.get('/api/schedule/month', wrap(async (req, res) => {
  const ym = req.query.ym || '';
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ ok: false, error: 'bad_ym' });
  const q = new AV.Query('State');
  q.startsWith('key', 'sched:' + ym + '-');
  q.limit(200);
  const rows = await q.find();
  const counts = {};
  rows.forEach((row) => {
    try { counts[row.get('key').slice(6)] = Object.keys(JSON.parse(row.get('value'))).length; } catch (e) {}
  });
  res.json({ ok: true, ym, counts });
}));

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

const PORT = process.env.LEANCLOUD_PORT || process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('family-plan-api (leancloud) listening on', PORT);
});
