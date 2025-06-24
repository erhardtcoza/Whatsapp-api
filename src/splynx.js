const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    console.log(`SPYLNX PARSE ERROR for ${url}:`, e);
  }
  console.log(`SPYLNX RESPONSE [${url}]:`, JSON.stringify(json));
  return json;
}

export async function getCustomerByPhone(rawPhone, env) {
  // Normalize to “27123456789”
  let phone = rawPhone.replace(/^\+|^0/, "");
  if (!phone.startsWith("27")) phone = "27" + phone;

  // Only call the documented search endpoint
  const url = `https://splynx.vinet.co.za/api/2.0/customers/search?phone=${encodeURIComponent(phone)}`;
  const json = await fetchJson(url);

  if (json?.data && Array.isArray(json.data) && json.data.length) {
    return json.data[0];
  }
  return null;
}
