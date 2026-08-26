const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
// ============================================================================
// Inlined from the old standalone _commissionEngine.js — merged in to
// reduce the total number of files Vercel counts as serverless functions
// (the free Hobby plan caps at 12), since only this file ever used it.
// ============================================================================

// Standard commission ladder — the default for everyone. Individual
// consultants (e.g. Josh Stark) can have this fully overridden in
// commission-settings, band-for-band.
const STANDARD_BANDS = [
  { min: 0, max: 150000, rate: 0.10 },
  { min: 150000, max: 300000, rate: 0.125 },
  { min: 300000, max: 450000, rate: 0.15 },
  { min: 450000, max: 600000, rate: 0.175 },
  { min: 600000, max: 750000, rate: 0.20 },
  { min: 750000, max: 900000, rate: 0.225 },
  { min: 900000, max: 1000000, rate: 0.25 },
  { min: 1000000, max: null, rate: 0.30 }, // null = uncapped
];

// Walks a consultant's GBP-converted, non-excluded deals for a year — in
// order — through their band ladder, cumulatively. A deal that crosses a
// band boundary splits into two (or more) commission lines, each taxed at
// its own band's rate, exactly like a progressive tax calculation.
//
// `deals` must already be sorted into the order they should count (by
// placement start date, falling back to fee date) and each entry needs:
//   { feeId, splitId, gbpAmount, feeDate, paid, paidMarkedAt, source }
function computeCommissionLines(deals, bands) {
  const sortedBands = [...bands].sort((a, b) => a.min - b.min);
  let cumulative = 0;
  const lines = [];

  for (const deal of deals) {
    let remaining = deal.gbpAmount;
    if (remaining === null || remaining === undefined || isNaN(remaining)) continue;

    while (remaining > 0.005) {
      const band = sortedBands.find(
        (b) => cumulative >= b.min && (b.max === null || cumulative < b.max)
      );
      if (!band) break; // shouldn't happen if the ladder is uncapped at the top

      const spaceInBand = band.max === null ? Infinity : band.max - cumulative;
      const portion = Math.min(remaining, spaceInBand);
      const commission = portion * band.rate;
      // usdAmount must split proportionally too, just like gbpPortion —
      // otherwise a deal crossing a bracket boundary would report its
      // FULL dollar value on every resulting line, wildly overstating the
      // total the moment more than one deal ever splits across bands.
      const usdPortion = (deal.usdAmount !== null && deal.usdAmount !== undefined && deal.gbpAmount > 0)
        ? deal.usdAmount * (portion / deal.gbpAmount)
        : null;

      lines.push({
        feeId: deal.feeId,
        splitId: deal.splitId,
        feeDate: deal.feeDate,
        startDate: deal.startDate || null,
        gbpPortion: portion,
        rate: band.rate,
        bandMin: band.min,
        bandMax: band.max,
        commission,
        paid: deal.paid,
        paidMarkedAt: deal.paidMarkedAt,
        source: deal.source || null,
        candidateName: deal.candidateName || null,
        clientCompanyName: deal.clientCompanyName || null,
        originalCurrency: deal.originalCurrency || null,
        originalAmount: deal.originalAmount !== undefined ? deal.originalAmount : null,
        usdAmount: usdPortion,
        monthOverrides: deal.monthOverrides || {},
        hasPlacementName: !!deal.hasPlacementName,
      });

      cumulative += portion;
      remaining -= portion;
    }
  }

  const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);
  return { lines, totalGBP: cumulative, totalCommission };
}

// Splits a commission line's payout into 4 equal monthly instalments,
// starting the month AFTER the deal was marked Paid. A month's status is
// worked out automatically from real dates every time this runs, so it
// keeps auto-advancing (paid → due → future shifting forward) forever
// with no manual upkeep. Scott/Lee can still manually override a specific
// month to Paid/Withheld for one-off corrections — but "Due" itself isn't
// a sticky flag; marking a month Due instead corrects paidMarkedAt so the
// natural date-based computation lines up with reality from then on (see
// deals.js's `recalibrateToMonth`).
//
//   "future"   — hasn't happened yet (or the deal isn't marked Paid yet)
//   "due"      — this is the current real calendar month, expected now
//   "paid"     — an earlier month that's passed
//   "withheld" — marked as a fine/withhold for this specific instalment
function payoutSchedule(line) {
  const perMonth = line.commission / 4;
  const overrides = line.monthOverrides || {};

  if (!line.paid || !line.paidMarkedAt) {
    return [1, 2, 3, 4].map((n) => ({
      label: `Month ${n}`,
      monthNumber: n,
      amount: perMonth,
      paidDate: null,
      status: overrides[n] || "future",
    }));
  }

  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const months = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    let status;
    // "due" should never be trusted as a stored override — only "paid" and
    // "withheld" are genuine sticky decisions under the current design.
    // Any leftover "due" from before Due became a recalibration action
    // (rather than a frozen flag) is ignored here, so those old records
    // self-heal back to auto-computing correctly rather than staying
    // stuck on whatever they happened to compute to at the time.
    if (overrides[i] && overrides[i] !== "due") status = overrides[i];
    else if (d.getTime() < currentMonthStart) status = "paid";
    else if (d.getTime() === currentMonthStart) status = "due";
    else status = "future";
    months.push({ label, monthNumber: i, amount: perMonth, paidDate: d.toISOString(), status });
  }
  return months;
}

// Coordinators get their whole flat fee in ONE lump sum, the month after
// the deal is marked Paid — not spread over 4 months like consultants.
// Same status logic (auto paid/due/future, with manual override support).
function singleMonthPayout(line) {
  const overrides = line.monthOverrides || {};

  if (!line.paid || !line.paidMarkedAt) {
    return [{
      label: "Month 1",
      monthNumber: 1,
      amount: line.commission,
      paidDate: null,
      status: overrides[1] && overrides[1] !== "due" ? overrides[1] : "future",
    }];
  }

  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  let status;
  if (overrides[1] && overrides[1] !== "due") status = overrides[1];
  else if (d.getTime() < currentMonthStart) status = "paid";
  else if (d.getTime() === currentMonthStart) status = "due";
  else status = "future";

  return [{ label, monthNumber: 1, amount: line.commission, paidDate: d.toISOString(), status }];
}
// ============================================================================
// End of inlined _commissionEngine.js content
// ============================================================================


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

// Each currency independently finds its own most recent set month, rather
// than all currencies being tied to a single "latest month" — otherwise,
// if GBP gets re-entered every month but EUR was only ever set once a
// while back, EUR deals would wrongly show "no rate" despite a perfectly
// valid EUR rate still existing from that earlier month.
function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}

// Prefers the REAL rate from the month a deal was actually paid, once
// Scott/Lee have set one for THAT SPECIFIC CURRENCY that month. Otherwise
// — not paid yet, or paid but that exact month/currency has no rate
// entered — falls back to whichever month most recently had a rate set
// for this specific currency. This is deliberately never tied to today's
// literal calendar date: rates are set manually, so "today" might not
// have one yet, and using it would either wrongly show "held back" or
// silently disagree with what's already on screen.
function getRateForCurrency(record, allRates, currency) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    const paidRate = allRates[paidMonthKey] && allRates[paidMonthKey][currency];
    if (paidRate) return paidRate;
  }
  const latestKey = latestSetMonthKeyForCurrency(allRates, currency);
  return latestKey ? allRates[latestKey][currency] : null;
}

// Converts a deal's share amount into GBP, using the SAME monthly rates
// already set in Deal Lead Award (stored as "1 unit of that currency = X
// USD") — just run in reverse for GBP/EUR, and via USD as a bridge for EUR.
function convertToGBP(record, allRates) {
  if (record.currency === "GBP") return record.shareAmount;
  const gbpRate = getRateForCurrency(record, allRates, "GBP");
  if (!gbpRate) return null; // no GBP rate set for any applicable month yet
  if (record.currency === "USD") return record.shareAmount / gbpRate;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    const usdEquivalent = record.shareAmount * eurRate;
    return usdEquivalent / gbpRate;
  }
  return null;
}

// A USD-equivalent figure alongside the GBP one, shown for EVERY line
// (not just when the original currency happens to differ from GBP) — so
// there's always a dollar reference point, matching how Deal Lead Award
// and Total Revenue already show both currencies.
function convertToUSDEquivalent(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    return record.shareAmount * eurRate;
  }
  if (record.currency === "GBP") {
    const gbpRate = getRateForCurrency(record, allRates, "GBP");
    if (!gbpRate) return null;
    return record.shareAmount * gbpRate;
  }
  return null;
}

// ============================================================================
// SPECIAL CASE — Natasha Barnard / Citadel, effective 2026 onward.
//
// Natasha is paid 30% on Citadel deals, versus the standard 25% everyone
// else (including her own non-Citadel deals) is paid on. Every deal is
// still RECORDED in Atlas at the standard 25% — this function tops up the
// commission-calculation inputs by the extra 5 percentage points, ON THIS
// PAGE ONLY, so it blends invisibly into her own bracket ladder and deals
// list without a separate flagged line item.
//
// The extra 5% of the candidate's salary is mathematically equal to
// exactly 1/5 (20%) of the recorded 25%-based fee — no need to reverse out
// the salary — so the fee simply gets multiplied by 1.2.
//
// This must NEVER touch the underlying atlas-fee-records data, and must
// NEVER be visible or applied anywhere except Natasha's own commission
// compute below: not the Yearly Deal Table leaderboard (deals.js, a
// completely separate file, untouched by this change), not Team Lead
// Bonus (team-lead-bonus.js, also untouched), not any other consultant's
// page even if they also do Citadel deals.
//
// Four conditions must ALL be true, checked directly against the record
// every time — nothing here is inherited from outer filtering, so this
// stays correct and auditable even if surrounding code changes later:
//   1. This is genuinely Natasha's own record (by consultantId, not name)
//   2. The client name contains "Citadel" (covers both "Citadel" and
//      "Citadel Securities") — case-insensitive, substring match
//   3. The deal's effective year is 2026 or later
//   4. It's a genuine placement (a real linked candidate name) — NOT an
//      onsite fee, which never gets the uplift regardless of client/year
const SPECIAL_RATE_CONSULTANT_ID = "natasha-barnard";
const SPECIAL_RATE_CLIENT_SUBSTRING = "citadel";
const SPECIAL_RATE_MIN_YEAR = 2026;
const SPECIAL_RATE_MULTIPLIER = 1.2; // 30% / 25% — tops up the recorded 25%-based fee to reflect the true 30%

function appliesNatashaCitadelUplift(record, year) {
  if (record.consultantId !== SPECIAL_RATE_CONSULTANT_ID) return false;
  const client = (record.clientCompanyName || "").toLowerCase();
  if (!client.includes(SPECIAL_RATE_CLIENT_SUBSTRING)) return false;
  if (!year || year < SPECIAL_RATE_MIN_YEAR) return false;
  if (!record.hasPlacementName) return false;
  return true;
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

// Bands (and flat rates) set for a given year carry forward to every later
// year automatically, until a NEW value is explicitly saved for some later
// year — at which point that becomes the new carried-forward value from
// then on. So setting 2026's brackets applies to 2027, 2028... forever,
// unless 2027 gets its own explicit change, in which case 2026 is
// untouched and 2027+ uses the new value instead.
function carryForwardValue(byYear, year) {
  if (!byYear) return null;
  if (byYear[year] !== undefined && byYear[year] !== null) {
    const v = byYear[year];
    if (Array.isArray(v) ? v.length > 0 : true) return v;
  }
  const priorYears = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= year && byYear[y] !== undefined && byYear[y] !== null && (!Array.isArray(byYear[y]) || byYear[y].length > 0))
    .sort((a, b) => b - a);
  return priorYears.length ? byYear[priorYears[0]] : null;
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
        carryForwardValue(personSettings.flatRateByYear, year) || DEFAULT_FLAT_RATE;

      const yearRecords = allRecords.filter((r) => effectiveYear(r, placements) === year && r.coordinatorId === consultantId);
      const withOrderDate = yearRecords.map((r) => {
        const placement = r.placementId ? placements[r.placementId] : null;
        const orderDate = (placement && placement.startDate) || r.feeDate;
        const candidateName = (placement && placement.candidateName) || r.notes || null;
        const startDate = (placement && placement.startDate) || r.feeDate || null;
        const hasPlacementName = !!(placement && placement.candidateName);
        const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
        return { ...r, orderDate, candidateName, startDate, hasPlacementName, clientCompanyName };
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
        clientCompanyName: r.clientCompanyName,
        originalCurrency: r.currency,
        originalAmount: r.totalAmount,
        usdAmount: convertToUSDEquivalent(r, allRates),
        monthOverrides: r.monthOverrides || {},
        hasPlacementName: r.hasPlacementName,
      }));
      const linesWithSchedule = lines.map((l) => ({ ...l, payout: singleMonthPayout(l) }));
      const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);
      const placementBreakdown = {
        placements: {
          count: lines.filter((l) => l.hasPlacementName).length,
          totalCommission: lines.filter((l) => l.hasPlacementName).reduce((s, l) => s + l.commission, 0),
        },
        onsiteFees: {
          count: lines.filter((l) => !l.hasPlacementName).length,
          totalCommission: lines.filter((l) => !l.hasPlacementName).reduce((s, l) => s + l.commission, 0),
        },
      };

      return res.status(200).json({
        consultantId,
        year,
        isCoordinator: true,
        flatRate,
        dealCount: placementBreakdown.placements.count, // genuine placements only, never onsite fees -- matches every other "deals" count in this app
        totalCommission,
        target: (personSettings.targets && personSettings.targets[year]) || null,
        lines: linesWithSchedule,
        heldBackCount: 0,
        placementBreakdown,
      });
    }

    // --- CONSULTANT: tiered brackets, cumulative through the year ---
    // A bracket schedule set for a year carries forward to every later
    // year automatically, until a new one is explicitly saved for some
    // later year — e.g. a promotion at the end of 2026 that changes 2027
    // onward, without touching 2026's own numbers. Falls back to the
    // standard ladder only if this person has never had any year set.
    const bands = carryForwardValue(personSettings.bandsByYear, year) || STANDARD_BANDS;
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
      const candidateName = (placement && placement.candidateName) || r.notes || null;
      const startDate = (placement && placement.startDate) || r.feeDate || null;
      const hasPlacementName = !!(placement && placement.candidateName);
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      return { ...r, orderDate, candidateName, startDate, hasPlacementName, clientCompanyName };
    });
    withOrderDate.sort((a, b) => (a.orderDate || "").localeCompare(b.orderDate || ""));

    const dealsForEngine = withOrderDate.map((r) => {
      const uplift = appliesNatashaCitadelUplift(r, year);
      const rawGbp = convertToGBP(r, allRates);
      const rawUsd = convertToUSDEquivalent(r, allRates);
      return {
        feeId: r.feeId,
        splitId: r.splitId,
        gbpAmount: (uplift && rawGbp !== null) ? rawGbp * SPECIAL_RATE_MULTIPLIER : rawGbp,
        feeDate: r.feeDate,
        startDate: r.startDate,
        paid: r.paid,
        paidMarkedAt: r.paidMarkedAt,
        source: r.source,
        candidateName: r.candidateName,
        clientCompanyName: r.clientCompanyName,
        originalCurrency: r.currency,
        originalAmount: r.totalAmount,
        usdAmount: (uplift && rawUsd !== null) ? rawUsd * SPECIAL_RATE_MULTIPLIER : rawUsd,
        monthOverrides: r.monthOverrides || {},
        hasPlacementName: r.hasPlacementName,
      };
    });

    const heldBack = dealsForEngine.filter((d) => d.gbpAmount === null).length;
    const usableDeals = dealsForEngine.filter((d) => d.gbpAmount !== null);

    const { lines, totalGBP, totalCommission } = computeCommissionLines(usableDeals, bands);
    const linesWithSchedule = lines.map((l) => ({ ...l, payout: payoutSchedule(l) }));

    // A single deal can split into multiple lines across bracket boundaries,
    // so count DISTINCT deals (by feeId+splitId), not lines, while still
    // summing commission across every line for the £ totals.
    const dealKey = (l) => `${l.feeId}|${l.splitId}`;
    const placementLines = lines.filter((l) => l.hasPlacementName);
    const onsiteLines = lines.filter((l) => !l.hasPlacementName);
    const placementBreakdown = {
      placements: {
        count: new Set(placementLines.map(dealKey)).size,
        totalCommission: placementLines.reduce((s, l) => s + l.commission, 0),
      },
      onsiteFees: {
        count: new Set(onsiteLines.map(dealKey)).size,
        totalCommission: onsiteLines.reduce((s, l) => s + l.commission, 0),
      },
    };

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
      placementBreakdown,
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
