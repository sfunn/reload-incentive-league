const { getUserFromRequest } = require("./_authHelpers");

// This is the "Connect to Xero" step — Scott or Lee visits this URL once,
// gets sent to Xero's own login/consent screen, and Xero redirects back to
// our callback endpoint with a temporary code we exchange for real tokens.
//
// Unlike every other endpoint in this app, this one has to be a genuine
// browser navigation (the browser itself needs to physically leave for
// Xero's login page) — it can't be called via fetch() from inside the
// React app the normal way, so there's no custom Authorization header to
// read. Instead, the token is passed as a ?token= query parameter, built
// by the "Connect to Xero" button in the app itself.
module.exports = async (req, res) => {
  const queryToken = req.query.token;
  const fakeReq = queryToken ? { headers: { authorization: `Bearer ${queryToken}` } } : req;
  const user = await getUserFromRequest(fakeReq);
  if (!user || !user.isSuperAdmin) {
    res.setHeader("Content-Type", "text/html");
    return res.status(401).send(
      `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2 style="color: #c0392b;">Super Admin access required</h2>
        <p>Use the "Connect to Xero" button on the Company Overview page instead of visiting this link directly.</p>
      </body></html>`
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
};
