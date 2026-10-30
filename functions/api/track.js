function clean(value, max = 180) {
  return String(value ?? "").replace(/[\\u0000-\\u001f\\u007f]/g, "").trim().slice(0, max);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const eventType = clean(body.event_type, 30);
  if (!["page_view", "whatsapp_click"].includes(eventType)) return Response.json({ error: "Invalid event type" }, { status: 400 });
  const slug = clean(body.slug, 80);
  const sessionToken = clean(body.session_token, 80);
  if (!slug || !/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return Response.json({ error: "Invalid link ID" }, { status: 400 });
  if (!sessionToken || !/^[A-Za-z0-9_-]{20,80}$/.test(sessionToken)) return Response.json({ error: "Missing or invalid customer session" }, { status: 400 });
  try {
    const link = await env.DB.prepare("SELECT id, source, agent, campaign, ad FROM landing_links WHERE slug = ? AND enabled = 1 LIMIT 1").bind(slug).first();
    if (!link) return Response.json({ error: "Link not found" }, { status: 404 });
    const session = await env.DB.prepare("SELECT customer_code FROM customer_code_sessions WHERE slug = ? AND session_token = ? LIMIT 1").bind(slug, sessionToken).first();
    if (!session?.customer_code) return Response.json({ error: "Customer code session not found; event was not counted." }, { status: 409 });
    const customerCode = session.customer_code;
    const counterColumn = eventType === "page_view" ? "page_views" : "whatsapp_clicks";
    // D1 batch is transactional: ledger, event row and counter either all commit or all roll back.
    // SQLite changes() passes the ledger INSERT result to the next statement, preventing duplicates.
    const results = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO unique_customer_events (slug, customer_code, event_type) VALUES (?, ?, ?)").bind(slug, customerCode, eventType),
      env.DB.prepare("INSERT INTO events (link_id, slug, event_type, source, agent, campaign, ad, button_type, page_path, referrer_host) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1").bind(
        link.id, slug, eventType, link.source, link.agent, link.campaign, link.ad,
        clean(body.button_type, 40) || null, clean(body.page_path, 180) || "/", clean(body.referrer_host, 120) || null
      ),
      env.DB.prepare("UPDATE customer_code_sessions SET " + counterColumn + " = " + counterColumn + " + 1, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = ? AND session_token = ? AND changes() = 1").bind(slug, sessionToken)
    ]);
    const counted = Number(results?.[0]?.meta?.changes || 0) === 1;
    return Response.json({ ok: true, counted, deduplicated: !counted }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("[track-error]", String(error?.message || error).slice(0, 180));
    return Response.json({ error: "Could not save event" }, { status: 500 });
  }
}
