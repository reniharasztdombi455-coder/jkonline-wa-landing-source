// Keep campaign URLs as direct server-side WhatsApp redirects; block link-preview crawlers before any side effects.
function isCrawlerRequest(request) {
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  return /meta-externalads|meta-externalagent|facebookexternalhit|facebot|facebookcatalog|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|googlebot|bingbot|applebot|yandexbot|baiduspider|crawler|spider|previewbot|pinterestbot|embedly|quora link preview/.test(ua);
}

function blockedCrawlerResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

export async function onRequest(context) {
  if (context.request.method === "HEAD" || isCrawlerRequest(context.request)) {
    return blockedCrawlerResponse();
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
