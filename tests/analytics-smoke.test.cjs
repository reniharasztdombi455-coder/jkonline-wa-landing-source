const assert = require("node:assert/strict");
const base = process.env.TEST_BASE || "http://127.0.0.1:8788";
const slug = "queue-test";
const session_token = "session_analytics_test_0000_abcdefgh";
async function post(body) {
  const res = await fetch(base + "/api/track", {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({slug, session_token, page_path:"/go/", ...body}),
    cache:"no-store"
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  return data;
}
(async () => {
  const claimRes = await fetch(base + "/api/queue-claim", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({slug,session_token}),
    cache:"no-store"
  });
  assert.equal(claimRes.status, 200, await claimRes.text());
  for (const event_type of ["page_view","whatsapp_open_attempt","whatsapp_click"]) {
    await post({event_type,button_type:"test"});
    const duplicate = await post({event_type,button_type:"test"});
    assert.equal(duplicate.counted, false, event_type + " should deduplicate per customer");
  }
  const check = await fetch(base + "/api/track", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({slug,session_token,event_type:"invalid_event"}),
    cache:"no-store"
  });
  assert.equal(check.status,400,"unknown event types must be rejected");
  console.log(JSON.stringify({ok:true,scenario:"analytics event semantics",eventTypes:["page_view","whatsapp_open_attempt","whatsapp_click"],duplicateEventsDeduplicated:true,invalidEventRejected:true}));
})().catch(error => { console.error(error); process.exit(1); });
