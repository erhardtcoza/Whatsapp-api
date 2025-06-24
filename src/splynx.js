// src/splynx.js
const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(rawPhone, env) {
  try {
    // 1) Normalize incoming phone to "27123456789"
    let phone = rawPhone.replace(/^\+|^0/, "");
    if (!phone.startsWith("27")) phone = "27" + phone;

    // 2) Construct search URL
    const url = `https://splynx.vinet.co.za/api/2.0/admin/customers/search?phone=${encodeURIComponent(phone)}`;

    // 3) Fetch from Splynx
    const res = await fetch(url, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });

    // 4) Parse JSON
    const json = await res.json();

    // DEBUG: log entire payload to worker logs
    console.log('SPYLNX SEARCH JSON:', JSON.stringify(json, null, 2));

    // 5) Extract data array
    const list = Array.isArray(json.data) ? json.data : [];

    // 6) Return first record or null
    return list.length ? list[0] : null;
  } catch (err) {
    console.error('SPYLNX SEARCH ERROR:', err);
    return null;
  }
}
