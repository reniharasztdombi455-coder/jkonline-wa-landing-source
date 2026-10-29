// Let campaign URLs load the landing page so page views are measured separately
// from WhatsApp button clicks. The client records whatsapp_click only after an
// explicit user interaction; GET requests and link previews must not count as clicks.
export async function onRequest(context) {
  const userAgent = (context.request.headers.get("User-Agent") || "").toLowerCase();
  if (userAgent.includes("meta-externalads/") || userAgent.includes("meta-externalagent/")) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Robots-Tag": "noindex, nofollow"
      }
    });
  }
  return context.next();
}
