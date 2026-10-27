CLOUDFLARE PAGES UPDATE PACKAGE — NO AUTO REDIRECT

This update removes JavaScript auto-redirect entirely. The visitor must tap a visible button.
- Primary button: opens WhatsApp with pre-filled message: 我的邀请码是这个F-HT-1027/-1
- Fallback button: opens WhatsApp without pre-filled text
- WhatsApp number: 254106706603

DEPLOY
1. Keep this ZIP structure as-is; index.html must be at the ZIP root.
2. Cloudflare Dashboard > Workers & Pages > jkonline-wa-landing.
3. Create a new deployment / upload a new version (wording may vary).
4. Upload this ZIP or extract it and upload the folder containing index.html, depending on the upload screen.
5. Deploy, then test the live pages.dev or custom-domain URL on iPhone Messenger.

The page no longer attempts any automatic redirect on load.
