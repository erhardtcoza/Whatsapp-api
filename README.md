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
Set the webhook URL in your WhatsApp Cloud API dashboard to:



file layout

vinet-whatsapp-worker/
├── src/
│   ├── index.js           # Main Worker - webhook, bot API, command routing
│   ├── splynx.js          # Splynx API helpers
│   ├── whatsapp.js        # WhatsApp send message helper
│   ├── commands.js        # Command routing and message formatting
│   ├── utils.js           # Utility functions (e.g. logging, formatting)
│   └── admin-portal.jsx   # (Optional) Admin portal React page
├── public/
│   └── index.html         # (Optional) Static landing page or dashboard entry
├── wrangler.toml
└── README.md
