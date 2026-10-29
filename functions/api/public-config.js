export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || url.searchParams.get("id") || "").trim().slice(0, 60);

  if (!slug || !/^[A-Za-z0-9_-]{1,60}$/.test(slug)) {
    return Response.json(
      { error: "Missing or invalid link ID" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // Keep this query compatible with the original landing_links schema.
    // The public landing page currently needs only the phone number; optional
    // presentation fields (title, description, button_text) may not exist in
    // older D1 databases and must not make the entire endpoint return HTTP 500.
    const link = await env.DB.prepare(`
      SELECT id, slug, name, phone, message, source, agent, campaign, ad, enabled
      FROM landing_links
      WHERE slug = ?
      LIMIT 1
    `).bind(slug).first();

    if (!link || Number(link.enabled) !== 1) {
      return Response.json(
        { error: "Link not found or disabled" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    return Response.json(
      { link },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Keep the public response generic, but record the actual failure in
    // Cloudflare Workers Logs so future 500s can be diagnosed.
    console.error("[public-config] D1 query failed", {
      message: String(error?.message || error),
      slug
    });

    return Response.json(
      { error: "Could not read link configuration. Check the D1 database binding and landing_links table." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
