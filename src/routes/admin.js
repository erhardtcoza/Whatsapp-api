
import { withCORS } from '../utils/cors.js';
import { sendWhatsAppMessage } from '../utils/respond.js';

export default async function adminHandler(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCORS(new Response("OK"));
  }

  // Route handling
  switch (url.pathname) {
    // --- API: Verify client ---
    case "/api/verify-client": {
      if (request.method !== "POST") break;

      const { phone, name, email, customer_id } = await request.json();
      await env.DB.prepare(`
        UPDATE customers SET name=?, email=?, customer_id=?, verified=1 WHERE phone=?
      `).bind(name, email, customer_id, phone).run();

      const msg = `Hi, you've been verified.\nHow can we assist?\n1. Support\n2. Sales\n3. Accounts`;
      await sendWhatsAppMessage(phone, msg, env);

      await env.DB.prepare(`
        INSERT INTO messages (from_number, body, tag, timestamp, direction)
        VALUES (?, ?, 'system', ?, 'outgoing')
      `).bind(phone, msg, Date.now()).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Send message to client ---
    case "/api/send-message": {
      if (request.method !== "POST") break;

      const { phone, body } = await request.json();
      await sendWhatsAppMessage(phone, body, env);

      await env.DB.prepare(`
        INSERT INTO messages (from_number, body, tag, timestamp, direction)
        VALUES (?, ?, 'system', ?, 'outgoing')
      `).bind(phone, body, Date.now()).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Delete client ---
    case "/api/delete-client": {
      if (request.method !== "POST") break;

      const { phone } = await request.json();
      await env.DB.prepare(`DELETE FROM customers WHERE phone=?`).bind(phone).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Set message/chat tag manually ---
    case "/api/set-tag": {
      if (request.method !== "POST") break;

      const { from_number, tag } = await request.json();
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`)
        .bind(tag, from_number).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Update customer & verify ---
    case "/api/update-customer": {
      if (request.method !== "POST") break;

      const { phone, name, customer_id, email } = await request.json();
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

    // --- API: Get all customers ---
    case "/api/customers": {
      if (request.method !== "GET") break;

      const { results } = await env.DB.prepare(`
        SELECT phone, name, customer_id, email, verified, status, street, zip_code, city, payment_method, balance, labels
        FROM customers ORDER BY name
      `).all();

      return withCORS(Response.json(results));
    }

    // --- API: Admin users CRUD ---
    case "/api/users": {
      if (request.method !== "GET") break;

      const { results } = await env.DB.prepare(`
        SELECT id, username, role FROM admins ORDER BY username
      `).all();

      return withCORS(Response.json(results));
    }

    case "/api/add-user": {
      if (request.method !== "POST") break;

      const { username, password, role } = await request.json();
      await env.DB.prepare(`
        INSERT INTO admins (username, password, role) VALUES (?, ?, ?)
      `).bind(username, password, role).run();

      return withCORS(Response.json({ ok: true }));
    }

    case "/api/delete-user": {
      if (request.method !== "POST") break;

      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Office hours CRUD ---
    case "/api/office-hours": {
      if (request.method === "GET") {
        const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
        return withCORS(Response.json(results));
      }

      if (request.method === "POST") {
        const { tag, day, open_time, close_time, closed } = await request.json();
        await env.DB.prepare(`
          INSERT INTO office_hours (tag, day, open_time, close_time, closed)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tag, day) DO UPDATE SET
            open_time=excluded.open_time,
            close_time=excluded.close_time,
            closed=excluded.closed
        `).bind(tag, day, open_time, close_time, closed ? 1 : 0).run();

        return withCORS(Response.json({ ok: true }));
      }
      break;
    }

    // --- API: Global office status ---
    case "/api/office-global": {
      if (request.method === "GET") {
        const globalOffice = await env.DB.prepare(`
          SELECT * FROM office_global WHERE id=1
        `).first();
        return withCORS(Response.json(globalOffice));
      }

      if (request.method === "POST") {
        const { closed, message } = await request.json();
        await env.DB.prepare(`
          UPDATE office_global SET closed=?, message=? WHERE id=1
        `).bind(closed ? 1 : 0, message).run();

        return withCORS(Response.json({ ok: true }));
      }
      break;
    }

    // --- API: Public holidays CRUD ---
    case "/api/public-holidays": {
      if (request.method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT * FROM public_holidays ORDER BY date
        `).all();
        return withCORS(Response.json(results));
      }

      if (request.method === "POST") {
        const { date, name } = await request.json();
        await env.DB.prepare(`
          INSERT INTO public_holidays (date, name) VALUES (?, ?)
        `).bind(date, name).run();

        return withCORS(Response.json({ ok: true }));
      }
      break;
    }

    case "/api/public-holidays/delete": {
      if (request.method !== "POST") break;

      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();

      return withCORS(Response.json({ ok: true }));
    }

    default:
      return new Response("Not Found", { status: 404 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
