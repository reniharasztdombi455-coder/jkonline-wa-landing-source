// Keep existing campaign links working while removing the visible landing page.
// A URL such as /?slug=1 is routed straight to the server-side WhatsApp redirect.
// Other requests, including the admin APIs and static assets, continue normally.
export async function onRequest(context) {
  // Meta ad crawlers may fetch campaign URLs automatically. Never let crawler
  // requests trigger customer-code claims or WhatsApp-number assignment.
  const userAgent = (context.request.headers.get("User-Agent") || "").toLowerCase();
  if (userAgent.includes("meta-externalads/") || userAgent.includes("meta-externalagent/")) {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "X-Robots-Tag": "noindex, nofollow" }
    });
  }
  const url = new URL(context.request.url);
  if (url.pathname === "/" && (url.searchParams.has("slug") || url.searchParams.has("id"))) {
    const slug = (url.searchParams.get("slug") || url.searchParams.get("id") || "").trim();
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug)) {
      return new Response("Missing or invalid link ID.", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    const target = new URL("/api/whatsapp-go", url.origin);
    target.searchParams.set("slug", slug);
    for (const key of ["src", "campaign", "ad"]) {
      const value = url.searchParams.get(key);
      if (value) target.searchParams.set(key, value.slice(0, 120));
    }
    return Response.redirect(target.toString(), 302);
  }
  return context.next();
}
