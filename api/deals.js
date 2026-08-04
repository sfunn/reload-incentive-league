const { kv } = require("@vercel/kv");

const RECORDS_KEY = "atlas-fee-records";
const FX_KEY = "atlas-fx-rates";

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const monthKey = monthKeyFromDateStr(record.feeDate);
  const monthRates = allRates[monthKey];
  const rate = monthRates && monthRates[record.currency];
  if (!rate) return null; // no rate set for that month/currency yet
  return record.shareAmount * rate;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const records = (await kv.get(RECORDS_KEY)) || [];
    const allRates = (await kv.get(FX_KEY)) || {};
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();

    // Scott/Lee-only: full detail view, including unconverted deals
    // (missing an FX rate for their month) so they know a rate needs setting.
    if (req.query.detail === "true") {
      if (!process.env.SUPER_ADMIN_PASSCODE) {
        return res.status(500).json({ error: "SUPER_ADMIN_PASSCODE is not set on the server" });
      }
      if (req.query.passcode !== process.env.SUPER_ADMIN_PASSCODE) {
        return res.status(401).json({ error: "Incorrect passcode" });
      }
      const yearRecords = records.filter((r) => r.year === year);
      const withUSD = await Promise.all(
        yearRecords.map(async (r) => ({ ...r, usdAmount: await convertToUSD(r, allRates) }))
      );
      return res.status(200).json({ year, records: withUSD });
    }

    // Public leaderboard: totals per consultant, in USD, for the given year.
    // Deals missing an FX rate for their month are silently excluded from
    // the total (rather than guessing) — they'll appear once Scott/Lee set
    // that month's rate.
    const yearRecords = records.filter((r) => r.year === year && r.consultantId);
    const totals = {};
    for (const r of yearRecords) {
      const usd = await convertToUSD(r, allRates);
      if (usd === null) continue;
      if (!totals[r.consultantId]) {
        totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalUSD: 0 };
      }
      totals[r.consultantId].totalUSD += usd;
    }
    const leaderboard = Object.values(totals).sort((a, b) => b.totalUSD - a.totalUSD);
    return res.status(200).json({ year, leaderboard });
  }

  if (req.method === "POST") {
    // Mark a fee record as paid — Scott/Lee only. This is the manual
    // trigger point: the 4-month commission payout clock starts the month
    // AFTER this is set, computed later in the commission logic (Phase 2).
    const { passcode, feeId, splitId, paid } = req.body || {};
    if (!process.env.SUPER_ADMIN_PASSCODE) {
      return res.status(500).json({ error: "SUPER_ADMIN_PASSCODE is not set on the server" });
    }
    if (passcode !== process.env.SUPER_ADMIN_PASSCODE) {
      return res.status(401).json({ error: "Incorrect passcode" });
    }
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }
    records[idx].paid = !!paid;
    records[idx].paidMarkedAt = paid ? new Date().toISOString() : null;
    await kv.set(RECORDS_KEY, records);
    return res.status(200).json({ ok: true, record: records[idx] });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
