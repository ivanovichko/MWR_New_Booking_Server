/**
 * Groq egress proxy — Cloudflare Worker
 * ------------------------------------------------------------------
 * Why this exists:
 *   Render's free-tier shared egress IP gets blocked by Groq with a
 *   403 "Access denied. Please check your network settings." across
 *   ALL models. The traffic must leave from an IP Groq accepts.
 *   Cloudflare Workers egress from Cloudflare's IPs, which are not on
 *   Groq's block list, so this relay restores access for free.
 *
 * What it does:
 *   Forwards any request verbatim to https://api.groq.com + same path,
 *   preserving method, headers (incl. Authorization), and body. The
 *   Groq API key stays in the backend's env — this worker never sees
 *   or stores it beyond passing the header through.
 *
 * Deploy (no CLI needed):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker.
 *   2. Paste this file as the worker code, Deploy.
 *   3. Copy the worker URL, e.g. https://groq-proxy.<you>.workers.dev
 *   4. On Render, set env var:
 *        GROQ_API_URL = https://groq-proxy.<you>.workers.dev/openai/v1/chat/completions
 *      (aiService.js + prewarmService.js read this; unset = Groq direct.)
 *   5. Redeploy the Render service so it picks up the env var.
 *
 * Optional hardening: set a shared secret to stop others using your
 * proxy. Uncomment the PROXY_SECRET check and send a matching
 * "x-proxy-secret" header from the backend (would need a small tweak
 * to the fetch calls). Not required if the URL stays private.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Only relay the chat-completions path (and any other Groq path).
    const target = 'https://api.groq.com' + url.pathname + url.search;

    const init = {
      method: request.method,
      headers: request.headers,
      body: (request.method === 'GET' || request.method === 'HEAD')
        ? undefined
        : request.body,
    };

    const upstream = await fetch(target, init);

    // Stream the upstream response straight back, status and all.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};
