const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

const RECORDS_KEY = "atlas-fee-records";
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const records = (await kv.get(RECORDS_KEY)) || [];
    const allRates = (await kv.get(FX_KEY)) || {};
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();

    // Super Admin only: full detail view, including unconverted deals
    // (missing an FX rate for their month) so they know a rate needs setting.
    if (req.query.detail === "true") {
      const user = await getUserFromRequest(req);
      if (!user || !user.isSuperAdmin) {
        return res.status(401).json({ error: "Super Admin access required" });
      }
      const yearRecords = records.filter((r) => r.year === year);
      const placements = (await kv.get(PLACEMENTS_KEY)) || {};
      const withUSD = await Promise.all(
        yearRecords.map(async (r) => {
          const placement = r.placementId ? placements[r.placementId] : null;
          return {
            ...r,
            usdAmount: await convertToUSD(r, allRates),
            candidateName: (placement && placement.candidateName) || null,
            clientCompanyName: (placement && placement.clientCompanyName) || null,
            placementStartDate: (placement && placement.startDate) || null,
            excludedFromCommission: !!r.excludedFromCommission,
            source: r.source || null,
          };
        })
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
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Not authorized" });

    const { feeId, splitId, paid, excludedFromCommission, source } = req.body || {};
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Paid and excludedFromCommission are financial/admin decisions —
    // Super Admin only. Source is just "how did this deal come in", which
    // the consultant themselves can also set on their own deals.
    const changingRestrictedFields = paid !== undefined || excludedFromCommission !== undefined;
    if (changingRestrictedFields && !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    if (source !== undefined && !user.isSuperAdmin && user.consultantId !== records[idx].consultantId) {
      return res.status(401).json({ error: "You can only set the source on your own deals" });
    }

    if (paid !== undefined) {
      records[idx].paid = !!paid;
      records[idx].paidMarkedAt = paid ? new Date().toISOString() : null;
    }
    if (excludedFromCommission !== undefined) {
      records[idx].excludedFromCommission = !!excludedFromCommission;
    }
    if (source !== undefined) {
      records[idx].source = source || null;
    }

    await kv.set(RECORDS_KEY, records);
    return res.status(200).json({ ok: true, record: records[idx] });
  }

  if (req.method === "DELETE") {
    // Super Admin only. Removes the record entirely — since commission and
    // the leaderboard are both calculated live from this data, the deleted
    // deal disappears from that person's commission sheet and the Deal Lead
    // Award total the moment it's gone, with nothing else to update.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    const { feeId, splitId } = req.body || {};
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }
    records.splice(idx, 1);
    await kv.set(RECORDS_KEY, records);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
