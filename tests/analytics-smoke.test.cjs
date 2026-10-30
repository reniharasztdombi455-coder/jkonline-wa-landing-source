const assert = require("node:assert/strict");
const base = process.env.TEST_BASE || "http://127.0.0.1:8788";
const slug = "queue-test";
const session_token = "session_analytics_test_0000_abcdefgh";
async function post(body) {
  const res = await fetch(base + "/api/track", {
    method: "POST",
    headers: {"content-type":"application/json","origin":base},
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
    headers:{"content-type":"application/json","origin":base},
    body:JSON.stringify({slug,session_token}),
    cache:"no-store"
  });
  assert.equal(claimRes.status, 200, await claimRes.text());
  const firstView = await post({event_type:"page_view",button_type:"test"});
  const duplicateView = await post({event_type:"page_view",button_type:"test"});
  assert.equal(firstView.counted, true, "first page view should count");
  assert.equal(duplicateView.counted, false, "page view should deduplicate per customer");
  for (let i = 0; i < 3; i++) {
    const click = await post({event_type:"whatsapp_click",button_type:["header","hero","footer"][i]});
    assert.equal(click.counted, true, "every WhatsApp click should count");
    assert.equal(click.deduplicated, false, "WhatsApp clicks must not deduplicate");
  }
  const check = await fetch(base + "/api/track", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({slug,session_token,event_type:"invalid_event"}),
    cache:"no-store"
  });
  assert.equal(check.status,400,"unknown event types must be rejected");
  console.log(JSON.stringify({ok:true,scenario:"analytics event semantics",eventTypes:["page_view","whatsapp_click"],pageViewsDeduplicated:true,whatsappClicksCountEveryTime:true,invalidEventRejected:true}));
})().catch(error => { console.error(error); process.exit(1); });
