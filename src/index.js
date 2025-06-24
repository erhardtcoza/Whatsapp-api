import { sendWhatsAppMessage } from './whatsapp.js';

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

    // --- Webhook verification ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const type = msgObj.type;
      const now = Date.now();
      let userInput = msgObj.text?.body?.trim() || "";
      let tag = "lead";

      const greetingKeywords = ["hi", "hello", "good day", "hey"];
      let customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(from).first();

      // 1. Unverified flow
      if (!customer || customer.verified === 0) {
        if (greetingKeywords.includes(userInput.toLowerCase())) {
          const welcome = "Welcome! Please reply with your name, email address, and customer ID. If unsure, send whatever you have.";
          await sendWhatsAppMessage(from, welcome, env);
          await env.DB.prepare(`INSERT OR IGNORE INTO customers (phone, verified) VALUES (?, 0)`).bind(from).run();
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'system', ?, 'outgoing')`).bind(from, welcome, now).run();
          return Response.json({ ok: true });
        }

        const details = userInput.split(/[,\n]/).map(d => d.trim());
        const [name, email, customer_id] = details;

        await env.DB.prepare(`
          UPDATE customers SET 
            name = COALESCE(?, name),
            email = COALESCE(?, email),
            customer_id = COALESCE(?, customer_id)
          WHERE phone = ?
        `).bind(name || null, email || null, customer_id || null, from).run();

        const ack = "Thanks! Our team will verify your details shortly.";
        await sendWhatsAppMessage(from, ack, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'system', ?, 'outgoing')`).bind(from, ack, now).run();
        return Response.json({ ok: true });
      }

      // 2. Verified users
      if (customer.verified === 1) {
        if (greetingKeywords.includes(userInput.toLowerCase())) {
          const greet = `Welcome back ${customer.name || ""}! How can we assist you?\n1. Sales\n2. Accounts\n3. Support`;
          await sendWhatsAppMessage(from, greet, env);
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'system', ?, 'outgoing')`).bind(from, greet, now).run();
          return Response.json({ ok: true });
        }

        if (userInput === "1") tag = "sales";
        else if (userInput === "2") tag = "accounts";
        else if (userInput === "3") tag = "support";
        else tag = "customer";

        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, 'incoming')`).bind(from, userInput, tag, now).run();

        const reply = `You've been connected with ${tag}. How can we assist further?`;
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, 'outgoing')`).bind(from, reply, tag, now).run();
        return Response.json({ ok: true });
      }

      return Response.json({ ok: true });
    }

    // --- API ROUTES ---

    if (url.pathname === "/api/chats" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
               SUM(CASE WHEN m.direction='incoming' AND (m.seen IS NULL OR m.seen = 0) THEN 1 ELSE 0 END) AS unread_count,
               (SELECT tag FROM messages m3 WHERE m3.from_number = m.from_number ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON m.from_number = c.phone
        WHERE (m.closed IS NULL OR m.closed = 0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `).all();
      return withCORS(Response.json(results));
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      const { results } = await env.DB.prepare(`
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages WHERE from_number=? ORDER BY timestamp ASC LIMIT 200
      `).bind(phone).all();
      return withCORS(Response.json(results));
    }

    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction, seen) VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, email, customer_id } = await request.json();
      await env.DB.prepare(`
        INSERT INTO customers (phone, name, email, customer_id, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          email=excluded.email,
          customer_id=excluded.customer_id,
          verified=1
      `).bind(phone, name, email, customer_id).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT id, username, role FROM users`).all();
      return withCORS(Response.json(results));
    }

    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      await env.DB.prepare(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`).bind(username, password, role).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return Response.json(results);
    }

    if (url.pathname === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (id) {
        await env.DB.prepare(`UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`).bind(tag, hours, reply, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)`).bind(tag, hours, reply).run();
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
      return new Response("Static assets missing", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }
};
