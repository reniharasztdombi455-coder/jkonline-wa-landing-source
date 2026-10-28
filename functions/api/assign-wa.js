function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function clean(v, n = 180) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n); }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const slug = clean(body.slug, 60), token = clean(body.session_token, 80);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) return json({ error: "Invalid link or session" }, 400);
  const perf = { totalStart: Date.now() };
  try {
    let stageStart = Date.now();
    const link = await env.DB.prepare("SELECT id, enabled, phone FROM landing_links WHERE slug=? LIMIT 1").bind(slug).first();
    perf.linkLookupMs = Date.now() - stageStart;
    if (!link || !link.enabled) return json({ error: "Link not found or disabled" }, 404);
    stageStart = Date.now();
    const session = await env.DB.prepare("SELECT customer_code FROM customer_code_sessions WHERE slug=? AND session_token=? LIMIT 1").bind(slug, token).first();
    perf.sessionLookupMs = Date.now() - stageStart;
    if (!session?.customer_code) return json({ error: "Customer code session not found" }, 409);
    // The table checks are idempotent and independent. Run them concurrently to
    // avoid paying the full D1 round-trip latency three times in sequence.
    stageStart = Date.now();
    await Promise.all([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, phone TEXT NOT NULL,
        max_per_cycle INTEGER NOT NULL DEFAULT 3, sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`).run(),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL,
        wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL, assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(slug, customer_code)
      )`).run(),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_route_state (
        id INTEGER PRIMARY KEY CHECK(id=1), cycle INTEGER NOT NULL DEFAULT 1
      )`).run()
    ]);
    perf.schemaMs = Date.now() - stageStart;
    stageStart = Date.now();
    await env.DB.prepare("INSERT OR IGNORE INTO wa_route_state(id,cycle) VALUES(1,1)").run();
    perf.routeStateInitMs = Date.now() - stageStart;
    stageStart = Date.now();
    const prior = await env.DB.prepare(`SELECT a.wa_number_id,a.cycle,n.phone,n.label
      FROM wa_assignments a JOIN wa_numbers n ON n.id=a.wa_number_id
      WHERE a.slug=? AND a.customer_code=? LIMIT 1`).bind(slug, session.customer_code).first();
    perf.priorAssignmentLookupMs = Date.now() - stageStart;
    if (prior) { perf.totalMs = Date.now() - perf.totalStart; console.log("[wa-timing] assign-wa", JSON.stringify({...perf, outcome:"existing"})); return json({ ok:true, phone:prior.phone, label:prior.label, counted:false, cycle:prior.cycle }); }
    stageStart = Date.now();
    const numbers = await env.DB.prepare("SELECT id,label,phone,max_per_cycle,sort_order FROM wa_numbers WHERE enabled=1 ORDER BY sort_order,id").all();
    perf.numberPoolLookupMs = Date.now() - stageStart;
    const pool = numbers.results || [];
    if (!pool.length) return json({ ok:true, phone:link.phone, label:"默认号码", counted:false, fallback:true });
    stageStart = Date.now();
    let state = await env.DB.prepare("SELECT cycle FROM wa_route_state WHERE id=1").first();
    perf.cycleLookupMs = Date.now() - stageStart;
    let cycle = Number(state?.cycle || 1);
    async function findAvailable(c) {
      // Count assignments for all enabled numbers in one query instead of one query per number.
      const countsResult = await env.DB.prepare(
        "SELECT wa_number_id, COUNT(*) AS total FROM wa_assignments WHERE cycle=? GROUP BY wa_number_id"
      ).bind(c).all();
      const counts = new Map((countsResult.results || []).map(row => [Number(row.wa_number_id), Number(row.total || 0)]));
      for (const n of pool) {
        if ((counts.get(Number(n.id)) || 0) < Math.max(1, Number(n.max_per_cycle || 3))) return n;
      }
      return null;
    }
    stageStart = Date.now();
    let chosen = await findAvailable(cycle);
    if (!chosen) {
      cycle += 1;
      await env.DB.prepare("UPDATE wa_route_state SET cycle=? WHERE id=1").bind(cycle).run();
      chosen = await findAvailable(cycle);
    }
    perf.selectAvailableMs = Date.now() - stageStart;
    if (!chosen) return json({ error:"No WhatsApp number is available." }, 503);
    stageStart = Date.now();
    try {
      await env.DB.prepare("INSERT INTO wa_assignments(slug,customer_code,wa_number_id,cycle) VALUES(?,?,?,?)").bind(slug,session.customer_code,chosen.id,cycle).run();
    } catch (error) {
      const raced = await env.DB.prepare(`SELECT n.phone,n.label,a.cycle FROM wa_assignments a JOIN wa_numbers n ON n.id=a.wa_number_id WHERE a.slug=? AND a.customer_code=? LIMIT 1`).bind(slug,session.customer_code).first();
      if (raced) return json({ok:true,phone:raced.phone,label:raced.label,counted:false,cycle:raced.cycle});
      throw error;
    }
    perf.assignmentInsertMs = Date.now() - stageStart;
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-wa", JSON.stringify({...perf, outcome:"new"}));
    return json({ ok:true, phone:chosen.phone, label:chosen.label, counted:true, cycle });
  } catch (error) {
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-wa-error", JSON.stringify(perf));
    return json({ error:"Could not assign WhatsApp number: "+String(error?.message||error).slice(0,120) },500);
  }
}