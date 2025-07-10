// src/utils/office.js
export function isDepartmentOpen(department, officeHours, now = new Date()) {
  const today = now.getDay(); // 0 = Sunday
  const hours = officeHours?.[department]?.[today];
  if (!hours) return false;
  const [start, end] = hours.split("-").map(t => parseInt(t));
  const current = now.getHours();
  return current >= start && current < end;
}

export async function sendClosureMessageWithButton(phone, env) {
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
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Ons is tans gesluit. Ons sal jou kontak sodra ons weer beskikbaar is." },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "confirm_wait", title: "OK, wag vir julle" }
            }
          ]
        }
      }
    }),
  });

  if (!res.ok) {
    console.error("Failed to send closure message:", await res.text());
  }
}
