// 小鲨鱼小鱼小熊家庭十年成长计划 · 服务器 API
// 存储：Cloudflare KV（todos / complaints / wage 三个键，JSON）
// 工资条编码只存在 Worker 密钥 SLIP_CODE 里，不出现在任何前端代码中。

const CORS = {
  "Access-Control-Allow-Origin": "https://xiaoxue221323156-arch.github.io",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function readJSON(env, key, fallback) {
  const raw = await env.KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function authed(env, req) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return false;
  const v = await env.KV.get("sess:" + token);
  return v === "1";
}

const CAP = 3000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (path === "/api/health") return json({ ok: true });

      // ---------- 编码解锁（服务器验真） ----------
      if (path === "/api/unlock" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const code = String(body.code || "").trim();
        if (!env.SLIP_CODE) return json({ ok: false, error: "server_not_configured" }, 500);
        if (code !== env.SLIP_CODE) return json({ ok: false, error: "bad_code" }, 403);
        const token = uid() + uid() + uid();
        await env.KV.put("sess:" + token, "1", { expirationTtl: 43200 }); // 12 小时
        return json({ ok: true, token });
      }

      // ---------- 工资条（需解锁令牌） ----------
      if (path === "/api/wage") {
        if (!(await authed(env, req))) return json({ ok: false, error: "locked" }, 401);
        const wage = await readJSON(env, "wage", {});
        if (req.method === "GET") {
          const month = url.searchParams.get("month") || "";
          const items = wage[month] || [];
          const total = items.reduce((s, x) => s + x.amount, 0);
          return json({ ok: true, month, cap: CAP, items, total, balance: CAP - total });
        }
        const body = await req.json().catch(() => ({}));
        const month = String(body.month || "");
        if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: "bad_month" }, 400);
        const items = wage[month] || [];
        if (req.method === "POST") {
          const amount = Math.round(Number(body.amount) * 100) / 100;
          if (!(amount > 0)) return json({ ok: false, error: "bad_amount" }, 400);
          const total = items.reduce((s, x) => s + x.amount, 0);
          if (total + amount > CAP) return json({ ok: false, error: "exceeds", balance: CAP - total }, 400);
          items.push({ id: uid(), amount, time: Date.now() });
          wage[month] = items;
          await env.KV.put("wage", JSON.stringify(wage));
          const t2 = items.reduce((s, x) => s + x.amount, 0);
          return json({ ok: true, month, cap: CAP, items, total: t2, balance: CAP - t2 });
        }
        if (req.method === "DELETE") {
          wage[month] = items.filter((x) => x.id !== body.id);
          await env.KV.put("wage", JSON.stringify(wage));
          const items2 = wage[month];
          const t2 = items2.reduce((s, x) => s + x.amount, 0);
          return json({ ok: true, month, cap: CAP, items: items2, total: t2, balance: CAP - t2 });
        }
      }

      // ---------- 关键待办（全家共享） ----------
      if (path === "/api/todos") {
        let items = await readJSON(env, "todos", []);
        if (req.method === "GET") return json({ ok: true, items });
        const body = await req.json().catch(() => ({}));
        if (req.method === "POST" && body.action === "add") {
          const text = String(body.text || "").trim().slice(0, 200);
          if (!text) return json({ ok: false, error: "empty" }, 400);
          items.unshift({ id: uid(), text, done: false, time: Date.now() });
        } else if (req.method === "POST" && body.action === "toggle") {
          items = items.map((x) => (x.id === body.id ? { ...x, done: !x.done } : x));
        } else if (req.method === "DELETE") {
          items = items.filter((x) => x.id !== body.id);
        } else {
          return json({ ok: false, error: "bad_action" }, 400);
        }
        await env.KV.put("todos", JSON.stringify(items));
        return json({ ok: true, items });
      }

      // ---------- 投诉栏（全家共享，匿名） ----------
      if (path === "/api/complaints") {
        let items = await readJSON(env, "complaints", []);
        if (req.method === "GET") return json({ ok: true, items });
        const body = await req.json().catch(() => ({}));
        if (req.method === "POST") {
          const target = String(body.target || "");
          const reason = String(body.reason || "");
          const text = String(body.text || "").trim().slice(0, 500);
          if (!["白熊", "鲨鱼", "暮鱼"].includes(target)) return json({ ok: false, error: "bad_target" }, 400);
          if (!["情感", "工作", "认知"].includes(reason)) return json({ ok: false, error: "bad_reason" }, 400);
          if (!text) return json({ ok: false, error: "empty" }, 400);
          items.unshift({ id: uid(), target, reason, text, time: Date.now() });
        } else if (req.method === "DELETE") {
          items = items.filter((x) => x.id !== body.id);
        } else {
          return json({ ok: false, error: "bad_method" }, 400);
        }
        await env.KV.put("complaints", JSON.stringify(items));
        return json({ ok: true, items });
      }

      // ---------- 日程打勾（全家共享） ----------
      if (path === "/api/schedule") {
        if (req.method === "GET") {
          const date = url.searchParams.get("date") || "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "bad_date" }, 400);
          const checks = await readJSON(env, "sched:" + date, {});
          return json({ ok: true, date, checks });
        }
        const body = await req.json().catch(() => ({}));
        const date = String(body.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "bad_date" }, 400);
        let checks = await readJSON(env, "sched:" + date, {});
        if (req.method === "POST" && body.action === "set") {
          const task = String(body.task || "");
          if (!task) return json({ ok: false, error: "bad_task" }, 400);
          if (body.done) checks[task] = true; else delete checks[task];
        } else if (req.method === "POST" && body.action === "setAll") {
          const raw = body.checks && typeof body.checks === "object" ? body.checks : {};
          checks = {};
          Object.keys(raw).forEach((k) => { if (raw[k]) checks[k] = true; });
        } else if (req.method === "POST" && body.action === "clear") {
          checks = {};
        } else {
          return json({ ok: false, error: "bad_action" }, 400);
        }
        await env.KV.put("sched:" + date, JSON.stringify(checks));
        return json({ ok: true, date, checks });
      }
      if (path === "/api/schedule/month" && req.method === "GET") {
        const ym = url.searchParams.get("ym") || "";
        if (!/^\d{4}-\d{2}$/.test(ym)) return json({ ok: false, error: "bad_ym" }, 400);
        const listed = await env.KV.list({ prefix: "sched:" + ym + "-" });
        const counts = {};
        for (const k of listed.keys) {
          const v = await readJSON(env, k.name, {});
          counts[k.name.slice(6)] = Object.keys(v).length;
        }
        return json({ ok: true, ym, counts });
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      return json({ ok: false, error: "server_error", detail: String(e && e.message || e) }, 500);
    }
  },
};
