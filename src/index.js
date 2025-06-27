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

    // --- WhatsApp webhook verification ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge    = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp incoming handler ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });
      const from = msgObj.from, now = Date.now();

      // 0) GLOBAL & HOLIDAY CLOSURE
      const global = await env.DB.prepare(`SELECT closed, message FROM office_global LIMIT 1`).first();
      if (global?.closed) {
        const text = global.message || "Our office is currently closed. We'll reply when we reopen.";
        await sendWhatsAppMessage(from, text, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, text, now).run();
        return Response.json({ ok: true });
      }
      const today = new Date().toISOString().slice(0,10);
      const hol = await env.DB.prepare(`SELECT 1 FROM public_holidays WHERE date = ?`).bind(today).first();
      if (hol) {
        const text = "We're closed today for a public holiday. We'll get back to you soon.";
        await sendWhatsAppMessage(from, text, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, text, now).run();
        return Response.json({ ok: true });
      }

      // 1) parse message
      let userInput = "", media_url = null, location_json = null;
      const type = msgObj.type;
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const auto = "Sorry, we can't process voice notes. Please send text or docs.";
          await sendWhatsAppMessage(from, auto, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, 'lead', ?, 'incoming', ?)`
          ).bind(from, "[Voice Note]", now, msgObj.audio.url).run();
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, auto, now).run();
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
        userInput = `[LOCATION:${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else {
        userInput = `[Unknown:${type}]`;
        if (msgObj[type]?.url) media_url = msgObj[type].url;
      }

      // 2) lookup customer
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      // 3) verified flow
      const greetings = ["hi","hello","good day","hey"];
      if (customer && customer.verified === 1) {
        const lc = userInput.toLowerCase();
        if (greetings.includes(lc)) {
          const fn = (customer.name||"").split(" ")[0]||"";
          const reply =
            `Hello ${fn}! How can we help you?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }
        let tag = null;
        if (userInput === "1") tag = "support";
        if (userInput === "2") tag = "sales";
        if (userInput === "3") tag = "accounts";
        if (tag) {
          await env.DB.prepare(
            `UPDATE messages SET tag = ? WHERE from_number = ?`
          ).bind(tag, from).run();
          const reply = `Connected with ${tag}. How can we assist further?`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, reply, tag, now).run();
          return Response.json({ ok: true });
        }
        // else drop through
      }

      // 4) unverified / new flow
      const prompt =
        "Welcome! Are you an existing Vinet client? Reply with:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "Or reply `new` to create a lead.";
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

    // --- OPEN CHATS ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) as last_message,
               SUM(CASE WHEN m.direction='incoming'
                        AND (m.seen IS NULL OR m.seen=0) THEN 1 ELSE 0 END)
                 as unread_count,
               (SELECT tag FROM messages m3
                  WHERE m3.from_number=m.from_number
                  ORDER BY m3.timestamp DESC LIMIT 1) as tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- CLOSED CHATS ---
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.closed=1
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- MESSAGES IN CHAT ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200`;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- CLOSE CHAT ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      const txt = "Your session is closed. To start a new one, just say hi.";
      await sendWhatsAppMessage(phone, txt, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, txt, Date.now()).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- ADMIN SEND MESSAGE ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone||!body) return withCORS(new Response("Missing fields", { status:400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- SET TAG MANUALLY ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number||!tag) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`)
        .bind(tag, from_number).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- UPDATE CUSTOMER / VERIFY ---
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`
        INSERT INTO customers(phone,name,customer_id,email,verified)
        VALUES(?,?,?,?,1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone,name,customer_id,email).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- AUTO-REPLIES CRUD ---
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag||!reply) return new Response("Missing fields", { status:400 });
      if (id) {
        await env.DB.prepare(
          `UPDATE auto_replies SET tag=?,hours=?,reply=? WHERE id=?`
        ).bind(tag,hours,reply,id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO auto_replies(tag,hours,reply)VALUES(?,?,?)`
        ).bind(tag,hours,reply).run();
      }
      return withCORS(Response.json({ ok:true }));
    }
    if (url.pathname === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status:400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- DEPARTMENTAL CHAT LISTS ---
    const dept = {
      "/api/support-chats":"support",
      "/api/accounts-chats":"accounts",
      "/api/sales-chats":"sales"
    }[url.pathname];
    if (dept && request.method==="GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) as last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='${dept}' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC LIMIT 200`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- UNLINKED CLIENTS ---
    if (url.pathname==="/api/unlinked-clients" && request.method==="GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'') AS name,
               COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number=c.phone
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
        GROUP BY m.from_number
        ORDER BY last_msg DESC LIMIT 200`;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch {
        return withCORS(new Response("DB error", { status:500 }));
      }
    }

    // --- SYNC CUSTOMERS ---
    if (url.pathname==="/api/customers-sync" && request.method==="POST") {
      const syncSql = `
        INSERT OR IGNORE INTO customers(phone,name,email,verified)
        SELECT DISTINCT from_number,'','',0
          FROM messages
          WHERE from_number NOT IN(SELECT phone FROM customers)`;
      await env.DB.prepare(syncSql).run();
      return withCORS(Response.json({ ok:true,message:"Synced." }));
    }

    // --- ADMIN USERS ---
    if (url.pathname==="/api/users" && request.method==="GET") {
      const { results } = await env.DB.prepare(`SELECT id,username,role FROM admins ORDER BY username`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname==="/api/add-user" && request.method==="POST") {
      const { username,password,role } = await request.json();
      if (!username||!password||!role) return withCORS(new Response("Missing fields",{status:400}));
      await env.DB.prepare(`INSERT INTO admins(username,password,role)VALUES(?,?,?)`)
        .bind(username,password,role).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (url.pathname==="/api/delete-user" && request.method==="POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id",{status:400}));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- OFFICE HOURS ---
    if (url.pathname==="/api/office-hours" && request.method==="GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname==="/api/office-hours" && request.method==="POST") {
      const { tag,day,open_time,close_time,closed } = await request.json();
      if (typeof tag!=="string"||typeof day!=="number")
        return withCORS(new Response("Missing fields",{status:400}));
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

    if (url.pathname==="/api/office-global" && request.method==="GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0]||{closed:0,message:""}));
    }
    if (url.pathname==="/api/office-global" && request.method==="POST") {
      const { closed,message } = await request.json();
      await env.DB.prepare(`UPDATE office_global SET closed=?,message=? WHERE id=1`)
        .bind(closed?1:0,message||"").run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- PUBLIC HOLIDAYS ---
    if (url.pathname==="/api/public-holidays" && request.method==="GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname==="/api/public-holidays" && request.method==="POST") {
      const { date,name } = await request.json();
      await env.DB.prepare(`INSERT INTO public_holidays(date,name)VALUES(?,?)`)
        .bind(date,name).run();
      return withCORS(Response.json({ ok:true }));
    }
    if (url.pathname==="/api/public-holidays/delete" && request.method==="POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- SYSTEM / FLOW-BUILDER ---
    // list all flows
    if (url.pathname === "/api/flows" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM flows ORDER BY id`).all();
      return withCORS(Response.json(results));
    }
    // create or update a flow
    if (url.pathname === "/api/flow" && request.method === "POST") {
      const { id,name } = await request.json();
      if (!name) return withCORS(new Response("Missing name",{status:400}));
      if (id) {
        await env.DB.prepare(`UPDATE flows SET name=? WHERE id=?`).bind(name,id).run();
      } else {
        await env.DB.prepare(`INSERT INTO flows(name)VALUES(?)`).bind(name).run();
      }
      return withCORS(Response.json({ ok:true }));
    }
    // delete a flow
    if (url.pathname === "/api/flow" && request.method === "DELETE") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id",{status:400}));
      await env.DB.prepare(`DELETE FROM flows WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }
    // list steps for a flow
    if (url.pathname === "/api/flow-steps" && request.method === "GET") {
      const flowId = url.searchParams.get("flowId");
      if (!flowId) return withCORS(new Response("Missing flowId",{status:400}));
      const { results } = await env.DB.prepare(
        `SELECT * FROM flow_steps WHERE flow_id=? ORDER BY step_index`
      ).bind(flowId).all();
      return withCORS(Response.json(results));
    }
    // create/update a step
    if (url.pathname === "/api/flow-step" && request.method === "POST") {
      const { id,flow_id,step_index,trigger,action } = await request.json();
      if (!flow_id||step_index==null||!trigger||!action)
        return withCORS(new Response("Missing fields",{status:400}));
      if (id) {
        await env.DB.prepare(
          `UPDATE flow_steps SET step_index=?,trigger=?,action=? WHERE id=?`
        ).bind(step_index,trigger,action,id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flow_steps(flow_id,step_index,trigger,action)
           VALUES(?,?,?,?)`
        ).bind(flow_id,step_index,trigger,action).run();
      }
      return withCORS(Response.json({ ok:true }));
    }
    // delete a step
    if (url.pathname === "/api/flow-step" && request.method === "DELETE") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id",{status:400}));
      await env.DB.prepare(`DELETE FROM flow_steps WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Serve static HTML ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
      }
      return new Response("Static assets missing", { status:404 });
    }

    // --- Fallback ---
    return new Response("Not found", { status:404 });
  }
};
