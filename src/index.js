
// --- Full Combined index.js with webhook and admin endpoints ---

import { getCustomerByPhone } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const type = msgObj.type;
      const now = Date.now();
      let userInput = msgObj.text?.body?.trim().toLowerCase() || "";
      let media_url = null;
      let location_json = null;
      const greetingKeywords = ["hi", "hello", "good day", "hey"];

      let customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(from).first();

      if (!customer || customer.verified === 0) {
        if (greetingKeywords.includes(userInput)) {
          const reply = "Welcome! Please reply with your name, email address, and customer ID. If unsure, provide any information you have.";
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(`INSERT OR IGNORE INTO customers (phone, verified) VALUES (?, 0)`).bind(from).run();
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'unverified', ?, 'outgoing')`).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        const details = userInput.split(/[,
]/).map(d => d.trim());
        const [name, email, customer_id] = details;

        await env.DB.prepare(`
          UPDATE customers SET 
            name = COALESCE(?, name),
            email = COALESCE(?, email),
            customer_id = COALESCE(?, customer_id)
          WHERE phone = ?
        `).bind(name || null, email || null, customer_id || null, from).run();

        const reply = "Thanks! Our team will verify your details soon.";
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'unverified', ?, 'outgoing')`).bind(from, reply, now).run();
        return Response.json({ ok: true });
      }

      if (customer.verified === 1) {
        if (greetingKeywords.includes(userInput)) {
          const reply = `Welcome back ${customer.name}! How can we assist you today?
1. Sales
2. Accounts
3. Support`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'customer', ?, 'outgoing')`).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        let tag = "customer";
        if (userInput === "1") tag = "sales";
        else if (userInput === "2") tag = "accounts";
        else if (userInput === "3") tag = "support";

        await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from).run();

        const reply = `You've been connected with ${tag}. How may we assist you further?`;
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, 'outgoing')`).bind(from, reply, tag, now).run();
        return Response.json({ ok: true });
      }

      return Response.json({ ok: true });
    }

    // --- Example endpoint: chats ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id, MAX(m.timestamp) as last_ts,
          (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message,
          SUM(CASE WHEN m.direction = 'incoming' AND (m.seen IS NULL OR m.seen = 0) THEN 1 ELSE 0 END) as unread_count,
          (SELECT tag FROM messages m3 WHERE m3.from_number = m.from_number ORDER BY m3.timestamp DESC LIMIT 1) as tag
        FROM messages m
        LEFT JOIN customers c ON c.phone = m.from_number
        WHERE (m.closed IS NULL OR m.closed = 0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `).all();
      return withCORS(Response.json(results));
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        const html = await env.ASSETS.fetch(new Request(url.origin + '/index.html'));
        return html;
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }
};
