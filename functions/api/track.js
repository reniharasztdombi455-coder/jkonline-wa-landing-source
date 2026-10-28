function clean(value, max = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = clean(body.event_type, 30);

  if (!["page_view", "whatsapp_click", "whatsapp_open_attempt"].includes(eventType)) {
    return Response.json({ error: "Invalid event type" }, { status: 400 });
  }

  const slug = clean(body.slug, 80);
  const sessionToken = clean(body.session_token, 80);

  if (!slug || !/^[A-Za-z0-9_-]{1,80}$/.test(slug)) {
    return Response.json({ error: "Invalid link ID" }, { status: 400 });
  }

  try {
    const link = await env.DB.prepare(
      `SELECT id, source, agent, campaign, ad
       FROM landing_links
       WHERE slug = ? AND enabled = 1
       LIMIT 1`
    ).bind(slug).first();

    if (!link) {
      return Response.json({ error: "Link not found" }, { status: 404 });
    }

    if (!sessionToken || !/^[A-Za-z0-9_-]{20,80}$/.test(sessionToken)) {
      return Response.json({ error: "Missing customer session; event was not counted." }, { status: 400 });
    }

    const session = await env.DB.prepare(
      "SELECT customer_code FROM customer_code_sessions WHERE slug = ? AND session_token = ? LIMIT 1"
    ).bind(slug, sessionToken).first();

    if (!session?.customer_code) {
      return Response.json({ error: "Customer code session not found; event was not counted." }, { status: 409 });
    }

    const customerCode = session.customer_code;
    let countEvent = true;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS unique_customer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      customer_code TEXT NOT NULL,
      event_type TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(slug, customer_code, event_type)
    )`).run();

    try {
      await env.DB.prepare(
        "INSERT INTO unique_customer_events (slug, customer_code, event_type) VALUES (?, ?, ?)"
      ).bind(slug, customerCode, eventType).run();
    } catch (error) {
      if (/unique constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error?.message || error))) {
        countEvent = false;
      } else {
        throw error;
      }
    }

    if (sessionToken && countEvent) {
      const column = eventType === "page_view" ? "page_views" : (eventType === "whatsapp_click" ? "whatsapp_clicks" : null);
      await env.DB.prepare(
        "UPDATE customer_code_sessions SET " + column + " = " + column + " + 1, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = ? AND session_token = ?"
      ).bind(slug, sessionToken).run().catch(() => {});
    }

    if (countEvent) await env.DB.prepare(
      `INSERT INTO events
       (link_id, slug, event_type, source, agent, campaign, ad,
        button_type, page_path, referrer_host)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      link.id,
      slug,
      eventType,
      link.source,
      link.agent,
      link.campaign,
      link.ad,
      clean(body.button_type, 40) || null,
      clean(body.page_path, 180) || "/",
      clean(body.referrer_host, 120) || null
    ).run();

    return Response.json(
      { ok: true, counted: countEvent, deduplicated: !countEvent },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json({ error: "Could not save event" }, { status: 500 });
  }
}
