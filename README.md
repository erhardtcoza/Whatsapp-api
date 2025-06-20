# Whatsapp-worker-vinet

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
