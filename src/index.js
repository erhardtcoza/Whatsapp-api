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
      let customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      // Check if in onboarding flow (store onboarding status in KV or DB as needed)
      // Simple in-memory status: Replace this with a KV lookup for persistent state
      let state = null;
      try {
        let st = await env.DB.prepare(`SELECT * FROM onboarding WHERE phone = ?`).bind(from).first();
        state = st?.step || null;
      } catch { state = null; }

      // --- Onboarding and lead flow (simple, no address in customers) ---
      if (!customer || customer.verified !== 1) {
        if (!state) {
          // Start onboarding
          await env.DB.prepare(`INSERT OR IGNORE INTO onboarding (phone, step) VALUES (?, 'init')`).bind(from).run();
          const prompt =
            "Welcome. We want to assist you as effectively and quickly as possible, but we need your information first. Please reply only with the options provided.\nAre you currently a Vinet client? Yes / No";
          await sendWhatsAppMessage(from, prompt, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'system', ?, 'outgoing')`
          ).bind(from, prompt, now).run();
          return Response.json({ ok: true });
        }

        // Waiting for Yes/No reply
        if (state === "init") {
          const ans = userInput.trim().toLowerCase();
          if (ans === "yes") {
            await env.DB.prepare(`UPDATE onboarding SET step = 'ask_client_details' WHERE phone = ?`).bind(from).run();
            const msg = "Please reply with your Client Code, First and Last Name, and Email address, separated by commas.\nExample: 123456, John Doe, john@example.com";
            await sendWhatsAppMessage(from, msg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          } else if (ans === "no") {
            await env.DB.prepare(`UPDATE onboarding SET step = 'ask_lead_details' WHERE phone = ?`).bind(from).run();
            const msg = "Thank you for showing interest in our service, please provide us with your First and Last name, email address and address, separated by commas.";
            await sendWhatsAppMessage(from, msg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          } else {
            const msg = "Please reply only with Yes or No.";
            await sendWhatsAppMessage(from, msg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          }
        }

        // Onboarding: waiting for client details (yes)
        if (state === "ask_client_details") {
          // Example: 123456, John Doe, john@example.com
          const parts = userInput.split(",");
          if (parts.length < 3) {
            const msg = "Please provide your Client Code, Full Name, and Email address, separated by commas.";
            await sendWhatsAppMessage(from, msg, env);
            return Response.json({ ok: true });
          }
          const [customer_id, name, email] = parts.map(x => x.trim());
          // Add to unverified
          await env.DB.prepare(
            `INSERT INTO customers (phone, customer_id, name, email, verified)
             VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(phone) DO UPDATE SET customer_id=?, name=?, email=?`
          ).bind(from, customer_id, name, email, customer_id, name, email).run();
          // Mark onboarding as waiting for admin verify
          await env.DB.prepare(`UPDATE onboarding SET step = 'wait_verify' WHERE phone = ?`).bind(from).run();
          const msg = "Thank you. Your details have been received and are pending verification by our agents.";
          await sendWhatsAppMessage(from, msg, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'system', ?, 'outgoing')`
          ).bind(from, msg, now).run();
          return Response.json({ ok: true });
        }

        // Onboarding: waiting for lead details (no)
        if (state === "ask_lead_details") {
          // Example: John Doe, john@example.com, 5 Main Street
          const parts = userInput.split(",");
          if (parts.length < 3) {
            const msg = "Please provide your Full Name, Email, and Address, separated by commas.";
            await sendWhatsAppMessage(from, msg, env);
            return Response.json({ ok: true });
          }
          const [name, email, address] = parts.map(x => x.trim());
          await env.DB.prepare(
            `INSERT INTO leads (phone, name, email, address, status, created_at)
             VALUES (?, ?, ?, ?, 'new', ?)`
          ).bind(from, name, email, address, now).run();
          await env.DB.prepare(`DELETE FROM onboarding WHERE phone = ?`).bind(from).run();
          const msg = "Thank you, our sales team will be in contact with you shortly.";
          await sendWhatsAppMessage(from, msg, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, msg, now).run();
          return Response.json({ ok: true });
        }

        // Waiting for verification by admin: only check if admin has verified
        if (state === "wait_verify") {
          customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone = ?`).bind(from).first();
          if (customer && customer.verified === 1) {
            await env.DB.prepare(`DELETE FROM onboarding WHERE phone = ?`).bind(from).run();
            const msg = `Hi, our agents have successfully verified your details. How can we help you?\n1. Support\n2. Sales\n3. Accounts`;
            await sendWhatsAppMessage(from, msg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          }
          // Otherwise, just ignore or say "waiting for verification"
          const msg = "Your details are pending verification. Please wait for an agent.";
          await sendWhatsAppMessage(from, msg, env);
          return Response.json({ ok: true });
        }
      }

      // --- VERIFIED CUSTOMER FLOW ---
      if (customer && customer.verified === 1) {
        // Main menu after verification or onboarding
        const greetings = ["hi","hello","hey","good day"];
        const lc = userInput.toLowerCase();
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

        // Department choice
        let deptTag = null;
        if (userInput === "1") deptTag = "support";
        else if (userInput === "2") deptTag = "sales";
        else if (userInput === "3") deptTag = "accounts";

        if (deptTag) {
          // create a date-based ticket: YYYYMMDDxxx
          const today = new Date();
          const yyyymmdd = today.toISOString().slice(0,10).replace(/-/g,"");
          const dayStart = Date.parse(today.toISOString().slice(0,10) + "T00:00:00Z");
          const dayEnd   = Date.parse(today.toISOString().slice(0,10) + "T23:59:59Z");
          const { count=0 } = await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM chatsessions WHERE start_ts BETWEEN ? AND ?`
          ).bind(dayStart, dayEnd).first();
          const session_id = `${yyyymmdd}${String(count+1).padStart(3,'0')}`;
          await env.DB.prepare(
            `INSERT INTO chatsessions (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from, session_id, deptTag, now).run();
          const ack = `Thank you, we have created a chat session with our ${deptTag} department: Your ref is ${session_id}, please reply with your message.`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, ack, deptTag, now).run();
          return Response.json({ ok: true });
        }

        // (Commented out) - Auto replies after department selection
        // const reply = await routeCommand({ userInput, customer, env });
        // await sendWhatsAppMessage(from, reply, env);
        // await env.DB.prepare(
        //   `INSERT INTO messages (from_number, body, tag, timestamp, direction)
        //    VALUES (?, ?, ?, ?, 'outgoing')`
        // ).bind(from, reply, customer.tag||'customer', now).run();
        // return Response.json({ ok: true });

        // Just echo for now
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'customer', ?, 'incoming')`
        ).bind(from, userInput, now).run();
        return Response.json({ ok: true });
      }

      // --- fallback ---
      return Response.json({ ok: true });
    }

    // --- API: List open chats ---
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

    // --- API: List closed chats ---
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

    // --- API: List messages in a chat ---
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

    // --- API: Close a chat ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      // mark closed
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`)
        .bind(phone).run();
      // auto-notify the client
      const notice = "This session has been closed. To start a new chat, just say ‘hi’ again.";
      await sendWhatsAppMessage(phone, notice, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, notice, Date.now()).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Admin sends a reply ---
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

    // --- API: Set a message/chat tag manually ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`)
        .bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Update customer & mark verified ---
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

    // --- API: GET customers (for Send Message page) ---
    if (url.pathname === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT phone, name, customer_id, email
           FROM customers
          ORDER BY name`
      ).all();
      return withCORS(Response.json(results));
    }

    // GET /api/chat-sessions?phone=…
    if (url.pathname === "/api/chat-sessions" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      const { results } = await env.DB.prepare(
        `SELECT id, ticket, department, start_ts, end_ts
           FROM chatsessions WHERE phone = ? ORDER BY start_ts DESC`
      ).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- API: List leads ---
if (url.pathname === "/api/leads" && request.method === "GET") {
  const { results } = await env.DB.prepare(
    `SELECT * FROM leads ORDER BY created_at DESC LIMIT 200`
  ).all();
  return withCORS(Response.json(results));
}

    if (url.pathname === "/api/lead-contacted" && request.method === "POST") {
  const { id } = await request.json();
  if (!id) return withCORS(new Response("Missing id", { status: 400 }));
  await env.DB.prepare(`UPDATE leads SET status='contacted' WHERE id=?`).bind(id).run();
  return withCORS(Response.json({ ok: true }));
}

    
    // --- API: Auto-Replies CRUD ---
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
    if (url.pathname === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status: 400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return Response.json({ ok: true });
    }

    // --- API: Departmental chat lists ---
    if (url.pathname === "/api/support-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
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
               MAX(m.timestamp) AS last_ts,
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
               MAX(m.timestamp) AS last_ts,
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

    // --- API: Unlinked / Unverified clients ---
   if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
  const sql = `
    SELECT
      c.phone,
      c.name,
      c.email,
      c.customer_id,
      c.verified
    FROM customers c
    WHERE c.verified = 0
    ORDER BY c.phone DESC
    LIMIT 200
  `;
  const { results } = await env.DB.prepare(sql).all();
  return withCORS(Response.json(results));
}

    // --- API: Sync customers from messages ---
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

    // --- API: Admin users (admins table) ---
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

    // --- API: Office hours ---
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

    // --- API: Global office open/close ---
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

    // --- API: Public holidays ---
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

    // --- API: Flows CRUD ---
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

    // --- API: Flow-Steps CRUD ---
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

    // --- Serve static HTML (dashboard SPA) ---
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
