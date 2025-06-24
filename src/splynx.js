const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(rawPhone, env) {
  try {
    // 1) Normalize incoming to “27123456789”
    let phone = rawPhone.replace(/^\+|^0/, "");
    if (!phone.startsWith("27")) phone = "27" + phone;

    // 2) Hit the admin search endpoint
    const url = `https://splynx.vinet.co.za/api/2.0/admin/customers/search?phone=${encodeURIComponent(phone)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) return null;
    const json = await res.json();

    // 3) The API returns { data: [...] }
    if (!Array.isArray(json.data) || !json.data.length) {
      return null;
    }

    // 4) Return the first customer record
    return json.data[0];
  } catch {
    return null;
  }
}
