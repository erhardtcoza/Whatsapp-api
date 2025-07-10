import { parseWhatsAppMessage } from '../utils.js';
import { sendGreeting, sendClosureMessage } from './responses.js';
import { getCustomerByPhone } from '../lib/db.js';

export default async function whatsappHandler(request, env, ctx) {
  const url = new URL(request.url);

  // WhatsApp webhook verification (GET)
  if (request.method === 'GET') {
    const verify_token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (verify_token === env.VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // WhatsApp message handler (POST)
  if (request.method === 'POST') {
    try {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;

      const customer = await getCustomerByPhone(from, env);

      // Send greeting if customer is verified
      if (customer?.verified) {
        await sendGreeting(from, customer.name, env);
      }

      const parsedMessage = await parseWhatsAppMessage(msgObj, from, env);

      // Placeholder for further message handling logic
      // e.g., routing messages to departments, checking office hours, etc.

      return Response.json({ ok: true });
    } catch (error) {
      console.error('WhatsApp webhook error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  // Method not allowed response
  return new Response('Method not allowed', { status: 405 });
}
