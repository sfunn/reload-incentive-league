const { kv } = require("@vercel/kv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Only these 12 people are allowed to have an account — this is a fixed
// whitelist, not open signup. Same set as the Deal Lead Award (10 consultants
// + James + Josh, the two team leaders who are also real fee-earners).
const EMAIL_TO_CONSULTANT = {
  "alex@reloadsearch.com": { id: "alex-silverman", name: "Alex Silverman" },
  "ash@reloadsearch.com": { id: "ash-thiara", name: "Ash Thiara" },
  "jack@reloadsearch.com": { id: "jack-thompson", name: "Jack Thompson" },
  "max@reloadsearch.com": { id: "max-hart", name: "Max Hart" },
  "oleg@reloadsearch.com": { id: "oleg-sokyrka", name: "Oleg Sokyrka" },
  "alexander@reloadsearch.com": { id: "alex-aparo", name: "Alex Aparo" },
  "jackr@reloadsearch.com": { id: "jack-routledge", name: "Jack Routledge" },
  "joe@reloadsearch.com": { id: "joe-purton", name: "Joe Purton" },
  "joshd@reloadsearch.com": { id: "josh-davis", name: "Josh Davis" },
  "natasha@reloadsearch.com": { id: "natasha-barnard", name: "Natasha Barnard" },
  "james@reloadsearch.com": { id: "james-lancer", name: "James Lancer" },
  "josh@reloadsearch.com": { id: "josh-stark", name: "Josh Stark" },
};

const USERS_KEY = "auth-users";

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function requireSuperAdmin(req, res) {
  if (!process.env.SUPER_ADMIN_PASSCODE) {
    res.status(500).json({ error: "SUPER_ADMIN_PASSCODE is not set on the server" });
    return false;
  }
  const passcode = req.method === "GET" ? req.query.passcode : (req.body || {}).passcode;
  if (passcode !== process.env.SUPER_ADMIN_PASSCODE) {
    res.status(401).json({ error: "Incorrect passcode" });
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.AUTH_JWT_SECRET) {
    return res.status(500).json({ error: "AUTH_JWT_SECRET is not set on the server" });
  }

  const action = req.method === "GET" ? req.query.action : req.query.action;
  const body = req.body || {};

  // --- LIST USERS: Scott/Lee only, to see who has an account yet ---
  if (req.method === "GET" && action === "list-users") {
    if (!requireSuperAdmin(req, res)) return;
    const users = (await kv.get(USERS_KEY)) || {};
    const list = Object.entries(EMAIL_TO_CONSULTANT).map(([email, c]) => ({
      email,
      name: c.name,
      consultantId: c.id,
      hasAccount: !!users[email],
    }));
    return res.status(200).json({ users: list });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // --- LOG IN ---
  if (action === "login") {
    const email = normalizeEmail(body.email);
    const { password } = body;
    const users = (await kv.get(USERS_KEY)) || {};
    const user = users[email];
    if (!user) {
      return res.status(401).json({ error: "No account found for this email. Ask Scott or Lee to set you up." });
    }
    const match = await bcrypt.compare(password || "", user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const token = jwt.sign({ email, consultantId: user.consultantId, name: user.name }, process.env.AUTH_JWT_SECRET, { expiresIn: "30d" });
    return res.status(200).json({ ok: true, token, consultantId: user.consultantId, name: user.name });
  }

  // --- ADMIN SET/RESET PASSWORD: Scott/Lee only. Creates the account if it
  // doesn't exist yet, or overwrites the password if it does. ---
  if (action === "admin-set-password") {
    if (!requireSuperAdmin(req, res)) return;
    const email = normalizeEmail(body.email);
    const { newPassword } = body;
    const consultant = EMAIL_TO_CONSULTANT[email];
    if (!consultant) {
      return res.status(400).json({ error: "That email isn't on the consultant list." });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const users = (await kv.get(USERS_KEY)) || {};
    const passwordHash = await bcrypt.hash(newPassword, 10);
    users[email] = {
      passwordHash,
      consultantId: consultant.id,
      name: consultant.name,
      createdAt: (users[email] && users[email].createdAt) || new Date().toISOString(),
    };
    await kv.set(USERS_KEY, users);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action." });
};
