const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
const MANUAL_METRICS_KEY = "company-manual-metrics"; // { [year]: { grossProfitUSD, headcountOverride, notes } }

// Which year a deal counts toward — matches deals.js/commission.js exactly,
// based on the candidate's START DATE, falling back to the signed date.
function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// Each currency independently finds its own most recent set month — see
// deals.js for the full reasoning (GBP might get updated every month while
// EUR is only set occasionally, and each should look for its own history).
function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}
function getRateForCurrency(record, allRates, currency) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    const paidRate = allRates[paidMonthKey] && allRates[paidMonthKey][currency];
    if (paidRate) return paidRate;
  }
  const latestKey = latestSetMonthKeyForCurrency(allRates, currency);
  return latestKey ? allRates[latestKey][currency] : null;
}
async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const rate = getRateForCurrency(record, allRates, record.currency);
  if (!rate) return null;
  return record.shareAmount * rate;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Company-wide figures are Super Admin only — this is strategic/financial
  // data, not something every consultant needs visibility into.
  const user = await getUserFromRequest(req);
  if (!user || !user.isSuperAdmin) {
    return res.status(401).json({ error: "Super Admin access required." });
  }

  const action = req.query.action;

  if (req.method === "GET" && (!action || action === "overview")) {
    const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
    const [records, placements, allRates, manualMetrics] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
      kv.get(FX_KEY).then((v) => v || {}),
      kv.get(MANUAL_METRICS_KEY).then((v) => v || {}),
    ]);

    // Company-wide total — unlike the Deal Lead Award leaderboard, this
    // deliberately INCLUDES every consultant, Scott and Lee included,
    // since this is the true company total, not an individual ranking.
    const yearRecords = records.filter((r) => effectiveYear(r, placements) === year);
    let totalRevenueUSD = 0;
    let countedDeals = 0;
    const byClient = {};
    for (const r of yearRecords) {
      const usd = await convertToUSD(r, allRates);
      if (usd === null) continue; // held back — no rate set for that currency/month yet
      totalRevenueUSD += usd;
      countedDeals += 1;
      const placement = r.placementId ? placements[r.placementId] : null;
      const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";
      byClient[client] = (byClient[client] || 0) + usd;
    }

    const averageFeeUSD = countedDeals > 0 ? totalRevenueUSD / countedDeals : 0;

    const clientConcentration = Object.entries(byClient)
      .map(([client, usd]) => ({ client, totalUSD: usd, percentage: totalRevenueUSD > 0 ? (usd / totalRevenueUSD) * 100 : 0 }))
      .sort((a, b) => b.totalUSD - a.totalUSD);
    const top3Percentage = clientConcentration.slice(0, 3).reduce((s, c) => s + c.percentage, 0);
    const top5Percentage = clientConcentration.slice(0, 5).reduce((s, c) => s + c.percentage, 0);

    const manual = manualMetrics[year] || {};

    return res.status(200).json({
      year,
      totalRevenueUSD,
      countedDeals,
      averageFeeUSD,
      clientConcentration,
      top3Percentage,
      top5Percentage,
      grossProfitUSD: manual.grossProfitUSD ?? null,
      grossProfitNotes: manual.notes || null,
    });
  }

  if (req.method === "POST" && action === "set-manual-metric") {
    const { year, grossProfitUSD, notes } = req.body || {};
    const y = parseInt(year, 10);
    if (!y) return res.status(400).json({ error: "A valid year is required." });
    const all = (await kv.get(MANUAL_METRICS_KEY)) || {};
    all[y] = {
      ...all[y],
      grossProfitUSD: grossProfitUSD === "" || grossProfitUSD === undefined ? (all[y] && all[y].grossProfitUSD) || null : Number(grossProfitUSD),
      notes: notes !== undefined ? notes : (all[y] && all[y].notes) || null,
    };
    await kv.set(MANUAL_METRICS_KEY, all);
    return res.status(200).json({ ok: true, year: y, metrics: all[y] });
  }

  return res.status(400).json({ error: "Unknown action." });
};
