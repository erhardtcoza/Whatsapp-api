/src
  ├── index.js                  # Main entry point
  ├── routes
  │   ├── whatsapp.js           # WhatsApp webhook handlers
  │   ├── admin.js              # Admin API endpoints
  │   └── api.js                # Other API routes (messages, sessions, etc.)
  ├── lib
  │   ├── db.js                 # Database interactions
  │   └── r2.js                 # R2 storage handlers
  └── utils
      ├── cors.js               # CORS helper
      ├── file.js               # File handling helpers
      ├── office.js             # Office hour helpers
      └── respond.js            # WhatsApp response helpers
