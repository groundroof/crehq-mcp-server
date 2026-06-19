/**
 * Server-rendered OAuth consent screen. Plain HTML (no framework) so it works
 * identically in Workers and Node. The user authorizes the connector and links
 * their CREHQ API key here; the form POSTs to /authorize/consent.
 *
 * In PRODUCTION this paste step is replaced by "Sign in with CREHQ" (a redirect
 * to the WordPress login that issues/looks-up a scoped key) — see DEPLOY.md.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function consentPage(opts: {
  pendingId: string;
  clientName: string;
  scopes: string[];
  error?: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "read:locations":
      "Read brands, locations, FDD financials, datasets & trends (basic)",
    "read:intelligence":
      "Premium intelligence: credit signals, whitespace, co-tenancy, site-timeline & point-in-time occupancy",
  };
  const scopeList = opts.scopes
    .map((s) => `<li><code>${esc(s)}</code> — ${esc(scopeLabels[s] ?? s)}</li>`)
    .join("");
  const errorBlock = opts.error
    ? `<div class="error" role="alert">${esc(opts.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authorize ${esc(opts.clientName)} — CREHQ</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0; background: #0b1220; color: #e8edf5; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #131c2e; border: 1px solid #243149; border-radius: 14px; max-width: 460px; width: calc(100% - 32px);
    padding: 28px 30px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #94a3b8; font-size: 13px; margin: 0 0 18px; }
  .brand { font-weight: 700; color: #38bdf8; }
  ul { padding-left: 18px; margin: 8px 0 18px; }
  li { margin: 4px 0; font-size: 13.5px; color: #cbd5e1; }
  code { background: #0b1220; padding: 1px 6px; border-radius: 5px; font-size: 12px; color: #7dd3fc; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 9px;
    border: 1px solid #2c3a55; background: #0b1220; color: #e8edf5; font-size: 14px; font-family: ui-monospace, monospace; }
  .hint { font-size: 12px; color: #7c8aa3; margin-top: 6px; }
  .hint a { color: #38bdf8; }
  button { margin-top: 18px; width: 100%; padding: 12px; border: 0; border-radius: 9px; background: #2563eb; color: #fff;
    font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { background: #3b1418; border: 1px solid #7f1d1d; color: #fca5a5; padding: 10px 12px; border-radius: 9px;
    font-size: 13px; margin-bottom: 16px; }
  .foot { margin-top: 16px; font-size: 11.5px; color: #64748b; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <h1>Authorize <span class="brand">${esc(opts.clientName)}</span></h1>
    <p class="sub">Connecting to <span class="brand">CREHQ</span> location intelligence.</p>
    ${errorBlock}
    <p style="font-size:13.5px;color:#cbd5e1;margin:0 0 4px;">This connector will be allowed to:</p>
    <ul>${scopeList}</ul>
    <form method="POST" action="/authorize/consent" autocomplete="off">
      <input type="hidden" name="pending_id" value="${esc(opts.pendingId)}">
      <label for="apikey">Your CREHQ API key</label>
      <input id="apikey" name="crehq_api_key" type="password" placeholder="crehq_live_..." required
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="hint">Paste the key from your <a href="https://crehq.com/api-keys/" target="_blank" rel="noopener">CREHQ account</a>,
        or get a free sandbox key (1,000 calls/mo) at <a href="https://crehq.com/developers/sandbox/" target="_blank" rel="noopener">crehq.com/developers/sandbox</a>.
        Your tier determines whether premium intelligence tools are unlocked.</p>
      <button type="submit">Authorize</button>
    </form>
    <p class="foot">Your key is stored only to make API calls on your behalf and is never shown to the AI client.</p>
  </main>
</body>
</html>`;
}

export function messagePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b1220;color:#e8edf5;
display:flex;min-height:100vh;align-items:center;justify-content:center}.c{max-width:440px;padding:24px;text-align:center}
h1{font-size:18px}p{color:#94a3b8}</style></head>
<body><main class="c"><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
}
