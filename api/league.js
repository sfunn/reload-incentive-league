const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

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

  if (req.method === "GET" && action === "placement-counts") {
    // Deliberately COUNTS ONLY — never returns fee amounts, currency,
    // or anything commission-related. A genuine placement here means
    // exactly what it means everywhere else in this codebase: a real
    // placement-linked candidate name, never a notes-derived onsite fee.
    // Bucketed by month using the placement's START DATE, same convention
    // as the year-bucketing rule used for the Yearly Deal Table.
    const [records, placements] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    ]);
    const seen = new Set(); // dedupe key: consultantId|placementId
    const byConsultantMonth = {};
    for (const r of records) {
      if (!r.consultantId || !r.placementId) continue;
      const placement = placements[r.placementId];
      const candidateName = placement && placement.candidateName;
      if (!candidateName) continue; // not a genuine placement
      const dedupeKey = `${r.consultantId}|${r.placementId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const mk = monthKeyFromDateStr(placement.startDate || r.feeDate);
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
  const KPI_OVERRIDE_FIELDS = ["cvs", "interviews", "onsite", "offers", "placements"];

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
