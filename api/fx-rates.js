const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

// Rates are stored per calendar month, e.g. "2026-08", so historical months
// keep whatever rate was set at the time rather than being overwritten by
// later changes. Rate is "how many units of this currency equal 1 USD"
// is NOT what we store — instead we store "1 unit of this currency = X USD",
// so converting is just: amountInThatCurrency * rate = amountInUSD.
const KEY = "atlas-fx-rates";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const rates = (await kv.get(KEY)) || {};
    return res.status(200).json({ rates });
  }

  if (req.method === "POST") {
    // Exchange rates are set by Scott/Lee only — James and Josh are
    // themselves earners on the Deal Lead Award and shouldn't be the ones
    // setting the conversion rate their own numbers are judged against.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    const { monthKey, yearKey, rates: monthRates } = req.body || {};
    if (typeof monthRates !== "object") {
      return res.status(400).json({ error: "Malformed rates payload" });
    }
    const all = (await kv.get(KEY)) || {};

    // Setting a whole year at once — useful for backfilling older years
    // (e.g. 2024) where monthly precision isn't available or doesn't
    // matter, without having to enter the same rate twelve separate times.
    if (yearKey) {
      const year = String(parseInt(yearKey, 10));
      if (!year || year === "NaN") {
        return res.status(400).json({ error: "Malformed yearKey" });
      }
      for (let m = 1; m <= 12; m++) {
        const mk = `${year}-${String(m).padStart(2, "0")}`;
        all[mk] = monthRates;
      }
      await kv.set(KEY, all);
      return res.status(200).json({ ok: true, yearKey: year, rates: monthRates });
    }

    if (!monthKey) {
      return res.status(400).json({ error: "Either monthKey or yearKey is required" });
    }
    // monthRates expected shape: { GBP: 1.27, EUR: 1.09, USD: 1 }
    all[monthKey] = monthRates;
    await kv.set(KEY, all);
    return res.status(200).json({ ok: true, monthKey, rates: monthRates });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
