// Legacy endpoint retained only to return a clear response to outdated clients.
// Customer-code and WhatsApp-number allocation must go through /api/queue-claim.
export async function onRequest({ request }) {
  return Response.json(
    {
      error: "This allocation endpoint has been retired. Use /api/queue-claim.",
      code: "LEGACY_ENDPOINT_RETIRED"
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store",
        "Deprecation": "true",
        "Sunset": "Fri, 30 Oct 2026 00:00:00 GMT"
      }
    }
  );
}
