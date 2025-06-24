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

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN)
        return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now = Date.now();

      // --- Session lookup & refresh / prompt verification ---
      // Try to find an existing session
      const sess = await env.DB.prepare(
        `SELECT verified, last_seen FROM sessions WHERE phone = ?`
      ).bind(from).first();

      if (sess && sess.verified === 1 && sess.last_seen + 90*24*60*60*1000 > now) {
        // session valid: refresh last_seen
        await env.DB.prepare(
          `UPDATE sessions SET last_seen = ? WHERE phone = ?`
        ).bind(now, from).run();
      } else if (!sess || sess.verified === 0 || sess.last_seen + 90*24*60*60*1000 <= now) {
        // create or reset session to unverified
        await env.DB.prepare(
          `INSERT INTO sessions (phone, email, customer_id, verified, last_seen)
           VALUES (?, '', '', 0, ?)
           ON CONFLICT(phone) DO UPDATE SET
             verified = 0,
             last_seen = excluded.last_seen`
        ).bind(from, now).run();

        // Prompt for customer ID and email
        const promptAuth = "Welcome! Please confirm your Customer ID and email address to continue.";
        await sendWhatsAppMessage(from, promptAuth, env);

        // Save the outgoing prompt
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, promptAuth, now).run();

        return Response.json({ ok: true });
      }

      // --- Handle message types ---
      const type = msgObj.type;
      let userInput = "";
      let media_url = null;
      let location_json = null;

      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        userInput = "[Audio]";
        media_url = msgObj.audio?.url || null;
      } else if (type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url || null;
      } else if (type === "location") {
        userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else {
        userInput = `[Unknown: ${type}]`;
        media_url = msgObj[type]?.url || null;
      }

      // --- Business logic routing ---
      let customer = await getCustomerByPhone(from, env);
      let reply = await routeCommand({ userInput, customer, env });

      // --- Send reply ---
      await sendWhatsAppMessage(from, reply, env);

      // --- Persist incoming message ---
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        from,
        userInput,
        customer ? "customer" : "lead",
        now,
        "incoming",
        media_url,
        location_json
      ).run();

      // --- Ensure sender exists in customers table ---
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      // --- Persist outgoing reply ---
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        from,
        reply,
        customer ? "customer" : "lead",
        now,
        "outgoing"
      ).run();

      return Response.json({ ok: true });
    }

    // --- List chats for dashboard (open) ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          c.email,
          c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
          SUM(CASE WHEN m.direction = 'incoming' AND (m.seen IS NULL OR m.seen = 0) THEN 1 ELSE 0 END) AS unread_count,
          (SELECT tag FROM messages m3 WHERE m3.from_number = m.from_number ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone = m.from_number
        WHERE (m.closed IS NULL OR m.closed = 0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List closed chats ---
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          c.email,
          c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone = m.from_number
        WHERE m.closed = 1
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List messages for a chat ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number = ?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Close chat endpoint ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Other API endpoints remain unchanged ---
    // ... /api/send-message, /api/set-tag, /api/update-customer, auto-replies, support-chats, etc.

    // --- Serve static HTML ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        const html = await env.ASSETS.fetch(new Request(url.origin + '/index.html'));
        return html;
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    // --- Fallback: Not Found ---
    return new Response("Not found", { status: 404 });
  }
};
