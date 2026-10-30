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

  const perf = { totalStart: Date.now() };
  try {
    let stageStart = Date.now();
    // Counter and session tables are provisioned by the reviewed D1 migrations.

    const link = await env.DB.prepare(`SELECT id, slug, phone, message, source, agent, enabled
      FROM landing_links WHERE slug = ? LIMIT 1`).bind(slug).first();
    perf.linkLookupMs = Date.now() - stageStart;
    if (!link || !link.enabled) return json({ error: "Link not found or disabled" }, 404);

    const pattern = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/-\d+/;
    const match = String(link.message || "").match(pattern);
    if (!match) {
      return json({ error: "请在后台预设消息中放入基础编码，例如 F-HT-1027/-1，系统才能自动生成流水号。" }, 400);
    }
    const prefix = match[1];

    stageStart = Date.now();
    let session = await env.DB.prepare(
      "SELECT customer_code FROM customer_code_sessions WHERE slug = ? AND session_token = ? LIMIT 1"
    ).bind(slug, token).first();

    perf.sessionLookupMs = Date.now() - stageStart;
    stageStart = Date.now();
    if (!session) {
      const counter = await env.DB.prepare(`
        INSERT INTO landing_code_counters (slug, last_number) VALUES (?, 1)
        ON CONFLICT(slug) DO UPDATE SET last_number = last_number + 1
        RETURNING last_number
      `).bind(prefix).first();
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

    perf.createOrReuseSessionMs = Date.now() - stageStart;
    stageStart = Date.now();
    await env.DB.prepare(`UPDATE customer_code_sessions
      SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE slug = ? AND session_token = ?`).bind(slug, token).run();

    perf.lastSeenUpdateMs = Date.now() - stageStart;
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-code", JSON.stringify(perf));
    const code = session.customer_code;
    const personalizedMessage = String(link.message || "").replace(pattern, code);
    return json({ code, message: personalizedMessage, session_token: token });
  } catch (error) {
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-code-error", JSON.stringify(perf));
    return json({ error: "Could not assign customer code: " + String(error?.message || error).slice(0, 160) }, 500);
  }
}
