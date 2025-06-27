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
    const url  = new URL(request.url);
    const path = url.pathname;
    const now  = Date.now();

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification ---
    if (path === "/webhook" && request.method === "GET") {
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler ---
    if (path === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      let   userInput     = "";
      let   media_url     = null;
      let   location_json = null;

      // 1️⃣ Global Closure?
      const g = await env.DB.prepare("SELECT closed, message FROM office_global WHERE id=1").first();
      if (g?.closed) {
        const note = g.message || "Our office is closed.";
        await sendWhatsAppMessage(from, note, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, note, now).run();
        return Response.json({ ok: true });
      }

      // 2️⃣ Public Holiday?
      const today = new Date().toISOString().slice(0,10);
      const ph    = await env.DB.prepare(
        "SELECT 1 FROM public_holidays WHERE date=?"
      ).bind(today).first();
      if (ph) {
        const note = "Closed today (public holiday).";
        await sendWhatsAppMessage(from, note, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, note, now).run();
        return Response.json({ ok: true });
      }

      // parse incoming content
      const type = msgObj.type;
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url ?? null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const ar = "Sorry, we can’t process voice notes. Please send text.";
          await sendWhatsAppMessage(from, ar, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, ar, now).run();
          return Response.json({ ok: true });
        }
        userInput = "[Audio]";
        media_url = msgObj.audio?.url ?? null;
      } else if (type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url ?? null;
      } else if (type === "location") {
        userInput     = `[LOC:${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else {
        userInput = `[${type.toUpperCase()}]`;
        media_url = msgObj[type]?.url ?? null;
      }

      // look up in our customers table
      const customer = await env.DB
        .prepare("SELECT * FROM customers WHERE phone = ?")
        .bind(from)
        .first();

      const greetings = ["hi","hello","hey","good day"];
      const lc = userInput.toLowerCase();

      // ✅ VERIFIED FLOW
      if (customer && customer.verified === 1) {
        if (greetings.includes(lc)) {
          const fn = (customer.name||"").split(" ")[0] || "";
          const menu =
            `Hello ${fn}! How can we help you?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, menu, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          ).bind(from, menu, now).run();
          return Response.json({ ok: true });
        }
        // department choice
        let dept = null;
        if (userInput==="1") dept="support";
        if (userInput==="2") dept="sales";
        if (userInput==="3") dept="accounts";
        if (dept) {
          // start a new session ticket
          const dk   = today.replace(/-/g,"");
          const cntR = await env.DB.prepare(
            `SELECT COUNT(*) AS c FROM chatsessions WHERE ticket LIKE ?`
          ).bind(`${dk}-%`).first();
          const seq    = (cntR.c||0) + 1;
          const ticket = `${dk}-${seq}`;
          await env.DB.prepare(
            `INSERT INTO chatsessions (phone,ticket,department,start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from,ticket,dept,now).run();
          const ack =
            `✅ Ticket *${ticket}* (${dept}). How may we assist?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, ack, dept, now).run();
          return Response.json({ ok: true });
        }
        // otherwise route within existing session
        await env.DB.prepare(
          `INSERT INTO messages
             (from_number, body, tag, timestamp, direction, media_url, location_json)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(from,userInput,"customer",now,"incoming",media_url,location_json).run();
        const reply = await routeCommand({ userInput, customer, env });
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?,?,?,?, 'outgoing')`
        ).bind(from, reply, "customer", now).run();
        return Response.json({ ok: true });
      }

      // 🔒 UNVERIFIED FLOW
      const prompt =
        "Existing Vinet client? Reply:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "Else reply `new` → we'll treat you as lead.";
      await sendWhatsAppMessage(from, prompt, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone,name,email,verified)
         VALUES(?, '', '', 0)`
      ).bind(from).run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      ).bind(from, prompt, now).run();
      return Response.json({ ok: true });
    }

    // ------------------------------------------------------------
    //                            DASHBOARD API
    // ------------------------------------------------------------

    // — Customers for Send Message page
    if (path === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT phone, customer_id, name
        FROM customers ORDER BY customer_id
      `).all();
      return withCORS(Response.json(results));
    }

    // — Admin -> send a message
    if (path === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      ).bind(phone, body, now).run();
      return withCORS(Response.json({ ok: true }));
    }

    // — Chat lists (open/closed) —
    if (path === "/api/chats" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
               SUM(CASE WHEN m.direction='incoming' AND (m.seen=0 OR m.seen IS NULL)
                        THEN 1 ELSE 0 END) AS unread_count,
               (SELECT tag FROM messages m3
                  WHERE m3.from_number=m.from_number
                  ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE (m.closed=0 OR m.closed IS NULL)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/closed-chats" && request.method === "GET") {
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

    // — Messages within a chat —
    if (path === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      const { results } = await env.DB.prepare(`
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200
      `).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // — Close chat + notify user —
    if (path === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      const note = "This chat has been closed. Say 'hi' to start again.";
      await sendWhatsAppMessage(phone, note, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, note, now).run();
      return withCORS(Response.json({ ok: true }));
    }

    // — Set tag manually —
    if (path === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status:400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // — Update customer (verify) —
    if (path === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status:400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone,name,customer_id,email,verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone,name,customer_id,email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // — Auto-Response CRUD (now CORS-enabled!) —
    if (path === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag || !reply) return withCORS(new Response("Missing fields", { status:400 }));
      if (id) {
        await env.DB.prepare(
          `UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`
        ).bind(tag,hours,reply,id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO auto_replies (tag, hours, reply) VALUES(?,?,?)`
        ).bind(tag,hours,reply).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (path === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // — System / Flow Builder CRUD —
    if (path === "/api/flows" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM flows ORDER BY id`).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/flows" && request.method === "POST") {
      const { id, name, description } = await request.json();
      if (!name) return withCORS(new Response("Missing name", { status:400 }));
      if (id) {
        await env.DB.prepare(
          `UPDATE flows SET name=?, description=? WHERE id=?`
        ).bind(name,description||"",id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flows (name,description) VALUES(?,?)`
        ).bind(name,description||"").run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (path === "/api/flows-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM flows WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    if (path === "/api/flow-steps" && request.method === "GET") {
      const flowId = url.searchParams.get("flowId");
      if (!flowId) return withCORS(new Response("Missing flowId", { status:400 }));
      const { results } = await env.DB.prepare(
        `SELECT * FROM flow_steps WHERE flow_id=? ORDER BY step_order`
      ).bind(flowId).all();
      return withCORS(Response.json(results));
    }
    if (path === "/api/flow-step" && request.method === "POST") {
      const { id, flow_id, step_order, prompt, response } = await request.json();
      if (!flow_id || !prompt) return withCORS(new Response("Missing fields", { status:400 }));
      if (id) {
        await env.DB.prepare(
          `UPDATE flow_steps SET step_order=?, prompt=?, response=? WHERE id=?`
        ).bind(step_order||0,prompt,response||"",id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO flow_steps (flow_id,step_order,prompt,response) VALUES(?,?,?,?)`
        ).bind(flow_id,step_order||0,prompt,response||"").run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (path === "/api/flow-step-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status:400 }));
      await env.DB.prepare(`DELETE FROM flow_steps WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Static assets ---
    if (path === "/" || path === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }
};
