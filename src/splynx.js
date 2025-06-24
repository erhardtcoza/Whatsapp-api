// src/splynx.js
const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(rawPhone, env) {
  try {
    // Normalize incoming phone to "27123456789" form
    let phone = rawPhone.replace(/^\+|^0/, "");
    if (!phone.startsWith("27")) phone = "27" + phone;

    // 1) Primary: search endpoint
    const searchURL = `https://splynx.vinet.co.za/api/2.0/admin/customers/search?phone=${encodeURIComponent(phone)}`;
    const res1 = await fetch(searchURL, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });
    const json1 = await res1.json();
    console.log('SPYLNX SEARCH JSON:', JSON.stringify(json1, null, 2));

    if (res1.ok) {
      const list = Array.isArray(json1.data) ? json1.data : [];
      if (list.length) return list[0];
    }

    // 2) Fallback: legacy customer endpoint
    const fallbackURL = `https://splynx.vinet.co.za/api/2.0/admin/customers/customer?main_phone=${encodeURIComponent(phone)}`;
    const res2 = await fetch(fallbackURL, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });
    const json2 = await res2.json();
    console.log('SPYLNX FALLBACK JSON:', JSON.stringify(json2, null, 2));

    if (res2.ok) {
      if (Array.isArray(json2)) {
        return json2.length ? json2[0] : null;
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
