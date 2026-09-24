// Shared between api/atlas-webhook.js and api/atlas-reconcile-cron.js.
// Underscore-prefixed so Vercel excludes it from routing — it's a plain
// module, not an API endpoint, and doesn't count against the 12-function
// Hobby-plan cap. The whole point of this file existing is that these
// mappings must be byte-identical in both places: if a stage name or a
// consultant's email were ever updated in one file and not the other, the
// webhook and the reconciliation job would silently disagree about what
// counts as what, which defeats the reconciliation job's entire purpose
// (catching what the webhook missed, not re-litigating what counts).

const CVS_OUT_STAGE = "CV Sent";
const INTERVIEW_STAGES = ["1st Stage Interview", "HRX", "HR call"];
const ONSITE_STAGES = ["Onsite"];
const OFFER_STAGES = ["Offer"];

const INTERVIEW_COUNTED_KEY = "atlas-interview-counted";
const ONSITE_COUNTED_KEY = "atlas-onsite-counted";
const OFFER_COUNTED_KEY = "atlas-offer-counted";
// Added alongside the reconciliation job: CVs Out previously had no dedup
// key at all, since a single webhook firing once per genuine event never
// needed one. But a reconciliation job polling the same underlying event
// from a separate source (the candidate-stage-events API) has no way to
// know the webhook already counted it, for CVs Out specifically — the
// other three metrics were already protected by their own dedup keys,
// this makes CVs Out consistent with them, on the same reasoning: a
// candidate genuinely should only ever count as "CV Sent" once per
// project, no matter how many times that stage gets touched.
const CVS_OUT_COUNTED_KEY = "atlas-cvsout-counted";

const PROJECT_NAMES_CACHE_KEY = "atlas-project-names-cache-v2";
// "-v2" because this cache key is SHARED with atlas-fee-webhook.js's own
// copy of this same lookup (see its own comment for the full story) —
// both were extracting the wrong field (a flat "name" that doesn't
// exist; the real field is company.name) and both wrote into this same
// cache, so every project id looked up by either one got permanently
// stuck with a null name. Both files' cache key must stay in sync.
const EXCLUDED_PROJECT_NAME = "citsec options";

const EMAIL_TO_CONSULTANT = {
  "alex@reloadsearch.com": "alex-silverman",
  "ash@reloadsearch.com": "ash-thiara",
  "jack@reloadsearch.com": "jack-thompson",
  "max@reloadsearch.com": "max-hart",
  "oleg@reloadsearch.com": "oleg-sokyrka",
  "alexander@reloadsearch.com": "alex-aparo",
  "jackr@reloadsearch.com": "jack-routledge",
  "joe@reloadsearch.com": "joe-purton",
  "joshd@reloadsearch.com": "josh-davis",
  "natasha@reloadsearch.com": "natasha-barnard",
  "james@reloadsearch.com": "james-lancer",
  "josh@reloadsearch.com": "josh-stark",
};

function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Given a stage name (e.g. newStage.name from the webhook, or stageTo.name
// from the candidate-stage-events API), returns which KPI metric it counts
// toward, or null if it's not a tracked stage at all.
function metricForStageName(stageName) {
  if (stageName === CVS_OUT_STAGE) return "cvsOut";
  if (INTERVIEW_STAGES.includes(stageName)) return "interviews";
  if (ONSITE_STAGES.includes(stageName)) return "onsite";
  if (OFFER_STAGES.includes(stageName)) return "offers";
  return null;
}

const DEDUPE_KEY_BY_METRIC = {
  cvsOut: CVS_OUT_COUNTED_KEY,
  interviews: INTERVIEW_COUNTED_KEY,
  onsite: ONSITE_COUNTED_KEY,
  offers: OFFER_COUNTED_KEY,
};

// Atlas's own documented rate limits (from their API introduction): 1200
// read requests per 60 seconds, per agency, shared across every endpoint
// this whole app calls. A 429 response includes retryAfterSec, and
// Atlas's own guidance is explicit: "watch RateLimit-Remaining and slow
// down... rather than retrying on 429s" blindly. This wraps every Atlas
// GET call this project makes with a small, DELIBERATELY SHORT retry —
// one quick attempt, capped at a couple of seconds, in case a specific
// call hit a transient blip. It does NOT try to wait out a genuinely
// exhausted, agency-wide rate limit window (which can take up to 60
// seconds to clear): a single request here makes many sequential calls
// (one per unique candidate), and if each one waited the full window
// before retrying, those waits would stack up sequentially and could
// easily exceed this whole function's own execution time limit — turning
// a fast, clear failure into a slow, confusing hang that still fails
// anyway. A genuinely exhausted limit is better surfaced quickly as a
// real error (the KPI page's own error banner handles this, with a
// manual Retry the user can use once the window's had a chance to
// reset) than gambled on silently within one request.
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_WAIT_MS = 2000;
async function fetchAtlasWithRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    if (attempt === MAX_RATE_LIMIT_RETRIES) return res; // out of retries — let the caller see the final 429
    let retryAfterSec = 2;
    try {
      const body = await res.clone().json();
      if (typeof body.retryAfterSec === "number") retryAfterSec = body.retryAfterSec;
    } catch (e) { /* fall back to the default above */ }
    const waitMs = Math.min(retryAfterSec * 1000, MAX_RETRY_WAIT_MS);
    console.warn(`[atlas-shared] 429 rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function lookupProjectName(kv, projectId) {
  if (!projectId) return null;
  const cache = (await kv.get(PROJECT_NAMES_CACHE_KEY)) || {};
  if (projectId in cache) return cache[projectId];
  let name = null;
  try {
    const res = await fetchAtlasWithRetry(
      `https://api.recruitwithatlas.com/api/v1/projects/${projectId}`,
      { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
    );
    if (res.ok) {
      const json = await res.json();
      // A project has no flat "name" field at all — confirmed directly
      // from Atlas's own raw response (it returns jobRole and a nested
      // company.name instead). This is genuinely the client's own name,
      // e.g. "PDT Partners" — the same field atlas-fee-webhook.js's own
      // lookupProjectClientName() already uses (json.data.company.name),
      // proven correct there since it's what's driven this exact CitSec
      // Options exclusion in production commission/KPI data all along.
      // Deliberately matching that proven field rather than guessing
      // again, since a guess is exactly what got this wrong twice
      // already this session for the candidate-name lookup.
      const data = json.data || {};
      name = (data.company && data.company.name) || null;
    }
  } catch (e) {
    console.error("[atlas-shared] project name lookup failed:", e.message);
  }
  cache[projectId] = name;
  await kv.set(PROJECT_NAMES_CACHE_KEY, cache);
  return name;
}

async function lookupCandidateOwnerEmail(projectId, candidateId) {
  const res = await fetchAtlasWithRetry(
    `https://api.recruitwithatlas.com/api/v1/projects/${projectId}/candidates/${candidateId}`,
    { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Atlas candidate lookup failed: ${res.status}`);
  const json = await res.json();
  const owner = json.data && json.data.owner;
  return owner ? owner.email : null;
}

// The same underlying Atlas endpoint as the owner-email lookup above,
// but ALSO capturing the candidate's own name — added specifically so
// a live CVs Out / Interviews count can be broken down into the actual
// candidates behind it (e.g. reconciling "this week doesn't match,
// something's missing" against Atlas by name, not just a bare number).
// Deliberately a SEPARATE function from lookupCandidateOwnerEmail
// rather than changing that one's return shape — it's called directly
// (expecting a plain email string back) by atlas-webhook.js and
// atlas-reconcile-cron.js, and touching its shape would mean carefully
// updating both of those production-critical paths for no reason this
// one specifically needs. The exact field Atlas uses for a candidate's
// name isn't confirmed anywhere else in this codebase, so this tries
// the couple of most likely shapes and falls back to null (which the
// frontend shows as "Unknown candidate") rather than guessing wrong
// and silently mislabelling someone.
async function lookupCandidateDetails(projectId, candidateId) {
  const res = await fetchAtlasWithRetry(
    `https://api.recruitwithatlas.com/api/v1/projects/${projectId}/candidates/${candidateId}`,
    { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Atlas candidate lookup failed: ${res.status}`);
  const json = await res.json();
  const data = json.data || {};
  const owner = data.owner;
  // Atlas nests a candidate's actual name under its own "person" object
  // (person.firstName / person.lastName) rather than flat on the
  // candidate itself — confirmed from the exact shape already used
  // elsewhere in this codebase for stage-event payloads
  // (candidate.person.firstName/lastName, e.g. in the webhook and its
  // own tests). The flatter shapes are kept as fallbacks in case a
  // future Atlas response varies, but person.* is the one actually
  // confirmed to exist.
  const person = data.person || {};
  const name =
    (person.firstName || person.lastName ? `${person.firstName || ""} ${person.lastName || ""}`.trim() : null) ||
    data.name || data.fullName ||
    (data.firstName || data.lastName ? `${data.firstName || ""} ${data.lastName || ""}`.trim() : null) ||
    null;
  // The specific job/pipeline title (e.g. "Aaron Rosen: PDT - SWE
  // Pipeline") — genuinely distinct from the client/company name
  // (lookupProjectName, e.g. "PDT Partners"), and confirmed sitting
  // right here in this SAME candidate-detail response already being
  // fetched (data.project.jobRole), so no separate lookup or extra
  // Atlas call is needed to get it.
  const jobRole = (data.project && data.project.jobRole) || null;
  return { email: owner ? owner.email : null, name, jobRole };
}

const CANDIDATE_OWNER_CACHE_KEY = "atlas-candidate-owner-cache"; // { [candidateId]: email | null }
// A cached wrapper around the lookup above — used by any live, on-the-fly
// computation (e.g. the KPI page's own live query) that may need to look
// the same candidate up repeatedly across page loads. A candidate's owner
// rarely changes, so caching trades a small amount of staleness risk for
// a large reduction in repeated API calls. NOT used by the webhook, which
// deliberately looks up fresh every time — a webhook event is rare enough
// (one per stage move) that a stale cached owner would be a worse trade
// there than it is here, where the same candidate can appear many times
// across a single computation.
async function lookupCandidateOwnerEmailCached(kv, projectId, candidateId) {
  const cache = (await kv.get(CANDIDATE_OWNER_CACHE_KEY)) || {};
  if (candidateId in cache) return cache[candidateId];
  let email = null;
  try {
    email = await lookupCandidateOwnerEmail(projectId, candidateId);
  } catch (e) {
    console.error("[atlas-shared] cached candidate owner lookup failed:", e.message);
    return null; // deliberately NOT cached — a transient failure shouldn't poison the cache
  }
  cache[candidateId] = email;
  await kv.set(CANDIDATE_OWNER_CACHE_KEY, cache);
  return email;
}

const CANDIDATE_DETAILS_CACHE_KEY = "atlas-candidate-details-cache-v3"; // { [candidateId]: { email, name, jobRole } | null }
// Same caching principle as lookupCandidateOwnerEmailCached above, its
// own separate cache key and shape ({email, name} objects, not bare
// email strings) so it can't collide with or be corrupted by the
// existing owner-only cache, or vice versa.
//
// The "-v2" suffix is deliberate, not decorative: the first version of
// this lookup guessed the wrong field for a candidate's name (tried a
// flat "name" field; Atlas actually nests it under person.firstName /
// person.lastName), and every candidate looked up under that first,
// wrong version got PERMANENTLY cached with name: null — this cache has
// no expiry at all, so once poisoned, a candidate would show "Unknown
// candidate" forever, even after the underlying lookup logic was fixed,
// since the cache check short-circuits before the corrected logic ever
// runs again for that same candidate. Renaming the key means every
// candidate gets looked up fresh, under the corrected logic, exactly
// once, rather than needing every poisoned entry found and cleared by
// hand. A null name is also deliberately NOT cached below, for the same
// reason: a transient miss shouldn't calcify into a permanent one.
//
// "-v3" now, for the exact same reason: jobRole was added to this same
// lookup afterward, and every candidate already cached under "-v2" (a
// plain {email, name} object, no jobRole key at all) would keep
// returning without it forever otherwise — bumping the composite
// week/month cache alone wasn't enough, since that recompute still
// calls straight back into this same, still-poisoned cache underneath.
async function lookupCandidateDetailsCached(kv, projectId, candidateId) {
  const cache = (await kv.get(CANDIDATE_DETAILS_CACHE_KEY)) || {};
  if (candidateId in cache) return cache[candidateId];
  let details = null;
  try {
    details = await lookupCandidateDetails(projectId, candidateId);
  } catch (e) {
    console.error("[atlas-shared] cached candidate details lookup failed:", e.message);
    return null; // deliberately NOT cached — a transient failure shouldn't poison the cache
  }
  // A genuine failure to find a name at all is also deliberately NOT
  // cached — see the comment above the cache key: caching a null name
  // forever is exactly the bug this fix is undoing, so this must not
  // reintroduce the same failure mode for any future edge case.
  if (details && details.name) {
    cache[candidateId] = details;
    await kv.set(CANDIDATE_DETAILS_CACHE_KEY, cache);
  }
  return details;
}

// The exact same tally-writing logic the webhook uses — writes both the
// weekly tally (needed for the Weekly Incentive competition itself) and
// the per-event monthly tally (needed for exact month-level KPI
// reporting, avoiding the week-straddles-two-months bucketing bug).
// The proven, tested computation from the KPI page's live query — this
// is the genuinely generic core: given any date range, query Atlas's own
// candidate-stage-events directly, dedupe each candidate+project pair
// once (regardless of how many different metrics it needed), resolve
// owners LOOKUP_CONCURRENCY at a time rather than one after another, and
// respect a time budget so a genuinely oversized range fails with a
// clear, specific reason well before Vercel's own platform-level kill at
// 60s. Both a calendar month (computeMonthlyKpiLive, just below) and an
// ISO week (computeWeeklyKpiLive, for the Weekly Incentive) delegate to
// this SAME function — a week is a smaller date range, not a different
// computation, so it gets the identical, already-proven logic rather
// than a second implementation with its own new bugs to find. Does NOT
// touch caching itself, deliberately: caching is the caller's decision.
async function computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs = 45000) {
  const people = {}; // { [consultantId]: { cvsOut, interviews, onsite, offers } }
  // Same counts as `people` above, but broken down to the actual
  // candidates behind each number — added so a mismatched week/month
  // can be reconciled against Atlas by name, not just a bare count.
  // { [consultantId]: { cvsOut: [{candidateName, projectName}], interviews: [...], ... } }
  const peopleDetails = {};
  const seenDedupeKeys = new Set(); // `${candidateId}:${projectId}:${metric}`
  const pairsToResolve = new Map(); // `${candidateId}:${projectId}` -> { projectId, candidateId, metrics: Set<string> }
  let eventsSeen = 0, eventsCounted = 0;
  let cursorDate = null, cursorId = null;
  let pagesFetched = 0;
  const MAX_PAGES = 20; // 20 * 100 = 2000 events, comfortably beyond one month's realistic volume
  const LOOKUP_CONCURRENCY = 15; // stays well inside Atlas's own 1200 requests/60s limit
  const startTime = Date.now();

  while (pagesFetched < MAX_PAGES) {
    if (Date.now() - startTime > timeBudgetMs) {
      throw new Error(`Timed out after ${Math.round((Date.now() - startTime) / 1000)}s fetching pages — likely a sustained Atlas rate limit rather than a one-off blip (${eventsSeen} events seen so far). Try again in a minute.`);
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
      eventsSeen++;
      if (event.isReverted) continue;

      const metric = metricForStageName(event.stageTo && event.stageTo.name);
      if (!metric) continue;

      const projectId = event.project && event.project.id;
      const candidateId = event.candidate && event.candidate.id;
      if (!projectId || !candidateId) continue;

      const dedupeKey = `${candidateId}:${projectId}:${metric}`;
      if (seenDedupeKeys.has(dedupeKey)) continue;
      seenDedupeKeys.add(dedupeKey);

      const pairKey = `${candidateId}:${projectId}`;
      if (!pairsToResolve.has(pairKey)) {
        pairsToResolve.set(pairKey, { projectId, candidateId, metrics: new Set() });
      }
      pairsToResolve.get(pairKey).metrics.add(metric);
    }

    const pagination = json.pagination || {};
    if (!pagination.hasMore) break;
    cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
    cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
    if (!cursorDate || !cursorId) break;
  }

  const pairs = Array.from(pairsToResolve.values());
  for (let i = 0; i < pairs.length; i += LOOKUP_CONCURRENCY) {
    if (Date.now() - startTime > timeBudgetMs) {
      throw new Error(`Timed out after ${Math.round((Date.now() - startTime) / 1000)}s resolving owners — likely a sustained Atlas rate limit rather than a one-off blip (${eventsSeen} events seen, ${eventsCounted} counted so far). Try again in a minute.`);
    }
    const batch = pairs.slice(i, i + LOOKUP_CONCURRENCY);
    const resolved = await Promise.all(batch.map(async ({ projectId, candidateId, metrics }) => {
      const projectName = await lookupProjectName(kv, projectId);
      if (projectName && projectName.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) return null;
      const details = await lookupCandidateDetailsCached(kv, projectId, candidateId);
      const email = details ? details.email : null;
      const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
      if (!consultantId) return null;
      return { consultantId, metrics, candidateName: (details && details.name) || null, projectName: projectName || null, jobRole: (details && details.jobRole) || null };
    }));

    for (const r of resolved) {
      if (!r) continue;
      if (!people[r.consultantId]) people[r.consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      if (!peopleDetails[r.consultantId]) peopleDetails[r.consultantId] = { cvsOut: [], interviews: [], onsite: [], offers: [] };
      for (const metric of r.metrics) {
        people[r.consultantId][metric] += 1;
        peopleDetails[r.consultantId][metric].push({ candidateName: r.candidateName, projectName: r.projectName, jobRole: r.jobRole });
        eventsCounted++;
      }
    }
  }

  return { people, peopleDetails, eventsSeen, eventsCounted, pairsResolved: pairsToResolve.size, pagesFetched };
}

// Byte-identical copy of league.js's own isoWeekToDates — same principle
// already established for isoWeekKey just above: a week's Monday and
// Sunday must resolve identically everywhere this project computes them,
// never two subtly different implementations drifting apart over time.
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

// Thin wrapper over the generic range computation, for a calendar month —
// used by the KPI page (?action=kpi-live-monthly) and the background job
// that keeps its cache warm.
async function computeMonthlyKpiLive(kv, year, month, timeBudgetMs = 45000) {
  const monthStr = String(month).padStart(2, "0");
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const createdAfter = `${year}-${monthStr}-01T00:00:00.000Z`;
  const createdBefore = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}T23:59:59.999Z`;
  return computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs);
}

// Thin wrapper over the generic range computation, for a single ISO week
// (Monday through Sunday) — used by the Weekly Incentive's own live
// numbers and the background job that keeps the current week's cache
// warm. A week is roughly a quarter of a month's volume, so this is
// expected to comfortably finish well within the time budget even for a
// genuinely busy week.
async function computeWeeklyKpiLive(kv, weekKey, timeBudgetMs = 45000) {
  const { monday, sunday } = isoWeekToDates(weekKey);
  const createdAfter = `${monday}T00:00:00.000Z`;
  const createdBefore = `${sunday}T23:59:59.999Z`;
  return computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs);
}

async function writeTally(kv, consultantId, metric, movedAt) {
  const weekKey = `atlas-tally:${isoWeekKey(movedAt)}`;
  const current = (await kv.get(weekKey)) || {};
  if (!current[consultantId]) {
    current[consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
  } else {
    if (current[consultantId].onsite === undefined) current[consultantId].onsite = 0;
    if (current[consultantId].offers === undefined) current[consultantId].offers = 0;
  }
  current[consultantId][metric] += 1;
  await kv.set(weekKey, current);

  const monthKey = new Date(movedAt).toISOString().slice(0, 7);
  const monthTallyKey = `atlas-monthly-tally:${monthKey}`;
  const currentMonth = (await kv.get(monthTallyKey)) || {};
  if (!currentMonth[consultantId]) {
    currentMonth[consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
  } else {
    if (currentMonth[consultantId].onsite === undefined) currentMonth[consultantId].onsite = 0;
    if (currentMonth[consultantId].offers === undefined) currentMonth[consultantId].offers = 0;
  }
  currentMonth[consultantId][metric] += 1;
  await kv.set(monthTallyKey, currentMonth);

  return { weekKey, monthKey };
}

module.exports = {
  CVS_OUT_STAGE,
  INTERVIEW_STAGES,
  ONSITE_STAGES,
  OFFER_STAGES,
  CVS_OUT_COUNTED_KEY,
  INTERVIEW_COUNTED_KEY,
  ONSITE_COUNTED_KEY,
  OFFER_COUNTED_KEY,
  PROJECT_NAMES_CACHE_KEY,
  EXCLUDED_PROJECT_NAME,
  EMAIL_TO_CONSULTANT,
  DEDUPE_KEY_BY_METRIC,
  isoWeekKey,
  metricForStageName,
  fetchAtlasWithRetry,
  lookupProjectName,
  lookupCandidateOwnerEmail,
  lookupCandidateOwnerEmailCached,
  lookupCandidateDetails,
  lookupCandidateDetailsCached,
  isoWeekToDates,
  computeKpiLiveForRange,
  computeMonthlyKpiLive,
  computeWeeklyKpiLive,
  writeTally,
};
