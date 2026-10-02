const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const {
  EXCLUDED_PROJECT_NAME,
  computeMonthlyKpiLive,
  computeWeeklyKpiLive,
  fetchAtlasWithRetry,
  metricForStageName,
  lookupProjectDetails,
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

// Subtracts manually excluded candidate+project pairs (a mistaken
// submission, see the toggle-kpi-exclusion endpoint's own comment for
// the full reasoning) from a person's raw counts — shared by BOTH
// kpi-live-monthly and week-live, deliberately: an exclusion made once,
// on the KPI page, is keyed on the candidate+project pair itself, not
// on "month" or "week" at all, so it must take effect everywhere that
// pair could ever show up, with nothing further for Scott to action on
// the Weekly Incentive page separately. Moved here from the frontend
// specifically so each endpoint itself returns the already-correct
// number: anyone calling either endpoint directly (the Directors site
// included) gets the same adjusted figure automatically, with no need
// to separately read kpi-exclusions or replicate this subtraction
// themselves. Deliberately leaves the details/breakdown argument
// completely untouched — the breakdown list a person opens must always
// show the true, complete history regardless, only the headline count
// itself is adjusted. Returns a NEW object rather than mutating the one
// passed in, since the caller's own variable may still be the thing
// about to get cached or reused elsewhere unexcluded.
function applyKpiExclusions(monthly, monthlyDetails, exclusions) {
  if (!exclusions || Object.keys(exclusions).length === 0) return monthly;
  const adjusted = {};
  for (const [personId, counts] of Object.entries(monthly || {})) {
    const personDetails = (monthlyDetails || {})[personId] || {};
    const excludedCountFor = (metric) => (personDetails[metric] || []).filter(c => c.candidateId && c.projectId && exclusions[`${c.candidateId}:${c.projectId}`]).length;
    adjusted[personId] = {
      cvsOut: Math.max(0, (counts.cvsOut || 0) - excludedCountFor("cvsOut")),
      interviews: Math.max(0, (counts.interviews || 0) - excludedCountFor("interviews")),
      onsite: Math.max(0, (counts.onsite || 0) - excludedCountFor("onsite")),
      offers: Math.max(0, (counts.offers || 0) - excludedCountFor("offers")),
    };
  }
  return adjusted;
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

  // A temporary, Super-Admin-only diagnostic: returns Atlas's own raw,
  // unmodified response for one real candidate from a given week —
  // added specifically because two successive guesses at where Atlas
  // puts a candidate's name (a flat "name" field, then a nested
  // "person.firstName/lastName") both turned out wrong, and a third
  // blind guess isn't a good use of anyone's time. This shows the
  // actual shape directly instead, so the real field can be identified
  // with certainty rather than guessed at again. Safe to remove once
  // the candidate-name field is confirmed and permanently fixed.
  if (req.method === "GET" && action === "debug-candidate-raw") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

    const weekKey = req.query.week;
    if (!weekKey) return res.status(400).json({ error: "week is required, e.g. ?week=2026-W38" });
    const { monday, sunday } = isoWeekToDates(weekKey);

    // Pages through every event for the week now, not just the first
    // 20 — a prior version stopped at one page, and a real week's
    // eventCount landing exactly on that page size was the tell: a
    // specific candidate genuinely being investigated could sit
    // anywhere past that cutoff and never show up at all. Same
    // pagination shape (cursorDate/cursorId, pagination.hasMore) already
    // proven in computeKpiLiveForRange itself, capped generously (10
    // pages, 100 each) to stay well inside one request's time budget.
    let events = [];
    let cursorDate = null, cursorId = null;
    let pagesFetched = 0;
    const MAX_PAGES = 10;
    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams({ createdAfter: monday, createdBefore: sunday, pageSize: "100" });
      if (cursorDate && cursorId) {
        params.set("cursorDate", cursorDate);
        params.set("cursorId", cursorId);
      }
      let apiRes;
      try {
        apiRes = await fetchAtlasWithRetry(
          `https://api.recruitwithatlas.com/api/v1/candidate-stage-events?${params.toString()}`,
          { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
        );
      } catch (e) {
        return res.status(502).json({ error: `stage-events request failed: ${e.message}` });
      }
      if (!apiRes.ok) return res.status(502).json({ error: `stage-events request failed: ${apiRes.status}` });
      const stageJson = await apiRes.json();
      events = events.concat(stageJson.data || []);
      pagesFetched++;
      const pagination = stageJson.pagination || {};
      if (!pagination.hasMore) break;
      cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
      cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
      if (!cursorDate || !cursorId) break;
    }
    if (events.length === 0) return res.status(200).json({ note: `No events found for ${weekKey} at all`, candidates: [] });

    // A compact summary per candidate rather than the full raw blob for
    // every one of them — the earlier, single-candidate version returned
    // everything unmodified (including each project's own huge stages
    // list), which is fine for one candidate but would be an unreadably
    // large paste for a whole week. Still pulling from the real, raw
    // response fields directly (movedBy.name, person.firstName/lastName,
    // project.jobRole, owner.email) — nothing reshaped or guessed at,
    // just narrowed to what's actually relevant to this diagnosis.
    const candidates = await Promise.all(events.map(async (event) => {
      const candidateId = event.candidate && event.candidate.id;
      const projectId = event.project && event.project.id;
      if (!candidateId || !projectId) return { consultant: event.movedBy && event.movedBy.name, error: "event missing candidate or project id" };
      try {
        const candRes = await fetchAtlasWithRetry(
          `https://api.recruitwithatlas.com/api/v1/projects/${projectId}/candidates/${candidateId}`,
          { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
        );
        if (!candRes.ok) return { consultant: event.movedBy && event.movedBy.name, candidateId, error: `candidate detail request failed: ${candRes.status}` };
        const candJson = await candRes.json();
        const data = candJson.data || {};
        const person = data.person || {};
        return {
          consultant: event.movedBy && event.movedBy.name,
          candidateId,
          candidateName: `${person.firstName || ""} ${person.lastName || ""}`.trim() || null,
          jobRole: (data.project && data.project.jobRole) || null,
          projectId,
        };
      } catch (e) {
        return { consultant: event.movedBy && event.movedBy.name, candidateId, error: e.message };
      }
    }));

    return res.status(200).json({ weekKey, eventCount: events.length, pagesFetched, truncated: pagesFetched >= MAX_PAGES, candidates });
  }

  if (req.method === "GET" && action === "debug-atlas-endpoints") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

    // Built specifically to answer one question a persistent 500 on
    // candidate-stage-events leaves open: is this ONE endpoint broken
    // for us, or is Atlas's whole API unreachable right now? Those point
    // at very different things (a bug tied to this specific query vs.
    // something wrong with the API key or account overall), and this is
    // the most direct way to tell them apart — testing several genuinely
    // different endpoints in one pass, each reported on its own, rather
    // than inferring anything from just the one that's already known to
    // fail.
    const results = {};

    // A deliberately tiny, single-day window — if volume or date-range
    // size were somehow the trigger, this rules that out by asking for
    // as little as possible.
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res1 = await fetchAtlasWithRetry(
        `https://api.recruitwithatlas.com/api/v1/candidate-stage-events?createdAfter=${today}T00:00:00.000Z&createdBefore=${today}T23:59:59.999Z&pageSize=5`,
        { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
      );
      const body = await res1.text().catch(() => "");
      results.candidateStageEvents = { status: res1.status, ok: res1.ok, body: body.slice(0, 300) };
    } catch (e) {
      results.candidateStageEvents = { error: e.message };
    }

    // Only run if a real project id is supplied — Scott can copy one
    // straight from Atlas's own URL bar while viewing any pipeline. Not
    // guessed at or scanned for, since a wrong id would just be its own,
    // unrelated 404 muddying the actual answer.
    const projectId = req.query.projectId;
    if (projectId) {
      try {
        const res2 = await fetchAtlasWithRetry(
          `https://api.recruitwithatlas.com/api/v1/projects/${projectId}`,
          { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
        );
        const body = await res2.text().catch(() => "");
        results.projectDetail = { status: res2.status, ok: res2.ok, body: body.slice(0, 300) };
      } catch (e) {
        results.projectDetail = { error: e.message };
      }
    } else {
      results.projectDetail = { skipped: "no ?projectId= supplied" };
    }

    const candidateId = req.query.candidateId;
    if (projectId && candidateId) {
      try {
        const res3 = await fetchAtlasWithRetry(
          `https://api.recruitwithatlas.com/api/v1/projects/${projectId}/candidates/${candidateId}`,
          { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
        );
        const body = await res3.text().catch(() => "");
        results.candidateDetail = { status: res3.status, ok: res3.ok, body: body.slice(0, 300) };
      } catch (e) {
        results.candidateDetail = { error: e.message };
      }
    } else {
      results.candidateDetail = { skipped: "needs both ?projectId= and ?candidateId=" };
    }

    // Reads the actual, current STORED tracking state for one specific
    // candidate+project pair directly — not what Atlas itself says, but
    // what this app has separately recorded: whether a Sourcing reset is
    // on file for this pair, and which period (if any) has already
    // claimed each metric via the cross-period dedup. Built specifically
    // to diagnose "why isn't this candidate showing up" cases precisely,
    // rather than guessing — these are the two pieces of persisted state
    // that could cause exactly that, invisibly, from outside Atlas's own
    // data entirely.
    if (projectId && candidateId) {
      const [sourcingResetIso, firstReachedMonth, firstReachedWeek] = await Promise.all([
        kv.get(`atlas-sourcing-reset:${candidateId}:${projectId}`),
        kv.get(`atlas-first-reached:month:${candidateId}:${projectId}`),
        kv.get(`atlas-first-reached:week:${candidateId}:${projectId}`),
      ]);
      results.pairTrackingState = { sourcingReset: sourcingResetIso || null, firstReachedMonth: firstReachedMonth || null, firstReachedWeek: firstReachedWeek || null };
    } else {
      results.pairTrackingState = { skipped: "needs both ?projectId= and ?candidateId=" };
    }

    // Added specifically to sidestep a real, recurring problem: Atlas's
    // own UI shows several different kinds of id (a "profile" id in one
    // URL, a project-scoped candidate id in another), and copying the
    // wrong one into candidateId above just produces its own unrelated
    // 404, no closer to the real question. Originally tried filtering by
    // project id, but a real check just proved Atlas's own API silently
    // ignores that filter and returns every project's events regardless
    // — so this instead paginates through the WHOLE month directly from
    // Atlas and returns only the events for a specific candidate name,
    // wherever in the month they actually fall. The real candidate id
    // for that person is sitting right there in a matching event,
    // unambiguous, nothing to extract from a URL at all.
    //
    // Which month: an explicit ?year=&month= always wins; otherwise this
    // defaults to the REAL current month, computed fresh each call —
    // never hardcoded to a specific month. A hardcoded month search was
    // the actual, confirmed cause of a real debugging dead end: a
    // candidate's own activity was genuinely in a different month than
    // the one this was silently always searching, so it reported zero
    // matches while implying the candidate simply didn't exist, rather
    // than naming which month it had actually searched.
    const candidateName = req.query.candidateName;
    if (candidateName) {
      try {
        const now = new Date();
        const searchYear = req.query.year ? Number(req.query.year) : now.getUTCFullYear();
        const searchMonth = req.query.month ? Number(req.query.month) : (now.getUTCMonth() + 1);
        const searchMonthKey = `${searchYear}-${String(searchMonth).padStart(2, "0")}`;
        const daysInSearchMonth = new Date(Date.UTC(searchYear, searchMonth, 0)).getUTCDate();
        const needle = candidateName.trim().toLowerCase();
        const matches = [];
        let cursorDate = null, cursorId = null, pagesFetched = 0;
        const MAX_SEARCH_PAGES = 30; // comfortably covers a full month (~2000-3000 events at 100/page) within one request
        while (pagesFetched < MAX_SEARCH_PAGES) {
          const params = new URLSearchParams({ createdAfter: `${searchMonthKey}-01T00:00:00.000Z`, createdBefore: `${searchMonthKey}-${String(daysInSearchMonth).padStart(2, "0")}T23:59:59.999Z`, pageSize: "100" });
          if (cursorDate && cursorId) { params.set("cursorDate", cursorDate); params.set("cursorId", cursorId); }
          const res4 = await fetchAtlasWithRetry(
            `https://api.recruitwithatlas.com/api/v1/candidate-stage-events?${params.toString()}`,
            { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
          );
          if (!res4.ok) { results.candidateNameSearch = { status: res4.status, ok: false, body: (await res4.text().catch(() => "")).slice(0, 300), searchedMonth: searchMonthKey }; break; }
          const json4 = await res4.json();
          pagesFetched++;
          for (const ev of json4.data || []) {
            const full = `${(ev.candidate && ev.candidate.person && ev.candidate.person.firstName) || ""} ${(ev.candidate && ev.candidate.person && ev.candidate.person.lastName) || ""}`.trim().toLowerCase();
            if (full.includes(needle)) matches.push(ev);
          }
          const pagination = json4.pagination || {};
          if (!pagination.hasMore) { results.candidateNameSearch = { ok: true, searchedMonth: searchMonthKey, pagesSearched: pagesFetched, matchCount: matches.length, matches }; break; }
          cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
          cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
          if (!cursorDate || !cursorId) { results.candidateNameSearch = { ok: true, searchedMonth: searchMonthKey, pagesSearched: pagesFetched, matchCount: matches.length, matches, note: "stopped — pagination cursor missing" }; break; }
        }
        if (!results.candidateNameSearch) results.candidateNameSearch = { ok: true, searchedMonth: searchMonthKey, pagesSearched: pagesFetched, matchCount: matches.length, matches, note: `stopped at the ${MAX_SEARCH_PAGES}-page search cap` };
      } catch (e) {
        results.candidateNameSearch = { error: e.message };
      }
    } else {
      results.candidateNameSearch = { skipped: "needs ?candidateName= (a first and/or last name to search for); searches the current real month by default, or add &year=&month= to search a specific one" };
    }

    const testedCount = Object.values(results).filter((r) => !r.skipped).length;
    const allOk = Object.values(results).every((r) => r.ok || r.skipped);
    const allFailed = Object.entries(results).filter(([, r]) => !r.skipped).every(([, r]) => !r.ok);

    return res.status(200).json({
      results,
      note: testedCount < 2
        ? "Only one endpoint was actually tested here (candidate-stage-events) — a projectId (and ideally a candidateId too) is needed to test the other two and tell whether this is specific to that one query or the whole API. Nothing meaningful can be concluded from a single endpoint's result alone, whichever way it goes."
        : allOk
          ? "Every endpoint tested came back fine — whatever's happening with the live pages isn't showing up here."
          : allFailed
            ? "Every endpoint tested is failing, not just candidate-stage-events — this looks like the whole API is unreachable for this key right now, not one specific query."
            : "Mixed results — some endpoints work and others don't, which narrows this down to something specific about the failing one(s), not the API key or account as a whole.",
    });
  }

  if (req.method === "GET" && action === "debug-stage-name-coverage") {
    const caller = await getUserFromRequest(req);
    if (!caller || !caller.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

    // What prompted this: a real pipeline (Citadel US Java Pipeline) uses
    // "CV Submitted" instead of "CV Sent" for the same underlying step —
    // any candidate moved through a differently-named equivalent stage,
    // in ANY pipeline, was silently invisible to CVs Out, Interviews,
    // Onsite or Offers alike, for as long as those metrics only matched
    // one exact string apiece, with no signal anywhere that anything was
    // being missed. This tallies every distinct stage name actually seen
    // across the whole range in one pass — no per-candidate or
    // per-project Atlas lookups at all, so it's fast even across a full
    // month — and reports which ones aren't mapping to any of the four
    // metrics, so a naming variant like that one surfaces on its own
    // instead of needing someone to spot it by chance in Atlas's own UI.
    const weekKey = req.query.week;
    const monthParam = req.query.month; // "2026-09"
    if (!weekKey && !monthParam) return res.status(400).json({ error: "week or month is required, e.g. ?month=2026-09 or ?week=2026-W38" });

    let createdAfter, createdBefore, rangeLabel;
    if (weekKey) {
      const { monday, sunday } = isoWeekToDates(weekKey);
      createdAfter = `${monday}T00:00:00.000Z`;
      createdBefore = `${sunday}T23:59:59.999Z`;
      rangeLabel = weekKey;
    } else {
      const [yearStr, monthStr] = monthParam.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      createdAfter = `${yearStr}-${monthStr}-01T00:00:00.000Z`;
      createdBefore = `${yearStr}-${monthStr}-${String(daysInMonth).padStart(2, "0")}T23:59:59.999Z`;
      rangeLabel = monthParam;
    }

    const tally = {}; // { [stageName]: { count, mappedMetric, projectIds: Set } }
    let cursorDate = null, cursorId = null;
    let pagesFetched = 0;
    let eventsSeen = 0;
    const MAX_PAGES = 100;
    const startTime = Date.now();
    let truncated = false;
    while (pagesFetched < MAX_PAGES) {
      if (Date.now() - startTime > 45000) { truncated = true; break; }
      const params = new URLSearchParams({ createdAfter, createdBefore, pageSize: "100" });
      if (cursorDate && cursorId) {
        params.set("cursorDate", cursorDate);
        params.set("cursorId", cursorId);
      }
      const apiRes = await fetchAtlasWithRetry(
        `https://api.recruitwithatlas.com/api/v1/candidate-stage-events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
      );
      if (!apiRes.ok) return res.status(502).json({ error: `stage-events request failed: ${apiRes.status}` });
      const json = await apiRes.json();
      pagesFetched++;
      for (const event of json.data || []) {
        eventsSeen++;
        if (event.isReverted) continue;
        const stageName = (event.stageTo && event.stageTo.name) || "(no stage name)";
        if (!tally[stageName]) tally[stageName] = { count: 0, mappedMetric: metricForStageName(stageName), projectIds: new Set() };
        tally[stageName].count++;
        const projectId = event.project && event.project.id;
        // Capped per stage name — a stage like "Sourcing" could span
        // hundreds of distinct pipelines, and resolving every single one
        // just to answer "which pipelines use this name" would be a lot
        // of Atlas calls for no extra clarity beyond a representative
        // handful.
        if (projectId && tally[stageName].projectIds.size < 10) tally[stageName].projectIds.add(projectId);
      }
      const pagination = json.pagination || {};
      if (!pagination.hasMore) break;
      cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
      cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
      if (!cursorDate || !cursorId) break;
    }
    if (pagesFetched >= MAX_PAGES) truncated = true;

    const stageNames = Object.entries(tally)
      .map(([stageName, v]) => ({ stageName, count: v.count, mappedMetric: v.mappedMetric, projectIds: v.projectIds }))
      .sort((a, b) => b.count - a.count);
    const unmapped = stageNames.filter((s) => !s.mappedMetric);

    // Only for the unmapped ones — resolving every distinct project for
    // every stage name (mapped or not) would be a lot of extra Atlas
    // calls (though cached, so cheap on repeat) for names that already
    // aren't in question. This is specifically to answer "which
    // pipelines actually use this name", so a real decision can be made
    // about whether it deserves mapping, rather than guessing from the
    // name alone.
    for (const s of unmapped) {
      const pipelines = await Promise.all(Array.from(s.projectIds).map(async (projectId) => {
        const details = await lookupProjectDetails(kv, projectId);
        return { projectId, jobRole: (details && details.jobRole) || null, companyName: (details && details.companyName) || null };
      }));
      s.pipelines = pipelines;
      delete s.projectIds;
    }
    for (const s of stageNames) delete s.projectIds; // mapped ones never needed resolving, just drop the raw ids from the response

    return res.status(200).json({
      range: rangeLabel, eventsSeen, pagesFetched, truncated,
      note: unmapped.length > 0
        ? `${unmapped.length} distinct stage name(s) aren't mapping to any of the four metrics — see "unmappedStageNames" below. Some of these are genuinely fine (offer-rejected, hired, sourcing-only stages, etc. were never meant to count) — but any that look like a CV-out/interview/onsite/offer equivalent under a different name is a real gap.`
        : "Every stage name seen in this range maps to a known metric — no gaps found.",
      unmappedStageNames: unmapped,
      allStageNames: stageNames,
    });
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

    const CACHE_KEY = `atlas-week-cache-v4:${weekKey}`;
    // "-v4": a week cached under "-v3" would be missing the jobRole
    // field entirely (added after "-v3" existed), same reasoning as
    // every previous bump — a cache written before a new piece of data
    // existed can't have that data, and "does peopleDetails exist" alone
    // doesn't catch a breakdown that's just missing its newest field.
    // "-v3" now, for the SAME reason "-v2" existed: a week cached
    // between the candidate-name fix and the LATER project-name fix
    // would have correct candidate names but still-null project names
    // baked in, and "does peopleDetails exist" alone doesn't catch a
    // breakdown that's only partially correct. Bumping this every time
    // a piece of what it contains gets fixed is a blunt tool, but a
    // reliable one — the alternative (checking that every single nested
    // field is non-null) is its own source of false positives, since a
    // genuinely missing name for some other reason would look identical
    // to a poisoned one.
    // "-v2" is deliberate, not decorative: a week cached DURING the
    // brief window between the wrong candidate-name fix and the
    // corrected one would have peopleDetails present (so the earlier
    // "does peopleDetails even exist" staleness check let it through),
    // but every candidateName inside it permanently null, since that's
    // exactly what the wrong extraction produced at the time. Renaming
    // the key throws away every cache entry from before this point
    // wholesale, guaranteeing a genuinely fresh recompute rather than
    // needing to detect "peopleDetails exists but is secretly poisoned"
    // as its own special case.
    // 6 hours, not 15 minutes — the background job that keeps this warm
    // (atlas-reconcile-cron.js) can only run once a day on this Vercel
    // plan (Hobby caps cron at daily; a more frequent schedule fails
    // deployment outright, discovered the hard way). A 15-minute window
    // against a once-daily refresh meant the cache would expire roughly
    // 95 times between each real warm-up, sending far more people than
    // necessary down the slower, live-computed path for no actual
    // freshness benefit. 6 hours roughly matches the gap between the
    // two daily warm runs (6am and noon), so the cache stays genuinely
    // warm through the parts of the day people are actually using this.
    // The "Warm this month's KPI cache now" button remains the right
    // tool for anyone who wants it fresher than that, on demand.
    const CACHE_TTL_MS = isRecent ? 6 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const cached = await kv.get(CACHE_KEY);
    let computed, computedDetails;
    // Set when Atlas is unreachable and a genuinely usable, if merely
    // stale-by-TTL, cached result gets served instead of failing outright
    // — the outage this guards against is exactly the kind where
    // "slightly out of date" beats "completely unavailable". Included on
    // the final response below so the frontend can show a clear "this
    // may be outdated" note rather than presenting it as fully current.
    let isStale = false;
    let staleReason = null;
    // A cache entry written before this candidate-breakdown feature
    // existed has no peopleDetails field at all -- treated here as
    // stale regardless of age, forcing a fresh recompute, rather than
    // silently serving a technically-fresh-by-timestamp result that's
    // missing information it's now supposed to carry.
    if (cached && cached.cachedAt && cached.peopleDetails && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      computed = cached.people;
      computedDetails = cached.peopleDetails;
    } else {
      try {
        const live = await computeWeeklyKpiLive(kv, weekKey);
        computed = live.people;
        computedDetails = live.peopleDetails;
        await kv.set(CACHE_KEY, { people: computed, peopleDetails: computedDetails, cachedAt: Date.now() });
      } catch (e) {
        console.error("[week-live] live Atlas query failed:", e.message);
        if (cached && cached.peopleDetails) {
          console.warn(`[week-live] serving stale cache for ${weekKey} — Atlas is unreachable, age: ${cached.cachedAt ? Math.round((Date.now() - cached.cachedAt) / 60000) + "min" : "unknown"}`);
          computed = cached.people;
          computedDetails = cached.peopleDetails;
          isStale = true;
          staleReason = `Couldn't reach Atlas for a fresh number — showing the last successfully loaded data instead${cached.cachedAt ? ` (from ${Math.round((Date.now() - cached.cachedAt) / 60000)} minutes ago)` : ""}.`;
        } else {
          return res.status(502).json({ error: `Couldn't reach Atlas: ${e.message}` });
        }
      }
    }

    // A manual exclusion made on the Consultant KPIs page applies here
    // automatically — see applyKpiExclusions' own comment for why this
    // is deliberately shared with kpi-live-monthly, not something Scott
    // needs to separately action on this page too.
    const kpiExclusions = (await kv.get("kpi-exclusions")) || {};
    computed = applyKpiExclusions(computed, computedDetails, kpiExclusions);

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
      candidates: computedDetails[consultantId] || null,
    }));

    // Team leads' own activity — a separate array, deliberately never
    // merged into `consultants` above, same isolation principle as the
    // old live-week action just above (see its own comment for why this
    // separation is load-bearing, not cosmetic).
    const teamLeads = Object.keys(TEAM_LEAD_BY_CONSULTANT).map((consultantId) => ({
      consultantId,
      team: TEAM_LEAD_BY_CONSULTANT[consultantId],
      ...applyOverrides(consultantId, computed[consultantId] || {}),
      candidates: computedDetails[consultantId] || null,
    }));

    return res.status(200).json({
      weekKey, weekStart: monday, weekEnd: sunday,
      metric: weekConfig.metric, threshold: weekConfig.threshold,
      isCurrentWeek,
      consultants, teamLeads,
      stale: isStale, staleReason,
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
    const CACHE_KEY = `atlas-kpi-cache-v4:${requestedMonthKey}`;
    // "-v4" for the same reason as week-live's own cache key just above.
    // "-v3" for the exact same reason as week-live's own cache key just
    // above (see its comment) — a month cached between the candidate-
    // name fix and the LATER project-name fix would have correct
    // candidate names but still-null project names baked in.
    // "-v2" for the exact same reason as week-live's own cache key just
    // above (see its comment) — a month cached during the brief window
    // between the wrong candidate-name fix and the corrected one would
    // have monthlyDetails present but every candidateName inside it
    // permanently null, which the earlier "does monthlyDetails even
    // exist" check alone wasn't strict enough to catch.
    const now = new Date();
    const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    // 6 hours, not 15 minutes — see the matching comment on week-live's
    // own CACHE_TTL_MS just above for the full reasoning: the background
    // warming job can only run once a day on this plan, so the cache
    // window is set to roughly match that instead of expiring itself
    // many times between each real refresh.
    const CACHE_TTL_MS = isCurrentMonth ? 6 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const cached = await kv.get(CACHE_KEY);
    // Fetched once, applied to whichever of the three response paths
    // below actually gets used — see applyKpiExclusions's own
    // comment for why this lives here, in the endpoint itself, rather
    // than left for each separate consumer of this endpoint to
    // replicate on their own.
    const kpiExclusions = (await kv.get("kpi-exclusions")) || {};
    // Same reasoning as week-live's own cache check just above: a cache
    // entry from before this feature existed has no monthlyDetails at
    // all, and is treated as stale regardless of its age so it gets
    // recomputed fresh rather than silently serving an
    // information-incomplete result for up to 6 hours.
    if (cached && cached.cachedAt && cached.monthlyDetails && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      console.log(`[kpi-live-monthly] ${requestedMonthKey}: served from cache (${Math.round((Date.now() - cached.cachedAt) / 1000)}s old)`);
      return res.status(200).json({ year, month, monthly: { [requestedMonthKey]: applyKpiExclusions(cached.monthly, cached.monthlyDetails, kpiExclusions) }, monthlyDetails: { [requestedMonthKey]: cached.monthlyDetails } });
    }

    const ALL_PEOPLE_IDS = [...Object.keys(DEFAULT_TEAM_BY_CONSULTANT), ...Object.keys(TEAM_LEAD_BY_CONSULTANT)];
    let live;
    let isStale = false;
    let staleReason = null;
    try {
      live = await computeMonthlyKpiLive(kv, year, month);
    } catch (e) {
      console.error("[kpi-live-monthly] live Atlas query failed:", e.message);
      // Atlas being unreachable shouldn't mean showing nothing at all
      // when a genuinely usable, if merely stale-by-TTL, cached result
      // already exists right here — the outage this guards against is
      // exactly the kind where "slightly out of date" beats "completely
      // unavailable". Only reached when the cache above didn't already
      // satisfy the TTL check, so this is deliberately a second look at
      // the SAME cached value with that requirement relaxed, not a
      // separate, looser cache.
      if (cached && cached.monthlyDetails) {
        console.warn(`[kpi-live-monthly] serving stale cache for ${requestedMonthKey} — Atlas is unreachable, age: ${cached.cachedAt ? Math.round((Date.now() - cached.cachedAt) / 60000) + "min" : "unknown"}`);
        return res.status(200).json({
          year, month, monthly: { [requestedMonthKey]: applyKpiExclusions(cached.monthly, cached.monthlyDetails, kpiExclusions) }, monthlyDetails: { [requestedMonthKey]: cached.monthlyDetails },
          stale: true, staleReason: `Couldn't reach Atlas for a fresh number — showing the last successfully loaded data instead${cached.cachedAt ? ` (from ${Math.round((Date.now() - cached.cachedAt) / 60000)} minutes ago)` : ""}.`,
        });
      }
      return res.status(502).json({ error: `Couldn't reach Atlas: ${e.message}` });
    }

    console.log(`[kpi-live-monthly] ${requestedMonthKey}: ${live.pagesFetched} page(s), ${live.eventsSeen} event(s) seen, ${live.pairsResolved} unique candidate/project pair(s) resolved, ${live.eventsCounted} counted`);

    for (const personId of ALL_PEOPLE_IDS) {
      if (!live.people[personId]) live.people[personId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
    }

    // The cache itself always stores the raw, UN-excluded numbers,
    // deliberately — exclusions are applied fresh at response time
    // below, never baked into what's cached, so un-excluding something
    // later doesn't need a full recompute to correctly "add the
    // candidate back".
    await kv.set(CACHE_KEY, { monthly: live.people, monthlyDetails: live.peopleDetails, cachedAt: Date.now() });

    return res.status(200).json({ year, month, monthly: { [requestedMonthKey]: applyKpiExclusions(live.people, live.peopleDetails, kpiExclusions) }, monthlyDetails: { [requestedMonthKey]: live.peopleDetails }, stale: isStale, staleReason });
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
    // Candidate-level breakdown alongside the counts above, same
    // principle as the candidate-stage-events path just above it in
    // this file (compute-all-due's own popover) — except this one needs
    // no extra Atlas call at all, since candidateName and the client's
    // company name are already sitting right here on the placement
    // object already in KV.
    const byConsultantMonthDetails = {};
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
      if (!byConsultantMonthDetails[r.consultantId]) byConsultantMonthDetails[r.consultantId] = {};
      if (!byConsultantMonthDetails[r.consultantId][mk]) byConsultantMonthDetails[r.consultantId][mk] = [];
      byConsultantMonthDetails[r.consultantId][mk].push({
        candidateName,
        projectName: placement.clientCompanyName || r.projectClientName || null,
      });
    }
    return res.status(200).json({ placementCounts: byConsultantMonth, placementDetails: byConsultantMonthDetails });
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

  // A genuinely different mechanism from kpi-overrides above: that one
  // replaces a whole month's figure outright with a manually-typed
  // number; this one excludes one specific, mistaken candidate
  // submission from the count, leaving everything else that genuinely
  // belongs in that figure untouched. Keyed on candidateId:projectId --
  // Atlas's own per-pipeline identifiers, the same ones every dedup
  // elsewhere in this app already keys on, deliberately never the
  // candidate's shared person.id -- so excluding one mistaken submission
  // for one specific role never touches that same real person's other,
  // genuinely separate roles. Applies across every metric for that one
  // pair (Scott's own explicit call: a mistaken submission is wrong at
  // the root, so whatever stage it reached under that submission
  // shouldn't count either), but is applied entirely on the frontend,
  // as a subtraction from the already-computed figure -- never baked
  // into computeMonthlyKpiLive itself -- so excluding something takes
  // effect immediately, with no force-recompute ever needed the way an
  // actual logic change to the underlying counting would.
  const KPI_EXCLUSIONS_KEY = "kpi-exclusions";
  if (req.method === "GET" && action === "kpi-exclusions") {
    const exclusions = (await kv.get(KPI_EXCLUSIONS_KEY)) || {};
    return res.status(200).json({ exclusions });
  }

  if (req.method === "POST" && action === "toggle-kpi-exclusion") {
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }
    const { candidateId, projectId, excluded } = req.body || {};
    if (!candidateId || !projectId || typeof excluded !== "boolean") {
      return res.status(400).json({ error: "candidateId, projectId, and a boolean excluded are all required." });
    }
    const exclusions = (await kv.get(KPI_EXCLUSIONS_KEY)) || {};
    const pairKey = `${candidateId}:${projectId}`;
    if (excluded) {
      exclusions[pairKey] = { excludedAt: Date.now(), excludedBy: user.email };
    } else {
      delete exclusions[pairKey];
    }
    await kv.set(KPI_EXCLUSIONS_KEY, exclusions);
    return res.status(200).json({ ok: true, exclusions });
  }

  if (req.method === "GET" && action === "cv-history-backfill-status") {
    // Lets the KPI page's own backfill tools check what's already
    // genuinely, fully done (written by atlas-reconcile-cron.js
    // whenever a month or week completes without needing another pass)
    // BEFORE walking through any periods at all — so a refresh mid-run,
    // or simply clicking the button again later, correctly skips
    // straight to whatever's left, rather than re-doing already-settled
    // history from the very start every single time.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });
    const progress = (await kv.get("atlas-cv-history-backfill-done")) || { month: {}, week: {} };
    return res.status(200).json(progress);
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

  if (req.method === "POST" && action === "clear-all-kpi-overrides") {
    // Deliberately Super Admin, not just Admin like the single-field
    // version above — this wipes many manual corrections across many
    // people and months at once, which is a genuinely different, much
    // larger-blast-radius action than correcting one field for one
    // person for one month.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }
    const year = req.query.year;
    if (!year || !/^\d{4}$/.test(year)) {
      return res.status(400).json({ error: "year is required, e.g. ?year=2026 — this clears one specific year at a time, never every year at once." });
    }
    // An optional, further narrowing to one specific month within that
    // year — added specifically so a single month can be tried first
    // (see how it goes) before committing to the whole year at once.
    const month = req.query.month;
    if (month && !/^([1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: "month, if supplied, must be 1-12." });
    }
    const targetMonthKey = month ? `${year}-${String(month).padStart(2, "0")}` : null;
    // Only the fields this session's own live-computation work actually
    // produces a real replacement for (cvs, interviews, onsite, offers)
    // — calls and phoneHours come from Ringover, and placements
    // (Deals Agreed) from fee records, both entirely separate systems
    // this "Warm" mechanism never touches, so clearing THOSE overrides
    // would leave nothing real behind to replace them with.
    const CLEARABLE_FIELDS = ["cvs", "interviews", "onsite", "offers"];
    const overrides = (await kv.get(KPI_OVERRIDES_KEY)) || {};
    let clearedCount = 0;
    for (const personId of Object.keys(overrides)) {
      for (const monthKey of Object.keys(overrides[personId])) {
        if (!monthKey.startsWith(`${year}-`)) continue; // a different year entirely — left untouched
        if (targetMonthKey && monthKey !== targetMonthKey) continue; // a specific month was requested — every other month in this same year is left untouched too
        for (const field of CLEARABLE_FIELDS) {
          if (field in overrides[personId][monthKey]) {
            delete overrides[personId][monthKey][field];
            clearedCount++;
          }
        }
        if (Object.keys(overrides[personId][monthKey]).length === 0) delete overrides[personId][monthKey];
      }
      if (Object.keys(overrides[personId]).length === 0) delete overrides[personId];
    }
    await kv.set(KPI_OVERRIDES_KEY, overrides);
    // Clearing the overrides alone does nothing to what's actually
    // DISPLAYED unless each affected month's own live cache genuinely
    // has real, Atlas-derived numbers to fall back to — a month that
    // was always manually entered from day one may never have had a
    // live computation run for it at all. Clearing here, then warming
    // each affected month (via ?action=... with an explicit year/month)
    // is the full, two-step path to genuinely replacing old manual
    // numbers with real ones, not just this one step alone.
    return res.status(200).json({ ok: true, year, month: month || null, monthKey: targetMonthKey, clearedCount, fieldsCleared: CLEARABLE_FIELDS });
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

  if (req.method === "POST" && action === "migrate-legacy-weeks") {
    // A one-time (but safely repeatable) migration from the old,
    // webhook-fed reload-league-weeks into the new live-query-backed
    // system — Super Admin only, given how consequential this is: it can
    // genuinely change what a past week's numbers show. Deliberately
    // NOT run automatically on deploy; a director triggers this
    // knowingly, once, when ready.
    //
    // The actual distinction this makes, deliberately: a week that was
    // only ever auto-finalized (autoFinalized === true) and never
    // touched again holds whatever the flawed, webhook-fed tally
    // happened to capture at the time — that's exactly the unreliable
    // data the live rebuild exists to replace, so it's discarded here
    // and left for the new system to compute fresh, accurately, from
    // Atlas directly. A week that WAS manually touched at some point
    // (autoFinalized is false, cleared by an explicit edit, OR
    // undefined, a brand-new manual entry that never went through
    // auto-finalize at all) represents a director's own deliberate,
    // checked correction — that's preserved as a permanent override on
    // top of the new live number, exactly the same as any override set
    // going forward.
    //
    // Every week's metric/threshold/exclusions carry over regardless,
    // since that's a real decision made at the time, not something
    // Atlas could ever reconstruct on its own.
    //
    // Field names differ between the two systems (the old rows use
    // "cvs", the new live/override data uses "cvsOut", matching Atlas's
    // own field name) — mapped explicitly here, not assumed identical.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }

    const legacyWeeks = (await kv.get(WEEKS_KEY)) || [];
    const configs = (await kv.get(WEEK_CONFIGS_KEY)) || {};
    const overrides = (await kv.get(WEEK_OVERRIDES_KEY)) || {};

    let weeksProcessed = 0;
    let weeksWithPreservedOverrides = 0;
    let weeksSkippedNoDate = 0;

    for (const week of legacyWeeks) {
      let weekKey;
      if (typeof week.id === "string" && week.id.startsWith("auto-")) {
        weekKey = week.id.slice("auto-".length);
      } else if (week.date) {
        weekKey = isoWeekKey(week.date);
      } else {
        weeksSkippedNoDate++;
        continue;
      }

      const excludedConsultants = Object.keys(week.rows || {}).filter((cid) => week.rows[cid].excluded);
      configs[weekKey] = {
        metric: week.metric || METRIC_CVS_OUT,
        threshold: week.threshold ?? null,
        excludedConsultants,
      };

      if (week.autoFinalized !== true) {
        if (!overrides[weekKey]) overrides[weekKey] = {};
        for (const [consultantId, r] of Object.entries(week.rows || {})) {
          if (!overrides[weekKey][consultantId]) overrides[weekKey][consultantId] = {};
          if (typeof r.cvs === "number") overrides[weekKey][consultantId].cvsOut = r.cvs;
          if (typeof r.interviews === "number") overrides[weekKey][consultantId].interviews = r.interviews;
          if (typeof r.onsite === "number") overrides[weekKey][consultantId].onsite = r.onsite;
          if (typeof r.offers === "number") overrides[weekKey][consultantId].offers = r.offers;
        }
        weeksWithPreservedOverrides++;
      }
      weeksProcessed++;
    }

    await kv.set(WEEK_CONFIGS_KEY, configs);
    await kv.set(WEEK_OVERRIDES_KEY, overrides);

    return res.status(200).json({
      ok: true,
      totalLegacyWeeks: legacyWeeks.length,
      weeksProcessed,
      weeksWithPreservedOverrides,
      weeksRecomputedFresh: weeksProcessed - weeksWithPreservedOverrides,
      weeksSkippedNoDate,
    });
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
