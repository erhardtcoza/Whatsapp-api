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
      const now = Date.now();
      let userInput = "";

      // Capture text for verification & department logic
      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // --- Session lookup ---
      const sess = await env.DB.prepare(
        `SELECT verified, last_seen, department FROM sessions WHERE phone = ?`
      ).bind(from).first();

      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const needsAuth =
        !sess ||
        sess.verified === 0 ||
        (sess.last_seen + ninetyDays <= now);

      // --- Unverified or expired session ---
      if (needsAuth) {
        // Try to verify if already pending and input looks like "ID email"
        if (sess && sess.verified === 0 && userInput) {
          const parts = userInput.split(/\s+/);
          if (parts.length >= 2 && parts[1].includes("@")) {
            const [providedId, providedEmailRaw] = parts;
            const providedEmail = providedEmailRaw.toLowerCase();
            const customer = await getCustomerByPhone(from, env);
            const realId = customer?.customer_id;
            const realEmail = customer?.email?.toLowerCase();

            if (customer && realId === providedId && realEmail === providedEmail) {
              // Mark verified
              await env.DB.prepare(
                `INSERT INTO sessions
                   (phone, email, customer_id, verified, last_seen, department)
                 VALUES (?, ?, ?, 1, ?, NULL)
                 ON CONFLICT(phone) DO UPDATE SET
                   email=excluded.email,
                   customer_id=excluded.customer_id,
                   verified=1,
                   last_seen=excluded.last_seen`
              ).bind(from, providedEmail, providedId, now).run();

              const menu =
                "✅ Thanks! You’re verified.\n" +
                "How can we assist today?\n" +
                "1. Sales\n" +
                "2. Accounts\n" +
                "3. Support";
              await sendWhatsAppMessage(from, menu, env);
              await env.DB.prepare(
                `INSERT INTO messages
                   (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, menu, now).run();

              return Response.json({ ok: true });
            } else {
              const msg =
                "❌ Credentials didn’t match.\n" +
                "Please reply with your Customer ID and email again.";
              await sendWhatsAppMessage(from, msg, env);
              await env.DB.prepare(
                `INSERT INTO messages
                   (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, msg, now).run();

              return Response.json({ ok: true });
            }
          }
        }

        // Prompt for authentication
        await env.DB.prepare(
          `INSERT INTO sessions
             (phone, email, customer_id, verified, last_seen, department)
           VALUES (?, '', '', 0, ?, NULL)
           ON CONFLICT(phone) DO UPDATE SET
             verified=0,
             last_seen=excluded.last_seen`
        ).bind(from, now).run();

        const promptAuth =
          "Welcome! To verify your account, please reply with your Customer ID and email address.";
        await sendWhatsAppMessage(from, promptAuth, env);
        await env.DB.prepare(
          `INSERT INTO messages
             (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, promptAuth, now).run();

        return Response.json({ ok: true });
      }

      // --- Session valid: refresh last_seen ---
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, from).run();

      // --- Department selection and ticket creation ---
      if (sess && sess.verified === 1 && !sess.department && userInput) {
        let dept;
        if (userInput === "1") dept = "sales";
        else if (userInput === "2") dept = "accounts";
        else if (userInput === "3") dept = "support";

        if (dept) {
          // Update session with department
          await env.DB.prepare(
            `UPDATE sessions SET department = ?, last_seen = ? WHERE phone = ?`
          ).bind(dept, now, from).run();

          // Generate ticket
          const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const rnd = Math.floor(Math.random() * 9000 + 1000);
          const ticket = `TKT-${date}-${rnd}`;

          // Insert chat session
          await env.DB.prepare(
            `INSERT INTO chatsessions
               (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from, ticket, dept, now).run();

          const ack =
            `✅ Your ticket is *${ticket}* (Dept: ${dept}).\n` +
            `How can we help you today?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages
               (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'ticket', ?, 'outgoing')`
          ).bind(from, ack, now).run();

          return Response.json({ ok: true });
        }
      }

      // --- Extract message content ---
      let media_url = null;
      let location_json = null;
      if (msgObj.type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (msgObj.type === "audio") {
        userInput = "[Audio]";
        media_url = msgObj.audio?.url || null;
      } else if (msgObj.type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url || null;
      } else if (msgObj.type === "location") {
        userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else if (msgObj.type !== "text") {
        userInput = `[Unknown: ${msgObj.type}]`;
        media_url = msgObj[msgObj.type]?.url || null;
      }

      // --- Business logic routing ---
      const customer = await getCustomerByPhone(from, env);
      const reply = await routeCommand({ userInput, customer, env });

      // --- Send reply ---
      await sendWhatsAppMessage(from, reply, env);

      // --- Persist incoming message ---
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, media_url, location_json)
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

      // --- Ensure customer record ---
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers
           (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      // --- Persist outgoing reply ---
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(from, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // --- API: open chats ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number=m.from_number
             ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
          SUM(CASE WHEN m.direction='incoming'
                   AND (m.seen IS NULL OR m.seen=0) THEN 1 ELSE 0 END)
            AS unread_count,
          (SELECT tag FROM messages m3
             WHERE m3.from_number=m.from_number
             ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: closed chats ---
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number=m.from_number
             ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.closed=1
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: list messages ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- API: send message ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", ts, "outgoing").run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: close chat ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: set tag ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET tag=? WHERE from_number=?`
      ).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: update customer ---
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

    // --- API: auto-replies ---
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return Response.json(results);
    }
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

    // --- API: support-chats, accounts-chats, sales-chats, unlinked-clients, customers-sync ---
    // (Unchanged from your existing code)

    // --- Serve static assets ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    // --- Fallback ---
    return new Response("Not found", { status: 404 });
  }
};
