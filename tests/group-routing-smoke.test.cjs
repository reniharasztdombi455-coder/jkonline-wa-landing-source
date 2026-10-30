const assert = require("node:assert/strict");
const base = process.env.TEST_BASE || "http://127.0.0.1:8788";
const slug = "group-test";
const token = n => ("group_session_" + String(n).padStart(4,"0") + "_abcdefghijk").slice(0,40);
async function claim(session_token) {
  const res = await fetch(base + "/api/queue-claim", {
    method:"POST",
    headers:{"content-type":"application/json","origin":base},
    body:JSON.stringify({slug,session_token}),
    cache:"no-store"
  });
  const data = await res.json();
  return {status:res.status,data};
}
(async()=>{
  const first=await claim(token(1));
  assert.equal(first.status,200,JSON.stringify(first.data));
  assert.equal(first.data.destination_type,"group");
  assert.equal(first.data.target_url,"https://chat.whatsapp.com/GROUP_A_TEST");
  assert.match(first.data.code,/^TEST-AB\/-\d+$/);

  const revisit=await claim(token(1));
  assert.equal(revisit.status,200);
  assert.equal(revisit.data.code,first.data.code,"revisit must preserve customer code");
  assert.equal(revisit.data.group_id,first.data.group_id,"revisit must preserve original group");

  const others=await Promise.all([claim(token(2)),claim(token(3)),claim(token(4)),claim(token(5))]);
  const successes=others.filter(x=>x.status===200);
  const full=others.filter(x=>x.status===503);
  assert.equal(successes.length,3,"remaining three group slots should be allocated");
  assert.equal(full.length,1,"fifth unique visitor should be rejected after all groups fill");
  assert.ok(successes.every(x=>x.data.destination_type==="group"));
  assert.equal(new Set([first.data.code,...successes.map(x=>x.data.code)]).size,4,"customer codes must be unique");
  assert.equal(new Set([first.data.group_id,...successes.map(x=>x.data.group_id)]).size,2,"both groups must be used");
  const counts=await fetch(base+"/api/health").catch(()=>null);
  console.log(JSON.stringify({ok:true,scenario:"group routing",firstGroup:first.data.group_id,assigned:4,fullResponses:full.length,revisitPreserved:true,healthEndpointAvailable:!!counts}));
})().catch(e=>{console.error(e);process.exit(1)});
