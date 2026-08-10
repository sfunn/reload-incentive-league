const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

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

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function latestSetMonthKey(allRates) {
  const keys = Object.keys(allRates).sort();
  return keys.length ? keys[keys.length - 1] : null;
}
async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const dateForRate = record.paid && record.paidMarkedAt ? record.paidMarkedAt : null;
  let monthRates = allRates[monthKeyFromDateStr(dateForRate)];
  if (!monthRates) {
    const latestKey = latestSetMonthKey(allRates);
    monthRates = latestKey ? allRates[latestKey] : null;
  }
  const rate = monthRates && monthRates[record.currency];
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

    const [weeks, records, placements, teamOverrides, allRates, bonusStore] = await Promise.all([
      kv.get(WEEKS_KEY).then((v) => v || []),
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
      kv.get(TEAMS_KEY).then((v) => v || {}),
      kv.get(FX_KEY).then((v) => v || {}),
      kv.get(BONUS_KEY).then((v) => v || {}),
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

    for (const week of weeks) {
      if (!inRange(week.date, start, end)) continue;
      const mk = week.date.slice(0, 7);
      if (!perMonth[mk]) continue;
      for (const [consultantId, row] of Object.entries(week.rows || {})) {
        const rowTeam = row.team || (await getTeamForConsultant(consultantId, teamOverrides));
        if (rowTeam !== team) continue;
        perMonth[mk].cvs += Number(row.cvs) || 0;
        perMonth[mk].interviews += Number(row.interviews) || 0;
        perMonth[mk].activeConsultants.add(consultantId);
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
      const candidateName = (placement && placement.candidateName) || r.notes || null;
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
