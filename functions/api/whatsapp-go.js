// Legacy automatic-redirect endpoint disabled.
// Visitors must enter through the landing page and click the WhatsApp button.
export async function onRequestGet() {
  return new Response("Automatic WhatsApp redirects are disabled. Please open your landing page and click the WhatsApp button.", {
    status: 410,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
