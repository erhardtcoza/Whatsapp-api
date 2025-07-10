// cors.js - Utility for CORS response handling

export function withCORS(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  return response;
}

export function handleOptions(request) {
  return withCORS(new Response(null, { status: 204 }));
}
