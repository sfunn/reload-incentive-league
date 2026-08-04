const { kv } = require("@vercel/kv");

// Rates are stored per calendar month, e.g. "2026-08", so historical months
// keep whatever rate was set at the time rather than being overwritten by
// later changes. Rate is "how many units of this currency equal 1 USD"
// is NOT what we store — instead we store "1 unit of this currency = X USD",
// so converting is just: amountInThatCurrency * rate = amountInUSD.
const KEY = "atlas-fx-rates";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const rates = (await kv.get(KEY)) || {};
    return res.status(200).json({ rates });
  }

  if (req.method === "POST") {
    // Exchange rates are set by Scott/Lee only — a separate, higher-tier
    // passcode from the general ADMIN_PASSCODE, since James and Josh are
    // themselves earners on the Deal Lead Award and shouldn't be the ones
    // setting the conversion rate their own numbers are judged against.
    const { passcode, monthKey, rates: monthRates } = req.body || {};
    if (!process.env.SUPER_ADMIN_PASSCODE) {
      return res.status(500).json({ error: "SUPER_ADMIN_PASSCODE is not set on the server" });
    }
    if (passcode !== process.env.SUPER_ADMIN_PASSCODE) {
      return res.status(401).json({ error: "Incorrect passcode" });
    }
    if (!monthKey || typeof monthRates !== "object") {
      return res.status(400).json({ error: "Malformed rates payload" });
    }
    // monthRates expected shape: { GBP: 1.27, EUR: 1.09, USD: 1 }
    const all = (await kv.get(KEY)) || {};
    all[monthKey] = monthRates;
    await kv.set(KEY, all);
    return res.status(200).json({ ok: true, monthKey, rates: monthRates });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
