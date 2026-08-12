const { kv } = require("@vercel/kv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getUserFromRequest, SUPER_ADMIN_EMAILS, USERS_KEY } = require("./_authHelpers");

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
  // Scott and Lee aren't consultants (no leaderboard entry, no commission
  // sheet), but they still need real accounts to log in through the same
  // single login as everyone else — their Super Admin status comes from
  // SUPER_ADMIN_EMAILS in _authHelpers.js, not from being in this list.
  "scott@reloadsearch.com": { id: null, name: "Scott Finn" },
  "lee@reloadsearch.com": { id: null, name: "Lee Mamo" },
  // Coordinators — not fee-earning consultants, no leaderboard entry, but
  // they get their own Commission page showing a flat fee per deal they're
  // manually assigned to (rather than the tiered bracket system).
  "isabelle@reloadsearch.com": { id: "izzy-coordinator", name: "Izzy", isCoordinator: true },
  "alexandra@reloadsearch.com": { id: "zoe-coordinator", name: "Alexandra", isCoordinator: true },
};

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function effectiveRoles(email, record) {
  const isSuperAdmin = !!(record && record.isSuperAdmin) || SUPER_ADMIN_EMAILS.has(email);
  const isAdmin = !!(record && record.isAdmin) || isSuperAdmin;
  return { isAdmin, isSuperAdmin };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.AUTH_JWT_SECRET) {
    return res.status(500).json({ error: "AUTH_JWT_SECRET is not set on the server" });
  }

  const action = req.query.action;
  const body = req.body || {};

  // --- LIST USERS: Super Admin only ---
  if (req.method === "GET" && action === "list-users") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const users = (await kv.get(USERS_KEY)) || {};
    const list = Object.entries(EMAIL_TO_CONSULTANT).map(([email, c]) => {
      const record = users[email];
      const roles = effectiveRoles(email, record);
      return {
        email,
        name: c.name,
        consultantId: c.id,
        hasAccount: !!record,
        isAdmin: roles.isAdmin,
        isSuperAdmin: roles.isSuperAdmin,
        isPermanentSuperAdmin: SUPER_ADMIN_EMAILS.has(email),
      };
    });
    return res.status(200).json({ users: list });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // --- SIGN UP ---
  if (action === "signup") {
    const email = normalizeEmail(body.email);
    const { password } = body;
    const consultant = EMAIL_TO_CONSULTANT[email];
    if (!consultant) {
      return res.status(403).json({ error: "This email isn't recognised. Check with Scott or Lee." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const users = (await kv.get(USERS_KEY)) || {};
    if (users[email]) {
      return res.status(409).json({ error: "An account already exists for this email — try logging in instead." });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    users[email] = {
      passwordHash,
      consultantId: consultant.id,
      name: consultant.name,
      isAdmin: false,
      isSuperAdmin: false,
      createdAt: new Date().toISOString(),
    };
    await kv.set(USERS_KEY, users);
    const roles = effectiveRoles(email, users[email]);
    const token = jwt.sign({ email }, process.env.AUTH_JWT_SECRET, { expiresIn: "30d" });
    return res.status(200).json({ ok: true, token, consultantId: consultant.id, name: consultant.name, ...roles });
  }

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
    const roles = effectiveRoles(email, user);
    const token = jwt.sign({ email }, process.env.AUTH_JWT_SECRET, { expiresIn: "30d" });
    return res.status(200).json({ ok: true, token, consultantId: user.consultantId, name: user.name, ...roles });
  }

  // --- ADMIN SET/RESET PASSWORD: Super Admin only ---
  if (action === "admin-set-password") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
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
      ...(users[email] || {}),
      passwordHash,
      consultantId: consultant.id,
      name: consultant.name,
      isAdmin: (users[email] && users[email].isAdmin) || false,
      isSuperAdmin: (users[email] && users[email].isSuperAdmin) || false,
      createdAt: (users[email] && users[email].createdAt) || new Date().toISOString(),
    };
    await kv.set(USERS_KEY, users);
    return res.status(200).json({ ok: true });
  }

  // --- ADMIN SET ROLES: Super Admin only ---
  if (action === "admin-set-roles") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const email = normalizeEmail(body.email);
    const consultant = EMAIL_TO_CONSULTANT[email];
    if (!consultant) {
      return res.status(400).json({ error: "That email isn't on the consultant list." });
    }
    const users = (await kv.get(USERS_KEY)) || {};
    if (!users[email]) {
      return res.status(400).json({ error: "This person doesn't have an account yet — set a password for them first." });
    }
    users[email].isAdmin = !!body.isAdmin;
    users[email].isSuperAdmin = !!body.isSuperAdmin;
    await kv.set(USERS_KEY, users);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action." });
};
