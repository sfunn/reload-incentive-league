const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const { computeMonthlyKpiLive } = require("./_atlasShared");

const KPI_CACHE_PREFIX = "atlas-kpi-cache-v4:"; // same cache the KPI page itself reads/writes -- see api/league.js's own ?action=kpi-live-monthly
const KPI_OVERRIDES_KEY = "kpi-overrides"; // same store the KPI page's own editable override cells write to

const WEEKS_KEY = "reload-league-weeks";
const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const TEAMS_KEY = "consultant-teams";
const FX_KEY = "atlas-fx-rates";
const BONUS_KEY = "team-lead-bonus-records"; // { [teamLeadId]: { [period]: {finalized, finalizedAt, promotions: []} } }

// Matches public/index.html's INITIAL_CONSULTANTS default team assignment —
// used as the fallback for legacy weeks that predate per-week team stamping.
const DEFAULT_TEAM_BY_CONSULTANT = {
  "alex-silverman": "james",
  "ash-thiara": "james",
  "jack-thompson": "james",
  "max-hart": "james",
  "oleg-sokyrka": "james",
  "alex-aparo": "josh",
  "jack-routledge": "josh",
  "joe-purton": "josh",
  "josh-davis": "josh",
  "natasha-barnard": "josh",
};

const TEAM_LEAD_TEAM = { "james-lancer": "james", "josh-stark": "josh" };

// Display names — matches public/index.html's INITIAL_CONSULTANTS.
const CONSULTANT_NAMES = {
  "alex-silverman": "Alex Silverman",
  "ash-thiara": "Ash Thiara",
  "jack-thompson": "Jack Thompson",
  "max-hart": "Max Hart",
  "oleg-sokyrka": "Oleg Sokyrka",
  "alex-aparo": "Alex Aparo",
  "jack-routledge": "Jack Routledge",
  "joe-purton": "Joe Purton",
  "josh-davis": "Josh Davis",
  "natasha-barnard": "Natasha Barnard",
  "james-lancer": "James Lancer",
  "josh-stark": "Josh Stark",
};


// Each pillar's named tiers, in ascending order. Anything between two named
// points is interpolated exactly linearly (e.g. 85% between 80%→£1,000 and
// 90%→£2,000 gives exactly £1,500). Below the lowest tier = £0. At or above
// the highest tier = capped at that top figure (no further extrapolation).
const PILLAR_1_CV_VOLUME = [[80, 1000], [90, 2000], [100, 3000], [110, 4000], [120, 5000]];
const PILLAR_2_INTERVIEW_VOLUME = [[80, 2000], [90, 4000], [100, 6000], [110, 8000], [120, 10000]];
const PILLAR_3_CV_TO_INTERVIEW_RATIO = [[60, 1000], [65, 5000], [70, 10000], [75, 15000], [80, 20000]];
// Pillar 4 is keyed by raw DEAL COUNT, not percentage — the document's own
// percentage labels don't divide out evenly against the 12-deal target
// (11/12 = 91.7%, not "90%"), so interpolating off count is the exact match.
const PILLAR_4_DESK_DEALS_BY_COUNT = [[10, 5000], [11, 10000], [12, 20000], [13, 25000], [14, 30000]];
const PILLAR_4_TARGET_DEALS = 12;
const TEAM_LEAD_OWN_DEAL_CAP = 4;

const DEVELOPMENT_MILESTONES_USD = [
  { threshold: 250000, bonus: 2500 },
  { threshold: 500000, bonus: 5000 },
  { threshold: 1000000, bonus: 10000 },
];

function interpolate(tiers, value) {
  if (value < tiers[0][0]) return 0;
  const last = tiers[tiers.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < tiers.length - 1; i++) {
    const [pLow, amtLow] = tiers[i];
    const [pHigh, amtHigh] = tiers[i + 1];
    if (value >= pLow && value < pHigh) {
      return amtLow + ((value - pLow) / (pHigh - pLow)) * (amtHigh - amtLow);
    }
  }
  return 0;
}

function periodBounds(period) {
  // period like "H1-2026" or "H2-2026"
  const [half, yearStr] = period.split("-");
  const year = parseInt(yearStr, 10);
  if (half === "H1") return { start: `${year}-01-01`, end: `${year}-06-30`, year };
  return { start: `${year}-07-01`, end: `${year}-12-31`, year };
}

function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  return dateStr >= start && dateStr <= end;
}

async function getTeamForConsultant(consultantId, teamOverrides) {
  return teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId] || null;
}

// The real fix this whole file needed: CVs Out / Interviews now come from
// the same, corrected, live-computed KPI source the Consultant KPIs page
// itself reads from (api/_atlasShared.js's computeMonthlyKpiLive), not
// the old, webhook-fed reload-league-weeks rows — which were measured
// elsewhere in this app to genuinely miss a real share of events. Team
// membership HISTORY (who was on which team, during which specific past
// month) still comes from those same old weekly rows below, completely
// unrelated to this fix and just as accurate as it's always been — the
// old rows' own team-stamping is the only place that history has ever
// been recorded at all, there's no equivalent in the new KPI source.
// Same cache-check-then-live-compute-if-needed pattern as the KPI page's
// own ?action=kpi-live-monthly, and the same freshness window (6 hours
// for the current month, 30 days for a past one) — so a team lead never
// sees a different number here than what the actual KPI page shows for
// the same person and month.
// Takes the cache as a parameter (a fresh {} created per request, at the
// call site inside the handler below) rather than module-level shared
// state — a serverless function can stay warm across separate,
// different requests, and module-level state would then leak between
// them, serving one request's memoized month to a completely different
// one that happens to land on the same warm instance later.
async function getMonthlyKpiData(monthlyKpiCache, year, month) {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  if (monthlyKpiCache[monthKey]) return monthlyKpiCache[monthKey];
  const now = new Date();
  const isCurrentMonth = monthKey === `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const CACHE_TTL_MS = isCurrentMonth ? 6 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const cached = await kv.get(`${KPI_CACHE_PREFIX}${monthKey}`);
  let monthly, monthlyDetails;
  if (cached && cached.cachedAt && cached.monthlyDetails && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    monthly = cached.monthly;
    monthlyDetails = cached.monthlyDetails;
  } else {
    const live = await computeMonthlyKpiLive(kv, year, month);
    monthly = live.people;
    monthlyDetails = live.peopleDetails;
    await kv.set(`${KPI_CACHE_PREFIX}${monthKey}`, { monthly, monthlyDetails, cachedAt: Date.now() });
  }
  monthlyKpiCache[monthKey] = monthly;
  return monthly;
}

// Same override-wins merge as the KPI page's own kpiOverrideValue in
// public/index.html — a manual correction on that page always takes
// precedence over the live-computed figure, exactly matched here so
// this bonus can never disagree with what a team lead can see for
// themselves on the KPI page.
function kpiValueFor(kpiOverrides, monthlyData, consultantId, monthKey, overrideField, liveField) {
  const override = kpiOverrides[consultantId] && kpiOverrides[consultantId][monthKey] && kpiOverrides[consultantId][monthKey][overrideField];
  if (override !== undefined && override !== null) return Number(override) || 0;
  const liveEntry = (monthlyData || {})[consultantId];
  return (liveEntry && Number(liveEntry[liveField])) || 0;
}

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// Each currency independently finds its own most recent set month, rather
// than all currencies being tied to a single "latest month" — otherwise,
// if GBP gets re-entered every month but EUR was only ever set once a
// while back, EUR deals would wrongly show no rate despite a perfectly
// valid EUR rate still existing from that earlier month.
function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}
async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  let rate = null;
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    rate = allRates[paidMonthKey] && allRates[paidMonthKey][record.currency];
  }
  if (!rate) {
    const latestKey = latestSetMonthKeyForCurrency(allRates, record.currency);
    rate = latestKey ? allRates[latestKey][record.currency] : null;
  }
  if (!rate) return null;
  return record.shareAmount * rate;
}

// 50% at the end of the review period, the remaining 50% deferred over 4
// equal monthly instalments after that. Same auto-advancing paid/due/future
// status logic as the commission engine, just with this 50%+4x12.5% shape
// instead of a straight 4-way split.
function buildPayout(totalBonus, finalized, finalizedAt) {
  const lumpAmount = totalBonus * 0.5;
  const instalmentAmount = totalBonus * 0.125;

  if (!finalized || !finalizedAt) {
    return {
      lumpSum: { label: "50% at period end", amount: lumpAmount, status: "future", date: null },
      instalments: [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, amount: instalmentAmount, status: "future", date: null })),
    };
  }

  const base = new Date(finalizedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const lumpSum = {
    label: base.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }),
    amount: lumpAmount,
    status: "paid",
    date: base.toISOString(),
  };

  const instalments = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    let status;
    if (d.getTime() < currentMonthStart) status = "paid";
    else if (d.getTime() === currentMonthStart) status = "due";
    else status = "future";
    instalments.push({
      label: d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }),
      amount: instalmentAmount,
      status,
      date: d.toISOString(),
    });
  }
  return { lumpSum, instalments };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = await getUserFromRequest(req);
  if (!user || !user.isAdmin) {
    return res.status(401).json({ error: "Admin access required." });
  }

  const action = req.query.action;

  if (req.method === "GET" && action === "compute") {
    const teamLeadId = req.query.teamLeadId;
    const period = req.query.period; // "H1-2026" / "H2-2026"
    if (!teamLeadId || !TEAM_LEAD_TEAM[teamLeadId] || !period) {
      return res.status(400).json({ error: "Valid teamLeadId and period are required." });
    }
    const team = TEAM_LEAD_TEAM[teamLeadId];
    const { start, end, year } = periodBounds(period);

    const [weeks, records, placements, teamOverrides, allRates, bonusStore, kpiOverrides] = await Promise.all([
      kv.get(WEEKS_KEY).then((v) => v || []),
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
      kv.get(TEAMS_KEY).then((v) => v || {}),
      kv.get(FX_KEY).then((v) => v || {}),
      kv.get(BONUS_KEY).then((v) => v || {}),
      kv.get(KPI_OVERRIDES_KEY).then((v) => v || {}),
    ]);

    // --- Pillars 1, 2 & 3: assessed month by month, then averaged over
    // the 6-month review period — not as one aggregate total. Each month's
    // target uses the roster who ACTUALLY reported that team that month
    // (not just a static headcount), so a team that grew or shrank
    // mid-period is judged fairly for each individual month.
    const monthKeys = [];
    {
      const [sy, sm] = start.split("-").map(Number);
      for (let i = 0; i < 6; i++) {
        const mi = sm - 1 + i;
        const y = sy + Math.floor(mi / 12);
        const m = (mi % 12) + 1;
        monthKeys.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    const perMonth = {};
    for (const mk of monthKeys) perMonth[mk] = { cvs: 0, interviews: 0, activeConsultants: new Set() };

    // Step 1 — team membership HISTORY only, still from the old weekly
    // rows (see this file's own comment on getMonthlyKpiData above for
    // why this one piece stays as-is): which consultants were genuinely
    // on this team during each specific month, deduped per month so
    // someone appearing across several of that month's weeks is only
    // ever counted once below, not once per week.
    //
    // week.date is that week's SUNDAY (its end), not its Monday -- so a
    // week straddling a month boundary (like 2026-W40, Mon Sep 28 - Sun
    // Oct 4) has a Sunday landing in the LATER month, and naively taking
    // month-from-date here would attribute the WHOLE week's membership
    // to October alone, even though six of its seven days, and whoever
    // was genuinely on this team then, belong to September. This is the
    // exact same class of bug found and fixed today in ringover-webhook.js
    // (deriving a month from a week's Sunday) -- caught here by
    // specifically checking for that same pattern elsewhere in this
    // codebase after that fix, not found independently. The fix: a
    // straddling week counts as membership for BOTH months it touches,
    // not just one, since the consultant genuinely was on this team
    // during each.
    for (const week of weeks) {
      if (!inRange(week.date, start, end)) continue;
      const sundayDate = new Date(week.date);
      const mondayDate = new Date(sundayDate);
      mondayDate.setUTCDate(sundayDate.getUTCDate() - 6);
      const mondayMonth = `${mondayDate.getUTCFullYear()}-${String(mondayDate.getUTCMonth() + 1).padStart(2, "0")}`;
      const sundayMonth = `${sundayDate.getUTCFullYear()}-${String(sundayDate.getUTCMonth() + 1).padStart(2, "0")}`;
      const monthsThisWeekTouches = mondayMonth === sundayMonth ? [mondayMonth] : [mondayMonth, sundayMonth];
      for (const [consultantId, row] of Object.entries(week.rows || {})) {
        const rowTeam = row.team || (await getTeamForConsultant(consultantId, teamOverrides));
        if (rowTeam !== team) continue;
        for (const mk of monthsThisWeekTouches) {
          if (!perMonth[mk]) continue;
          perMonth[mk].activeConsultants.add(consultantId);
        }
      }
    }

    // Step 2 — the actual CVs Out / Interviews figures themselves, for
    // each consultant Step 1 confirmed was on this team that month, now
    // from the corrected, live-computed KPI source (with manual
    // overrides applied, exactly matching what the KPI page itself
    // would show for the same person and month).
    const monthlyKpiCache = {}; // fresh per request -- see getMonthlyKpiData's own comment for why this must never be module-level state
    for (const mk of monthKeys) {
      const [y, m] = mk.split("-").map(Number);
      const monthlyData = await getMonthlyKpiData(monthlyKpiCache, y, m);
      for (const consultantId of perMonth[mk].activeConsultants) {
        perMonth[mk].cvs += kpiValueFor(kpiOverrides, monthlyData, consultantId, mk, "cvs", "cvsOut");
        perMonth[mk].interviews += kpiValueFor(kpiOverrides, monthlyData, consultantId, mk, "interviews", "interviews");
      }
    }

    const currentRoster = Object.keys(DEFAULT_TEAM_BY_CONSULTANT)
      .concat(Object.keys(teamOverrides))
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((cid) => (teamOverrides[cid] || DEFAULT_TEAM_BY_CONSULTANT[cid]) === team);

    const monthlyBreakdown = monthKeys.map((mk) => {
      const m = perMonth[mk];
      const roster = m.activeConsultants.size || 0;
      const targetCVs = 30 * roster;
      const targetInterviews = 30 * roster;
      const cvPercent = targetCVs > 0 ? (m.cvs / targetCVs) * 100 : 0;
      const interviewPercent = targetInterviews > 0 ? (m.interviews / targetInterviews) * 100 : 0;
      const ratioPercent = m.cvs > 0 ? (m.interviews / m.cvs) * 100 : 0;
      return {
        month: mk, roster, cvs: m.cvs, interviews: m.interviews,
        targetCVs, targetInterviews, cvPercent, interviewPercent, ratioPercent,
      };
    });

    const avg = (arr, key) => (arr.length ? arr.reduce((s, x) => s + x[key], 0) / arr.length : 0);
    // Months that haven't started yet shouldn't drag the average down to 0
    // just because nothing's happened there — only average across the
    // months that have actually begun (including the current, in-progress
    // one) by today's real date.
    const nowMonthKey = monthKeyFromDateStr(null);
    const monthsSoFar = monthlyBreakdown.filter((m) => m.month <= nowMonthKey);
    const totalCVs = monthlyBreakdown.reduce((s, m) => s + m.cvs, 0);
    const totalInterviews = monthlyBreakdown.reduce((s, m) => s + m.interviews, 0);
    const targetCVsTotal = monthlyBreakdown.reduce((s, m) => s + m.targetCVs, 0);
    const targetInterviewsTotal = monthlyBreakdown.reduce((s, m) => s + m.targetInterviews, 0);

    const pillar1Percent = avg(monthsSoFar, "cvPercent");
    const pillar2Percent = avg(monthsSoFar, "interviewPercent");
    const ratioPercent = avg(monthsSoFar, "ratioPercent");

    const pillar1Bonus = interpolate(PILLAR_1_CV_VOLUME, pillar1Percent);
    const pillar2Bonus = interpolate(PILLAR_2_INTERVIEW_VOLUME, pillar2Percent);
    const pillar3Bonus = interpolate(PILLAR_3_CV_TO_INTERVIEW_RATIO, ratioPercent);

    // --- Pillar 4: desk deals, team lead's own contribution capped at 4 ---
    // Uses the SIGNED date, not the placement start date (unlike commission,
    // which deliberately uses start date) — the Team Lead's performance is
    // about deals they actually closed during this window, not when the
    // candidate eventually starts.
    let teamMemberDeals = 0;
    let teamLeadOwnDeals = 0;
    const pillar4TeamDealsList = [];
    const pillar4OwnDealsList = [];
    for (const r of records) {
      if (!r.consultantId) continue;
      const dealDate = r.feeDate;
      if (!inRange(dealDate, start, end)) continue;
      const consultantTeam = teamOverrides[r.consultantId] || DEFAULT_TEAM_BY_CONSULTANT[r.consultantId] || null;
      const placement = r.placementId ? placements[r.placementId] : null;
      // Pillar 4 specifically only ever counts a deal if there's a genuine
      // placement-linked candidate name — unlike everywhere else in the
      // app, the notes fallback does NOT apply here.
      const candidateName = (placement && placement.candidateName) || null;
      if (!candidateName) continue;
      if (r.consultantId === teamLeadId) {
        teamLeadOwnDeals += 1;
        pillar4OwnDealsList.push({ candidateName, date: dealDate });
      } else if (consultantTeam === team) {
        teamMemberDeals += 1;
        pillar4TeamDealsList.push({ candidateName, date: dealDate, consultantName: CONSULTANT_NAMES[r.consultantId] || r.consultantId });
      }
    }
    const teamLeadCountedDeals = Math.min(teamLeadOwnDeals, TEAM_LEAD_OWN_DEAL_CAP);
    const totalCountedDeals = teamMemberDeals + teamLeadCountedDeals;
    const pillar4Bonus = interpolate(PILLAR_4_DESK_DEALS_BY_COUNT, totalCountedDeals);

    // --- Development bonus: billing milestones (auto) + promotions (manual) ---
    // Based purely on what was signed WITHIN this specific 6-month period —
    // not a cumulative year-to-date total. So a £150k deal this period
    // never triggers the £250k milestone just because an EARLIER period's
    // deals would push the yearly total over it — only this period's own
    // revenue counts toward it. Uses the SIGNED date, same as Pillar 4.
    const periodTotalByConsultant = {};
    for (const r of records) {
      if (!r.consultantId || !currentRoster.includes(r.consultantId)) continue;
      const dealDate = r.feeDate;
      if (!inRange(dealDate, start, end)) continue;
      const usd = await convertToUSD(r, allRates);
      if (usd === null) continue;
      periodTotalByConsultant[r.consultantId] = (periodTotalByConsultant[r.consultantId] || 0) + usd;
    }
    const milestoneCrossings = [];
    for (const consultantId of currentRoster) {
      const periodTotal = periodTotalByConsultant[consultantId] || 0;
      for (const m of DEVELOPMENT_MILESTONES_USD) {
        if (periodTotal < m.threshold) continue;
        milestoneCrossings.push({
          consultantId,
          consultantName: CONSULTANT_NAMES[consultantId] || consultantId,
          threshold: m.threshold,
          bonus: m.bonus,
          periodTotal: Math.round(periodTotal),
        });
      }
    }

    const periodData = (bonusStore[teamLeadId] && bonusStore[teamLeadId][period]) || {};
    const promotions = periodData.promotions || [];
    const promotionBonusTotal = promotions.length * 2500;
    const milestoneBonusTotal = milestoneCrossings.reduce((s, m) => s + m.bonus, 0);
    const developmentBonusTotal = promotionBonusTotal + milestoneBonusTotal;

    const totalBonus = pillar1Bonus + pillar2Bonus + pillar3Bonus + pillar4Bonus + developmentBonusTotal;
    const payout = buildPayout(totalBonus, periodData.finalized, periodData.finalizedAt);

    return res.status(200).json({
      teamLeadId,
      period,
      periodStart: start,
      periodEnd: end,
      rosterSize: currentRoster.length,
      pillar1: { actual: totalCVs, target: targetCVsTotal, percent: pillar1Percent, bonus: pillar1Bonus },
      pillar2: { actual: totalInterviews, target: targetInterviewsTotal, percent: pillar2Percent, bonus: pillar2Bonus },
      pillar3: { actualRatioPercent: ratioPercent, bonus: pillar3Bonus },
      monthlyBreakdown,
      pillar4: {
        teamMemberDeals, teamLeadOwnDeals, teamLeadCountedDeals, totalCountedDeals,
        target: PILLAR_4_TARGET_DEALS, bonus: pillar4Bonus,
        teamDealsList: pillar4TeamDealsList,
        ownDealsList: pillar4OwnDealsList,
      },
      developmentBonus: { milestoneCrossings, promotions, promotionBonusTotal, milestoneBonusTotal, total: developmentBonusTotal },
      totalBonus,
      finalized: !!periodData.finalized,
      finalizedAt: periodData.finalizedAt || null,
      payout,
    });
  }

  if (req.method === "POST" && action === "add-promotion") {
    const { teamLeadId, period, consultantId, consultantName } = req.body || {};
    if (!teamLeadId || !period || !consultantId) return res.status(400).json({ error: "Missing fields." });
    const store = (await kv.get(BONUS_KEY)) || {};
    store[teamLeadId] = store[teamLeadId] || {};
    store[teamLeadId][period] = store[teamLeadId][period] || { promotions: [] };
    store[teamLeadId][period].promotions = store[teamLeadId][period].promotions || [];
    store[teamLeadId][period].promotions.push({ id: `${consultantId}-${Date.now()}`, consultantId, consultantName });
    await kv.set(BONUS_KEY, store);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST" && action === "remove-promotion") {
    const { teamLeadId, period, promotionId } = req.body || {};
    if (!teamLeadId || !period || !promotionId) return res.status(400).json({ error: "Missing fields." });
    const store = (await kv.get(BONUS_KEY)) || {};
    if (store[teamLeadId] && store[teamLeadId][period]) {
      store[teamLeadId][period].promotions = (store[teamLeadId][period].promotions || []).filter((p) => p.id !== promotionId);
    }
    await kv.set(BONUS_KEY, store);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST" && action === "finalize") {
    if (!user.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required to finalize a bonus." });
    const { teamLeadId, period, finalized, finalizedAt } = req.body || {};
    if (!teamLeadId || !period) return res.status(400).json({ error: "Missing fields." });
    const store = (await kv.get(BONUS_KEY)) || {};
    store[teamLeadId] = store[teamLeadId] || {};
    store[teamLeadId][period] = store[teamLeadId][period] || { promotions: [] };
    store[teamLeadId][period].finalized = !!finalized;
    store[teamLeadId][period].finalizedAt = finalized ? (finalizedAt || new Date().toISOString()) : null;
    await kv.set(BONUS_KEY, store);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action." });
};
