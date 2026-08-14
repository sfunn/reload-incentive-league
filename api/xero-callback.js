const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

const TOKENS_KEY = "xero-oauth-tokens"; // { refreshToken, tenantId, tenantName, connectedAt }

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
  <body style="font-family: sans-serif; padding: 40px; text-align: center;">
    <h2 style="color: ${ok ? "#2e405b" : "#c0392b"};">${title}</h2>
    <p>${message}</p>
    <p><a href="/">Return to Reload Incentive League</a></p>
  </body></html>`;
}

// This single file handles BOTH steps of the Xero OAuth flow, merged
// together to save a serverless function slot (Vercel's free plan caps at
// 12) — but the actual URL Xero redirects back to must stay exactly
// "/api/xero-callback", since that's the fixed redirect URI already
// registered in the Xero app settings. The "start the flow" step
// (?action=connect) lives here too, on the same path, distinguished by
// that query parameter rather than being its own separate file/route.
module.exports = async (req, res) => {
  if (req.query.action === "connect") {
    return handleConnect(req, res);
  }
  return handleCallback(req, res);
};

// Scott or Lee visits /api/xero-callback?action=connect once (via the
// "Connect to Xero" button), gets sent to Xero's own login/consent screen,
// and Xero redirects back to this SAME URL (without ?action=connect) with
// a temporary code we exchange for real tokens in handleCallback below.
async function handleConnect(req, res) {
  // This step has to be a genuine browser navigation (the browser itself
  // needs to physically leave for Xero's login page) — it can't be called
  // via fetch() from inside the React app the normal way, so there's no
  // custom Authorization header to read. Instead, the token is passed as
  // a ?token= query parameter, built by the "Connect to Xero" button.
  const queryToken = req.query.token;
  const fakeReq = queryToken ? { headers: { authorization: `Bearer ${queryToken}` } } : req;
  const user = await getUserFromRequest(fakeReq);
  if (!user || !user.isSuperAdmin) {
    res.setHeader("Content-Type", "text/html");
    return res.status(401).send(
      htmlPage("Super Admin access required", `Use the "Connect to Xero" button on the Company Overview page instead of visiting this link directly.`, false)
    );
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI; // e.g. https://reload-incentive-league.vercel.app/api/xero-callback
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "Xero isn't configured yet — XERO_CLIENT_ID and XERO_REDIRECT_URI must be set in Vercel." });
  }

  // A random value Xero echoes back unchanged — lets the callback confirm
  // this specific request initiated the flow, rather than blindly trusting
  // whatever comes back.
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const scopes = [
    "openid",
    "profile",
    "email",
    "accounting.reports.read",
    "accounting.settings.read",
    "offline_access", // required to receive a refresh token, not just a short-lived access token
  ].join(" ");

  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

// Xero redirects the browser back here after Scott/Lee approves the
// connection in Xero's own consent screen. This exchanges the one-time
// code for a refresh token (which lasts much longer, and is what lets us
// pull fresh reports later without asking anyone to log in again) and
// finds out which Xero organization ("tenant") was actually connected.
async function handleCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send(htmlPage("Connection cancelled", `Xero reported: ${error}`, false));
  }
  if (!code) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send(htmlPage("Something went wrong", "No authorization code was returned by Xero.", false));
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  try {
    // Step 1 — exchange the code for an access token + refresh token.
    const tokenRes = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error("[xero-callback] token exchange failed:", tokenData);
      res.setHeader("Content-Type", "text/html");
      return res.status(400).send(htmlPage("Connection failed", "Xero didn't return a valid token. Check the Vercel logs for details.", false));
    }

    // Step 2 — find out which organization was actually connected. A
    // single Xero app can technically be connected to several, but we
    // only need the one you actually use for Reload.
    const connectionsRes = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const connections = await connectionsRes.json();
    const tenant = Array.isArray(connections) && connections.length ? connections[0] : null;

    await kv.set(TOKENS_KEY, {
      refreshToken: tokenData.refresh_token,
      tenantId: tenant ? tenant.tenantId : null,
      tenantName: tenant ? tenant.tenantName : null,
      connectedAt: new Date().toISOString(),
    });

    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(
      htmlPage(
        "Xero connected",
        `Successfully connected to ${tenant ? tenant.tenantName : "your Xero organization"}. Gross profit and cash figures will now be able to pull from here automatically.`,
        true
      )
    );
  } catch (e) {
    console.error("[xero-callback] error:", e);
    res.setHeader("Content-Type", "text/html");
    return res.status(500).send(htmlPage("Something went wrong", "An unexpected error occurred. Check the Vercel logs for details.", false));
  }
}
