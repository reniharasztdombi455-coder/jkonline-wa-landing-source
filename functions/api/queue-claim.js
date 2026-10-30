function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function clean(v, n = 180) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n); }

const QUEUE_TARGET = 20;

// All queue/session tables are provisioned by the reviewed D1 migration.

async function readyCount(DB, slug) {
  const row = await DB.prepare("SELECT COUNT(*) AS n FROM wa_prefetch_queue WHERE slug=? AND status='ready'").bind(slug).first();
  return Number(row?.n || 0);
}

async function reserveOne(DB, link, prefix) {
  const counter = await DB.prepare(`
    INSERT INTO landing_code_counters(slug,last_number) VALUES(?,1)
    ON CONFLICT(slug) DO UPDATE SET last_number=last_number+1
    RETURNING last_number
  `).bind(prefix).first();
  const code = prefix + "/-" + Number(counter.last_number);
  const enabled = await DB.prepare("SELECT COUNT(*) AS n FROM wa_numbers WHERE enabled=1").first();
  if (Number(enabled?.n || 0) < 1) return false;

  const state = await DB.prepare("SELECT cycle FROM wa_route_state WHERE id=1").first();
  const baseCycle = Math.max(1, Number(state?.cycle || 1));

  // A different landing link can reserve the same candidate between SELECT
  // and batch(). The batch rechecks capacity atomically; if that race is lost,
  // re-query instead of reporting a false "no available number".
  for (let attempt = 0; attempt < 10; attempt++) {
    let reserved = null;

    // A full cycle may already be occupied. Keep advancing until a cycle has
    // capacity; an enabled number pool always has capacity in a later cycle.
    for (let offset = 0; offset < 1000 && !reserved; offset++) {
      const cycle = baseCycle + offset;
      const result = await DB.prepare(`
        SELECT n.id AS wa_number_id
        FROM wa_numbers n
        WHERE n.enabled=1
          AND (SELECT COUNT(*) FROM wa_assignments a
               WHERE a.wa_number_id=n.id AND a.cycle=?) < MAX(1,COALESCE(n.max_per_cycle,1))
        ORDER BY n.sort_order,n.id LIMIT 1
      `).bind(cycle).first();
      if (result) reserved = { wa_number_id:Number(result.wa_number_id), cycle };
    }
    if (!reserved) return false;

    // Commit the assignment, queue row, and route cursor as one D1 transaction.
    // If queue insertion fails (including a constraint/trigger failure), D1 rolls
    // back the assignment too, so no invisible reservation consumes cycle capacity.
    const results = await DB.batch([
      DB.prepare(`
        INSERT INTO wa_assignments(slug,customer_code,wa_number_id,cycle)
        SELECT ?, ?, n.id, ?
        FROM wa_numbers n
        WHERE n.id=? AND n.enabled=1
          AND (SELECT COUNT(*) FROM wa_assignments a
               WHERE a.wa_number_id=n.id AND a.cycle=?) < MAX(1,COALESCE(n.max_per_cycle,1))
      `).bind(link.slug, code, reserved.cycle, reserved.wa_number_id, reserved.cycle),
      DB.prepare(`
        INSERT INTO wa_prefetch_queue(slug,customer_code,wa_number_id,cycle,status)
        SELECT ?, ?, a.wa_number_id, a.cycle, 'ready'
        FROM wa_assignments a
        WHERE a.slug=? AND a.customer_code=?
          AND NOT EXISTS (
            SELECT 1 FROM wa_prefetch_queue q
            WHERE q.slug=a.slug AND q.customer_code=a.customer_code
          )
      `).bind(link.slug, code, link.slug, code),
      DB.prepare(`
        UPDATE wa_route_state SET cycle=MAX(cycle,?)
        WHERE id=1 AND EXISTS (
          SELECT 1 FROM wa_prefetch_queue
          WHERE slug=? AND customer_code=?
        )
      `).bind(reserved.cycle, link.slug, code)
    ]);
    const assignmentChanges = Number(results?.[0]?.meta?.changes || 0);
    const queueChanges = Number(results?.[1]?.meta?.changes || 0);
    if (assignmentChanges === 1 && queueChanges === 1) return true;
    // A concurrent request may have taken the selected number/cycle. Retry
    // with a fresh capacity read; never weaken the capacity predicate.
  }
  return false;
}

async function refill(DB, link, prefix, target = QUEUE_TARGET) {
  const started = Date.now();
  const before = await readyCount(DB, link.slug).catch(() => -1);
  // Serialize replenishment per link so parallel visitors cannot overfill the queue.
  await DB.prepare("INSERT OR IGNORE INTO wa_queue_refill_locks(slug,locked_until) VALUES(?,0)").bind(link.slug).run();
  const lock = await DB.prepare(`
    UPDATE wa_queue_refill_locks SET locked_until=unixepoch()+60
    WHERE slug=? AND locked_until < unixepoch()
    RETURNING slug
  `).bind(link.slug).first();
  if (!lock) {
    console.log("[wa-queue-refill]", JSON.stringify({slug:link.slug,outcome:"lock-busy",readyBefore:before,target,elapsedMs:Date.now()-started}));
    return;
  }
  let created = 0;
  let outcome = "target-reached";
  try {
    for (let i = 0; i < target; i++) {
      const count = await readyCount(DB, link.slug);
      if (count >= target) break;
      const ok = await reserveOne(DB, link, prefix);
      if (!ok) {
        outcome = "no-available-number";
        break;
      }
      created++;
    }
  } finally {
    await DB.prepare("UPDATE wa_queue_refill_locks SET locked_until=0 WHERE slug=?").bind(link.slug).run();
    const after = await readyCount(DB, link.slug).catch(() => -1);
    console.log("[wa-queue-refill]", JSON.stringify({slug:link.slug,outcome,readyBefore:before,readyAfter:after,created,target,elapsedMs:Date.now()-started}));
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
  if (userAgent.includes("meta-externalads/") || userAgent.includes("meta-externalagent/")) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "X-Robots-Tag": "noindex, nofollow" } });
  }
  // This endpoint consumes a pre-assigned customer/phone pair. Accept
  // browser JSON requests only from this exact origin to reduce cross-site
  // request abuse; the internal /api/whatsapp-go call supplies the same Origin.
  const origin = request.headers.get("Origin") || "";
  let requestOrigin = "";
  try { requestOrigin = new URL(request.url).origin; } catch {}
  if (!origin || origin !== requestOrigin) {
    return json({ error:"Origin not allowed" },403);
  }
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json({ error:"Content-Type must be application/json" },415);
  }

  const started = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ error:"Invalid JSON" },400); }
  let slug = clean(body.slug,60);
  const token = clean(body.session_token,80);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return json({ error:"Invalid link or browser session" },400);
  }

  const timing = {};
  try {
    // Production schema is provisioned ahead of traffic by reviewed migrations.
    const phase = Date.now();
    // Accept both the canonical text slug and legacy numeric landing_links.id.
    // Once resolved, all queue/session/analytics work must use the canonical slug.
    // Resolve the link and look up an existing session in one D1 round trip.
    // This preserves legacy numeric IDs while avoiding a serial query on revisits.
    const link = await env.DB.prepare(`
      SELECT l.id,l.slug,l.phone,l.message,l.contact_mode,l.routing_mode,l.source,l.agent,l.enabled,
        s.customer_code AS existing_customer_code,
        n.phone AS existing_phone,n.label AS existing_label,a.cycle AS existing_cycle,\n        ga.group_id AS existing_group_id,g.invite_url AS existing_group_url,g.label AS existing_group_label
      FROM landing_links l
      LEFT JOIN customer_code_sessions s ON s.slug=l.slug AND s.session_token=?
      LEFT JOIN wa_assignments a ON a.slug=s.slug AND a.customer_code=s.customer_code
      LEFT JOIN wa_numbers n ON n.id=a.wa_number_id
      LEFT JOIN wa_group_assignments ga ON ga.slug=s.slug AND ga.customer_code=s.customer_code
      LEFT JOIN wa_groups g ON g.id=ga.group_id
      WHERE l.slug=? OR CAST(l.id AS TEXT)=?
      LIMIT 1
    `).bind(token,slug,slug).first();
    timing.linkLookupMs = Date.now() - phase;
    if (!link || !link.enabled) return json({error:"Link not found or disabled"},404);
    slug = String(link.slug || "");
    const pattern = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/-\d+/;
    const match = String(link.message || "").match(pattern);
    if (!match) return json({error:"后台预设消息中需要包含基础客户编号，例如 F-HT-1027/-1。"},400);
    const prefix = match[1];

    // Group routing bypasses the phone queue entirely. A browser session keeps
    // its original group assignment on every revisit.
    if (link.routing_mode === "group") {
      let customerCode = link.existing_customer_code || "";
      let group = link.existing_group_id ? {
        id: Number(link.existing_group_id),
        invite_url: link.existing_group_url,
        label: link.existing_group_label
      } : null;

      if (!customerCode) {
        const counter = await env.DB.prepare(`
          INSERT INTO landing_code_counters(slug,last_number) VALUES(?,1)
          ON CONFLICT(slug) DO UPDATE SET last_number=last_number+1
          RETURNING last_number
        `).bind(slug).first();
        customerCode = prefix + "/-" + Number(counter?.last_number || 0);
        if (!Number(counter?.last_number || 0)) {
          return json({error:"无法生成客户编号，请稍后重试。"},500);
        }

        await env.DB.prepare(`
          INSERT INTO customer_code_sessions(slug,session_token,customer_code,source,agent)
          VALUES(?,?,?,?,?)
        `).bind(slug,token,customerCode,link.source||"direct",link.agent||"unknown").run();

        const groups = await env.DB.prepare(`
          SELECT id FROM wa_groups WHERE enabled=1
          ORDER BY sort_order,id
        `).all();
        for (const candidate of (groups.results || [])) {
          await env.DB.prepare(`
            INSERT INTO wa_group_assignments(slug,customer_code,group_id)
            SELECT ?,?,?
            WHERE (SELECT COUNT(*) FROM wa_group_assignments WHERE group_id=?) <
              (SELECT max_members FROM wa_groups WHERE id=? AND enabled=1)
            ON CONFLICT(slug,customer_code) DO NOTHING
          `).bind(slug,customerCode,candidate.id,candidate.id,candidate.id).run();
          const assigned = await env.DB.prepare(`
            SELECT ga.group_id,g.invite_url,g.label
            FROM wa_group_assignments ga JOIN wa_groups g ON g.id=ga.group_id
            WHERE ga.slug=? AND ga.customer_code=? LIMIT 1
          `).bind(slug,customerCode).first();
          if (assigned) {
            group = {id:Number(assigned.group_id),invite_url:assigned.invite_url,label:assigned.label};
            break;
          }
        }
      }

      if (!group?.invite_url) {
        return json({error:"目前所有 WhatsApp 群组均已满员或停用，请联系管理员。"},503);
      }
      const customerMessage = String(link.message || "").replace(pattern,customerCode);
      console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:link.existing_customer_code?"group-existing":"group-new"}));
      return json({
        ok:true,code:customerCode,message:customerMessage,
        contact_mode:"code_only",destination_type:"group",
        target_url:group.invite_url,label:group.label,group_id:group.id
      });
    }

    // Idempotent revisit: the same browser token always receives its original pair.
    const existing = link.existing_customer_code ? {
      customer_code:link.existing_customer_code,
      phone:link.existing_phone,
      label:link.existing_label,
      cycle:link.existing_cycle
    } : null;
    if (existing?.customer_code) {
      const message = String(link.message || "").replace(pattern,existing.customer_code);
      if (existing.phone) {
        console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"existing"}));
        return json({ok:true,code:existing.customer_code,message,phone:existing.phone,contact_mode:link.contact_mode || "prefill",label:existing.label,cycle:existing.cycle});
      }
      // Legacy session created before queue rollout: keep its original customer code
      // and allocate a phone to that code rather than consuming a different queued code.
      const poolResult = await env.DB.prepare("SELECT id,label,phone,max_per_cycle,sort_order FROM wa_numbers WHERE enabled=1 ORDER BY sort_order,id").all();
      const pool = poolResult.results || [];
      const state = await env.DB.prepare("SELECT cycle FROM wa_route_state WHERE id=1").first();
      const baseCycle = Math.max(1, Number(state?.cycle || 1));
      let assigned = null;
      for (let offset=0; offset<8 && !assigned; offset++) {
        const cycle = baseCycle + offset;
        const row = await env.DB.prepare(`
          INSERT INTO wa_assignments(slug,customer_code,wa_number_id,cycle)
          SELECT ?, ?, n.id, ? FROM wa_numbers n
          WHERE n.enabled=1 AND
            (SELECT COUNT(*) FROM wa_assignments a WHERE a.wa_number_id=n.id AND a.cycle=?)
            < MAX(1,COALESCE(n.max_per_cycle,1))
          ORDER BY n.sort_order,n.id LIMIT 1
          RETURNING wa_number_id,cycle
        `).bind(slug,existing.customer_code,cycle,cycle).first();
        if (row) assigned = { ...row, cycle:Number(row.cycle) };
      }
      if (assigned) {
        const n = pool.find(x => Number(x.id)===Number(assigned.wa_number_id));
        if (n) {
          await env.DB.prepare("UPDATE wa_route_state SET cycle=MAX(cycle,?) WHERE id=1").bind(assigned.cycle).run();
          const doRefill = () => refill(env.DB,link,prefix,QUEUE_TARGET).catch(error => console.log("[wa-queue-refill-error]",String(error?.message||error).slice(0,180)));
          if (typeof waitUntil === "function") waitUntil(doRefill()); else await doRefill();
          console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"legacy-session",cycle:assigned.cycle}));
          return json({ok:true,code:existing.customer_code,message,phone:n.phone,contact_mode:link.contact_mode || "prefill",label:n.label,cycle:assigned.cycle});
        }
      }
      return json({error:"No WhatsApp number is available for this existing session."},503);
    }

    // Fast path: claim an already-prepared pair first. Avoid a COUNT query on
    // every click; only build the queue if it is empty. Join the phone pool now
    // so a successful claim does not need another D1 read to resolve its number.
    let claimed = null;
    let phone = null;
    let label = null;
    let claimQueryMs = 0;
    let refillInlineMs = 0;
    for (let attempt=0; attempt<4 && !claimed; attempt++) {
      const claimPhase = Date.now();
      const candidate = await env.DB.prepare(`
        UPDATE wa_prefetch_queue
        SET status='claimed',claimed_session_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=(
          SELECT q.id FROM wa_prefetch_queue q
          JOIN wa_numbers n ON n.id=q.wa_number_id AND n.enabled=1
          WHERE q.slug=? AND q.status='ready'
          ORDER BY q.id LIMIT 1
        ) AND status='ready'
        RETURNING id,customer_code,wa_number_id,cycle,
          (SELECT phone FROM wa_numbers WHERE id=wa_prefetch_queue.wa_number_id) AS phone,
          (SELECT label FROM wa_numbers WHERE id=wa_prefetch_queue.wa_number_id) AS label
      `).bind(token,slug).first();
      claimQueryMs += Date.now() - claimPhase;
      if (candidate) {
        claimed=candidate;
        phone=candidate.phone;
        label=candidate.label;
        continue;
      }
      if (!candidate) {
        // Empty-queue recovery must never build all 20 entries synchronously.
        // Reserve only one pair for this visitor; after it is claimed, the normal
        // waitUntil refill replenishes the remaining queue in the background.
        const fallbackPhase = Date.now();
        const fallbackCreated = await reserveOne(env.DB, link, prefix);
        const fallbackMs = Date.now() - fallbackPhase;
        console.log("[wa-queue-empty-recovery]", JSON.stringify({
          slug, created: Boolean(fallbackCreated), elapsedMs: fallbackMs
        }));
        if (fallbackCreated) {
          // The next loop iteration atomically claims the single prepared pair.
          continue;
        }

        // Another request may have replenished the queue between our first claim
        // attempt and fallback. Try to claim that ready pair before returning 503.
        const retry = await env.DB.prepare(`
          SELECT q.id,q.customer_code,q.wa_number_id,q.cycle,n.phone,n.label
          FROM wa_prefetch_queue q
          JOIN wa_numbers n ON n.id=q.wa_number_id AND n.enabled=1
          WHERE q.slug=? AND q.status='ready'
          ORDER BY q.id LIMIT 1
        `).bind(slug).first();
        if (!retry) break;
        const row = await env.DB.prepare(`UPDATE wa_prefetch_queue
          SET status='claimed',claimed_session_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status='ready'
          RETURNING id,customer_code,wa_number_id,cycle`).bind(token,retry.id).first();
        claimQueryMs += Date.now() - claimPhase;
        if (row) { claimed=row; phone=retry.phone; label=retry.label; }
        continue;
      }
    }
    timing.claimQueryMs = claimQueryMs;
    timing.refillInlineMs = refillInlineMs;
    if (!claimed) {
      console.log("[wa-timing] queue-claim", JSON.stringify({ ...timing, totalMs:Date.now()-started, outcome:"empty-queue" }));
      return json({error:"当前没有可用的预备号码，请稍后重试。"},503);
    }

    let sessionSaveMs = 0;
    try {
      const savePhase = Date.now();
      await env.DB.prepare(`INSERT INTO customer_code_sessions(slug,session_token,customer_code,source,agent)
        VALUES(?,?,?,?,?)`).bind(slug,token,claimed.customer_code,link.source||"direct",link.agent||"unknown").run();
      sessionSaveMs = Date.now() - savePhase;
      timing.sessionSaveMs = sessionSaveMs;
    } catch (error) {
      const session = await env.DB.prepare("SELECT customer_code FROM customer_code_sessions WHERE slug=? AND session_token=? LIMIT 1").bind(slug,token).first();
      if (!session) {
        // The claim was consumed but no session row was persisted. Restore the
        // queue item so a transient database failure cannot permanently drain it.
        await env.DB.prepare("UPDATE wa_prefetch_queue SET status='ready',claimed_session_token=NULL,claimed_at=NULL WHERE id=? AND status='claimed' AND claimed_session_token=?")
          .bind(claimed.id,token).run().catch(() => {});
        throw error;
      }
      // A parallel request with the same browser token may have claimed a second
      // queue row before the first session insert won. Release that extra row and
      // return the pair belonging to the already-persisted customer code.
      if (session.customer_code !== claimed.customer_code) {
        await env.DB.prepare("UPDATE wa_prefetch_queue SET status='ready',claimed_session_token=NULL,claimed_at=NULL WHERE id=? AND status='claimed' AND claimed_session_token=?").bind(claimed.id,token).run();
        const original = await env.DB.prepare("SELECT n.phone,n.label,a.cycle FROM wa_assignments a JOIN wa_numbers n ON n.id=a.wa_number_id WHERE a.slug=? AND a.customer_code=? LIMIT 1").bind(slug,session.customer_code).first();
        if (!original?.phone) throw error;
        const originalMessage = String(link.message || "").replace(pattern,session.customer_code);
        const doRefill = () => refill(env.DB,link,prefix,QUEUE_TARGET).catch(refillError => console.log("[wa-queue-refill-error]",String(refillError?.message||refillError).slice(0,180)));
        if (typeof waitUntil === "function") waitUntil(doRefill()); else await doRefill();
        console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"parallel-reuse"}));
        return json({ok:true,code:session.customer_code,message:originalMessage,phone:original.phone,contact_mode:link.contact_mode || "prefill",label:original.label,cycle:original.cycle});
      }
    }

    if (!phone) return json({error:"预备号码不存在或已停用，请联系管理员。"},500);

    // Click analytics are recorded once by /api/track in whatsapp-go.js.
    // Queue claims alone are not counted as completed WhatsApp click events.

    const doRefill = () => refill(env.DB,link,prefix,QUEUE_TARGET).catch(error => console.log("[wa-queue-refill-error]",String(error?.message||error).slice(0,180)));
    if (typeof waitUntil === "function") waitUntil(doRefill());
    else await doRefill();

    const message = String(link.message || "").replace(pattern,claimed.customer_code);
    // Keep the visitor's critical path short: queue depth is operational
    // telemetry, not required to open WhatsApp. Refill runs via waitUntil.
    console.log("[wa-timing] queue-claim",JSON.stringify({ ...timing, totalMs:Date.now()-started, outcome:"new", cycle:claimed.cycle }));
    return json({ok:true,code:claimed.customer_code,message,phone,contact_mode:link.contact_mode || "prefill",label,cycle:claimed.cycle});
  } catch (error) {
    console.log("[wa-timing] queue-claim", JSON.stringify({ ...timing, totalMs:Date.now()-started, outcome:"error" }));
    console.log("[wa-queue-error]",String(error?.message||error).slice(0,200));
    return json({error:"无法领取预备资源，请稍后重试。"},500);
  }
}
