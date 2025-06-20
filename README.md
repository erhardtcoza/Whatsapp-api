# Whatsapp-worker-vinet


# Vinet WhatsApp Worker

WhatsApp bot for Vinet Internet Solutions.

## Key Features
- Customer auto-detection and personalized commands
- Splynx integration (balance, invoice, status, etc.)
- New customer registration path
- Easy to extend and customize

## Setup
1. Update `wrangler.toml` with your Cloudflare, D1, and WhatsApp details.
2. Deploy with `npx wrangler deploy`.

## Webhook
Set the webhook URL in your WhatsApp Cloud API dashboard to: https://w-api.vinetdns.co.za/webhook

How to use:

    Place your React JSX files in src/.

    Serve static files from /public using Workers assets (or just deploy with a simple build pipeline).

    The admin portal fetches /api/chats and /api/messages?phone=... as discussed above.

File Tree

vinet-whatsapp-worker/
├── src/
│   ├── index.js              # Worker entry, bot/webhook, routes
│   ├── splynx.js             # Splynx API helpers
│   ├── whatsapp.js           # WhatsApp send function
│   ├── commands.js           # Bot command router
│   └── admin-portal.jsx      # Admin React dashboard
├── public/
│   └── index.html            # Loads the React admin UI
├── wrangler.toml
└── README.md

