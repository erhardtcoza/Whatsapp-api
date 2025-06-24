// src/splynx.js
const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(rawPhone, env) {
  try {
    // 1) Normalize incoming phone to "27123456789"
    let phone = rawPhone.replace(/^\+|^0/, "");
    if (!phone.startsWith("27")) phone = "27" + phone;

    // 2) Primary: correct search endpoint (no /admin prefix)
    const searchURL = `https://splynx.vinet.co.za/api/2.0/customers/search?phone=${encodeURIComponent(phone)}`;
    const res1 = await fetch(searchURL, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });
    const json1 = await res1.json();
    console.log('SPYLNX SEARCH JSON:', JSON.stringify(json1, null, 2));

    if (res1.ok && Array.isArray(json1.data) && json1.data.length) {
      return json1.data[0];
    }

    // 3) Fallback: legacy endpoint using main_phone
    const fallbackURL = `https://splynx.vinet.co.za/api/2.0/customers/customer?main_phone=${encodeURIComponent(phone)}`;
    const res2 = await fetch(fallbackURL, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });
    const json2 = await res2.json();
    console.log('SPYLNX FALLBACK JSON:', JSON.stringify(json2, null, 2));

    if (res2.ok) {
      if (Array.isArray(json2) && json2.length) {
        return json2[0];
      }
      if (json2 && typeof json2 === 'object') {
        return json2;
      }
    }

    return null;
  } catch (err) {
    console.error('SPYLNX ERROR:', err);
    return null;
  }
}
