const { kv } = require("@vercel/kv");

const TOKENS_KEY = "xero-oauth-tokens"; // { refreshToken, tenantId, tenantName, connectedAt }

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
  <body style="font-family: sans-serif; padding: 40px; text-align: center;">
    <h2 style="color: ${ok ? "#2e405b" : "#c0392b"};">${title}</h2>
    <p>${message}</p>
    <p><a href="/">Return to Reload Incentive League</a></p>
  </body></html>`;
}

// Xero redirects the browser back here after Scott/Lee approves the
// connection in Xero's own consent screen. This exchanges the one-time
// code for a refresh token (which lasts much longer, and is what lets us
// pull fresh reports later without asking anyone to log in again) and
// finds out which Xero organization ("tenant") was actually connected.
module.exports = async (req, res) => {
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
};
