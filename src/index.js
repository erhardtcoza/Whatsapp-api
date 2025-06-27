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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // --- Handle CORS preflight for any /api/ endpoint ---
    if (method === "OPTIONS" && pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (pathname === "/webhook" && method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge    = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (pathname === "/webhook" && method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now  = Date.now();
      let   userInput     = "";
      let   media_url     = null;
      let   location_json = null;

      // --- parse incoming message ---
      const type = msgObj.type;
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const autoReply = "Sorry, voice notes aren’t supported. Please send text or a document.";
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

      // --- lookup customer in local table ---
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      const greetingKeywords = ["hi","hello","hey","good day"];
      const lc = userInput.toLowerCase();

      // --- VERIFIED CUSTOMER FLOW ---
      if (customer && customer.verified === 1) {
        if (greetingKeywords.includes(lc)) {
          const firstName = (customer.name||"").split(" ")[0]||"";
          const reply =
            `Hello ${firstName}! How can we help today?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        // department selection
        let tag = null;
        if (userInput === "1") tag = "support";
        else if (userInput === "2") tag = "sales";
        else if (userInput === "3") tag = "accounts";

        if (tag) {
          await env.DB.prepare(
            `UPDATE messages SET tag=? WHERE from_number=?`
          ).bind(tag, from).run();
          const ack = `Connected to ${tag}. How may we assist?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, ack, tag, now).run();
          return Response.json({ ok: true });
        }
        // otherwise continue to normal routing...
      }

      // --- NEW / UNVERIFIED FLOW ---
      const prompt =
        "Welcome! Are you an existing Vinet client?\n" +
        "If yes, reply: First Last, you@example.com, CustomerID\n" +
        "If not, reply: new";
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

    // --- Flows: list all ---
    if (pathname === "/api/flows" && method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM flows ORDER BY name`).all();
      return withCORS(Response.json(results));
    }

    // --- Flows: create new ---
    if (pathname === "/api/flow" && method === "POST") {
      const { name } = await request.json();
      if (!name) return withCORS(new Response("Missing name", { status: 400 }));
      await env.DB.prepare(`INSERT INTO flows (name) VALUES (?)`).bind(name).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Flows: delete one ---
    {
      const m = pathname.match(/^\/api\/flow\/(\d+)$/);
      if (m && method === "DELETE") {
        const id = m[1];
        await env.DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(id).run();
        await env.DB.prepare(`DELETE FROM steps WHERE flow_id = ?`).bind(id).run();
        return withCORS(Response.json({ ok: true }));
      }
    }

    // --- Steps: list for a flow ---
    {
      const m = pathname.match(/^\/api\/flows\/(\d+)\/steps$/);
      if (m && method === "GET") {
        const flow_id = m[1];
        const { results } = await env.DB
          .prepare(`SELECT * FROM steps WHERE flow_id = ? ORDER BY id`)
          .bind(flow_id)
          .all();
        return withCORS(Response.json(results));
      }
    }

    // --- Steps: upsert all for a flow ---
    {
      const m = pathname.match(/^\/api\/flows\/(\d+)\/steps$/);
      if (m && method === "POST") {
        const flow_id = m[1];
        const steps = await request.json();  // array of {id?,flow_id,condition,response}
        // clear out then re-insert
        await env.DB.prepare(`DELETE FROM steps WHERE flow_id = ?`).bind(flow_id).run();
        const stmt = await env.DB.prepare(
          `INSERT INTO steps (flow_id, condition, response) VALUES (?, ?, ?)`
        );
        for (let s of steps) {
          await stmt.bind(flow_id, s.condition||"", s.response||"").run();
        }
        return withCORS(Response.json({ ok: true }));
      }
    }

    // --- List open chats ---
    if (pathname === "/api/chats" && method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
               SUM(CASE WHEN m.direction='incoming' AND (m.seen IS NULL OR m.seen=0)
                   THEN 1 ELSE 0 END) AS unread_count,
               (SELECT tag FROM messages m3
                  WHERE m3.from_number=m.from_number
                  ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.closed IS NULL OR m.closed=0
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List closed chats ---
    if (pathname === "/api/closed-chats" && method === "GET") {
      const { results } = await env.DB.prepare(`
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
      `).all();
      return withCORS(Response.json(results));
    }

    // --- List messages in a chat ---
    if (pathname === "/api/messages" && method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const { results } = await env.DB.prepare(`
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number = ?
        ORDER BY timestamp ASC
        LIMIT 200
      `).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Close a chat ---
    if (pathname === "/api/close-chat" && method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const now = Date.now();
      // mark closed
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      // inform client
      const note = "Your chat has been closed. To start again, just say Hi.";
      await sendWhatsAppMessage(phone, note, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, note, now).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Admin sends a reply ---
    if (pathname === "/api/send-message" && method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Set tag manually ---
    if (pathname === "/api/set-tag" && method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Update customer & verify ---
    if (pathname === "/api/update-customer" && method === "POST") {
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

    // --- Auto-replies CRUD ---
    if (pathname === "/api/auto-replies" && method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/auto-reply" && method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag || !reply) return new Response("Missing fields", { status: 400 });
      if (id) {
        await env.DB.prepare(`UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`)
          .bind(tag, hours, reply, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)`)
          .bind(tag, hours, reply).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (pathname === "/api/auto-reply-delete" && method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status: 400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Departmental chat lists ---
    if (pathname === "/api/support-chats" && method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='support' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/accounts-chats" && method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='accounts' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/sales-chats" && method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2 WHERE m2.from_number=m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='sales' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number ORDER BY last_ts DESC LIMIT 200
      `).all();
      return withCORS(Response.json(results));
    }

    // --- Unlinked / unverified clients list ---
    if (pathname === "/api/unlinked-clients" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(`
          SELECT m.from_number,
                 MAX(m.timestamp) AS last_msg,
                 COALESCE(c.name,'') AS name,
                 COALESCE(c.email,'') AS email
          FROM messages m
          LEFT JOIN customers c ON c.phone=m.from_number
          WHERE m.tag='unverified'
            AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
          GROUP BY m.from_number
          ORDER BY last_msg DESC
          LIMIT 200
        `).all();
        return withCORS(Response.json(results));
      } catch(e) {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // --- Sync customers from messages ---
    if (pathname === "/api/customers-sync" && method === "POST") {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO customers (phone,name,email,verified)
        SELECT DISTINCT from_number,'','',0 FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `).run();
      return withCORS(Response.json({ ok: true, message: "Synced" }));
    }

    // --- Admins (users) management ---
    if (pathname === "/api/users" && method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, username, role FROM admins ORDER BY username`
      ).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/add-user" && method === "POST") {
      const { username, password, role } = await request.json();
      if (!username||!password||!role) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`INSERT INTO admins(username,password,role) VALUES(?,?,?)`)
        .bind(username,password,role).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (pathname === "/api/delete-user" && method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id", { status:400 }));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Office hours endpoints ---
    if (pathname === "/api/office-hours" && method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/office-hours" && method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag!=="string"||typeof day!=="number") {
        return withCORS(new Response("Missing fields", { status:400 }));
      }
      await env.DB.prepare(`
        INSERT INTO office_hours(tag,day,open_time,close_time,closed)
        VALUES(?,?,?,?,?)
        ON CONFLICT(tag,day) DO UPDATE SET
          open_time=excluded.open_time,
          close_time=excluded.close_time,
          closed=excluded.closed
      `).bind(tag,day,open_time,close_time,closed?1:0).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Global office status ---
    if (pathname === "/api/office-global" && method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0]||{ closed:0,message:"" }));
    }
    if (pathname === "/api/office-global" && method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(`UPDATE office_global SET closed=?,message=? WHERE id=1`)
        .bind(closed?1:0,message||"").run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Public holidays endpoints ---
    if (pathname === "/api/public-holidays" && method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (pathname === "/api/public-holidays" && method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(`INSERT INTO public_holidays(date,name) VALUES(?,?)`)
        .bind(date,name).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (pathname === "/api/public-holidays/delete" && method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }
  // --- Flow builder: list all flows ---
  if (url.pathname === "/api/flows" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM flows ORDER BY id`
    ).all();
    return withCORS(Response.json(results));
  }

  // --- Flow builder: create a new flow ---
  if (url.pathname === "/api/flow" && request.method === "POST") {
    const { name } = await request.json();
    if (!name) return withCORS(new Response("Missing name", { status: 400 }));
    const insert = await env.DB.prepare(
      `INSERT INTO flows (name) VALUES (?)`
    ).bind(name).run();
    // run() returns lastInsertRowid
    return withCORS(
      Response.json({ id: insert.lastInsertRowid, name })
    );
  }

  // --- Flow builder: delete a flow and its steps ---
  if (url.pathname.startsWith("/api/flow/") && request.method === "DELETE") {
    const flowId = Number(url.pathname.split("/").pop());
    if (!flowId) return withCORS(new Response("Bad flow id", { status: 400 }));
    // delete the flow
    await env.DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(flowId).run();
    // cascade‐delete its steps
    await env.DB.prepare(`DELETE FROM flow_steps WHERE flow_id = ?`).bind(flowId).run();
    return withCORS(Response.json({ ok: true }));
  }

  // --- Flow builder: get steps for a flow ---
  if (
    url.pathname.match(/^\/api\/flows\/\d+\/steps$/) &&
    request.method === "GET"
  ) {
    const flowId = Number(url.pathname.split("/")[2]);
    const { results } = await env.DB.prepare(
      `SELECT id, flow_id, condition, response
         FROM flow_steps
        WHERE flow_id = ?
        ORDER BY id`
    )
      .bind(flowId)
      .all();
    return withCORS(Response.json(results));
  }

  // --- Flow builder: save (replace) all steps for a flow ---
  if (
    url.pathname.match(/^\/api\/flows\/\d+\/steps$/) &&
    request.method === "POST"
  ) {
    const flowId = Number(url.pathname.split("/")[2]);
    const newSteps = await request.json(); // expect array of { condition, response }
    // wipe out existing
    await env.DB.prepare(`DELETE FROM flow_steps WHERE flow_id = ?`)
      .bind(flowId)
      .run();
    // insert each in order
    for (const step of newSteps) {
      await env.DB.prepare(
        `INSERT INTO flow_steps (flow_id, condition, response)
           VALUES (?, ?, ?)`
      )
        .bind(flowId, step.condition, step.response)
        .run();
    }
    return withCORS(Response.json({ ok: true }));
  }

    
    // --- Serve dashboard static HTML ---
    if (pathname === "/" || pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
      }
      return new Response("Missing static assets", { status: 404 });
    }

    // --- Fallback ---
    return new Response("Not found", { status: 404 });
  }
};
