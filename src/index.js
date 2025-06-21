// src/index.js

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

    // --- Handle CORS preflight for API endpoints ---
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
      }

      // Lookup customer by phone
      let customer = await getCustomerByPhone(from, env);

      // Smart reply logic (customize as needed)
      let reply = await routeCommand({ userInput, customer, env });

      // Send WhatsApp reply
      await sendWhatsAppMessage(from, reply, env);

      // Store incoming and outgoing messages in D1
      const now = Date.now();
      // Incoming
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
      // Outgoing
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

    // --- Ensure customer exists in customers table ---
await env.DB.prepare(
  `INSERT OR IGNORE INTO customers (phone, name, email, verified)
   VALUES (?, '', '', 0)`
).bind(from).run();

    
    // --- List chats for dashboard ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          c.email,
          c.customer_id,
          MAX(m.timestamp) as last_ts,
          (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message,
          SUM(CASE WHEN m.direction = 'incoming' AND (m.seen IS NULL OR m.seen = 0) THEN 1 ELSE 0 END) as unread_count,
          (SELECT tag FROM messages m3 WHERE m3.from_number = m.from_number ORDER BY m3.timestamp DESC LIMIT 1) as tag
        FROM messages m
        LEFT JOIN customers c ON c.phone = m.from_number
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
        SELECT
          id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number = ?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Send admin reply from dashboard ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));

      await sendWhatsAppMessage(phone, body, env);

      // Store outgoing message in D1
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", now, "outgoing").run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- Set message/chat tag ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      // Update all messages for this number with the new tag
      await env.DB.prepare(
        `UPDATE messages SET tag=? WHERE from_number=?`
      ).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Update customer details from dashboard ---
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone, name, customer_id, email, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // GET all auto-replies
if (url.pathname === "/api/auto-replies" && request.method === "GET") {
  const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
  return Response.json(results);
}
// POST: update auto-reply
if (url.pathname === "/api/auto-reply" && request.method === "POST") {
  const { id, tag, hours, reply } = await request.json();
  if (!tag || !reply) return new Response("Missing fields", { status: 400 });
  if (id) {
    await env.DB.prepare(
      `UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`
    ).bind(tag, hours, reply, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)`
    ).bind(tag, hours, reply).run();
  }
  return Response.json({ ok: true });
}

    // GET all open support chats
if (url.pathname === "/api/support-chats" && request.method === "GET") {
  const sql = `
    SELECT
      m.from_number,
      c.name,
      c.email,
      c.customer_id,
      MAX(m.timestamp) as last_ts,
      (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
    FROM messages m
    LEFT JOIN customers c ON c.phone = m.from_number
    WHERE m.tag = 'support'
      AND (m.closed IS NULL OR m.closed = 0)
    GROUP BY m.from_number
    ORDER BY last_ts DESC
    LIMIT 200
  `;
  const { results } = await env.DB.prepare(sql).all();
  return withCORS(Response.json(results));
}

    // GET all open accounts chats
if (url.pathname === "/api/accounts-chats" && request.method === "GET") {
  const sql = `
    SELECT
      m.from_number,
      c.name,
      c.email,
      c.customer_id,
      MAX(m.timestamp) as last_ts,
      (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
    FROM messages m
    LEFT JOIN customers c ON c.phone = m.from_number
    WHERE m.tag = 'accounts'
      AND (m.closed IS NULL OR m.closed = 0)
    GROUP BY m.from_number
    ORDER BY last_ts DESC
    LIMIT 200
  `;
  const { results } = await env.DB.prepare(sql).all();
  return withCORS(Response.json(results));
}

    // GET all open sales chats
if (url.pathname === "/api/sales-chats" && request.method === "GET") {
  const sql = `
    SELECT
      m.from_number,
      c.name,
      c.email,
      c.customer_id,
      MAX(m.timestamp) as last_ts,
      (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
    FROM messages m
    LEFT JOIN customers c ON c.phone = m.from_number
    WHERE m.tag = 'sales'
      AND (m.closed IS NULL OR m.closed = 0)
    GROUP BY m.from_number
    ORDER BY last_ts DESC
    LIMIT 200
  `;
  const { results } = await env.DB.prepare(sql).all();
  return withCORS(Response.json(results));
}

    
        // --- List all unlinked clients (missing customer_id or email) ---
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          MAX(m.timestamp) AS last_msg,
          COALESCE(c.name, '') AS name,
          COALESCE(c.email, '') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number = c.phone
        WHERE m.tag = 'unverified'
          AND (c.verified IS NULL OR c.verified = 0 OR c.customer_id IS NULL OR c.customer_id = '')
        GROUP BY m.from_number
        ORDER BY last_msg DESC
        LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch (e) {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // POST /api/customers-sync
if (url.pathname === "/api/customers-sync" && request.method === "POST") {
  const sql = `
    INSERT OR IGNORE INTO customers (phone, name, email, verified)
    SELECT DISTINCT from_number, '', '', 0
    FROM messages
    WHERE from_number NOT IN (SELECT phone FROM customers)
  `;
  await env.DB.prepare(sql).run();
  return withCORS(Response.json({ ok: true, message: "Customers table synced with messages." }));
}

    
    // --- Serve static HTML (optional: if you use Workers Sites/KV Assets) ---
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
