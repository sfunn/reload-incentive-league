const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

// Current team assignment overrides, keyed by consultantId → "james" | "josh".
// Anyone not in here uses the default from the frontend's INITIAL_CONSULTANTS
// list. This is deliberately public-readable (like the league data itself)
// since it's needed to render the League Table for everyone, logged in or
// not — only changing it is restricted.
const KEY = "consultant-teams";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const teams = (await kv.get(KEY)) || {};
    return res.status(200).json({ teams });
  }

  if (req.method === "POST") {
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    const { consultantId, team } = req.body || {};
    if (!consultantId || (team !== "james" && team !== "josh")) {
      return res.status(400).json({ error: "consultantId and a valid team (james/josh) are required" });
    }
    const teams = (await kv.get(KEY)) || {};
    teams[consultantId] = team;
    await kv.set(KEY, teams);
    return res.status(200).json({ ok: true, teams });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
