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

# Vinet WhatsApp Worker

A WhatsApp bot + admin dashboard for Vinet Internet Solutions.

## Key Features
- Auto-detects customers by phone (Splynx integration)
- Quick account and support commands
- New customer registration flow
- Admin dashboard to view/reply to chats
- Logging to D1
- Brand-matching design

## Setup

1. Fill in `wrangler.toml` with your Cloudflare and WhatsApp API details.
2. Deploy with:


What to do:

    Push the repo to GitHub (optional but recommended).

    Run:

    npx wrangler deploy

    Check logs in your Cloudflare dashboard if anything fails.

    Set your WhatsApp Cloud API webhook to
    https://w-api.vinetdns.co.za/webhook

    Send a WhatsApp message to your number and watch the Worker reply.

    Open your admin dashboard (/ or /index.html) and confirm chats load.

Troubleshooting:

    If it fails to reply, check your Worker logs and WhatsApp Cloud API dashboard.

    If admin UI does not load, check static asset routing or permissions.

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

