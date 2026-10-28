function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function clean(v, n = 180) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n); }

const schema = [
  `CREATE TABLE IF NOT EXISTS landing_code_counters (
    slug TEXT PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS customer_code_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, session_token TEXT NOT NULL,
    customer_code TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'direct',
    agent TEXT NOT NULL DEFAULT 'unknown',
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    page_views INTEGER NOT NULL DEFAULT 0, whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
    UNIQUE(slug, session_token)
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL UNIQUE,
    wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
    claimed_session_token TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    claimed_at TEXT, UNIQUE(slug, customer_code)
  )`,
  `CREATE TABLE IF NOT EXISTS wa_queue_refill_locks (
    slug TEXT PRIMARY KEY, locked_until INTEGER NOT NULL DEFAULT 0
  )`
];

async function ensureSchema(DB) {
  await Promise.all(schema.map(sql => DB.prepare(sql).run()));
  await DB.prepare("INSERT OR IGNORE INTO wa_route_state(id,cycle) VALUES(1,1)").run();
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
  const state = await DB.prepare("SELECT cycle FROM wa_route_state WHERE id=1").first();
  const baseCycle = Math.max(1, Number(state?.cycle || 1));
  let reserved = null;

  for (let offset = 0; offset < 8 && !reserved; offset++) {
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

async function refill(DB, link, prefix, target = 3) {
  // Serialize replenishment per link so parallel visitors cannot overfill the queue.
  await DB.prepare("INSERT OR IGNORE INTO wa_queue_refill_locks(slug,locked_until) VALUES(?,0)").bind(link.slug).run();
  const lock = await DB.prepare(`
    UPDATE wa_queue_refill_locks SET locked_until=unixepoch()+60
    WHERE slug=? AND locked_until < unixepoch()
    RETURNING slug
  `).bind(link.slug).first();
  if (!lock) return;
  try {
    for (let i = 0; i < target; i++) {
      const count = await readyCount(DB, link.slug);
      if (count >= target) return;
      const ok = await reserveOne(DB, link, prefix);
      if (!ok) return;
    }
  } finally {
    await DB.prepare("UPDATE wa_queue_refill_locks SET locked_until=0 WHERE slug=?").bind(link.slug).run();
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  const started = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ error:"Invalid JSON" },400); }
  const slug = clean(body.slug,60), token = clean(body.session_token,80);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return json({ error:"Invalid link or browser session" },400);
  }

  try {
    await ensureSchema(env.DB);
    const link = await env.DB.prepare("SELECT id,slug,phone,message,source,agent,enabled FROM landing_links WHERE slug=? LIMIT 1").bind(slug).first();
    if (!link || !link.enabled) return json({error:"Link not found or disabled"},404);
    const pattern = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/-\d+/;
    const match = String(link.message || "").match(pattern);
    if (!match) return json({error:"后台预设消息中需要包含基础客户编号，例如 F-HT-1027/-1。"},400);
    const prefix = match[1];

    // Idempotent revisit: the same browser token always receives its original pair.
    const existing = await env.DB.prepare(`
      SELECT s.customer_code,n.phone,n.label,a.cycle
      FROM customer_code_sessions s
      LEFT JOIN wa_assignments a ON a.slug=s.slug AND a.customer_code=s.customer_code
      LEFT JOIN wa_numbers n ON n.id=a.wa_number_id
      WHERE s.slug=? AND s.session_token=? LIMIT 1
    `).bind(slug,token).first();
    if (existing?.customer_code) {
      const message = String(link.message || "").replace(pattern,existing.customer_code);
      if (existing.phone) {
        console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"existing"}));
        return json({ok:true,code:existing.customer_code,message,phone:existing.phone,label:existing.label,cycle:existing.cycle,queueReady:await readyCount(env.DB,slug)});
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
          const doRefill = () => refill(env.DB,link,prefix,3).catch(error => console.log("[wa-queue-refill-error]",String(error?.message||error).slice(0,180)));
          if (typeof waitUntil === "function") waitUntil(doRefill()); else await doRefill();
          console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"legacy-session",cycle:assigned.cycle}));
          return json({ok:true,code:existing.customer_code,message,phone:n.phone,label:n.label,cycle:assigned.cycle,queueReady:await readyCount(env.DB,slug)});
        }
      }
      return json({error:"No WhatsApp number is available for this existing session."},503);
    }

    // First visit can initialize an empty queue. After a successful claim, refill
    // runs in the background when the Pages runtime supplies waitUntil.
    if ((await readyCount(env.DB,slug)) < 1) await refill(env.DB,link,prefix,3);
    let claimed = null;
    for (let attempt=0; attempt<4 && !claimed; attempt++) {
      const candidate = await env.DB.prepare("SELECT id,customer_code,wa_number_id,cycle FROM wa_prefetch_queue WHERE slug=? AND status='ready' ORDER BY id LIMIT 1").bind(slug).first();
      if (!candidate) break;
      claimed = await env.DB.prepare(`UPDATE wa_prefetch_queue
        SET status='claimed',claimed_session_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='ready'
        RETURNING id,customer_code,wa_number_id,cycle`).bind(token,candidate.id).first();
    }
    if (!claimed) return json({error:"当前没有可用的预备号码，请稍后重试。"},503);

    try {
      await env.DB.prepare(`INSERT INTO customer_code_sessions(slug,session_token,customer_code,source,agent)
        VALUES(?,?,?,?,?)`).bind(slug,token,claimed.customer_code,link.source||"direct",link.agent||"unknown").run();
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
        const doRefill = () => refill(env.DB,link,prefix,3).catch(refillError => console.log("[wa-queue-refill-error]",String(refillError?.message||refillError).slice(0,180)));
        if (typeof waitUntil === "function") waitUntil(doRefill()); else await doRefill();
        console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"parallel-reuse"}));
        return json({ok:true,code:session.customer_code,message:originalMessage,phone:original.phone,label:original.label,cycle:original.cycle,queueReady:await readyCount(env.DB,slug)});
      }
    }

    const number = await env.DB.prepare("SELECT phone,label FROM wa_numbers WHERE id=? LIMIT 1").bind(claimed.wa_number_id).first();
    if (!number?.phone) return json({error:"预备号码不存在或已停用，请联系管理员。"},500);

    const doRefill = () => refill(env.DB,link,prefix,3).catch(error => console.log("[wa-queue-refill-error]",String(error?.message||error).slice(0,180)));
    if (typeof waitUntil === "function") waitUntil(doRefill());
    else await doRefill();

    const message = String(link.message || "").replace(pattern,claimed.customer_code);
    const queueReady = await readyCount(env.DB,slug);
    console.log("[wa-timing] queue-claim",JSON.stringify({totalMs:Date.now()-started,outcome:"new",cycle:claimed.cycle,queueReady}));
    return json({ok:true,code:claimed.customer_code,message,phone:number.phone,label:number.label,cycle:claimed.cycle,queueReady});
  } catch (error) {
    console.log("[wa-queue-error]",String(error?.message||error).slice(0,200));
    return json({error:"无法领取预备资源，请稍后重试。"},500);
  }
}
