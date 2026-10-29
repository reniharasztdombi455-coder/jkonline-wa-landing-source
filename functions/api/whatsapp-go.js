import { onRequestPost as claimQueue } from "./queue-claim.js";
import { onRequestPost as saveTrack } from "./track.js";

function clean(value, max = 80) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function fallbackPage(slug, message) {
  const safeSlug = encodeURIComponent(slug);
  const safeMessage = String(message || "We couldn't prepare WhatsApp automatically. Please continue using the button.")
    .replace(/[&<>"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[ch]));
  const href = "/?slug=" + safeSlug;
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to WhatsApp</title><body style="font-family:Arial,sans-serif;max-width:460px;margin:12vh auto;padding:24px;text-align:center"><h2>Continue to WhatsApp</h2><p>${safeMessage}</p><a style="display:inline-block;padding:14px 24px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:bold" href="${href}">Open WhatsApp page</a></body></html>`,
    { status: 503, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } }
  );
}

export async function onRequestGet({ request, env, waitUntil }) {
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
  if (/(^|[;,\\s])prefetch([;,\\s]|$)|prerender/.test(secPurpose) || purpose.includes("prefetch")) {
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

  // Each real direct campaign click gets its own session token. The queue
  // already contains prepared code/number pairs, so claim one and return a
  // server-side 302 instead of rendering a waiting landing page.
  const sessionToken = crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
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
    return fallbackPage(slug, "We couldn't prepare your WhatsApp contact automatically. Please use the fallback button.");
  }

  if (!claimResponse.ok || !claim?.ok || !claim.phone || !claim.message) {
    return fallbackPage(slug, claim?.error || "No prepared WhatsApp contact is available right now. Please use the fallback button.");
  }

  const digits = String(claim.phone).replace(/\\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return fallbackPage(slug, "The assigned WhatsApp number is invalid. Please use the fallback button.");
  }

  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(request.headers.get("User-Agent") || "");
  const target = isMobile
    ? new URL("https://wa.me/" + digits)
    : new URL("https://web.whatsapp.com/send");
  if (!isMobile) target.searchParams.set("phone", digits);
  target.searchParams.set("text", String(claim.message).slice(0, 800));

  const trackRequest = new Request(new URL("/api/track", incoming.origin), {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      slug,
      session_token:sessionToken,
      event_type:"whatsapp_open_attempt",
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
  console.log("[whatsapp-go]", JSON.stringify({ slug, code:claim.code, cycle:claim.cycle, redirect:"302" }));
  return Response.redirect(target.toString(), 302);
}
