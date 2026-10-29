import { onRequestPost as claimQueue } from "./queue-claim.js";
import { onRequestPost as saveTrack } from "./track.js";

function clean(value, max = 80) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function unavailable(message, status = 503) {
  return new Response(String(message || "WhatsApp is temporarily unavailable. Please try again later.").slice(0, 240), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache"
    }
  });
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : "";
    }
  }
  return "";
}

export async function onRequestGet({ request, env, waitUntil }) {
  const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
  if (userAgent.includes("meta-externalads/") || userAgent.includes("meta-externalagent/")) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "X-Robots-Tag": "noindex, nofollow" } });
  }
  const incoming = new URL(request.url);
  const slug = clean(incoming.searchParams.get("slug") || incoming.searchParams.get("id"), 60);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug)) {
    return new Response("Missing or invalid link ID.", { status:400, headers:{"Cache-Control":"no-store"} });
  }

  // Speculative browser requests must never consume a prepared customer/number
  // pair. Return a non-cacheable empty response so an actual user navigation
  // makes a fresh request and performs the claim.
  const secPurpose = (request.headers.get("Sec-Purpose") || "").toLowerCase();
  const purpose = (request.headers.get("Purpose") || "").toLowerCase();
  if (/(^|[;,\s])prefetch([;,\s]|$)|prerender/.test(secPurpose) || purpose.includes("prefetch")) {
    console.log("[wa-queue-skip]", JSON.stringify({ slug, reason:"speculative-request", secPurpose:secPurpose.slice(0,80) }));
    return new Response(null, {
      status:204,
      headers:{
        "Cache-Control":"no-store, no-cache, must-revalidate",
        "Pragma":"no-cache",
        "Vary":"Sec-Purpose, Purpose"
      }
    });
  }

  // Reuse a per-link browser session cookie so repeat visits can keep the same
  // customer code and WhatsApp assignment. A new browser/session gets a new code.
  const cookieName = "wa_session_" + slug;
  const existingToken = readCookie(request, cookieName);
  const sessionToken = existingToken || crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const claimRequest = new Request(new URL("/api/queue-claim", incoming.origin), {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ slug, session_token:sessionToken })
  });

  let claimResponse;
  let claim;
  const claimStarted = Date.now();
  try {
    claimResponse = await claimQueue({ request:claimRequest, env, waitUntil });
    claim = await claimResponse.json();
    console.log("[wa-timing] whatsapp-go-claim", JSON.stringify({ claimMs:Date.now()-claimStarted, claimStatus:claimResponse.status }));
  } catch {
    return unavailable("WhatsApp is temporarily unavailable. Please try again later.");
  }

  if (!claimResponse.ok || !claim?.ok || !claim.phone || !claim.message) {
    return unavailable("WhatsApp is temporarily unavailable. Please try again later.");
  }

  const digits = String(claim.phone).replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return unavailable("WhatsApp is temporarily unavailable. Please try again later.");
  }

  // Use the direct WhatsApp universal link on iOS as well. The custom
  // whatsapp:// interstitial increased observed end-to-end time in testing.
  // Keep the prefilled message and avoid a second client-side redirect.
  const target = new URL("https://wa.me/" + digits);
  target.searchParams.set("text", String(claim.message).slice(0, 800));
  const trackRequest = new Request(new URL("/api/track", incoming.origin), {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      slug,
      session_token:sessionToken,
      event_type:"whatsapp_click",
      button_type:"server_redirect",
      page_path:"/api/whatsapp-go",
      referrer_host:(() => { try { return incoming.searchParams.get("src") || new URL(request.headers.get("Referer") || "").hostname; } catch { return ""; } })()
    })
  });
  const tracking = saveTrack({ request:trackRequest, env }).catch(error => {
    console.log("[whatsapp-go-track-error]", String(error?.message || error).slice(0,160));
  });
  if (typeof waitUntil === "function") waitUntil(tracking);

  console.log("[wa-timing] whatsapp-go-total", JSON.stringify({ totalMs:Date.now()-claimStarted, outcome:"redirect-302" }));
  console.log("[whatsapp-go]", JSON.stringify({ slug, code:claim.code, cycle:claim.cycle, response:"302-redirect" }));
  // Construct a fresh response so headers remain mutable in Cloudflare Workers.
  const headers = new Headers({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache"
  });
  if (!existingToken) {
    headers.set("Set-Cookie", cookieName + "=" + sessionToken + "; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax");
  }

  headers.set("Location", target.toString());
  return new Response(null, { status: 302, headers });
}
