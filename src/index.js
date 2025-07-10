import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

// --- Utility function to convert ArrayBuffer to base64 ---
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Utility function to get file extension from mime_type or filename ---
function getFileExtension(mime_type, filename) {
  const mimeToExt = {
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'video/webm': 'webm',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
  };
  if (mimeToExt[mime_type]) {
    return mimeToExt[mime_type];
  }
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext && ['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) {
      return ext;
    }
  }
  return 'bin'; // Fallback extension
}

// --- Utility function to check if a department is open ---
async function isDepartmentOpen(env, department, now) {
  const today = new Date(now);
  const day = today.getDay(); // 0 (Sunday) to 6 (Saturday)
  const currentTime = today.toLocaleTimeString('en-ZA', { hour12: false, hour: '2-digit', minute: '2-digit' }); // e.g., "18:03"
  
  const officeHours = await env.DB.prepare(
    `SELECT open_time, close_time, closed FROM office_hours WHERE tag = ? AND day = ?`
  ).bind(department, day).first();

  if (!officeHours || officeHours.closed === 1) {
    return { isOpen: false, openTime: officeHours?.open_time || "08:00" };
  }

  const [openHour, openMinute] = officeHours.open_time.split(':').map(Number);
  const [closeHour, closeMinute] = officeHours.close_time.split(':').map(Number);
  const [currentHour, currentMinute] = currentTime.split(':').map(Number);

  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;
  const currentMinutes = currentHour * 60 + currentMinute;

  return {
    isOpen: currentMinutes >= openMinutes && currentMinutes < closeMinutes,
    openTime: officeHours.open_time
  };
}

// --- Utility function to send message with Emergency button ---
async function sendClosureMessageWithButton(phone, department, openTime, ticket, env) {
  const message = {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `Unfortunately, our ${department} department is now closed and will be available again at ${openTime}. Your message has been received, and one of our agents will reply once we are available again.`
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "emergency",
              title: "Emergency"
            }
          }
        ]
      }
    }
  };

  const response = await fetch(`https://graph.facebook.com/v22.0/${env.PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    console.error(`Failed to send closure message with button: ${response.status} ${response.statusText}`);
    throw new Error("Failed to send WhatsApp message");
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
     VALUES (?, ?, ?, ?, 'outgoing')`
  ).bind(phone, message.interactive.body.text, `${department}_pending`, Date.now()).run();
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
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
        let location_json = null;

        // Lookup customer and send greeting if verified
        let customer = await env.DB.prepare(`SELECT name, verified FROM customers WHERE phone = ?`).bind(from).first();
        if (customer && customer.verified === 1) {
          const firstName = (customer.name || "").split(" ")[0] || "";
          const greeting = `Hello ${firstName}, welcome back! How can we assist you today?`;
          await sendWhatsAppMessage(from, greeting, env);
          await env.DB.prepare(
            `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'system', ?, 'outgoing')`
          ).bind(from, greeting, now).run();
        }

        // Check for emergency closure
        const globalOffice = await env.DB.prepare(
          `SELECT closed, message FROM office_global WHERE id = 1`
        ).first();
        if (globalOffice && globalOffice.closed === 1) {
          const reply = globalOffice.message || "OFFICE CLOSED";
          await sendWhatsAppMessage(from, reply, env);
          return Response.json({ ok: true });
        }

        // Check for duplicate message
        const existing = await env.DB.prepare(
          `SELECT id FROM messages WHERE from_number = ? AND body LIKE ? AND timestamp > ?`
        ).bind(from, `[%${msgObj.type}%]`, now - 60000).first();
        if (existing) {
          console.log(`Duplicate message detected: msgId=${msgId}`);
          return Response.json({ ok: true });
        }

        // Parse incoming message of any type, and store media if needed
        const type = msgObj.type;
        if (type === "text") {
          userInput = msgObj.text.body.trim();
        } else if (type === "button" && msgObj.button?.text?.toLowerCase() === "emergency") {
          userInput = "emergency";
        } else if (type === "image") {
          userInput = "[Image]";
          console.log('Image message received:', JSON.stringify(msgObj));
          const mediaId = msgObj.image?.id;
          console.log('mediaId:', mediaId, 'R2_BUCKET:', !!env.R2_BUCKET);
          
          if (!mediaId) {
            console.error('No mediaId in image payload');
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'incoming')`
            ).bind(from, "[Image: No mediaId]", now).run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO customers (phone, name, email, verified)
               VALUES (?, '', '', 0)`
            ).bind(from).run();
            await sendWhatsAppMessage(from, "Sorry, we couldn't process your image. Please try sending it again.", env);
          } else {
            try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
                throw new Error(`Image metadata fetch failed: ${mediaMeta.status}`);
              }
              const mediaData = await mediaMeta.json();
              console.log('Image metadata:', JSON.stringify(mediaData));
              const directUrl = mediaData.url;

              const imageRes = await fetch(directUrl, {
                headers: {
                  Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
                  'User-Agent': 'curl/7.64.1'
                }
              });
              if (!imageRes.ok) {
                console.error(`Failed to fetch image: ${imageRes.status} ${imageRes.statusText}`);
                throw new Error(`Image fetch failed: ${imageRes.status}`);
              }
              const buf = await imageRes.arrayBuffer();

              if (!env.R2_BUCKET) {
                throw new Error('R2_BUCKET binding is missing');
              }
              const r2key = `wa-img/${from}-${now}.jpg`;
              await env.R2_BUCKET.put(r2key, buf);
              media_url = `https://w-image.vinetdns.co.za/${r2key}`;

              // Insert image message into messages table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url)
                 VALUES (?, ?, 'lead', ?, 'incoming', ?)`
              ).bind(from, userInput, now, media_url).run();

              // Ensure customer exists in customers table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
    }
    catch (error) {
              console.error(`Error processing image (mediaId: ${mediaId}):`, error);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'lead', ?, 'incoming')`
              ).bind(from, "[Image: Failed to process]", now).run();
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
              await sendWhatsAppMessage(from, "Sorry, we couldn't process your image. Please try sending it again.", env);
            }
          }
        } else if (type === "document") {
          userInput = "[Document]";
          console.log('Document message received:', JSON.stringify(msgObj));
          const mediaId = msgObj.document?.id;
          const mimeType = msgObj.document?.mime_type;
          const filename = msgObj.document?.filename || '';
          console.log('mediaId:', mediaId, 'mimeType:', mimeType, 'filename:', filename, 'R2_BUCKET:', !!env.R2_BUCKET);

          if (!mediaId) {
            console.error('No mediaId in document payload');
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'incoming')`
            ).bind(from, "[Document: No mediaId]", now).run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO customers (phone, name, email, verified)
               VALUES (?, '', '', 0)`
            ).bind(from).run();
            await sendWhatsAppMessage(from, "Sorry, we couldn't process your document. Please try sending it again.", env);
          } else {
            try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
                throw new Error(`Document metadata fetch failed: ${mediaMeta.status}`);
              }
              const mediaData = await mediaMeta.json();
              console.log('Document metadata:', JSON.stringify(mediaData));
              const directUrl = mediaData.url;

              const docRes = await fetch(directUrl, {
                headers: {
                  Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
                  'User-Agent': 'curl/7.64.1'
                }
              });
              if (!docRes.ok) {
                console.error(`Failed to fetch document: ${docRes.status} ${docRes.statusText}`);
                throw new Error(`Document fetch failed: ${docRes.status}`);
              }
              const buf = await docRes.arrayBuffer();

              if (!env.R2_BUCKET) {
                throw new Error('R2_BUCKET binding is missing');
              }
              const ext = getFileExtension(mimeType, filename);
              const r2key = `wa-doc/${from}-${now}.${ext}`;
              await env.R2_BUCKET.put(r2key, buf);
              media_url = `https://w-image.vinetdns.co.za/${r2key}`;

              // Insert document message into messages table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url)
                 VALUES (?, ?, 'lead', ?, 'incoming', ?)`
              ).bind(from, userInput, now, media_url).run();

              // Ensure customer exists in customers table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
    }
    catch (error) {
              console.error(`Error processing document (mediaId: ${mediaId}):`, error);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'lead', ?, 'incoming')`
              ).bind(from, "[Document: Failed to process]", now).run();
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
              await sendWhatsAppMessage(from, "Sorry, we couldn't process your document. Please try sending it again.", env);
            }
          }
        } else if (type === "video") {
          userInput = "[Video]";
          console.log('Video message received:', JSON.stringify(msgObj));
          const mediaId = msgObj.video?.id;
          const mimeType = msgObj.video?.mime_type;
          console.log('mediaId:', mediaId, 'mimeType:', mimeType, 'R2_BUCKET:', !!env.R2_BUCKET);

          if (!mediaId) {
            console.error('No mediaId in video payload');
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'incoming')`
            ).bind(from, "[Video: No mediaId]", now).run();
            await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
            await sendWhatsAppMessage(from, "Sorry, we couldn't process your video. Please try sending it again.", env);
          } else {
            try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
                throw new Error(`Video metadata fetch failed: ${mediaMeta.status}`);
              }
              const mediaData = await mediaMeta.json();
              console.log('Video metadata:', JSON.stringify(mediaData));
              const directUrl = mediaData.url;

              const videoRes = await fetch(directUrl, {
                headers: {
                  Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
                  'User-Agent': 'curl/7.64.1'
                }
              });
              if (!videoRes.ok) {
                console.error(`Failed to fetch video: ${videoRes.status} ${videoRes.statusText}`);
                throw new Error(`Video fetch failed: ${videoRes.status}`);
              }
              const buf = await videoRes.arrayBuffer();

              if (!env.R2_BUCKET) {
                throw new Error('R2_BUCKET binding is missing');
              }
              const ext = getFileExtension(mimeType, '');
              const r2key = `wa-video/${from}-${now}.${ext}`;
              await env.R2_BUCKET.put(r2key, buf);
              media_url = `https://w-image.vinetdns.co.za/${r2key}`;

              // Insert video message into messages table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url)
                 VALUES (?, ?, 'lead', ?, 'incoming', ?)`
              ).bind(from, userInput, now, media_url).run();

              // Ensure customer exists in customers table
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
    }
    catch (error) {
              console.error(`Error processing video (mediaId: ${mediaId}):`, error);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'lead', ?, 'incoming')`
              ).bind(from, "[Video: Failed to process]", now).run();
              await env.DB.prepare(
                `INSERT OR IGNORE INTO customers (phone, name, email, verified)
                 VALUES (?, '', '', 0)`
              ).bind(from).run();
              await sendWhatsAppMessage(from, "Sorry, we couldn't process your video. Please try sending it again.", env);
            }
          }
        } else if (type === "audio") {
          const autoReply = "Sorry, but we cannot receive voice notes. Please send text or documents.";
          await sendWhatsAppMessage(from, autoReply, env);
          await env.DB.prepare(
            `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, 'lead', ?, 'incoming', ?)`
          ).bind(from, "[Voice Note]", now, msgObj.audio.url).run();
          await env.DB.prepare(
            `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'lead', ?, 'outgoing')`
          ).bind(from, autoReply, now).run();
          await env.DB.prepare(
            `INSERT OR IGNORE INTO customers (phone, name, email, verified)
             VALUES (?, '', '', 0)`
          ).bind(from).run();
          return Response.json({ ok: true });
        } else if (type === "location") {
          userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
          location_json = JSON.stringify(msgObj.location);
        } else {
          userInput = `[Unsupported: ${type}]`;
          if (msgObj[type]?.url) media_url = msgObj[type].url;
        }

        // Lookup customer in our own table
        customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone = ?`).bind(from).first();

        // Onboarding state from DB
        let state = null;
        try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
            const reply = `Unfortunately, our leads department is now closed and will be available again at ${openTime}. Your message has been received, and one of our agents will reply once we are available again.`;
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json)
               VALUES (?, ?, ?, ?, 'incoming', ?, ?)`
            ).bind(from, userInput, 'leads_pending', now, media_url, location_json).run();
            await sendWhatsAppMessage(from, reply, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, reply, now).run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO customers (phone, name, email, verified)
               VALUES (?, '', '', 0)`
            ).bind(from).run();
            return Response.json({ ok: true });
          }

          if (!state) {
            // Start onboarding
            await env.DB.prepare(`INSERT OR IGNORE INTO onboarding (phone, step) VALUES (?, 'init')`).bind(from).run();
            const prompt =
              "Welcome. We want to assist you as effectively and quickly as possible, but we need your information first. Please reply only with the options provided.\nAre you currently a Vinet client? Yes / No";
            await sendWhatsAppMessage(from, prompt, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
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
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, msg, now).run();
              return Response.json({ ok: true });
            } else if (ans === "no") {
              await env.DB.prepare(`UPDATE onboarding SET step = 'ask_lead_details' WHERE phone = ?`).bind(from).run();
              const msg = "Thank you for showing interest in our service, please provide us with your First and Last name, email address and address, separated by commas.";
              await sendWhatsAppMessage(from, msg, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, msg, now).run();
              return Response.json({ ok: true });
            } else {
              const msg = "Please reply only with Yes or No.";
              await sendWhatsAppMessage(from, msg, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, msg, now).run();
              return Response.json({ ok: true });
            }
          }

          // Onboarding: waiting for client details (yes)
          if (state === "ask_client_details") {
            const parts = userInput.split(",");
            if (parts.length < 3) {
              const msg = "Please provide your Client Code, Full Name, and Email address, separated by commas.";
              await sendWhatsAppMessage(from, msg, env);
              return Response.json({ ok: true });
            }
            const [customer_id, name, email] = parts.map(x => x.trim());
            await env.DB.prepare(
              `INSERT INTO customers (phone, customer_id, name, email, verified)
               VALUES (?, ?, ?, ?, 0)
               ON CONFLICT(phone) DO UPDATE SET customer_id=?, name=?, email=?`
            ).bind(from, customer_id, name, email, customer_id, name, email).run();
            await env.DB.prepare(`UPDATE onboarding SET step = 'wait_verify' WHERE phone = ?`).bind(from).run();
            const msg = "Thank you. Your details have been received and are pending verification by our agents.";
            await sendWhatsAppMessage(from, msg, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          }

          // Onboarding: waiting for lead details (no)
          if (state === "ask_lead_details") {
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
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(from, msg, now).run();
            return Response.json({ ok: true });
          }

          // Waiting for verification by admin: only check if admin has verified
          if (state === "wait_verify") {
            customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone = ?`).bind(from).first();
            if (customer && customer.verified === 1) {
              await env.DB.prepare(`DELETE FROM onboarding WHERE phone = ?`).bind(from).run();
              const msg = `Hi, you have been verified by our admin team.\nHow can we help you?\n1. Support\n2. Sales\n3. Accounts`;
              await sendWhatsAppMessage(from, msg, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, msg, now).run();
              return Response.json({ ok: true });
            }
            const msg = "Your details are pending verification. Please wait for an agent.";
            await sendWhatsAppMessage(from, msg, env);
            return Response.json({ ok: true });
          }
        }

        // --- VERIFIED CUSTOMER FLOW ---
        if (customer && customer.verified === 1) {
          const greetings = ["hi", "hello", "hey", "good day"];
          const lc = userInput.toLowerCase();

          // Check for CLOSE command
          if (lc === "close") {
            const openSession = await env.DB.prepare(
              `SELECT ticket, department FROM chatsessions WHERE phone = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`
            ).bind(from).first();
            if (openSession) {
              await env.DB.prepare(
                `UPDATE chatsessions SET end_ts = ? WHERE ticket = ?`
              ).bind(now, openSession.ticket).run();
              const reply = `Your chat session (Ref: ${openSession.ticket}) with ${openSession.department} has been closed. To start a new session, say hi.`;
              await sendWhatsAppMessage(from, reply, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, reply, now).run();
              return Response.json({ ok: true });
            } else {
              const reply = `No active chat session found. To start a new session, say hi.`;
              await sendWhatsAppMessage(from, reply, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, reply, now).run();
              return Response.json({ ok: true });
            }
          }

          // Check for Emergency button press
          if (lc === "emergency") {
            const openSession = await env.DB.prepare(
              `SELECT ticket, department FROM chatsessions WHERE phone = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`
            ).bind(from).first();
            if (openSession) {
              // Close existing session
              await env.DB.prepare(
                `UPDATE chatsessions SET end_ts = ? WHERE ticket = ?`
              ).bind(now, openSession.ticket).run();
            }

            // Create new session with Support
            const today = new Date(now);
            const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
            const dayStart = Date.parse(today.toISOString().slice(0, 10) + "T00:00:00Z");
            const dayEnd = Date.parse(today.toISOString().slice(0, 10) + "T23:59:59Z");
            const { count = 0 } = await env.DB.prepare(
              `SELECT COUNT(*) AS count FROM chatsessions WHERE start_ts BETWEEN ? AND ?`
            ).bind(dayStart, dayEnd).first();
            const session_id = `${yyyymmdd}${String(count + 1).padStart(3, '0')}`;
            await env.DB.prepare(
              `INSERT INTO chatsessions (phone, ticket, department, start_ts)
               VALUES (?, ?, ?, ?)`
            ).bind(from, session_id, 'support', now).run();
            const reply = `Your chat session has been switched to our Support department (Ref: ${session_id}). Please reply with your message.`;
            await sendWhatsAppMessage(from, reply, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, ?, ?, 'outgoing')`
            ).bind(from, reply, 'support', now).run();
            return Response.json({ ok: true });
          }

          // Check for SWITCH command
          if (lc.startsWith("switch ")) {
            const requestedDept = lc.slice(7).trim().toLowerCase();
            const validDepts = { "support": "Support", "sales": "Sales", "accounts": "Accounts" };
            if (!validDepts[requestedDept]) {
              const reply = `Invalid department. Please use "SWITCH Support", "SWITCH Sales", or "SWITCH Accounts".`;
              await sendWhatsAppMessage(from, reply, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, reply, now).run();
              return Response.json({ ok: true });
            }

            const { isOpen, openTime } = await isDepartmentOpen(env, requestedDept, now);
            if (!isOpen) {
              const reply = `Unfortunately, our ${validDepts[requestedDept]} department is now closed and will be available again at ${openTime}. Your message has been received, and one of our agents will reply once we are available again.`;
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, ?, ?, 'incoming')`
              ).bind(from, userInput, `${requestedDept}_pending`, now).run();
              await sendWhatsAppMessage(from, reply, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'system', ?, 'outgoing')`
              ).bind(from, reply, now).run();
              return Response.json({ ok: true });
            }

            // Close any existing session
            const openSession = await env.DB.prepare(
              `SELECT ticket FROM chatsessions WHERE phone = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`
            ).bind(from).first();
            if (openSession) {
              await env.DB.prepare(
                `UPDATE chatsessions SET end_ts = ? WHERE ticket = ?`
              ).bind(now, openSession.ticket).run();
            }

            // Create new session
            const today = new Date(now);
            const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
            const dayStart = Date.parse(today.toISOString().slice(0, 10) + "T00:00:00Z");
            const dayEnd = Date.parse(today.toISOString().slice(0, 10) + "T23:59:59Z");
            const { count = 0 } = await env.DB.prepare(
              `SELECT COUNT(*) AS count FROM chatsessions WHERE start_ts BETWEEN ? AND ?`
            ).bind(dayStart, dayEnd).first();
            const session_id = `${yyyymmdd}${String(count + 1).padStart(3, '0')}`;
            await env.DB.prepare(
              `INSERT INTO chatsessions (phone, ticket, department, start_ts)
               VALUES (?, ?, ?, ?)`
            ).bind(from, session_id, requestedDept, now).run();
            const reply = `Your chat session has been switched to our ${validDepts[requestedDept]} department (Ref: ${session_id}). Please reply with your message.`;
            await sendWhatsAppMessage(from, reply, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, ?, ?, 'outgoing')`
            ).bind(from, reply, requestedDept, now).run();
            return Response.json({ ok: true });
          }

          // Check for greetings
if (greetings.includes(lc)) {
  const msg = `Hello ${firstName}! How can we help you today?\n1. Support\n2. Sales\n3. Accounts`;
  await sendWhatsAppMessage(from, msg, env);
  return new Response("Greeting sent");
            } else {
              const reply =
                `Hello ${firstName}! How can we help you today?\n` +
                `1. Support\n2. Sales\n3. Accounts`;
              await sendWhatsAppMessage(from, reply, env);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, 'customer', ?, 'outgoing')`
              ).bind(from, reply, now).run();
              return Response.json({ ok: true });
            }
          }

          // Department choice
          let deptTag = null;
          if (userInput === "1") deptTag = "support";
          else if (userInput === "2") deptTag = "sales";
          else if (userInput === "3") deptTag = "accounts";

          if (deptTag) {
            const { isOpen, openTime } = await isDepartmentOpen(env, deptTag, now);
            const today = new Date(now);
            const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
            const dayStart = Date.parse(today.toISOString().slice(0, 10) + "T00:00:00Z");
            const dayEnd = Date.parse(today.toISOString().slice(0, 10) + "T23:59:59Z");
            const { count = 0 } = await env.DB.prepare(
              `SELECT COUNT(*) AS count FROM chatsessions WHERE start_ts BETWEEN ? AND ?`
            ).bind(dayStart, dayEnd).first();
            const session_id = `${yyyymmdd}${String(count + 1).padStart(3, '0')}`;
            await env.DB.prepare(
              `INSERT INTO chatsessions (phone, ticket, department, start_ts)
               VALUES (?, ?, ?, ?)`
            ).bind(from, session_id, deptTag, now).run();
            if (!isOpen) {
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
                 VALUES (?, ?, ?, ?, 'incoming')`
              ).bind(from, userInput, `${deptTag}_pending`, now).run();
              await sendClosureMessageWithButton(from, deptTag, openTime, session_id, env);
              return Response.json({ ok: true });
            }
            const ack = `Thank you, we have created a chat session with our ${deptTag} department: Your ref is ${session_id}, please reply with your message.`;
            await sendWhatsAppMessage(from, ack, env);
            await env.DB.prepare(
              `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, ?, ?, 'outgoing')`
            ).bind(from, ack, deptTag, now).run();
            return Response.json({ ok: true });
          }

          // Main chat messaging
          const openSession = await env.DB.prepare(
            `SELECT * FROM chatsessions WHERE phone=? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`
          ).bind(from).first();

          let msgTag = "customer";
          if (openSession) {
            const { isOpen, openTime } = await isDepartmentOpen(env, openSession.department, now);
            if (!isOpen) {
              await env.DB.prepare(
                `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json)
                 VALUES (?, ?, ?, ?, 'incoming', ?, ?)`
              ).bind(from, userInput, `${openSession.department}_pending`, now, media_url, location_json).run();
              await sendClosureMessageWithButton(from, openSession.department, openTime, openSession.ticket, env);
              return Response.json({ ok: true });
            }
            msgTag = openSession.department;
          }

          await env.DB.prepare(
            `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json)
             VALUES (?, ?, ?, ?, 'incoming', ?, ?)`
          ).bind(from, userInput, msgTag, now, media_url, location_json).run();

          return Response.json({ ok: true });
        }

        // --- fallback ---
        return Response.json({ ok: true });
    }
    catch (error) {
        console.error('Webhook error:', error);

      }
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

    // --- API: List all customers with session count ---
    if (url.pathname === "/api/all-customers-with-sessions" && request.method === "GET") {
      const sql = `
        SELECT 
          c.phone, 
          c.name, 
          c.customer_id,
          COUNT(s.id) AS session_count
        FROM customers c
        LEFT JOIN chatsessions s ON s.phone = c.phone
        WHERE c.verified = 1
        GROUP BY c.phone, c.name, c.customer_id
        ORDER BY c.name
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: List open support sessions (for SupportPage) ---
    if (url.pathname === "/api/support-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT
          s.ticket,
          s.phone,
          c.name,
          c.customer_id,
          s.department,
          s.start_ts,
          s.end_ts
        FROM chatsessions s
        LEFT JOIN customers c ON c.phone = s.phone
        WHERE s.department = 'support'
          AND (s.end_ts IS NULL)
        ORDER BY s.start_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: List open accounts sessions (for AccountsPage) ---
    if (url.pathname === "/api/accounts-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT
          s.ticket,
          s.phone,
          c.name,
          c.customer_id,
          s.department,
          s.start_ts,
          s.end_ts
        FROM chatsessions s
        LEFT JOIN customers c ON c.phone = s.phone
        WHERE s.department = 'accounts'
          AND (s.end_ts IS NULL)
        ORDER BY s.start_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: List open sales sessions (for SalesPage) ---
    if (url.pathname === "/api/sales-chatsessions" && request.method === "GET") {
      const sql = `
        SELECT
          s.ticket,
          s.phone,
          c.name,
          c.customer_id,
          s.department,
          s.start_ts,
          s.end_ts
        FROM chatsessions s
        LEFT JOIN customers c ON c.phone = s.phone
        WHERE s.department = 'sales'
          AND (s.end_ts IS NULL)
        ORDER BY s.start_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: Close a session by ticket ---
    if (url.pathname === "/api/close-session" && request.method === "POST") {
      const { ticket } = await request.json();
      if (!ticket) return withCORS(new Response("Missing ticket", { status: 400 }));
      // Set end_ts for the session to now
      await env.DB.prepare(`UPDATE chatsessions SET end_ts = ? WHERE ticket = ?`)
        .bind(Date.now(), ticket).run();
      // Notify the user
      const sess = await env.DB.prepare(`SELECT phone, department FROM chatsessions WHERE ticket = ?`).bind(ticket).first();
      if (sess && sess.phone) {
        const reply = `Your chat session (Ref: ${ticket}) with ${sess.department} has been closed. To start a new session, just say hi!`;
        await sendWhatsAppMessage(sess.phone, reply, env);
        await env.DB.prepare(
          `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(sess.phone, reply, Date.now()).run();
      }
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Close a chat ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      // Mark closed
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      const notice = "This session has been closed. To start a new chat, just say ‘hi’ again.";
      await sendWhatsAppMessage(phone, notice, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, notice, Date.now()).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Verify client (admin) ---
    if (url.pathname === "/api/verify-client" && request.method === "POST") {
      const { phone, name, email, customer_id } = await request.json();
      await env.DB.prepare(`
        UPDATE customers SET name=?, email=?, customer_id=?, verified=1 WHERE phone=?
      `).bind(name, email, customer_id, phone).run();
      // After verify: send client menu
      const msg = `Hi, you have been verified by our admin team.\nHow can we help you?\n1. Support\n2. Sales\n3. Accounts`;
      await sendWhatsAppMessage(phone, msg, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, msg, Date.now()).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Send message to client (admin) ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing phone or body", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, body, Date.now()).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Delete client ---
    if (url.pathname === "/api/delete-client" && request.method === "POST") {
      const { phone } = await request.json();
      await env.DB.prepare(`DELETE FROM customers WHERE phone=?`).bind(phone).run();
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

    // --- API: Get all customers (for Send Message page and Customers page) ---
    if (url.pathname === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT phone, name, customer_id, email, verified, status, street, zip_code, city, payment_method, balance, labels
         FROM customers
         ORDER BY name`
      ).all();
      return withCORS(Response.json(results));
    }

    // --- API: Get sessions for a customer ---
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
      // Cascade delete steps
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

    // --- API: Templates CRUD ---
    if (url.pathname === "/api/templates" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM templates ORDER BY id DESC"
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/templates" && request.method === "POST") {
      const { id, name, body, language, status } = await request.json();
      const now = Date.now();
      if (id) {
        await env.DB.prepare(
          `UPDATE templates SET name=?, body=?, language=?, status=?, updated_at=? WHERE id=?`
        ).bind(name, body, language, status, now, id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO templates (name, body, language, status, created_at, updated_at, synced)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).bind(name, body, language, status || "draft", now, now).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/templates/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM templates WHERE id=?").bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/templates/status" && request.method === "POST") {
      const { id, status } = await request.json();
      await env.DB.prepare("UPDATE templates SET status=? WHERE id=?").bind(status, id).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/templates/unsynced" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM templates WHERE synced=0 AND status='approved'"
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/templates/sync" && request.method === "POST") {
      const { id } = await request.json();
      const tpl = await env.DB.prepare("SELECT * FROM templates WHERE id=?").bind(id).first();
      if (!tpl) return withCORS(new Response("Not found", { status: 404 }));

      // Compose the API call payload
      const body = {
        name: tpl.name.toLowerCase().replace(/[^a-z0-9_]/g, "_"), // WhatsApp rules
        language: tpl.language || "en",
        category: "MARKETING", // or "UTILITY", "TRANSACTIONAL"
        components: [
          {
            type: "BODY",
            text: tpl.body,
          },
        ],
      };

      // WhatsApp API Call
      const apiResp = await fetch(
        `https://graph.facebook.com/v19.0/${env.BUSINESS_ID}/message_templates`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      const apiResult = await apiResp.json();

      if (apiResp.ok && apiResult.id) {
        // Success: Mark as synced
        await env.DB.prepare("UPDATE templates SET synced=1 WHERE id=?").bind(id).run();
        return withCORS(Response.json({ ok: true, result: apiResult }));
      } else {
        // Error: Save error to db/log if desired
        return withCORS(Response.json({ ok: false, error: apiResult }, { status: 400 }));
      }
    }

    // Fetch WhatsApp template status from Meta
    if (url.pathname === "/api/templates/status" && request.method === "GET") {
      const name = url.searchParams.get("name");
      if (!name) return withCORS(new Response("Missing template name", { status: 400 }));

      const apiResp = await fetch(
        `https://graph.facebook.com/v19.0/${env.BUSINESS_ID}/message_templates?name=${encodeURIComponent(name)}`,
        {
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          },
        }
      );
      const apiResult = await apiResp.json();
      return withCORS(Response.json(apiResult));
    }

    // --- API: List all clients with frontend-friendly column names ---
    if (url.pathname === "/api/clients" && request.method === "GET") {
      const sql = `
        SELECT
          status AS Status,
          customer_id AS ID,
          name AS "Full name",
          phone AS "Phone number",
          street AS Street,
          zip_code AS "ZIP code",
          city AS City,
          payment_method AS "Payment Method",
          balance AS "Account balance",
          labels AS Labels
        FROM customers
        ORDER BY name
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    if (url.pathname === "/api/upload-clients" && request.method === "POST") {
      const { rows } = await request.json();
      let replaced = 0;
      const failed = [];

      const requiredFields = [
        "Status", "ID", "Full name", "Phone number",
        "Street", "ZIP code", "City", "Payment Method",
        "Account balance", "Labels"
      ];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Check for required fields
        const missing = requiredFields.filter(f => !(f in row));
        if (missing.length > 0) {
          failed.push({ idx: i + 1, reason: `Missing fields: ${missing.join(", ")}`, row });
          continue;
        }

        try {
        // logic here
      } catch (error) {
        console.error('Error:', error);
      } finally {
        return Response.json({ ok: true });
      }
              city=excluded.city,
              payment_method=excluded.payment_method,
              balance=excluded.balance,
              labels=excluded.labels
          `).bind(
            row["Status"], row["ID"], row["Full name"], row["Phone number"],
            row["Street"], row["ZIP code"], row["City"], row["Payment Method"],
            row["Account balance"], row["Labels"]
          ).run();
          replaced += 1;
        } catch (err) {
          failed.push({ idx: i + 1, reason: String(err), row });
          console.error("Row insert/update failed", { row, error: err });
        }
      }

      // Respond with detailed result
      return withCORS(Response.json({
        replaced,
        failed_rows: failed,
        message: failed.length
          ? `Upload complete: ${replaced} clients replaced. ${failed.length} row(s) failed.`
          : `Upload successful: ${replaced} clients replaced.`
      }));
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
