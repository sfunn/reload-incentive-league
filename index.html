const { kv } = require("@vercel/kv");

const KEY = "reload-league-weeks";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    // Passcode check only — no data returned or touched.
    if (typeof req.query.checkPasscode === "string") {
      const valid = req.query.checkPasscode === process.env.ADMIN_PASSCODE;
      return res.status(200).json({ valid });
    }
    const weeks = (await kv.get(KEY)) || [];
    return res.status(200).json({ weeks });
  }

  if (req.method === "POST") {
    const { passcode, weeks } = req.body || {};
    if (!process.env.ADMIN_PASSCODE) {
      return res.status(500).json({ error: "ADMIN_PASSCODE is not set on the server" });
    }
    if (passcode !== process.env.ADMIN_PASSCODE) {
      return res.status(401).json({ error: "Incorrect passcode" });
    }
    if (!Array.isArray(weeks)) {
      return res.status(400).json({ error: "Malformed weeks payload" });
    }
    await kv.set(KEY, weeks);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
