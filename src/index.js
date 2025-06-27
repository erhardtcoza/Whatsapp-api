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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (path === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge    = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (path === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      let   userInput     = "";
      let   media_url     = null;
      let   location_json = null;

      // --- ENFORCE OFFICE HOURS & GLOBAL CLOSURE ---
      // 1) Check global closed
      const globalRow = await env.DB.prepare(
        "SELECT closed, message FROM office_global WHERE id=1"
      ).first();
      if (globalRow?.closed) {
        const reply = globalRow.message || "Our office is currently closed.";
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, reply, now).run();
        return Response.json({ ok: true });
      }
      // 2) Public holiday?
      const today = new Date().toISOString().slice(0,10);
      const holiday = await env.DB.prepare(
        "SELECT 1 FROM public_holidays WHERE date=?"
      ).bind(today).first();
      if (holiday) {
        const reply = "Our office is closed today for a public holiday.";
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, reply, now).run();
        return Response.json({ ok: true });
      }

      // --- parse incoming message ---
      const type = msgObj.type;
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const autoReply = "Sorry, but we cannot process voice notes. Please send text or documents.";
          await sendWhatsAppMessage(from, autoReply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, 'lead', ?, 'incoming', ?)`
          ).bind(from, "[Voice Note]", now, msgObj.audio?.url).run();
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, autoReply, now).run();
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

      // --- LOOKUP LOCAL CUSTOMER ---
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      const greetingKeywords = ["hi","hello","hey","good day"];
      const lc = userInput.toLowerCase();

      // --- VERIFIED CUSTOMER FLOW ---
      if (customer && customer.verified === 1) {
        // a) greeting
        if (greetingKeywords.includes(lc)) {
          const firstName = (customer.name||"").split(" ")[0] || "";
          const intro =
            `Hello ${firstName}! How can we assist you today?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, intro, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, intro, now).run();
          return Response.json({ ok: true });
        }

        // b) department choice
        let dept = null;
        if (userInput === "1") dept = "support";
        else if (userInput === "2") dept = "sales";
        else if (userInput === "3") dept = "accounts";
        if (dept) {
          // generate session ticket: YYYYMMDD-N
          const dateKey = today.replace(/-/g,"");
          const { count } = await env.DB.prepare(
            `SELECT COUNT(*) AS count
               FROM chatsessions
               WHERE ticket LIKE ?`
          ).bind(`${dateKey}-%`).first();
          const seq = (count || 0) + 1;
          const ticket = `${dateKey}-${seq}`;

          // insert session
          await env.DB.prepare(
            `INSERT INTO chatsessions
               (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from, ticket, dept, now).run();

          const ack =
            `✅ Your ticket: *${ticket}* (Dept: ${dept}).\n` +
            `How may we help?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, ack, dept, now).run();
          return Response.json({ ok: true });
        }

        // c) normal routed message under existing session
        const reply = await routeCommand({ userInput, customer, env });
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages
             (from_number, body, tag, timestamp, direction, media_url, location_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(from, userInput, "customer", now, "incoming", media_url, location_json).run();
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
        ).bind(from, reply, now).run();
        return Response.json({ ok: true });
      }

      // --- NEW / UNVERIFIED FLOW ---
      const prompt =
        "Welcome! Are you an existing Vinet client? If yes, reply:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "If not, reply `new` and we’ll treat you as a lead.";
      await sendWhatsAppMessage(from, prompt, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      ).bind(from, prompt, now).run();
      return Response.json({ ok: true });
    }

    // --- REST API ENDPOINTS ---

    // chats (open)
    if (path === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
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

    // chats (closed)
    if (path === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
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

    // messages for chat
    if (path === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
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

    // close chat
    if (path === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      // auto-notify user
      const note = "This chat has been closed. Reply 'hi' to start a new session.";
      await sendWhatsAppMessage(phone, note, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, note, now).run();
      return withCORS(Response.json({ ok:true }));
    }

    // send admin reply
    if (path === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone||!body) return withCORS(new Response("Missing fields", { status:400 }));
      await sendWhatsAppMessage(phone, body, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, now).run();
      return withCORS(Response.json({ ok:true }));
    }

    // set tag
    if (path === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number||!tag) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok:true }));
    }

    // update customer & mark verified
    if (path === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone, name, customer_id, email, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone,name,customer_id,email).run();
      return withCORS(Response.json({ ok:true }));
    }

    // auto-replies
    if (path === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return Response.json(results);
    }
    if (path === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag||!reply) return new Response("Missing fields", { status:400 });
      if (id) {
        await env.DB.prepare(
          `UPDATE auto_replies SET tag=?,hours=?,reply=? WHERE id=?`
        ).bind(tag,hours,reply,id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO auto_replies (tag,hours,reply) VALUES(?,?,?)`
        ).bind(tag,hours,reply).run();
      }
      return Response.json({ ok:true });
    }
    if (path === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status:400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return Response.json({ ok:true });
    }

    // departmental chat lists
    if (path === "/api/support-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,c.name,c.email,c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='support' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/accounts-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,c.name,c.email,c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='accounts' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/sales-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,c.name,c.email,c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='sales' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // unlinked / unverified
    if (path === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'') AS name,
               COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number=c.phone
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
        GROUP BY m.from_number ORDER BY last_msg DESC LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch {
        return withCORS(new Response("DB error", { status:500 }));
      }
    }

    // sync customers
    if (path === "/api/customers-sync" && request.method === "POST") {
      const syncSql = `
        INSERT OR IGNORE INTO customers (phone,name,email,verified)
        SELECT DISTINCT from_number,'','',0 FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(syncSql).run();
      return withCORS(Response.json({ ok:true, message:"Synced" }));
    }

    // admins
    if (path === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT id,username,role FROM admins ORDER BY username`).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/add-user" && request.method === "POST") {
      const { username,password,role } = await request.json();
      if (!username||!password||!role) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`INSERT INTO admins (username,password,role) VALUES(?,?,?)`)
        .bind(username,password,role).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (path === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // office hours
    if (path === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/office-hours" && request.method === "POST") {
      const { tag,day,open_time,close_time,closed } = await request.json();
      if (typeof tag!=="string"||typeof day!=="number") {
        return withCORS(new Response("Missing fields", { status:400 }));
      }
      await env.DB.prepare(`
        INSERT INTO office_hours (tag,day,open_time,close_time,closed)
        VALUES(?,?,?,?,?)
        ON CONFLICT(tag,day) DO UPDATE SET
          open_time=excluded.open_time,
          close_time=excluded.close_time,
          closed=excluded.closed
      `).bind(tag,day,open_time,close_time,closed?1:0).run();
      return withCORS(Response.json({ ok:true }));
    }

    // global
    if (path === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0]||{ closed:0,message:"" }));
    }
    if (path === "/api/office-global" && request.method === "POST") {
      const { closed,message } = await request.json();
      await env.DB.prepare(`UPDATE office_global SET closed=?,message=? WHERE id=1`)
        .bind(closed?1:0,message||"").run();
      return withCORS(Response.json({ ok:true }));
    }

    // public holidays
    if (path === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/public-holidays" && request.method === "POST") {
      const { date,name } = await request.json();
      await env.DB.prepare(`INSERT INTO public_holidays (date,name) VALUES(?,?)`)
        .bind(date,name).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (path === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // departmental SESSIONS lists
    if (path === "/api/accounts-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT cs.ticket,cs.phone,cs.department,cs.start_ts,cs.end_ts,cs.closed_by,
               c.name,c.customer_id
        FROM chatsessions cs
        LEFT JOIN customers c ON c.phone=cs.phone
        WHERE cs.department='accounts' AND cs.end_ts IS NULL
        ORDER BY cs.start_ts DESC
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/sales-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT cs.ticket,cs.phone,cs.department,cs.start_ts,cs.end_ts,cs.closed_by,
               c.name,c.customer_id
        FROM chatsessions cs
        LEFT JOIN customers c ON c.phone=cs.phone
        WHERE cs.department='sales' AND cs.end_ts IS NULL
        ORDER BY cs.start_ts DESC
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/support-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT cs.ticket,cs.phone,cs.department,cs.start_ts,cs.end_ts,cs.closed_by,
               c.name,c.customer_id
        FROM chatsessions cs
        LEFT JOIN customers c ON c.phone=cs.phone
        WHERE cs.department='support' AND cs.end_ts IS NULL
        ORDER BY cs.start_ts DESC
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // close a session
    if (path === "/api/close-session" && request.method === "POST") {
      const { ticket, closed_by } = await request.json();
      if (!ticket) return withCORS(new Response("Missing ticket", { status:400 }));
      await env.DB.prepare(
        `UPDATE chatsessions SET end_ts=?, closed_by=? WHERE ticket=?`
      ).bind(now, closed_by||"admin", ticket).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Serve static HTML/dashboard ---
    if (path === "/" || path === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
      }
      return new Response("Dashboard assets missing", { status:404 });
    }

    // --- Fallback ---
    return new Response("Not found", { status:404 });
  }
};
