const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const { STANDARD_BANDS, computeCommissionLines, payoutSchedule, singleMonthPayout } = require("./_commissionEngine");

const SETTINGS_KEY = "commission-settings";
const RECORDS_KEY = "atlas-fee-records";
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";
const DEFAULT_FLAT_RATE = 500;

// Coordinators earn a flat fee per deal they're manually assigned to,
// rather than the tiered bracket system consultants use.
const COORDINATOR_IDS = new Set(["izzy-coordinator", "zoe-coordinator"]);

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// "YYYY-MM" keys sort correctly as plain strings, so the last one after
// sorting is simply the most recent month Scott/Lee have actually entered
// a rate for.
function latestSetMonthKey(allRates) {
  const keys = Object.keys(allRates).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

// Prefers the REAL rate from the month a deal was actually paid, once
// Scott/Lee have set one for that specific month. Otherwise — not paid
// yet, or paid but that exact month has no rate entered — falls back to
// whichever month they most recently set a rate for. This is deliberately
// NEVER tied to today's literal calendar date: rates are set manually,
// so "today" might not have one yet, and using it would either wrongly
// show "held back" or silently disagree with what's already on screen.
function applicableMonthRates(record, allRates) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    if (allRates[paidMonthKey]) return allRates[paidMonthKey];
  }
  const latestKey = latestSetMonthKey(allRates);
  return latestKey ? allRates[latestKey] : null;
}

// Converts a deal's share amount into GBP, using the SAME monthly rates
// already set in Deal Lead Award (stored as "1 unit of that currency = X
// USD") — just run in reverse for GBP/EUR, and via USD as a bridge for EUR.
function convertToGBP(record, allRates) {
  const monthRates = applicableMonthRates(record, allRates);
  if (record.currency === "GBP") return record.shareAmount;
  if (!monthRates || !monthRates.GBP) return null; // no GBP rate for that month yet
  if (record.currency === "USD") return record.shareAmount / monthRates.GBP;
  if (record.currency === "EUR") {
    if (!monthRates.EUR) return null;
    const usdEquivalent = record.shareAmount * monthRates.EUR;
    return usdEquivalent / monthRates.GBP;
  }
  return null;
}

// Which year a deal counts toward is based on the candidate's START DATE,
// not the signed/fee date — matching deals.js, so a deal never lands on a
// different year's commission sheet than it does on the leaderboard.
// Falls back to the fee's own date only when there's no linked placement
// start date yet.
function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  // --- GET settings: Super Admin only, returns bands+targets for everyone ---
  if (req.method === "GET" && action === "settings") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const all = (await kv.get(SETTINGS_KEY)) || {};
    return res.status(200).json({ settings: all, standardBands: STANDARD_BANDS });
  }

  // --- GET compute: the consultant themselves, or Super Admin viewing anyone ---
  if (req.method === "GET" && action === "compute") {
    const caller = await getUserFromRequest(req);
    const consultantId = req.query.consultantId;
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
    if (!caller || !consultantId) return res.status(401).json({ error: "Not authorized" });
    if (!caller.isSuperAdmin && caller.consultantId !== consultantId) {
      return res.status(401).json({ error: "Not authorized to view this person's commission" });
    }

    const allRecords = (await kv.get(RECORDS_KEY)) || [];
    const allRates = (await kv.get(FX_KEY)) || {};
    const placements = (await kv.get(PLACEMENTS_KEY)) || {};
    const allSettings = (await kv.get(SETTINGS_KEY)) || {};
    const personSettings = allSettings[consultantId] || {};

    // --- COORDINATOR: flat fee per deal they're manually assigned to ---
    if (COORDINATOR_IDS.has(consultantId)) {
      const flatRate =
        (personSettings.flatRateByYear && personSettings.flatRateByYear[year]) || DEFAULT_FLAT_RATE;

      const yearRecords = allRecords.filter((r) => effectiveYear(r, placements) === year && r.coordinatorId === consultantId);
      const withOrderDate = yearRecords.map((r) => {
        const placement = r.placementId ? placements[r.placementId] : null;
        const orderDate = (placement && placement.startDate) || r.feeDate;
        const candidateName = (placement && placement.candidateName) || null;
        const startDate = (placement && placement.startDate) || null;
        return { ...r, orderDate, candidateName, startDate };
      });
      withOrderDate.sort((a, b) => (a.orderDate || "").localeCompare(b.orderDate || ""));

      const lines = withOrderDate.map((r) => ({
        feeId: r.feeId,
        splitId: r.splitId,
        feeDate: r.feeDate,
        startDate: r.startDate,
        commission: flatRate,
        paid: r.paid,
        paidMarkedAt: r.paidMarkedAt,
        source: r.source || null,
        candidateName: r.candidateName,
        monthOverrides: r.monthOverrides || {},
      }));
      const linesWithSchedule = lines.map((l) => ({ ...l, payout: singleMonthPayout(l) }));
      const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);

      return res.status(200).json({
        consultantId,
        year,
        isCoordinator: true,
        flatRate,
        dealCount: lines.length,
        totalCommission,
        target: (personSettings.targets && personSettings.targets[year]) || null,
        lines: linesWithSchedule,
        heldBackCount: 0,
      });
    }

    // --- CONSULTANT: tiered brackets, cumulative through the year ---
    // Bands are set PER YEAR — e.g. a promotion at the end of 2026 can give
    // someone better brackets for 2027 without touching 2026's numbers.
    // Falls back to the standard ladder if that year has never been set.
    const bands =
      (personSettings.bandsByYear && personSettings.bandsByYear[year] && personSettings.bandsByYear[year].length)
        ? personSettings.bandsByYear[year]
        : STANDARD_BANDS;
    const target = (personSettings.targets && personSettings.targets[year]) || null;

    const yearRecords = allRecords.filter(
      (r) => effectiveYear(r, placements) === year && r.consultantId === consultantId
    );

    // Order by placement start date where we have it; fall back to the
    // fee's own date if the placement webhook hasn't given us a start date
    // for that deal yet.
    const withOrderDate = yearRecords.map((r) => {
      const placement = r.placementId ? placements[r.placementId] : null;
      const orderDate = (placement && placement.startDate) || r.feeDate;
      const candidateName = (placement && placement.candidateName) || null;
      const startDate = (placement && placement.startDate) || null;
      return { ...r, orderDate, candidateName, startDate };
    });
    withOrderDate.sort((a, b) => (a.orderDate || "").localeCompare(b.orderDate || ""));

    const dealsForEngine = withOrderDate.map((r) => ({
      feeId: r.feeId,
      splitId: r.splitId,
      gbpAmount: convertToGBP(r, allRates),
      feeDate: r.feeDate,
      startDate: r.startDate,
      paid: r.paid,
      paidMarkedAt: r.paidMarkedAt,
      source: r.source,
      candidateName: r.candidateName,
      monthOverrides: r.monthOverrides || {},
    }));

    const heldBack = dealsForEngine.filter((d) => d.gbpAmount === null).length;
    const usableDeals = dealsForEngine.filter((d) => d.gbpAmount !== null);

    const { lines, totalGBP, totalCommission } = computeCommissionLines(usableDeals, bands);
    const linesWithSchedule = lines.map((l) => ({ ...l, payout: payoutSchedule(l) }));

    return res.status(200).json({
      consultantId,
      year,
      isCoordinator: false,
      bands,
      target,
      totalGBP,
      totalCommission,
      lines: linesWithSchedule,
      heldBackCount: heldBack, // deals whose currency has no GBP rate set yet for their month
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // --- SET BANDS: Super Admin only. Bands are per consultant PER YEAR. ---
  if (action === "set-bands") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const { consultantId, year, bands } = req.body || {};
    if (!consultantId || !year || !Array.isArray(bands)) {
      return res.status(400).json({ error: "consultantId, year, and bands are required" });
    }
    const all = (await kv.get(SETTINGS_KEY)) || {};
    const existing = all[consultantId] || {};
    all[consultantId] = { ...existing, bandsByYear: { ...(existing.bandsByYear || {}), [year]: bands } };
    await kv.set(SETTINGS_KEY, all);
    return res.status(200).json({ ok: true });
  }

  // --- SET TARGET: Super Admin only ---
  if (action === "set-target") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const { consultantId, year, target } = req.body || {};
    if (!consultantId || !year) {
      return res.status(400).json({ error: "consultantId and year are required" });
    }
    const all = (await kv.get(SETTINGS_KEY)) || {};
    const existing = all[consultantId] || {};
    all[consultantId] = { ...existing, targets: { ...(existing.targets || {}), [year]: target } };
    await kv.set(SETTINGS_KEY, all);
    return res.status(200).json({ ok: true });
  }

  // --- SET FLAT RATE: Super Admin only. For coordinators, per year. ---
  if (action === "set-flat-rate") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const { consultantId, year, rate } = req.body || {};
    if (!consultantId || !year || rate === undefined) {
      return res.status(400).json({ error: "consultantId, year, and rate are required" });
    }
    const all = (await kv.get(SETTINGS_KEY)) || {};
    const existing = all[consultantId] || {};
    all[consultantId] = { ...existing, flatRateByYear: { ...(existing.flatRateByYear || {}), [year]: parseFloat(rate) || 0 } };
    await kv.set(SETTINGS_KEY, all);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action." });
};
