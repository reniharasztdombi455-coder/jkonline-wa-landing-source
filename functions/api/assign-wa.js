function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function clean(v, n = 180) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const slug = clean(body.slug, 60), token = clean(body.session_token, 80);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return json({ error: "Invalid link or session" }, 400);
  }

  const perf = { totalStart: Date.now() };
  try {
    let t = Date.now();
    const link = await env.DB.prepare("SELECT id, enabled, phone FROM landing_links WHERE slug=? LIMIT 1").bind(slug).first();
    perf.linkLookupMs = Date.now() - t;
    if (!link || !link.enabled) return json({ error: "Link not found or disabled" }, 404);

    t = Date.now();
    const session = await env.DB.prepare("SELECT customer_code FROM customer_code_sessions WHERE slug=? AND session_token=? LIMIT 1").bind(slug, token).first();
    perf.sessionLookupMs = Date.now() - t;
    if (!session?.customer_code) return json({ error: "Customer code session not found" }, 409);

    // Number-pool, assignment, and route-state tables are provisioned by migrations.
        const prior = await env.DB.prepare(`SELECT a.wa_number_id,a.cycle,n.phone,n.label
      FROM wa_assignments a JOIN wa_numbers n ON n.id=a.wa_number_id
      WHERE a.slug=? AND a.customer_code=? LIMIT 1`).bind(slug, session.customer_code).first();
    perf.priorAssignmentLookupMs = Date.now() - t;
    if (prior) {
      perf.totalMs = Date.now() - perf.totalStart;
      console.log("[wa-timing] assign-wa", JSON.stringify({...perf, outcome:"existing"}));
      return json({ok:true, phone:prior.phone, label:prior.label, counted:false, cycle:prior.cycle});
    }

    const poolResult = await env.DB.prepare("SELECT id,label,phone,max_per_cycle,sort_order FROM wa_numbers WHERE enabled=1 ORDER BY sort_order,id").all();
    const pool = poolResult.results || [];
    if (!pool.length) return json({ ok:true, phone:link.phone, label:"默认号码", counted:false, fallback:true });
    const state = await env.DB.prepare("SELECT cycle FROM wa_route_state WHERE id=1").first();
    const baseCycle = Math.max(1, Number(state?.cycle || 1));
    t = Date.now();

    // Capacity enforcement is part of the INSERT ... SELECT statement itself.
    // D1 serializes writes, so simultaneous visitors cannot all claim the same final slot.
    let chosen = null;
    let cycle = baseCycle;
    for (let offset = 0; offset < 6 && !chosen; offset++) {
      cycle = baseCycle + offset;
      const inserted = await env.DB.prepare(`
        INSERT INTO wa_assignments (slug, customer_code, wa_number_id, cycle)
        SELECT ?, ?, n.id, ?
        FROM wa_numbers n
        WHERE n.enabled=1
          AND (SELECT COUNT(*) FROM wa_assignments a
               WHERE a.wa_number_id=n.id AND a.cycle=?) < MAX(1, COALESCE(n.max_per_cycle, 1))
        ORDER BY n.sort_order, n.id
        LIMIT 1
        RETURNING wa_number_id, cycle
      `).bind(slug, session.customer_code, cycle, cycle).first();

      if (inserted) {
        const number = pool.find(n => Number(n.id) === Number(inserted.wa_number_id));
        if (number) chosen = { ...number, cycle: Number(inserted.cycle) };
      }
    }
    perf.atomicAllocationMs = Date.now() - t;
    if (!chosen) return json({ error:"No WhatsApp number is available in the next six cycles. Please contact the administrator." }, 503);

    await env.DB.prepare("UPDATE wa_route_state SET cycle=MAX(cycle, ?) WHERE id=1").bind(chosen.cycle).run();
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-wa", JSON.stringify({...perf, outcome:"new", cycle:chosen.cycle}));
    return json({ ok:true, phone:chosen.phone, label:chosen.label, counted:true, cycle:chosen.cycle });
  } catch (error) {
    perf.totalMs = Date.now() - perf.totalStart;
    console.log("[wa-timing] assign-wa-error", JSON.stringify(perf));
    return json({ error:"Could not assign WhatsApp number: "+String(error?.message||error).slice(0,120) },500);
  }
}
