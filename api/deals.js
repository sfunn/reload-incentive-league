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
            monthOverrides: r.monthOverrides || {},
            coordinatorId: r.coordinatorId || null,
            source: r.source || null,
          };
        })
      );

      // Firm/Client breakdown — Super Admin only. Uses the Client field
      // captured from Atlas's placement webhook. Deals with no linked
      // placement yet (or from an unmapped owner) fall into "Unknown" so
      // the percentages still add up to the full total.
      const byClient = {};
      let clientGrandTotal = 0;
      for (const r of withUSD) {
        if (r.usdAmount === null || !r.consultantId) continue;
        const firm = r.clientCompanyName || "Unknown";
        if (!byClient[firm]) byClient[firm] = { firm, totalUSD: 0 };
        byClient[firm].totalUSD += r.usdAmount;
        clientGrandTotal += r.usdAmount;
      }
      const clientBreakdown = Object.values(byClient)
        .map((c) => ({ ...c, percentage: clientGrandTotal > 0 ? (c.totalUSD / clientGrandTotal) * 100 : 0 }))
        .sort((a, b) => b.totalUSD - a.totalUSD);

      return res.status(200).json({ year, records: withUSD, clientBreakdown, clientGrandTotal });
    }

    // Public leaderboard: totals per consultant, in USD, for the given year.
    // Deals missing an FX rate for their month are silently excluded from
    // the total (rather than guessing) — they'll appear once Scott/Lee set
    // that month's rate.
    const yearRecords = records.filter((r) => r.year === year && r.consultantId);
    const totals = {};
    const bySource = {};
    for (const r of yearRecords) {
      const usd = await convertToUSD(r, allRates);
      if (usd === null) continue;
      if (!totals[r.consultantId]) {
        totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalUSD: 0 };
      }
      totals[r.consultantId].totalUSD += usd;

      // Source breakdown — visible to everyone, same as the leaderboard.
      // Deals without a source set yet just aren't counted here (rather
      // than guessing), so this total may be a bit less than the full
      // leaderboard total until every deal has a source recorded.
      if (r.source) {
        if (!bySource[r.source]) bySource[r.source] = { source: r.source, deals: 0, valueUSD: 0 };
        bySource[r.source].deals += 1;
        bySource[r.source].valueUSD += usd;
      }
    }
    const leaderboard = Object.values(totals).sort((a, b) => b.totalUSD - a.totalUSD);
    const sourceBreakdown = Object.values(bySource).sort((a, b) => b.valueUSD - a.valueUSD);
    return res.status(200).json({ year, leaderboard, sourceBreakdown });
  }

  if (req.method === "POST") {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Not authorized" });

    const { feeId, splitId, paid, paidDate, monthOverrides, source, coordinatorId, recalibrateToMonth } = req.body || {};
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Paid, paidDate, monthOverrides, coordinatorId, and recalibrateToMonth
    // are financial/admin decisions — Super Admin only. Source is just
    // "how did this deal come in", which the consultant themselves can
    // also set on their own deals.
    const changingRestrictedFields =
      paid !== undefined || paidDate !== undefined || monthOverrides !== undefined ||
      coordinatorId !== undefined || recalibrateToMonth !== undefined;
    if (changingRestrictedFields && !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    if (source !== undefined && !user.isSuperAdmin && user.consultantId !== records[idx].consultantId) {
      return res.status(401).json({ error: "You can only set the source on your own deals" });
    }

    if (paid !== undefined) {
      records[idx].paid = !!paid;
      if (!paid) {
        records[idx].paidMarkedAt = null;
      } else if (!records[idx].paidMarkedAt) {
        // Only default to "right now" the first time it's marked Paid —
        // if it's already paid and just the date is being edited (see
        // paidDate below), this won't stomp on that.
        records[idx].paidMarkedAt = new Date().toISOString();
      }
    }
    // A separate, explicit date lets Scott/Lee backfill deals that were
    // genuinely paid months ago, so the 4-month clock starts from the real
    // payment date rather than from whenever they happened to tick the box.
    if (paidDate !== undefined && records[idx].paid) {
      const d = new Date(paidDate);
      if (!isNaN(d.getTime())) records[idx].paidMarkedAt = d.toISOString();
    }
    // Marking a specific month "Due" from the Commission page doesn't set
    // a sticky flag — it corrects paidMarkedAt itself, so that month
    // naturally computes as due THIS real month, and everything before
    // and after it keeps auto-advancing correctly forever with no further
    // manual upkeep. Clears any existing overrides since the whole row's
    // timeline has just been resynced to reality.
    if (recalibrateToMonth !== undefined) {
      const now = new Date();
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - recalibrateToMonth, 1));
      records[idx].paid = true;
      records[idx].paidMarkedAt = target.toISOString();
      records[idx].monthOverrides = {};
    }
    if (monthOverrides !== undefined) {
      records[idx].monthOverrides = (monthOverrides && typeof monthOverrides === "object") ? monthOverrides : {};
    }
    if (source !== undefined) {
      records[idx].source = source || null;
    }
    if (coordinatorId !== undefined) {
      records[idx].coordinatorId = coordinatorId || null;
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
