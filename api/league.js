const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const {
  EXCLUDED_PROJECT_NAME,
  EMAIL_TO_CONSULTANT,
  metricForStageName,
  fetchAtlasWithRetry,
  lookupProjectName,
  lookupCandidateOwnerEmailCached,
} = require("./_atlasShared.js");

const WEEKS_KEY = "reload-league-weeks";
const CONFIG_KEY = "reload-current-week-config";
const TEAMS_KEY = "consultant-teams";
const TALLY_PREFIX = "atlas-tally:";
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
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const createdAfter = `${year}-${monthStr}-01T00:00:00.000Z`;
    const createdBefore = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}T23:59:59.999Z`;
    const requestedMonthKey = `${year}-${monthStr}`;

    const ALL_PEOPLE_IDS = [...Object.keys(DEFAULT_TEAM_BY_CONSULTANT), ...Object.keys(TEAM_LEAD_BY_CONSULTANT)];
    const monthly = { [requestedMonthKey]: {} };
    const seenDedupeKeys = new Set(); // `${candidateId}:${projectId}:${metric}` — a candidate genuinely only ever counts once per metric per project, computed fresh within this one request rather than a persisted dedup key
    let eventsSeen = 0, eventsCounted = 0;
    let cursorDate = null, cursorId = null;
    let pagesFetched = 0;
    const MAX_PAGES = 20; // safety cap — 20 * 100 = 2000 events, comfortably beyond one month's realistic volume
    // Vercel kills this function outright at its own maxDuration (60s),
    // with no chance to return a useful error — just a generic, opaque
    // 502. This budget bails out deliberately, well before that, so a
    // month that's taking too long (e.g. genuinely exhausted rate limits
    // making many sequential owner lookups slow) fails with a real,
    // specific, loggable reason instead of an unexplained platform kill.
    const startTime = Date.now();
    const TIME_BUDGET_MS = 45000;

    try {
      while (pagesFetched < MAX_PAGES) {
        if (Date.now() - startTime > TIME_BUDGET_MS) {
          throw new Error(`Timed out after ${Math.round((Date.now() - startTime) / 1000)}s — likely a sustained Atlas rate limit rather than a one-off blip (${eventsSeen} events seen so far). Try again in a minute.`);
        }
        const params = new URLSearchParams({ createdAfter, createdBefore, pageSize: "100" });
        if (cursorDate && cursorId) {
          params.set("cursorDate", cursorDate);
          params.set("cursorId", cursorId);
        }
        const apiRes = await fetchAtlasWithRetry(
          `https://api.recruitwithatlas.com/api/v1/candidate-stage-events?${params.toString()}`,
          { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
        );
        if (!apiRes.ok) {
          const body = await apiRes.text().catch(() => "");
          throw new Error(`candidate-stage-events request failed: ${apiRes.status} ${body}`);
        }
        const json = await apiRes.json();
        pagesFetched++;

        for (const event of json.data || []) {
          if (Date.now() - startTime > TIME_BUDGET_MS) {
            throw new Error(`Timed out after ${Math.round((Date.now() - startTime) / 1000)}s mid-page — likely a sustained Atlas rate limit rather than a one-off blip (${eventsSeen} events seen, ${eventsCounted} counted so far). Try again in a minute.`);
          }
          eventsSeen++;
          if (event.isReverted) continue;

          const metric = metricForStageName(event.stageTo && event.stageTo.name);
          if (!metric) continue;

          const projectId = event.project && event.project.id;
          const candidateId = event.candidate && event.candidate.id;
          if (!projectId || !candidateId) continue;

          const dedupeKey = `${candidateId}:${projectId}:${metric}`;
          if (seenDedupeKeys.has(dedupeKey)) continue;

          const projectName = await lookupProjectName(kv, projectId);
          if (projectName && projectName.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) continue;

          const email = await lookupCandidateOwnerEmailCached(kv, projectId, candidateId);
          const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
          if (!consultantId) continue;

          seenDedupeKeys.add(dedupeKey);

          if (!monthly[requestedMonthKey][consultantId]) monthly[requestedMonthKey][consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
          monthly[requestedMonthKey][consultantId][metric] += 1;
          eventsCounted++;
        }

        const pagination = json.pagination || {};
        if (!pagination.hasMore) break;
        cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
        cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
        if (!cursorDate || !cursorId) break;
      }
    } catch (e) {
      console.error("[kpi-live-monthly] live Atlas query failed:", e.message);
      return res.status(502).json({ error: `Couldn't reach Atlas: ${e.message}` });
    }

    console.log(`[kpi-live-monthly] ${requestedMonthKey}: ${pagesFetched} page(s), ${eventsSeen} event(s) seen, ${eventsCounted} counted`);

    for (const personId of ALL_PEOPLE_IDS) {
      if (!monthly[requestedMonthKey][personId]) monthly[requestedMonthKey][personId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
    }

    return res.status(200).json({ year, month, monthly });
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
