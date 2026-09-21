const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const {
  EXCLUDED_PROJECT_NAME,
  computeMonthlyKpiLive,
  computeWeeklyKpiLive,
} = require("./_atlasShared.js");

const WEEKS_KEY = "reload-league-weeks";
const CONFIG_KEY = "reload-current-week-config";
const TEAMS_KEY = "consultant-teams";
const TALLY_PREFIX = "atlas-tally:";
// New, live-query-backed Weekly Incentive data model — deliberately
// SEPARATE from WEEKS_KEY/CONFIG_KEY above, additive rather than
// replacing them outright, so the new ?action=week-live path can be
// built and proven correct before anything switches over to depending
// on it. WEEK_CONFIGS_KEY holds each week's own metric/threshold/
// exclusions (the one genuinely manual decision per week — Atlas has no
// way to know what a week is being scored on), separately from the
// actual volume numbers, which are computed live and cached, the same
// architecture already proven for the KPI page's own monthly numbers.
const WEEK_CONFIGS_KEY = "reload-week-configs";
const WEEK_OVERRIDES_KEY = "weekly-incentive-overrides";
// Read-only for the new placement-counts action below -- this file never
// writes to either key, and never touches commission/£ figures at all.
// It exists purely to answer "how many genuine placements did person X
// have in month Y", the same count already used (for different purposes)
// by team-lead-bonus.js's Pillar 4 and deals.js.
const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const METRIC_CVS_OUT = "CV's Out (Candidates presented)";
const METRIC_INTERVIEWS = "Interviews (Candidates IV stage)";
const METRIC_RATIO = "CV-to-interview ratio (presented-to-interviewed ratio)";

// Matches public/index.html's INITIAL_CONSULTANTS default team assignment.
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

// Team leads' own CV/interview/onsite/offer activity, captured for stats
// visibility ONLY — deliberately kept in a completely separate field
// (leadRows, below) from DEFAULT_TEAM_BY_CONSULTANT's rows. James and
// Josh's own recruiting activity must never be mixed into either the
// League Table's competitive scoring or Team Lead Bonus's Pillar 1-3 team
// volume averages — both of those read every entry in week.rows filtered
// only by team match, with no fixed-roster check, so putting a team
// lead's own numbers in there would silently inflate their own team's
// figures with their personal activity. A separate field is the only way
// to make that leak structurally impossible rather than hoping every
// current and future consumer of week.rows filters correctly.
const TEAM_LEAD_BY_CONSULTANT = {
  "james-lancer": "james",
  "josh-stark": "josh",
};


// Matches atlas-webhook.js's own isoWeekKey exactly, so both files always
// agree on which real-world Monday–Sunday window a given key represents.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// The Monday and Sunday (as YYYY-MM-DD) that a given ISO week key covers.
function isoWeekToDates(weekKey) {
  const [yearStr, wStr] = weekKey.split("-W");
  const year = Number(yearStr);
  const weekNum = Number(wStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // 0 = Monday
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (weekNum - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { monday: fmt(monday), sunday: fmt(sunday) };
}

function computeMetricValue(metric, cvs, interviews) {
  if (metric === METRIC_INTERVIEWS) return interviews;
  if (metric === METRIC_RATIO) return cvs > 0 ? Math.round((interviews / cvs) * 100) : 0;
  return cvs; // METRIC_CVS_OUT, and the default
}

// Whenever anyone loads league data, this checks whether the previously
// configured week has ended — if so, it locks that week in permanently
// using the live tally as it stood at that moment, and moves the "current
// week" config forward. This is deliberately lazy (runs on next visit)
// rather than a scheduled job, since Vercel's free tier only allows
// once-a-day cron and a lazy check needs no scheduling infrastructure at
// all to be reliable.
async function autoFinalizePastWeeks() {
  const weeks = (await kv.get(WEEKS_KEY)) || [];
  const nowKey = isoWeekKey(new Date().toISOString());
  let config = await kv.get(CONFIG_KEY);
  if (!config) {
    config = { weekKey: nowKey, metric: METRIC_CVS_OUT, threshold: null, excludedConsultants: [] };
    await kv.set(CONFIG_KEY, config);
    return { weeks, config };
  }
  if (!config.excludedConsultants) config.excludedConsultants = [];
  if (config.weekKey === nowKey) {
    return { weeks, config };
  }

  // The configured week is over — finalize it if it hasn't been already.
  let nextWeeks = weeks;
  const { sunday } = isoWeekToDates(config.weekKey);
  const alreadySaved = weeks.some((w) => w.date === sunday && w.id === `auto-${config.weekKey}`);
  if (!alreadySaved) {
    const tally = (await kv.get(`${TALLY_PREFIX}${config.weekKey}`)) || {};
    const teamOverrides = (await kv.get(TEAMS_KEY)) || {};
    const rows = {};
    for (const consultantId of Object.keys(DEFAULT_TEAM_BY_CONSULTANT)) {
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      const team = teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId];
      const cvs = t.cvsOut || 0;
      const interviews = t.interviews || 0;
      // onsite/offers may be missing entirely on tally entries recorded
      // before this tracking existed — default to 0 rather than leaving
      // them undefined, same defensive pattern as cvs/interviews above.
      const onsite = t.onsite || 0;
      const offers = t.offers || 0;
      rows[consultantId] = {
        cvs, interviews, onsite, offers, team,
        metricValue: computeMetricValue(config.metric, cvs, interviews),
        excluded: config.excludedConsultants.includes(consultantId),
      };
    }
    // Team leads' own activity — same tally source, deliberately written
    // into a separate field, never `rows`. See the comment on
    // TEAM_LEAD_BY_CONSULTANT above for why this separation is load-bearing,
    // not cosmetic.
    const leadRows = {};
    for (const consultantId of Object.keys(TEAM_LEAD_BY_CONSULTANT)) {
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      leadRows[consultantId] = {
        cvs: t.cvsOut || 0,
        interviews: t.interviews || 0,
        onsite: t.onsite || 0,
        offers: t.offers || 0,
        team: TEAM_LEAD_BY_CONSULTANT[consultantId],
      };
    }
    const newWeek = {
      id: `auto-${config.weekKey}`,
      date: sunday,
      metric: config.metric || METRIC_CVS_OUT,
      threshold: config.threshold ?? null,
      rows,
      leadRows,
      autoFinalized: true,
    };
    nextWeeks = [...weeks, newWeek];
    await kv.set(WEEKS_KEY, nextWeeks);
  }

  // Move the "current week" forward — carrying the same metric/threshold
  // forward as the sensible default until an Admin changes it. Exclusions
  // reset fresh each week (e.g. "on holiday this week") rather than
  // silently carrying someone's exclusion forward indefinitely.
  const newConfig = { weekKey: nowKey, metric: config.metric || METRIC_CVS_OUT, threshold: config.threshold ?? null, excludedConsultants: [] };
  await kv.set(CONFIG_KEY, newConfig);
  return { weeks: nextWeeks, config: newConfig };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = req.query.action;

  if (req.method === "GET" && action === "live-week") {
    // The currently in-progress week's live tally, for both metrics, split
    // by team — refreshed continuously, no manual pull needed.
    const { weeks, config } = await autoFinalizePastWeeks();
    const tally = (await kv.get(`${TALLY_PREFIX}${config.weekKey}`)) || {};
    const teamOverrides = (await kv.get(TEAMS_KEY)) || {};
    const { monday, sunday } = isoWeekToDates(config.weekKey);
    const excluded = config.excludedConsultants || [];
    const consultants = Object.keys(DEFAULT_TEAM_BY_CONSULTANT).map((consultantId) => {
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      return {
        consultantId,
        team: teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId],
        cvsOut: t.cvsOut || 0,
        interviews: t.interviews || 0,
        onsite: t.onsite || 0,
        offers: t.offers || 0,
        excluded: excluded.includes(consultantId),
      };
    });
    // Team leads' own live-week activity — a separate array, deliberately
    // never merged into `consultants` above, so no consumer of this
    // response can accidentally fold their personal numbers into the
    // League Table's competitive scoring.
    const teamLeads = Object.keys(TEAM_LEAD_BY_CONSULTANT).map((consultantId) => {
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      return {
        consultantId,
        team: TEAM_LEAD_BY_CONSULTANT[consultantId],
        cvsOut: t.cvsOut || 0,
        interviews: t.interviews || 0,
        onsite: t.onsite || 0,
        offers: t.offers || 0,
      };
    });
    return res.status(200).json({ weekKey: config.weekKey, weekStart: monday, weekEnd: sunday, metric: config.metric, threshold: config.threshold, consultants, teamLeads });
  }

  if (req.method === "GET" && action === "week-live") {
    // The new, live-query-backed Weekly Incentive numbers — computed
    // directly from Atlas's own candidate-stage-events (the same proven
    // logic the KPI page uses, see computeWeeklyKpiLive in
    // _atlasShared.js), bypassing the webhook-fed atlas-tally entirely.
    // That webhook was found, over the course of building this, to
    // genuinely miss a real share of events (roughly 22% in one
    // measured window) — going straight to Atlas is the actual fix for
    // the accuracy problem this whole rebuild exists to solve, not a
    // side effect of it.
    //
    // Works for ANY week, current or past, the same way: live-compute-
    // and-cache, then a manual override (if one's been set) always wins
    // on top, exactly the same pattern already proven on the KPI page.
    // A week within the last 2 weeks is treated as still worth checking
    // regularly (kept warm by the same background job that warms the
    // KPI page's current month); anything older is treated as settled
    // and cached for a long time — the same aging idea, just at a
    // week's timescale instead of a month's.
    //
    // Deliberately ADDITIVE at this stage: this does not yet replace
    // reload-league-weeks/CONFIG_KEY or the auto-finalize flow above —
    // this is the new path being proven correct before the frontend (and
    // Standings/League Table) are moved onto it.
    const weekKey = typeof req.query.week === "string" ? req.query.week : isoWeekKey(new Date().toISOString());
    const { monday, sunday } = isoWeekToDates(weekKey);
    const isCurrentWeek = weekKey === isoWeekKey(new Date().toISOString());
    const weeksSinceEnded = (Date.now() - new Date(`${sunday}T23:59:59.999Z`).getTime()) / (7 * 24 * 60 * 60 * 1000);
    const isRecent = isCurrentWeek || weeksSinceEnded < 2;

    const CACHE_KEY = `atlas-week-cache:${weekKey}`;
    const CACHE_TTL_MS = isRecent ? 15 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const cached = await kv.get(CACHE_KEY);
    let computed;
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      computed = cached.people;
    } else {
      try {
        const live = await computeWeeklyKpiLive(kv, weekKey);
        computed = live.people;
        await kv.set(CACHE_KEY, { people: computed, cachedAt: Date.now() });
      } catch (e) {
        console.error("[week-live] live Atlas query failed:", e.message);
        return res.status(502).json({ error: `Couldn't reach Atlas: ${e.message}` });
      }
    }

    const overrides = (await kv.get(WEEK_OVERRIDES_KEY)) || {};
    const weekOverrides = overrides[weekKey] || {};

    // A week's metric/threshold carries forward from the most recently
    // configured week (same default-forward behavior as the old
    // CONFIG_KEY flow) — but exclusions deliberately do NOT carry
    // forward (someone being off sick one week shouldn't silently stay
    // excluded forever), matching the old system's own stated reasoning.
    const configs = (await kv.get(WEEK_CONFIGS_KEY)) || {};
    let weekConfig = configs[weekKey];
    if (!weekConfig) {
      const pastKeys = Object.keys(configs).filter((k) => k < weekKey).sort();
      const fallback = pastKeys.length > 0 ? configs[pastKeys[pastKeys.length - 1]] : {};
      weekConfig = { metric: fallback.metric || METRIC_CVS_OUT, threshold: fallback.threshold ?? null, excludedConsultants: [] };
    }
    const excluded = weekConfig.excludedConsultants || [];
    const teamOverrides = (await kv.get(TEAMS_KEY)) || {};

    const applyOverrides = (consultantId, computedForPerson) => {
      const personOverrides = weekOverrides[consultantId] || {};
      return {
        cvsOut: personOverrides.cvsOut ?? computedForPerson.cvsOut ?? 0,
        interviews: personOverrides.interviews ?? computedForPerson.interviews ?? 0,
        onsite: personOverrides.onsite ?? computedForPerson.onsite ?? 0,
        offers: personOverrides.offers ?? computedForPerson.offers ?? 0,
        overridden: {
          cvsOut: personOverrides.cvsOut !== undefined,
          interviews: personOverrides.interviews !== undefined,
          onsite: personOverrides.onsite !== undefined,
          offers: personOverrides.offers !== undefined,
        },
      };
    };

    const consultants = Object.keys(DEFAULT_TEAM_BY_CONSULTANT).map((consultantId) => ({
      consultantId,
      team: teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId],
      excluded: excluded.includes(consultantId),
      ...applyOverrides(consultantId, computed[consultantId] || {}),
    }));

    // Team leads' own activity — a separate array, deliberately never
    // merged into `consultants` above, same isolation principle as the
    // old live-week action just above (see its own comment for why this
    // separation is load-bearing, not cosmetic).
    const teamLeads = Object.keys(TEAM_LEAD_BY_CONSULTANT).map((consultantId) => ({
      consultantId,
      team: TEAM_LEAD_BY_CONSULTANT[consultantId],
      ...applyOverrides(consultantId, computed[consultantId] || {}),
    }));

    return res.status(200).json({
      weekKey, weekStart: monday, weekEnd: sunday,
      metric: weekConfig.metric, threshold: weekConfig.threshold,
      isCurrentWeek,
      consultants, teamLeads,
    });
  }

  if (req.method === "GET" && action === "tally") {
    // Merged in from the old standalone atlas-tally.js — a raw read of a
    // specific (or current) ISO week's tally, used by the "Pull numbers
    // from Atlas" convenience button when correcting a past week.
    const week = typeof req.query.week === "string" ? req.query.week : isoWeekKey(new Date().toISOString());
    const tally = (await kv.get(`${TALLY_PREFIX}${week}`)) || {};
    return res.status(200).json({ week, tally });
  }

  if (req.method === "GET" && action === "kpi-live-monthly") {
    // Feeds the Consultant KPIs page's DISPLAY only — CVs Out, Interviews,
    // Onsite, and Offers are computed fresh, live, directly from Atlas's
    // own candidate-stage-events API every time this is called. No
    // accumulated tally, no webhook dependency, no month-boundary
    // bucketing logic — every event carries its own true date and owner,
    // so there's nothing left to approximate. This is deliberately
    // independent of reload-league-weeks entirely: the actual Weekly
    // Incentive competition (League Table, standings, Team Lead Bonus)
    // still scores off whatever's manually confirmed there in Matchday
    // Setup, completely untouched by this — a director's decision to
    // lock in a week's numbers for competition purposes is a separate
    // concern from what this page displays. A director who wants to
    // correct a specific number on the KPI page itself still can,
    // directly, through that page's own editable override cells
    // (kpi-overrides, handled separately below) — untouched by this.
    //
    // Scoped to ONE MONTH, not a whole year — querying a full year in one
    // call proved genuinely too slow to ever finish in practice: a year
    // can hold thousands of stage events, each needing its own separate,
    // sequential owner lookup, and that request was observed sitting
    // "Pending" for minutes without ever completing. A single month is
    // roughly a twelfth of that volume, which keeps this fast enough to
    // actually return. The `month` param is required (1-12); omitting it
    // falls back to the current UTC month rather than defaulting to a
    // full year, specifically so this can never silently regress back
    // into the slow, whole-year behavior that caused this in the first
    // place.
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
    const month = req.query.month ? parseInt(req.query.month, 10) : new Date().getUTCMonth() + 1;
    const monthStr = String(month).padStart(2, "0");
    const requestedMonthKey = `${year}-${monthStr}`;

    // A cache of the fully computed result for this specific month —
    // deliberately NOT a permanent accumulating tally (that was the old,
    // complex design this whole rebuild moved away from, with its own
    // reconciliation and backfill machinery). How long a cached result
    // stays trusted depends on whether the month could plausibly still
    // be changing: the CURRENT calendar month gets a short window, since
    // new events are still genuinely arriving and a background job (see
    // atlas-reconcile-cron.js) keeps it refreshed automatically — any
    // PAST, fully-elapsed month is treated as settled and cached for a
    // long time, since Atlas's own historical record for a month that's
    // already over essentially doesn't change. Either way, this means a
    // page load reads an already-computed answer far more often than it
    // pays the full live-query cost itself.
    const CACHE_KEY = `atlas-kpi-cache:${requestedMonthKey}`;
    const now = new Date();
    const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    const CACHE_TTL_MS = isCurrentMonth ? 15 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const cached = await kv.get(CACHE_KEY);
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      console.log(`[kpi-live-monthly] ${requestedMonthKey}: served from cache (${Math.round((Date.now() - cached.cachedAt) / 1000)}s old)`);
      return res.status(200).json({ year, month, monthly: { [requestedMonthKey]: cached.monthly } });
    }

    const ALL_PEOPLE_IDS = [...Object.keys(DEFAULT_TEAM_BY_CONSULTANT), ...Object.keys(TEAM_LEAD_BY_CONSULTANT)];
    let live;
    try {
      live = await computeMonthlyKpiLive(kv, year, month);
    } catch (e) {
      console.error("[kpi-live-monthly] live Atlas query failed:", e.message);
      return res.status(502).json({ error: `Couldn't reach Atlas: ${e.message}` });
    }

    console.log(`[kpi-live-monthly] ${requestedMonthKey}: ${live.pagesFetched} page(s), ${live.eventsSeen} event(s) seen, ${live.pairsResolved} unique candidate/project pair(s) resolved, ${live.eventsCounted} counted`);

    for (const personId of ALL_PEOPLE_IDS) {
      if (!live.people[personId]) live.people[personId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
    }

    await kv.set(CACHE_KEY, { monthly: live.people, cachedAt: Date.now() });

    return res.status(200).json({ year, month, monthly: { [requestedMonthKey]: live.people } });
  }

  if (req.method === "GET" && action === "placement-counts") {
    // Deliberately COUNTS ONLY — never returns fee amounts, currency,
    // or anything commission-related. A genuine placement here means
    // exactly what it means everywhere else in this codebase: a real
    // placement-linked candidate name, never a notes-derived onsite fee.
    //
    // Bucketed by "Deals Agreed" — the fee's own feeDate, the SAME date
    // already shown as "Date Signed" on the Yearly Deal Table and
    // Commission pages. Deliberately NOT the placement's start date:
    // Scott's call, since this feeds the Consultant KPIs page, where
    // every other figure (CVs, Interviews, Onsite, Offers) is activity
    // that happened THAT month. A candidate can be signed in March and
    // not start until June — using start date would have shown zero
    // placement activity in March (when the deal was actually agreed)
    // and an unrelated placement landing in June, breaking the
    // Offer:Placement ratio's month-to-month meaning. This intentionally
    // does NOT change how deals.js/commission.js attribute a deal to a
    // YEAR for commission and leaderboard purposes — that's a separate,
    // deliberate choice (start date) unaffected by this.
    const [records, placements] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    ]);
    const seen = new Set(); // dedupe key: consultantId|placementId
    const byConsultantMonth = {};
    // Scott's rule: CitSec Options is excluded from every consultant KPI
    // number, including Deals Agreed here. Only affects records created
    // after this field started being captured — existing records from
    // before this change have no projectName stored and are unaffected.
    // (EXCLUDED_PROJECT_NAME is now imported from _atlasShared.js at the
    // top of this file — the local redeclaration that used to live here
    // has been removed, since both held the identical value anyway.)
    for (const r of records) {
      if (!r.consultantId || !r.placementId) continue;
      if (r.projectName && r.projectName.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) continue;
      const placement = placements[r.placementId];
      const candidateName = placement && placement.candidateName;
      if (!candidateName) continue; // not a genuine placement
      const dedupeKey = `${r.consultantId}|${r.placementId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const mk = monthKeyFromDateStr(r.feeDate);
      if (!byConsultantMonth[r.consultantId]) byConsultantMonth[r.consultantId] = {};
      byConsultantMonth[r.consultantId][mk] = (byConsultantMonth[r.consultantId][mk] || 0) + 1;
    }
    return res.status(200).json({ placementCounts: byConsultantMonth });
  }

  // Manual corrections to the Consultant KPIs page — only ever a MONTHLY
  // override for one specific field (cvs/interviews/onsite/offers/
  // placements), never touching the underlying weekly Atlas data or the
  // League Table's own scoring. Any admin (including team leads) can set
  // these; deliberately public-readable like the rest of league data, so
  // the KPI page can apply them for anyone viewing it.
  const KPI_OVERRIDES_KEY = "kpi-overrides";
  const KPI_OVERRIDE_FIELDS = ["cvs", "interviews", "onsite", "offers", "placements", "calls", "phoneHours"];

  if (req.method === "GET" && action === "kpi-overrides") {
    const overrides = (await kv.get(KPI_OVERRIDES_KEY)) || {};
    return res.status(200).json({ overrides });
  }

  if (req.method === "POST" && action === "set-kpi-override") {
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required." });
    }
    const { personId, monthKey, field, value } = req.body || {};
    if (!personId || !monthKey || !KPI_OVERRIDE_FIELDS.includes(field)) {
      return res.status(400).json({ error: "personId, monthKey, and a valid field are required." });
    }
    // value === null clears the override for that one field, reverting to
    // the auto-computed figure; otherwise it must be a non-negative number.
    if (value !== null && (typeof value !== "number" || isNaN(value) || value < 0)) {
      return res.status(400).json({ error: "value must be a non-negative number, or null to clear the override." });
    }
    const overrides = (await kv.get(KPI_OVERRIDES_KEY)) || {};
    if (!overrides[personId]) overrides[personId] = {};
    if (!overrides[personId][monthKey]) overrides[personId][monthKey] = {};
    if (value === null) {
      delete overrides[personId][monthKey][field];
      if (Object.keys(overrides[personId][monthKey]).length === 0) delete overrides[personId][monthKey];
      if (Object.keys(overrides[personId]).length === 0) delete overrides[personId];
    } else {
      overrides[personId][monthKey][field] = value;
    }
    await kv.set(KPI_OVERRIDES_KEY, overrides);
    return res.status(200).json({ ok: true, overrides });
  }

  if (req.method === "POST" && action === "set-week-override") {
    // The Weekly Incentive's own manual correction, same "always wins"
    // pattern as set-kpi-override just above — Admin, not Super Admin,
    // same access level the KPI page's own overrides already use. Its
    // own field list, deliberately separate from KPI_OVERRIDE_FIELDS
    // above: the weekly data only ever has the four Atlas-derived
    // fields (using cvsOut, matching computeWeeklyKpiLive's own field
    // name, not the KPI page's differently-named "cvs") — it never has
    // placements/calls/phoneHours, which are specific to the KPI page.
    const WEEK_OVERRIDE_FIELDS = ["cvsOut", "interviews", "onsite", "offers"];
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required." });
    }
    const { consultantId, weekKey, field, value } = req.body || {};
    if (!consultantId || !weekKey || !WEEK_OVERRIDE_FIELDS.includes(field)) {
      return res.status(400).json({ error: "consultantId, weekKey, and a valid field are required." });
    }
    if (value !== null && (typeof value !== "number" || isNaN(value) || value < 0)) {
      return res.status(400).json({ error: "value must be a non-negative number, or null to clear the override." });
    }
    const overrides = (await kv.get(WEEK_OVERRIDES_KEY)) || {};
    if (!overrides[weekKey]) overrides[weekKey] = {};
    if (!overrides[weekKey][consultantId]) overrides[weekKey][consultantId] = {};
    if (value === null) {
      delete overrides[weekKey][consultantId][field];
      if (Object.keys(overrides[weekKey][consultantId]).length === 0) delete overrides[weekKey][consultantId];
      if (Object.keys(overrides[weekKey]).length === 0) delete overrides[weekKey];
    } else {
      overrides[weekKey][consultantId][field] = value;
    }
    await kv.set(WEEK_OVERRIDES_KEY, overrides);
    return res.status(200).json({ ok: true, overrides });
  }

  if (req.method === "POST" && action === "set-week-config") {
    // Sets a specific week's metric/threshold/exclusions — the one
    // genuinely manual decision left per week, since Atlas has no way to
    // infer what a week is being scored on. Deliberately separate from
    // the actual volume numbers (which come live from ?action=week-live)
    // — this never touches or overrides a person's own figures, only
    // which figure the competition is scored on and who's excluded.
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required." });
    }
    const { weekKey, metric, threshold, excludedConsultants } = req.body || {};
    if (!weekKey || ![METRIC_CVS_OUT, METRIC_INTERVIEWS, METRIC_RATIO].includes(metric)) {
      return res.status(400).json({ error: "weekKey and a valid metric are required." });
    }
    if (threshold !== null && threshold !== undefined && (typeof threshold !== "number" || isNaN(threshold) || threshold < 0)) {
      return res.status(400).json({ error: "threshold must be a non-negative number, or null." });
    }
    const configs = (await kv.get(WEEK_CONFIGS_KEY)) || {};
    configs[weekKey] = {
      metric,
      threshold: threshold ?? null,
      excludedConsultants: Array.isArray(excludedConsultants) ? excludedConsultants : [],
    };
    await kv.set(WEEK_CONFIGS_KEY, configs);
    return res.status(200).json({ ok: true, config: configs[weekKey] });
  }

  // Merged in from the old standalone consultant-teams.js — current team
  // assignment overrides, keyed by consultantId → "james" | "josh".
  // Deliberately public-readable (like the rest of league data) since it's
  // needed to render the League Table for everyone, logged in or not —
  // only changing it is restricted.
  if (req.method === "GET" && action === "teams") {
    const teams = (await kv.get(TEAMS_KEY)) || {};
    return res.status(200).json({ teams });
  }
  if (req.method === "POST" && action === "set-team") {
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    const { consultantId, team } = req.body || {};
    if (!consultantId || (team !== "james" && team !== "josh")) {
      return res.status(400).json({ error: "consultantId and a valid team (james/josh) are required" });
    }
    const teams = (await kv.get(TEAMS_KEY)) || {};
    teams[consultantId] = team;
    await kv.set(TEAMS_KEY, teams);
    return res.status(200).json({ ok: true, teams });
  }

  if (req.method === "POST" && action === "toggle-exclude") {
    // Excludes someone from this week's scoring entirely — e.g. a new
    // starter it wouldn't be fair to rank yet, or someone on leave whose
    // zeroed numbers shouldn't count against them. Resets automatically
    // each week rather than persisting indefinitely.
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required." });
    }
    const { consultantId } = req.body || {};
    if (!consultantId) return res.status(400).json({ error: "consultantId is required." });
    const { config } = await autoFinalizePastWeeks();
    const current = config.excludedConsultants || [];
    const next = current.includes(consultantId)
      ? current.filter((id) => id !== consultantId)
      : [...current, consultantId];
    const nextConfig = { ...config, excludedConsultants: next };
    await kv.set(CONFIG_KEY, nextConfig);
    return res.status(200).json({ ok: true, config: nextConfig });
  }

  if (req.method === "POST" && action === "set-current-week-config") {
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required." });
    }
    const { metric, threshold } = req.body || {};
    const { config } = await autoFinalizePastWeeks(); // make sure we're editing the genuinely current week
    const nextConfig = { ...config, metric: metric || config.metric, threshold: threshold === undefined ? config.threshold : threshold };
    await kv.set(CONFIG_KEY, nextConfig);
    return res.status(200).json({ ok: true, config: nextConfig });
  }

  if (req.method === "GET") {
    const { weeks } = await autoFinalizePastWeeks();
    return res.status(200).json({ weeks });
  }

  if (req.method === "POST") {
    const { weeks } = req.body || {};
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) {
      return res.status(401).json({ error: "Admin access required to save manual entries." });
    }
    if (!Array.isArray(weeks)) {
      return res.status(400).json({ error: "Malformed weeks payload" });
    }
    await kv.set(WEEKS_KEY, weeks);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};

// kpi-live-monthly in particular can make many sequential calls out to
// Atlas (once per unique candidate/project involved in a year's worth of
// stage events), so this whole file — which handles every action, not
// just that one — gets the same longer limit already given to the
// reconciliation cron job, for the same reason: a legitimately large,
// safe run shouldn't get cut off by a short default before it can finish
// and return a real result.
module.exports.config = {
  maxDuration: 60,
};
