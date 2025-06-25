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

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge     = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now  = Date.now();
      const text = msgObj.text?.body?.trim() || "";

      // 1) Check if we've seen this number before
      let cust = await env.DB
        .prepare(`SELECT phone,name,email,customer_id,verified FROM customers WHERE phone = ?`)
        .bind(from).first();

      // 2) Brand-new sender → insert & ask YES/NO
      if (!cust) {
        await env.DB
          .prepare(`INSERT INTO customers (phone, verified) VALUES (?, 0)`)
          .bind(from).run();

        const q = "Hi! Are you already a Vinet customer? Please reply YES or NO.";
        await sendWhatsAppMessage(from, q, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'unverified', ?, 'outgoing')`
        ).bind(from, q, now).run();
        return Response.json({ ok: true });
      }

      // 3) Still unverified
      if (cust.verified === 0) {
        const lower = text.toLowerCase();
        const noCreds = !cust.name && !cust.email && !cust.customer_id;

        // 3a) First answer YES/NO
        if (noCreds) {
          if (["no","n"].includes(lower)) {
            // Treat as lead
            const reply = "Thanks! We’ve created a lead entry and someone will reach out soon.";
            await sendWhatsAppMessage(from, reply, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(from, reply, now).run();
            return Response.json({ ok: true });
          }
          if (["yes","y"].includes(lower)) {
            // Ask for details
            const prompt = 
              "Great! Please reply with your full name, email address, and Vinet Customer ID " +
              "(e.g. “Jane Doe, jane@example.com, 12345”).";
            await sendWhatsAppMessage(from, prompt, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'unverified', ?, 'outgoing')`
            ).bind(from, prompt, now).run();
            return Response.json({ ok: true });
          }
          // Clarify YES/NO
          const remind = "Please reply YES if you’re a Vinet customer, or NO if not.";
          await sendWhatsAppMessage(from, remind, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'unverified', ?, 'outgoing')`
          ).bind(from, remind, now).run();
          return Response.json({ ok: true });
        }

        // 3b) They sent credentials → save them
        const parts        = text.split(/[,\n]/).map(p => p.trim()).filter(Boolean);
        const [name, email, customer_id] = parts;
        await env.DB.prepare(`
          UPDATE customers SET
            name        = COALESCE(?, name),
            email       = COALESCE(?, email),
            customer_id = COALESCE(?, customer_id)
          WHERE phone = ?
        `).bind(name||null, email||null, customer_id||null, from).run();

        const ack = "Thanks! We’ll verify your details and let you know once you’re fully set up.";
        await sendWhatsAppMessage(from, ack, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'unverified', ?, 'outgoing')`
        ).bind(from, ack, now).run();
        return Response.json({ ok: true });
      }

      // 4) Verified customer → route command
      const customer = await getCustomerByPhone(from, env);
      const reply    = await routeCommand({ userInput: text, customer, env });
      await sendWhatsAppMessage(from, reply, env);

      // Log incoming
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'customer', ?, 'incoming')`
      ).bind(from, text, now).run();

      // Log outgoing
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'customer', ?, 'outgoing')`
      ).bind(from, reply, now).run();

      return Response.json({ ok: true });
    }

    // --- List chats (OPEN) ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number, c.name, c.email, c.customer_id,
          MAX(m.timestamp)     AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number = m.from_number
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

    // --- List chats (CLOSED) ---
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number, c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number = m.from_number
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

    // --- List messages ---
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

    // --- Close chat ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Send admin reply ---
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

    // --- Set tag ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET tag=? WHERE from_number=?`
      ).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Update customer ---
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone, name, customer_id, email, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name        = excluded.name,
          customer_id = excluded.customer_id,
          email       = excluded.email,
          verified    = 1
      `).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Auto-replies: list, add/update, delete ---
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
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
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status: 400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Support, Accounts, Sales queues ---
    if (url.pathname === "/api/support-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='support' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/accounts-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='accounts' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/sales-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='sales' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- Unlinked (unverified) clients ---
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'')    AS name,
               COALESCE(c.email,'')   AS email
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0
               OR c.customer_id IS NULL OR c.customer_id='')
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

    // --- Sync customers table ---
    if (url.pathname === "/api/customers-sync" && request.method === "POST") {
      const sql = `
        INSERT OR IGNORE INTO customers (phone, name, email, verified)
        SELECT DISTINCT from_number, '', '', 0
        FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(sql).run();
      return withCORS(Response.json({ ok: true, message: "Customers table synced." }));
    }

    // --- Admin users CRUD ---
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, username, role FROM admins ORDER BY username"
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      if (!username || !password || !role) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        "INSERT INTO admins (username, password, role) VALUES (?, ?, ?)"
      ).bind(username, password, role).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id", { status: 400 }));
      await env.DB.prepare("DELETE FROM admins WHERE id=?").bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Office hours ---
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM office_hours").all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag !== "string" || typeof day !== "number") {
        return withCORS(new Response("Missing fields", { status: 400 }));
      }
      await env.DB.prepare(`
        INSERT INTO office_hours (tag, day, open_time, close_time, closed)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tag, day) DO UPDATE SET
          open_time  = excluded.open_time,
          close_time = excluded.close_time,
          closed     = excluded.closed
      `).bind(tag, day, open_time, close_time, closed?1:0).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Global office open/close status ---
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM office_global LIMIT 1").all();
      return withCORS(Response.json(results?.[0] || { closed: 0, message: "" }));
    }
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(
        "UPDATE office_global SET closed=?, message=? WHERE id=1"
      ).bind(closed?1:0, message||"").run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Public holidays ---
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM public_holidays ORDER BY date").all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(
        "INSERT INTO public_holidays (date, name) VALUES (?, ?)"
      ).bind(date, name).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM public_holidays WHERE id=?").bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Serve dashboard static HTML ---
    if ((url.pathname === "/" || url.pathname === "/index.html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
    }

    // --- Fallback ---
    return new Response("Not found", { status: 404 });
  }
};
