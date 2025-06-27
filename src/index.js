// src/index.js

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
      const challenge    = url.searchParams.get("hub.challenge");
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
      let   userInput     = "";
      let   media_url     = null;
      let   location_json = null;

      // Parse incoming message of any type
      const type = msgObj.type;
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const autoReply = "Sorry, but we cannot receive voice notes. Please send text or documents.";
          await sendWhatsAppMessage(from, autoReply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, 'lead', ?, 'incoming', ?)`
          ).bind(from, "[Voice Note]", now, msgObj.audio.url).run();
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, autoReply, now).run();
          await env.DB.prepare(
            `INSERT OR IGNORE INTO customers (phone, name, email, verified)
             VALUES (?, '', '', 0)`
          ).bind(from).run();
          return Response.json({ ok: true });
        } else {
          userInput = "[Audio]";
          media_url = msgObj.audio?.url || null;
        }
      } else if (type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url || null;
      } else if (type === "location") {
        userInput     = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else {
        userInput = `[Unknown: ${type}]`;
        if (msgObj[type]?.url) media_url = msgObj[type].url;
      }

      // Lookup customer in our own table
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      // greeting keywords
      const greetings = ["hi","hello","hey","good day"];
      const lc = userInput.toLowerCase();

      // --- VERIFIED CUSTOMER FLOW ---
      if (customer && customer.verified === 1) {
        // 1) on greeting, show main menu
        if (greetings.includes(lc)) {
          const firstName = (customer.name||"").split(" ")[0] || "";
          const reply =
            `Hello ${firstName}! How can we help you today?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        // 2) department choice
        let deptTag = null;
        if (userInput === "1") deptTag = "support";
        else if (userInput === "2") deptTag = "sales";
        else if (userInput === "3") deptTag = "accounts";

        if (deptTag) {
          // create a date-based ticket: YYYY-MM-DD-N
          const today = new Date().toISOString().slice(0,10);
          const dayStart = Date.parse(`${today}T00:00:00Z`);
          const dayEnd   = Date.parse(`${today}T23:59:59Z`);
          const { count=0 } = await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM chatsessions WHERE start_ts BETWEEN ? AND ?`
          ).bind(dayStart, dayEnd).first();
          const ticket = `${today}-${count+1}`;
          // insert session
          await env.DB.prepare(
            `INSERT INTO chatsessions
               (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from, ticket, deptTag, now).run();

          const ack = `✅ Your session ticket: *${ticket}* (Dept: ${deptTag}). How can we assist you?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, ack, deptTag, now).run();
          return Response.json({ ok: true });
        }

        // 3) fallback to your existing routeCommand logic
        const reply = await routeCommand({ userInput, customer, env });
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages
             (from_number, body, tag, timestamp, direction, media_url, location_json)
           VALUES (?, ?, ?, ?, 'incoming', ?, ?)`
        ).bind(from, userInput, customer.tag||'customer', now, media_url, location_json).run();
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, ?, ?, 'outgoing')`
        ).bind(from, reply, customer.tag||'customer', now).run();
        return Response.json({ ok: true });
      }

      // --- NEW / UNVERIFIED CLIENT FLOW ---
      const prompt =
        "Welcome! Are you an existing Vinet client? If yes, reply with:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "If not, reply with `new` and we’ll treat you as a lead.";
      await sendWhatsAppMessage(from, prompt, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers
           (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      ).bind(from, prompt, now).run();
      return Response.json({ ok: true });
    }

    // --- Customers list (for Send Message page) ---
    if (url.pathname === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT phone, name, customer_id, email FROM customers ORDER BY name`
      ).all();
      return withCORS(Response.json(results));
    }
    // Add a customer (Send Message page support)
    if (url.pathname === "/api/add-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone || !name) return withCORS(new Response("Missing required fields", { status: 400 }));
      await env.DB.prepare(
        `INSERT INTO customers (phone, name, customer_id, email, verified)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(phone) DO UPDATE SET name=excluded.name, customer_id=excluded.customer_id, email=excluded.email, verified=1`
      ).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Auto-Replies CRUD ---
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

    // --- System/Flow endpoints ---
    if (url.pathname === "/api/flows" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM flows ORDER BY id`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/flows" && request.method === "POST") {
      const { id, name, trigger } = await request.json();
      const nowTs = Date.now();
      if (id) {
        await env.DB.prepare(
          `UPDATE flows SET name = ?, trigger = ?, updated_ts = ? WHERE id = ?`
        ).bind(name, trigger, nowTs, id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flows (name, trigger, created_ts) VALUES (?, ?, ?)`
        ).bind(name, trigger, nowTs).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/flows/delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing flow id", { status: 400 }));
      // cascade delete steps
      await env.DB.prepare(`DELETE FROM flow_steps WHERE flow_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }
    // Flow-Steps CRUD
    if (url.pathname === "/api/flow-steps" && request.method === "GET") {
      const flowId = Number(url.searchParams.get("flow_id") || 0);
      if (!flowId) return withCORS(new Response("Missing flow_id", { status: 400 }));
      const { results } = await env.DB.prepare(
        `SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_order`
      ).bind(flowId).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/flow-steps" && request.method === "POST") {
      const { id, flow_id, step_order, type, message } = await request.json();
      if (!flow_id || !type) return withCORS(new Response("Missing fields", { status: 400 }));
      if (id) {
        await env.DB.prepare(
          `UPDATE flow_steps
              SET step_order = ?, type = ?, message = ?
            WHERE id = ?`
        ).bind(step_order, type, message, id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flow_steps (flow_id, step_order, type, message)
           VALUES (?, ?, ?, ?)`
        ).bind(flow_id, step_order, type, message).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/flow-steps/delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing step id", { status: 400 }));
      await env.DB.prepare(`DELETE FROM flow_steps WHERE id = ?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Office Hours & Holidays ---
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag !== "string" || typeof day !== "number")
        return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO office_hours (tag, day, open_time, close_time, closed)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tag, day) DO UPDATE SET
          open_time = excluded.open_time,
          close_time = excluded.close_time,
          closed    = excluded.closed
      `).bind(tag, day, open_time, close_time, closed ? 1 : 0).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0] || { closed: 0, message: "" }));
    }
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(
        `UPDATE office_global SET closed = ?, message = ? WHERE id = 1`
      ).bind(closed ? 1 : 0, message || "").run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(
        `INSERT INTO public_holidays (date, name) VALUES (?, ?)`
      ).bind(date, name).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id = ?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Admin users (admins table) ---
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, username, role FROM admins ORDER BY username`
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      if (!username || !password || !role)
        return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `INSERT INTO admins (username, password, role) VALUES (?, ?, ?)`
      ).bind(username, password, role).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id", { status: 400 }));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Departmental Chat Sessions ---
    if (url.pathname === "/api/accounts-chatsessions" && request.method === "GET") {
      // all open account department sessions
      const { results } = await env.DB.prepare(
        `SELECT s.ticket, s.phone, c.name, c.customer_id, s.department, s.start_ts, s.end_ts
           FROM chatsessions s
           LEFT JOIN customers c ON s.phone=c.phone
          WHERE s.department='accounts' AND s.end_ts IS NULL
          ORDER BY s.start_ts DESC`
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/support-chatsessions" && request.method === "GET") {
      // all open support sessions
      const { results } = await env.DB.prepare(
        `SELECT s.ticket, s.phone, c.name, c.customer_id, s.department, s.start_ts, s.end_ts
           FROM chatsessions s
           LEFT JOIN customers c ON s.phone=c.phone
          WHERE s.department='support' AND s.end_ts IS NULL
          ORDER BY s.start_ts DESC`
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/sales-chatsessions" && request.method === "GET") {
      // all open sales sessions
      const { results } = await env.DB.prepare(
        `SELECT s.ticket, s.phone, c.name, c.customer_id, s.department, s.start_ts, s.end_ts
           FROM chatsessions s
           LEFT JOIN customers c ON s.phone=c.phone
          WHERE s.department='sales' AND s.end_ts IS NULL
          ORDER BY s.start_ts DESC`
      ).all();
      return withCORS(Response.json(results));
    }

    // --- All customers with sessions, for AllChatsPage ---
    if (url.pathname === "/api/all-customers-with-sessions" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT c.phone, c.name, c.customer_id,
          COUNT(s.id) AS session_count
        FROM customers c
        LEFT JOIN chatsessions s ON s.phone = c.phone
        GROUP BY c.phone
        ORDER BY c.name
      `).all();
      return withCORS(Response.json(results));
    }

    // --- Chat sessions for a customer ---
    if (url.pathname === "/api/chat-sessions" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      const { results } = await env.DB.prepare(
        `SELECT id, ticket, department, start_ts, end_ts
         FROM chatsessions WHERE phone = ? ORDER BY start_ts DESC`
      ).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Messages for a phone (all), filtered in frontend by session ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 500
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Send reply/message (admin action) ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Close a chat session by ticket ---
    if (url.pathname === "/api/close-session" && request.method === "POST") {
      const { ticket } = await request.json();
      if (!ticket) return withCORS(new Response("Missing ticket", { status: 400 }));
      // Close session
      await env.DB.prepare(
        `UPDATE chatsessions SET end_ts = ? WHERE ticket = ?`
      ).bind(Date.now(), ticket).run();
      // Also close all messages in that session (optional)
      // Optionally notify user handled on frontend
      return withCORS(Response.json({ ok: true }));
    }

    // --- Unlinked / Unverified clients ---
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'')  AS name,
               COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number=c.phone
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
        GROUP BY m.from_number
        ORDER BY last_msg DESC
        LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // --- Sync customers from messages (utility) ---
    if (url.pathname === "/api/customers-sync" && request.method === "POST") {
      const syncSql = `
        INSERT OR IGNORE INTO customers (phone, name, email, verified)
        SELECT DISTINCT from_number, '', '', 0
          FROM messages
         WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(syncSql).run();
      return withCORS(Response.json({ ok: true, message: "Synced." }));
    }

    // --- Fallback: Serve static HTML (dashboard SPA) ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    // --- Not found ---
    return new Response("Not found", { status: 404 });
  }
};
