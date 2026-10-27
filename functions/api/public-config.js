export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || url.searchParams.get("id") || "").trim().slice(0, 60);
  if (!slug || !/^[A-Za-z0-9_-]{1,60}$/.test(slug)) {
    return Response.json({ error: "Missing or invalid link ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const link = await env.DB.prepare(`
      SELECT id, slug, name, phone, message, title, description, button_text, source, agent, campaign, ad, enabled
      FROM landing_links WHERE slug = ? LIMIT 1
    `).bind(slug).first();
    if (!link || !link.enabled) {
      return Response.json({ error: "Link not found or disabled" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ link }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not read link configuration; check the D1 binding." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
