function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function clean(value, max = 180) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const slug = clean(body.slug, 60);
  const token = clean(body.session_token, 80);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return json({ error: "Invalid link ID or browser session" }, 400);
  }

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS landing_code_counters (
      slug TEXT PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS customer_code_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      session_token TEXT NOT NULL,
      customer_code TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'direct',
      agent TEXT NOT NULL DEFAULT 'unknown',
      first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      page_views INTEGER NOT NULL DEFAULT 0,
      whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
      UNIQUE(slug, session_token)
    )`).run();

    const link = await env.DB.prepare(`SELECT id, slug, phone, message, source, agent, enabled
      FROM landing_links WHERE slug = ? LIMIT 1`).bind(slug).first();
    if (!link || !link.enabled) return json({ error: "Link not found or disabled" }, 404);

    const pattern = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/-\d+/;
    const match = String(link.message || "").match(pattern);
    if (!match) {
      return json({ error: "请在后台预设消息中放入基础编码，例如 F-HT-1027/-1，系统才能自动生成流水号。" }, 400);
    }
    const prefix = match[1];

    let session = await env.DB.prepare(
      "SELECT customer_code FROM customer_code_sessions WHERE slug = ? AND session_token = ? LIMIT 1"
    ).bind(slug, token).first();

    if (!session) {
      const counter = await env.DB.prepare(`
        INSERT INTO landing_code_counters (slug, last_number) VALUES (?, 1)
        ON CONFLICT(slug) DO UPDATE SET last_number = last_number + 1
        RETURNING last_number
      `).bind(slug).first();
      const code = prefix + "/-" + counter.last_number;
      try {
        await env.DB.prepare(`INSERT INTO customer_code_sessions
          (slug, session_token, customer_code, source, agent)
          VALUES (?, ?, ?, ?, ?)`).bind(slug, token, code, link.source || "direct", link.agent || "unknown").run();
        session = { customer_code: code };
      } catch (error) {
        // Concurrent requests from the same browser may race; reuse the winning session.
        session = await env.DB.prepare(
          "SELECT customer_code FROM customer_code_sessions WHERE slug = ? AND session_token = ? LIMIT 1"
        ).bind(slug, token).first();
        if (!session) throw error;
      }
    }

    await env.DB.prepare(`UPDATE customer_code_sessions
      SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE slug = ? AND session_token = ?`).bind(slug, token).run();

    const code = session.customer_code;
    const personalizedMessage = String(link.message || "").replace(pattern, code);
    return json({ code, message: personalizedMessage, session_token: token });
  } catch (error) {
    return json({ error: "Could not assign customer code: " + String(error?.message || error).slice(0, 160) }, 500);
  }
}
