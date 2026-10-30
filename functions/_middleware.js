import { onRequestGet as whatsappGo } from "./api/whatsapp-go.js";

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
    // Campaign URLs must be opened as a real top-level navigation. Preview
    // fetches and automated HTTP clients commonly omit these browser navigation
    // headers; stop them before redirecting to the side-effecting claim endpoint.
    const mode = (context.request.headers.get("Sec-Fetch-Mode") || "").toLowerCase();
    const dest = (context.request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
    const user = (context.request.headers.get("Sec-Fetch-User") || "").toLowerCase();
    const hasFetchMetadata = Boolean(mode || dest || user);
    const isNotTopLevelNavigation =
      (mode && mode !== "navigate") ||
      (dest && dest !== "document");
    // Some Facebook/Messenger in-app browsers omit Sec-Fetch-* headers.
    // Missing metadata alone is not proof of a crawler; crawler user agents
    // are filtered above. Reject only explicit non-document/fetch requests.
    if (context.request.method !== "GET" || isNotTopLevelNavigation) {
      console.log("[wa-campaign-skip]", JSON.stringify({
        reason: "not-top-level-browser-navigation",
        method: context.request.method,
        mode: mode || "missing",
        dest: dest || "missing",
        user: user || "missing",
        userAgent: (context.request.headers.get("User-Agent") || "").slice(0, 120)
      }));
      return blockedCrawlerResponse();
    }
    const slug = (url.searchParams.get("slug") || url.searchParams.get("id") || "").trim();
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(slug)) {
      return new Response("Missing or invalid link ID.", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    // Run the existing WhatsApp allocation/redirect handler in this request,
    // avoiding an extra browser-facing 302 through /api/whatsapp-go.
    // Keep the crawler and top-level-navigation checks above this call.
    return whatsappGo(context);
  }
  return context.next();
}
