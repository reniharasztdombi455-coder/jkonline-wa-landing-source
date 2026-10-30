function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function clean(v, n = 180) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n); }

const QUEUE_TARGET = 20;

const schema = [
  `CREATE TABLE IF NOT EXISTS landing_code_counters (
    slug TEXT PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS unique_customer_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    customer_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(slug, customer_code, event_type)
  )`,
  `CREATE TABLE IF NOT EXISTS customer_code_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, session_token TEXT NOT NULL,
    customer_code TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'direct',
    agent TEXT NOT NULL DEFAULT 'unknown',
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    page_views INTEGER NOT NULL DEFAULT 0, whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
    UNIQUE(slug, session_token), UNIQUE(slug, customer_code)
  )`,
  `CREATE TABLE IF NOT EXISTS wa_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, phone TEXT NOT NULL,
    max_per_cycle INTEGER NOT NULL DEFAULT 3, sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS wa_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL,
    wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(slug, customer_code)
  )`,
  `CREATE TABLE IF NOT EXISTS wa_route_state (
    id INTEGER PRIMARY KEY CHECK(id=1), cycle INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS wa_prefetch_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL,
    wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
    claimed_session_token TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    claimed_at TEXT, UNIQUE(slug, customer_code)
  )`,
  `CREATE TABLE IF NOT EXISTS wa_queue_refill_locks (
    slug TEXT PRIMARY KEY, locked_until INTEGER NOT NULL DEFAULT 0
  )`
];

// Cache schema initialization per Worker isolate. Running CREATE TABLE IF NOT EXISTS
// for every visitor adds avoidable D1 round trips to the redirect's critical path.
let schemaReady;
async function ensureSchema(DB) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await Promise.all(schema.map(sql => DB.prepare(sql).run()));
      await DB.prepare("INSERT OR IGNORE INTO wa_route_state(id,cycle) VALUES(1,1)").run();
    })().catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

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
  let reserved = null;

  // A full cycle may already be occupied. Keep advancing until a cycle has
  // capacity; an enabled number pool always has capacity in a later cycle.
  for (let offset = 0; offset < 1000 && !reserved; offset++) {
    const cycle = baseCycle + offset;
    const result = await DB.prepare(`
      INSERT INTO wa_assignments(slug,customer_code,wa_number_id,cycle)
      SELECT ?, ?, n.id, ?
      FROM wa_numbers n
      WHERE n.enabled=1
        AND (SELECT COUNT(*) FROM wa_assignments a
             WHERE a.wa_number_id=n.id AND a.cycle=?) < MAX(1,COALESCE(n.max_per_cycle,1))
      ORDER BY n.sort_order,n.id LIMIT 1
      RETURNING wa_number_id,cycle
    `).bind(link.slug, code, cycle, cycle).first();
    if (result) reserved = { wa_number_id:Number(result.wa_number_id), cycle:Number(result.cycle) };
  }
  if (!reserved) return false;

  await DB.prepare("UPDATE wa_route_state SET cycle=MAX(cycle,?) WHERE id=1").bind(reserved.cycle).run();
  try {
    await DB.prepare(`INSERT INTO wa_prefetch_queue(slug,customer_code,wa_number_id,cycle,status)
      VALUES(?,?,?,?,'ready')`).bind(link.slug, code, reserved.wa_number_id, reserved.cycle).run();
  } catch (error) {
    // Do not leave an invisible assignment consuming a phone's cycle capacity.
    await DB.prepare("DELETE FROM wa_assignments WHERE slug=? AND customer_code=?").bind(link.slug,code).run().catch(() => {});
    throw error;
  }
  return true;
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
    // Production schema is provisioned ahead of traffic. Do not run CREATE TABLE
    // statements in the redirect hot path: D1 DDL adds latency on every cold isolate.
    const phase = Date.now();
    // Accept both the canonical text slug and legacy numeric landing_links.id.
    // Once resolved, all queue/session/analytics work must use the canonical slug.
    // Resolve the link and look up an existing session in one D1 round trip.
    // This preserves legacy numeric IDs while avoiding a serial query on revisits.
    const link = await env.DB.prepare(`
      SELECT l.id,l.slug,l.phone,l.message,l.source,l.agent,l.enabled,
        s.customer_code AS existing_customer_code,
        n.phone AS existing_phone,n.label AS existing_label,a.cycle AS existing_cycle
      FROM landing_links l
      LEFT JOIN customer_code_sessions s ON s.slug=l.slug AND s.session_token=?
      LEFT JOIN wa_assignments a ON a.slug=s.slug AND a.customer_code=s.customer_code
      LEFT JOIN wa_numbers n ON n.id=a.wa_number_id
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
        return json({ok:true,code:existing.customer_code,message,phone:existing.phone,label:existing.label,cycle:existing.cycle});
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
          return json({ok:true,code:existing.customer_code,message,phone:n.phone,label:n.label,cycle:assigned.cycle});
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
        return json({ok:true,code:session.customer_code,message:originalMessage,phone:original.phone,label:original.label,cycle:original.cycle});
      }
    }

    if (!phone) return json({error:"预备号码不存在或已停用，请联系管理员。"},500);

    // Analytics are not required to create a correct assignment or redirect.
    // Schedule them after the response on Cloudflare; preserve synchronous
    // behavior only in runtimes that do not provide waitUntil.
    const recordClick = async () => {
      try {
        // The unique key prevents double-counting for the same code and event.
        const clickEvent = await env.DB.prepare(
          "INSERT OR IGNORE INTO unique_customer_events (slug, customer_code, event_type) VALUES (?, ?, 'whatsapp_click')"
        ).bind(slug, claimed.customer_code).run();
        if (Number(clickEvent.meta?.changes || 0) > 0) {
          await env.DB.prepare(
            "UPDATE customer_code_sessions SET whatsapp_clicks = whatsapp_clicks + 1, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = ? AND session_token = ?"
          ).bind(slug, token).run();
        }
      } catch (error) {
        console.log("[wa-click-count-error]", String(error?.message || error).slice(0,160));
      }
    };
    if (typeof waitUntil === "function") waitUntil(recordClick());
    else await recordClick();

    const doRefill = () => refill(env.DB,link,prefix,QUEUE_TARGET).catch(error => console.log("[wa-queue-refill-error]",String(error?.message||error).slice(0,180)));
    if (typeof waitUntil === "function") waitUntil(doRefill());
    else await doRefill();

    const message = String(link.message || "").replace(pattern,claimed.customer_code);
    // Keep the visitor's critical path short: queue depth is operational
    // telemetry, not required to open WhatsApp. Refill runs via waitUntil.
    console.log("[wa-timing] queue-claim",JSON.stringify({ ...timing, totalMs:Date.now()-started, outcome:"new", cycle:claimed.cycle }));
    return json({ok:true,code:claimed.customer_code,message,phone,label,cycle:claimed.cycle});
  } catch (error) {
    console.log("[wa-timing] queue-claim", JSON.stringify({ ...timing, totalMs:Date.now()-started, outcome:"error" }));
    console.log("[wa-queue-error]",String(error?.message||error).slice(0,200));
    return json({error:"无法领取预备资源，请稍后重试。"},500);
  }
}
