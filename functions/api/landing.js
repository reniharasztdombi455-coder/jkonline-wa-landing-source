function clean(value, max = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = clean(url.searchParams.get("slug"), 80);

  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    return Response.json(
      { error: "Missing or invalid link ID" },
      { status: 400 }
    );
  }

  try {
    const link = await env.DB.prepare(
      `SELECT slug, name, phone, message, title,
              description, button_text, source, agent,
              campaign, ad, enabled
       FROM landing_links
       WHERE slug = ?
       LIMIT 1`
    ).bind(slug).first();

    if (!link || !link.enabled) {
      return Response.json(
        { error: "Link not found or disabled" },
        { status: 404 }
      );
    }

    return Response.json(
      {
        link: {
          slug: link.slug,
          name: link.name,
          phone: link.phone,
          message: link.message,
          title: link.title,
          description: link.description,
          button_text: link.button_text,
          source: link.source,
          agent: link.agent,
          campaign: link.campaign,
          ad: link.ad
        }
      },
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  } catch {
    return Response.json(
      { error: "Unable to read landing page configuration" },
      { status: 500 }
    );
  }
}
