// src/utils/respond.js
export async function sendWhatsAppMessage(phone, message, env) {
  const url = `https://graph.facebook.com/v17.0/${env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    }),
  });

  if (!res.ok) {
    console.error("Failed to send message:", await res.text());
  }
}
