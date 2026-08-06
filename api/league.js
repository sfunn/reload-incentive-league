const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

const WEEKS_KEY = "reload-league-weeks";
const CONFIG_KEY = "reload-current-week-config";
const TEAMS_KEY = "consultant-teams";
const TALLY_PREFIX = "atlas-tally:";

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
    config = { weekKey: nowKey, metric: METRIC_CVS_OUT, threshold: null };
    await kv.set(CONFIG_KEY, config);
    return { weeks, config };
  }
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
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0 };
      const team = teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId];
      const cvs = t.cvsOut || 0;
      const interviews = t.interviews || 0;
      rows[consultantId] = {
        cvs, interviews, team,
        metricValue: computeMetricValue(config.metric, cvs, interviews),
      };
    }
    const newWeek = {
      id: `auto-${config.weekKey}`,
      date: sunday,
      metric: config.metric || METRIC_CVS_OUT,
      threshold: config.threshold ?? null,
      rows,
      autoFinalized: true,
    };
    nextWeeks = [...weeks, newWeek];
    await kv.set(WEEKS_KEY, nextWeeks);
  }

  // Move the "current week" forward — carrying the same metric/threshold
  // forward as the sensible default until an Admin changes it.
  const newConfig = { weekKey: nowKey, metric: config.metric || METRIC_CVS_OUT, threshold: config.threshold ?? null };
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
    const consultants = Object.keys(DEFAULT_TEAM_BY_CONSULTANT).map((consultantId) => {
      const t = tally[consultantId] || { cvsOut: 0, interviews: 0 };
      return {
        consultantId,
        team: teamOverrides[consultantId] || DEFAULT_TEAM_BY_CONSULTANT[consultantId],
        cvsOut: t.cvsOut || 0,
        interviews: t.interviews || 0,
      };
    });
    return res.status(200).json({ weekKey: config.weekKey, weekStart: monday, weekEnd: sunday, metric: config.metric, threshold: config.threshold, consultants });
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
