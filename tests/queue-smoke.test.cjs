const assert = require("node:assert/strict");
const base = process.env.TEST_BASE || "http://127.0.0.1:8788";
const slug = "queue-test";
const token = n => ("session_test_token_" + String(n).padStart(4, "0") + "_abcdefgh").slice(0, 40);
async function claim(session_token) {
  const res = await fetch(base + "/api/queue-claim", {
    method: "POST",
    headers: {"content-type":"application/json","origin":base},
    body: JSON.stringify({slug, session_token}),
    cache: "no-store"
  });
  const data = await res.json();
  if (!res.ok) throw new Error("claim failed (" + res.status + "): " + JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.match(data.code, /^TEST-AB\/-\d+$/);
  assert.match(data.phone, /^1555123\d{4}$/);
  assert.match(data.message, new RegExp(data.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return data;
}
(async () => {
  const warm = await claim(token(0));
  const same = await claim(token(0));
  assert.equal(same.code, warm.code, "same browser session must reuse its customer code");
  assert.equal(same.phone, warm.phone, "same browser session must reuse its phone");
  await new Promise(resolve => setTimeout(resolve, 250));
  const concurrent = await Promise.all([claim(token(1)), claim(token(2)), claim(token(3))]);
  const codes = [warm, ...concurrent].map(x => x.code);
  const phones = [warm, ...concurrent].map(x => x.phone);
  assert.equal(new Set(codes).size, codes.length, "different sessions must receive unique customer codes");
  assert.equal(new Set(phones).size, phones.length, "simultaneous claims must not receive duplicate phone pairs");
  // Simultaneous requests with the exact same browser token must converge
  // on one persisted customer/phone pair even when they race for ready rows.
  const sameToken = token(77);
  const raced = await Promise.all([claim(sameToken), claim(sameToken), claim(sameToken)]);
  assert.equal(new Set(raced.map(x => x.code)).size, 1, "parallel requests from one session must converge on one customer code");
  assert.equal(new Set(raced.map(x => x.phone)).size, 1, "parallel requests from one session must converge on one phone");
  await new Promise(resolve => setTimeout(resolve, 400));
  const afterRace = await claim(sameToken);
  assert.equal(afterRace.code, raced[0].code, "revisit after race must preserve the original customer code");
  assert.equal(afterRace.phone, raced[0].phone, "revisit after race must preserve the original phone");
  console.log(JSON.stringify({ok:true,scenario:"local D1 queue claims",sessions:codes.length,uniqueCodes:new Set(codes).size,uniquePhones:new Set(phones).size,parallelSameSessionRequests:raced.length,parallelSameSessionUniqueCodes:new Set(raced.map(x=>x.code)).size,parallelSameSessionUniquePhones:new Set(raced.map(x=>x.phone)).size,exampleQueueReady:warm.queueReady}));
})().catch(error => { console.error(error); process.exit(1); });
