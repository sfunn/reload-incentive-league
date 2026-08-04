const { kv } = require("@vercel/kv");
const jwt = require("jsonwebtoken");

// Permanently Super Admin, regardless of what's stored in their user record —
// this is how Scott/Lee bootstrap access without a chicken-and-egg problem
// (Manage Logins itself requires Super Admin to view).
const SUPER_ADMIN_EMAILS = new Set(["scott@reloadsearch.com", "lee@reloadsearch.com"]);
const USERS_KEY = "auth-users";

// Reads the Authorization: Bearer <token> header, verifies its signature,
// then looks up the CURRENT role flags from KV rather than trusting whatever
// was baked into the token at login time — so a promotion/demotion by
// Scott/Lee takes effect immediately, without the person needing to log out
// and back in.
async function getUserFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !process.env.AUTH_JWT_SECRET) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.AUTH_JWT_SECRET);
  } catch (e) {
    return null;
  }

  const email = decoded.email;
  const users = (await kv.get(USERS_KEY)) || {};
  const record = users[email];
  if (!record) return null;

  const isSuperAdmin = !!record.isSuperAdmin || SUPER_ADMIN_EMAILS.has(email);
  const isAdmin = !!record.isAdmin || isSuperAdmin;

  return {
    email,
    consultantId: record.consultantId,
    name: record.name,
    isAdmin,
    isSuperAdmin,
  };
}

module.exports = { getUserFromRequest, SUPER_ADMIN_EMAILS, USERS_KEY };
