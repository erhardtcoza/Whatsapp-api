// src/index.js

import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    //
    // --- WhatsApp Webhook ---
    //

    // GET verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // POST incoming message
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now  = Date.now();
      let userInput     = "";
      let media_url     = null;
      let location_json = null;

      // parse type
      switch (msgObj.type) {
        case "text":
          userInput = msgObj.text.body.trim();
          break;
        case "image":
          userInput = "[Image]";
          media_url = msgObj.image?.url || null;
          break;
        case "audio":
          if (msgObj.audio?.voice) {
            const autoReply = "Sorry, we cannot process voice notes. Please send text or documents.";
            await sendWhatsAppMessage(from, autoReply, env);
            // record voice note then autoReply
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
               VALUES (?, ?, 'lead', ?, 'incoming', ?)`
            ).bind(from, "[Voice Note]", now, msgObj.audio.url).run();
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(from, autoReply, now).run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO customers (phone,name,email,verified)
               VALUES (?, '', '', 0)`
            ).bind(from).run();
            return Response.json({ ok: true });
          } else {
            userInput = "[Audio]";
            media_url  = msgObj.audio?.url || null;
          }
          break;
        case "document":
          userInput = "[Document]";
          media_url  = msgObj.document?.url || null;
          break;
        case "location":
          userInput     = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
          location_json = JSON.stringify(msgObj.location);
          break;
        default:
          userInput = `[Unknown: ${msgObj.type}]`;
          if (msgObj[msgObj.type]?.url) media_url = msgObj[msgObj.type].url;
      }

      // look up in customers table
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone=?`)
        .bind(from)
        .first();

      // greetings
      const greetings = ["hi","hello","hey","good day"];
      const lc = userInput.toLowerCase();

      // VERIFIED customer flow
      if (customer && customer.verified === 1) {
        if (greetings.includes(lc)) {
          const first = (customer.name||"").split(" ")[0] || "";
          const reply =
            `Hello ${first}! How can we help you today?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number,body,tag,timestamp,direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }
        // department selection
        let tag = null;
        if (userInput === "1") tag = "support";
        if (userInput === "2") tag = "sales";
        if (userInput === "3") tag = "accounts";
        if (tag) {
          await env.DB.prepare(
            `UPDATE messages SET tag=? WHERE from_number=?`
          ).bind(tag, from).run();
          const rep = `You've been connected with ${tag}. How may we assist?`;
          await sendWhatsAppMessage(from, rep, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number,body,tag,timestamp,direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, rep, tag, now).run();
          return Response.json({ ok: true });
        }
        // else fall through to routing
      }

      // NEW / UNVERIFIED flow
      const prompt =
        "Welcome! Are you an existing Vinet client? If yes, reply with:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "If not, reply with `new` and we’ll treat you as a lead.";
      await sendWhatsAppMessage(from, prompt, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone,name,email,verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number,body,tag,timestamp,direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      ).bind(from, prompt, now).run();
      return Response.json({ ok: true });
    }

    //
    // --- Dashboard / API ---
    //

    // List open chats
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

    // List closed chats
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

    // List messages in a chat
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

    // Close chat & auto-notify
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      const note = "This chat has been closed. To start a new one, just say hi.";
      await sendWhatsAppMessage(phone, note, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number,body,tag,timestamp,direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, note, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Admin sends a reply
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number,body,tag,timestamp,direction,seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    // List customers for Send-Message UI
    if (url.pathname === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT phone, name FROM customers ORDER BY name`
      ).all();
      return withCORS(Response.json(results));
    }

    // Set tag manually
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Update customer & mark verified
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone,name,customer_id,email,verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Auto-Replies CRUD
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

    // Department-specific chat lists
    if (url.pathname === "/api/support-chats" && request.method === "GET") {
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
    if (url.pathname === "/api/accounts-chats" && request.method === "GET") {
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
    if (url.pathname === "/api/sales-chats" && request.method === "GET") {
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

    // Unlinked / unverified clients
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'') AS name,
               COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
        GROUP BY m.from_number ORDER BY last_msg DESC LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // Sync customers table from messages
    if (url.pathname === "/api/customers-sync" && request.method === "POST") {
      const sync = `
        INSERT OR IGNORE INTO customers (phone,name,email,verified)
        SELECT DISTINCT from_number,'','',0 FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(sync).run();
      return withCORS(Response.json({ ok: true, message: "Customers synced." }));
    }

    // Admin user management
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT id,username,role FROM admins ORDER BY username`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username,password,role } = await request.json();
      if (!username||!password||!role) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`INSERT INTO admins (username,password,role) VALUES(?,?,?)`)
        .bind(username,password,role).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id", { status:400 }));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Office hours
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag,day,open_time,close_time,closed } = await request.json();
      if (typeof tag!=="string"||typeof day!=="number") {
        return withCORS(new Response("Missing fields", { status:400 }));
      }
      await env.DB.prepare(`
        INSERT INTO office_hours (tag,day,open_time,close_time,closed)
        VALUES (?,?,?,?,?)
        ON CONFLICT(tag,day) DO UPDATE SET
          open_time=excluded.open_time,
          close_time=excluded.close_time,
          closed=excluded.closed
      `).bind(tag,day,open_time,close_time, closed?1:0).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Global office status
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0]||{ closed:0,message:"" }));
    }
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed,message } = await request.json();
      await env.DB.prepare(`UPDATE office_global SET closed=?,message=? WHERE id=1`)
        .bind(closed?1:0,message||"").run();
      return withCORS(Response.json({ ok: true }));
    }

    // Public holidays
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date,name } = await request.json();
      await env.DB.prepare(`INSERT INTO public_holidays (date,name) VALUES(?,?)`).bind(date,name).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // --- Flow-Builder CRUD ---
    //

    // List flows
    if (url.pathname === "/api/flows" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT id,name FROM flows ORDER BY name`).all();
      return withCORS(Response.json(results));
    }
    // Create or update flow
    if (url.pathname === "/api/flow" && request.method === "POST") {
      const { id,name } = await request.json();
      if (!name) return withCORS(new Response("Missing name", { status:400 }));
      if (id) {
        await env.DB.prepare(`UPDATE flows SET name=? WHERE id=?`).bind(name,id).run();
      } else {
        await env.DB.prepare(`INSERT INTO flows (name) VALUES(?)`).bind(name).run();
      }
      return withCORS(Response.json({ ok:true }));
    }
    // Delete flow
    if (url.pathname === "/api/flow-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM flows WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // List steps for a flow
    if (url.pathname.match(/^\/api\/flows\/\d+\/steps$/) && request.method === "GET") {
      const flowId = Number(url.pathname.split("/")[3]);
      const { results } = await env.DB.prepare(
        `SELECT id,condition,response FROM flow_steps WHERE flow_id=? ORDER BY id`
      ).bind(flowId).all();
      return withCORS(Response.json(results));
    }
    // Create or update a step
    if (url.pathname === "/api/flow-step" && request.method === "POST") {
      const { id,flow_id,condition,response } = await request.json();
      if (!flow_id||!condition||!response) {
        return withCORS(new Response("Missing fields", { status:400 }));
      }
      if (id) {
        await env.DB.prepare(
          `UPDATE flow_steps SET condition=?,response=? WHERE id=?`
        ).bind(condition,response,id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flow_steps (flow_id,condition,response) VALUES(?,?,?)`
        ).bind(flow_id,condition,response).run();
      }
      return withCORS(Response.json({ ok:true }));
    }
    // Delete a step
    if (url.pathname === "/api/flow-step-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM flow_steps WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    //
    // --- Serve dashboard UI ---
    //

    if ((url.pathname === "/" || url.pathname === "/index.html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
    }

    return new Response("Not found", { status: 404 });
  }
};
