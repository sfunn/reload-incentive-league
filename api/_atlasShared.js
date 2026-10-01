// Shared between api/atlas-webhook.js and api/atlas-reconcile-cron.js.
// Underscore-prefixed so Vercel excludes it from routing — it's a plain
// module, not an API endpoint, and doesn't count against the 12-function
// Hobby-plan cap. The whole point of this file existing is that these
// mappings must be byte-identical in both places: if a stage name or a
// consultant's email were ever updated in one file and not the other, the
// webhook and the reconciliation job would silently disagree about what
// counts as what, which defeats the reconciliation job's entire purpose
// (catching what the webhook missed, not re-litigating what counts).

// "CV Sent" is not the only name Reload's pipelines use for this same
// step — confirmed directly: at least one live pipeline (Citadel US
// Java Pipeline) labels its equivalent presentation stage "CV Submitted"
// instead, and any candidate moved through THAT stage name was silently
// invisible to this whole metric, in every pipeline using it, for as
// long as this only matched one exact string. Kept as an array, same
// shape as the other three metrics below, specifically so a newly
// discovered variant name is a one-line addition here rather than a
// structural change. "Presented" confirmed the same way — genuinely the
// same underlying step under a third name, seen across several DRW,
// Optiver and Citadel Securities pipelines specifically. This is a
// standing rule, not a one-off fix for those particular pipelines: any
// future pipeline that also happens to use "Presented" for this same
// step is covered automatically, without needing to be spotted and
// reported individually each time.
const CVS_OUT_STAGES = ["CV Sent", "CV Submitted", "Presented"];
// "Screen 1" and "Screen 2" both confirmed by Scott as genuine
// interview-equivalent stages — matching the same "only first-round
// interviews count" policy already applied to "1st Stage Interview".
// "1st Round Face to Face (3 hour over Zoomm)" confirmed the same way —
// a genuine first-round interview under a third, pipeline-specific name
// (seen on Aaron Rosen: PDT - SWE Pipeline). "Screen 2"'s own exact
// string includes a specific interviewer's name ("Screen 2 - System
// Design w/Cian Lane") — matched here exactly as it actually appears,
// same as every other entry in this list, rather than guessing at a
// broader prefix rule for it; a different pipeline using "Screen 2"
// under a different exact suffix would need its own confirmed entry
// added the same way, the way "Presented" needed calling out explicitly
// as a standing rule before it was treated as one.
//
// The various "2nd Stage" spellings (2nd Stage Interview, 2nd stage,
// Second Stage, 2nd Stage) were first confirmed as NOT counting — only
// first-round interviews were meant to count at all. That was reversed
// on review of the real, live data: 2nd Stage Interview should count
// toward the same Interviews KPI as a first interview after all. Every
// spelling variant of the same underlying second-round stage is
// included here together, for the same reason "CV Sent"/"CV
// Submitted"/"Presented" are grouped above — these are one concept
// spelled inconsistently across different, independently-set-up
// pipelines, not several different concepts.
// three confirmed August variants: "1st Stage" (a shorter label for the
// same "1st Stage Interview"), "1st Stage Interview (2xTechnicals)" (a
// pipeline running two technical rounds back to back, still a genuine
// first-round interview), and "HR Call" (capital C — the identical
// stage as the already-mapped "HR call", just typed differently in one
// specific pipeline; matching this exact case is deliberate rather than
// making the whole check case-insensitive, same reasoning as "Screen 2"
// above — a different capitalisation elsewhere would need its own
// confirmed entry, not a blanket rule that could silently absorb
// something genuinely different).
const INTERVIEW_STAGES = ["1st Stage Interview", "HRX", "HR call", "HR Call", "Screen 1", "Screen 2 - System Design w/Cian Lane", "1st Round Face to Face (3 hour over Zoomm)", "2nd Stage Interview", "2nd stage", "Second Stage", "2nd Stage", "1st Stage", "1st Stage Interview (2xTechnicals)"];
// Two entries for what's genuinely the one same stage, differing only by
// a missing space after a "+" — confirmed as a real onsite-equivalent
// stage by its own name ("Onsite (Design+Implementation+ Behavioural)"
// vs "...+Behavioural)" with no space). Kept as two separate array
// entries rather than trying to normalise the typo away, since a safe,
// general "fuzzy" stage-name match risks silently absorbing some
// genuinely different stage down the line — an explicit list stays
// exact and auditable, at the small cost of needing a new entry
// whenever a new typo variant of an existing name turns up.
const ONSITE_STAGES = ["Onsite", "Onsite (Design+Implementation+ Behavioural)", "Onsite (Design+Implementation+Behavioural)"];
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

const PROJECT_NAME_CACHE_PREFIX = "atlas-project-details:";
// One key per project (a shared object under one KV key was the old
// design — every touch read and rewrote the WHOLE thing, and concurrent
// lookups, which this runs up to 15 at a time, could silently overwrite
// each other's additions, losing entries that then had to be re-fetched
// from Atlas and re-cached again later, repeatedly — a real, ongoing
// driver of wasted KV commands). Renamed from "atlas-project-name:" to
// "atlas-project-details:" because the cached SHAPE changed too, not
// just its correctness: this used to cache a single string (jobRole),
// and now caches {jobRole, companyName} as an object — an old,
// string-shaped entry under the previous key would silently break both
// consumers of this cache, since neither `.jobRole` nor `.companyName`
// exist on a plain string. SHARED with atlas-fee-webhook.js's own copy
// of this same lookup, which must use the identical prefix.
const EXCLUDED_PROJECT_NAME = "citsec options";
// The funnel order the four metrics sit in, used to decide what a
// candidate's LATEST recorded stage actually confirms. A candidate
// moved to Onsite and then moved straight back to 1st Stage Interview
// (a real, confirmed scenario — a wrong click, corrected immediately)
// should not still show as having reached Onsite just because that
// stage was touched at some point; what should count is determined by
// where they genuinely, currently stand, not by the highest point ever
// briefly touched along the way.
const METRIC_RANK = { cvsOut: 1, interviews: 2, onsite: 3, offers: 4 };
// Confirmed by Scott directly: each candidate/project pair should only
// ever count toward a given metric ONCE across its whole history — not
// once per month. Without this, a candidate whose first interview
// happened in August, then genuinely moved to a later-round interview
// stage in September, would count as a fresh September interview too,
// since each month's own computation only ever looks at events within
// its own window and has no memory of what any other month already
// counted. This is the permanent, cross-period record that fixes that:
// one key per (granularity, candidate, project) — month and week
// tracked entirely separately, since they're different views a person
// might reasonably want counted on their own terms — holding, per
// metric, the period it was FIRST ever counted in. A later period sees
// that record and skips re-counting anything already claimed by an
// earlier one.
const FIRST_REACHED_CACHE_PREFIX = "atlas-first-reached:";

// A genuinely different dedup from the one above, for the Offers metric
// specifically: keyed by the candidate's PERSON id (never +projectId,
// unlike every other dedup in this file — and deliberately NOT Atlas's
// own per-pipeline candidate.id either, see personId's own comment at
// its extraction above for why), storing the date of the last offer
// COUNTED for that real person, anywhere, any project. Confirmed
// directly by Scott: several separate offers to the same candidate
// across different projects (a strong candidate drawing interest from
// Citadel, Point72 and Jump Trading all at once, say) were inflating
// Offers and distorting the Offer:Agreed rate, when in Reload's own
// terms that's one real outcome worth counting once, not several. A
// 3-MONTH ROLLING window, not "same calendar month" and not a permanent
// one-ever claim: an offer genuinely more than 3 months after the last
// counted one is a fresh, separate result. The breakdown list a person
// actually opens always shows every individual offer event regardless —
// only the headline COUNT folds nearby repeats together.
const OFFER_DEDUP_PREFIX = "atlas-offer-dedup:";
const OFFER_DEDUP_WINDOW_MONTHS = 3;

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
  if (CVS_OUT_STAGES.includes(stageName)) return "cvsOut";
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
// A 500 from Atlas's own side is a different failure than a 429 — there's
// no retryAfterSec to honor, since it's not telling us to back off a
// budget, just that something briefly went wrong on its end. A single
// short, fixed retry is enough to smooth over the transient blips this
// kind of error usually is, without masking a genuinely broken request
// by retrying it forever — a request that's actually malformed will
// just fail the same way twice and correctly surface as an error either
// way.
const MAX_SERVER_ERROR_RETRIES = 1;
const SERVER_ERROR_RETRY_WAIT_MS = 1000;
// A genuine network-level failure (the connection itself never
// completing — a DNS/routing/connectivity blip between here and Atlas,
// tried across several IP addresses and still timing out) is a
// different failure again from either of the two above: fetch() throws
// outright here, rather than resolving with a response object at all,
// so this needs its own try/catch around the call itself, which
// neither of the two checks above provide. Same reasoning on the retry
// budget as the 500 case — a single short retry smooths over a
// genuinely transient blip without masking a sustained, real outage,
// which will just fail the same way again and correctly surface as an
// error.
const MAX_NETWORK_ERROR_RETRIES = 1;
const NETWORK_ERROR_RETRY_WAIT_MS = 1000;
async function fetchAtlasWithRetry(url, options) {
  // Three independent counters rather than one shared loop index — a
  // 429, a 500, and a network-level failure are three different failure
  // modes with different retry budgets, and folding them into a single
  // shared attempt counter would mean a retry of one kind could
  // silently eat into another's own budget.
  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;
  let networkErrorAttempts = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (networkErrorAttempts >= MAX_NETWORK_ERROR_RETRIES) throw e; // out of retries — let the caller see the real, final failure
      networkErrorAttempts++;
      console.warn(`[atlas-shared] network-level failure reaching Atlas (${e.message}), waiting ${NETWORK_ERROR_RETRY_WAIT_MS}ms before retry ${networkErrorAttempts}/${MAX_NETWORK_ERROR_RETRIES}`);
      await new Promise((resolve) => setTimeout(resolve, NETWORK_ERROR_RETRY_WAIT_MS));
      continue;
    }
    if (res.status >= 500 && res.status < 600) {
      if (serverErrorAttempts >= MAX_SERVER_ERROR_RETRIES) return res; // out of retries — let the caller see the final error
      serverErrorAttempts++;
      console.warn(`[atlas-shared] ${res.status} from Atlas, waiting ${SERVER_ERROR_RETRY_WAIT_MS}ms before retry ${serverErrorAttempts}/${MAX_SERVER_ERROR_RETRIES}`);
      await new Promise((resolve) => setTimeout(resolve, SERVER_ERROR_RETRY_WAIT_MS));
      continue;
    }
    if (res.status !== 429) return res;
    if (rateLimitAttempts >= MAX_RATE_LIMIT_RETRIES) return res; // out of retries — let the caller see the final 429
    rateLimitAttempts++;
    let retryAfterSec = 2;
    try {
      const body = await res.clone().json();
      if (typeof body.retryAfterSec === "number") retryAfterSec = body.retryAfterSec;
    } catch (e) { /* fall back to the default above */ }
    const waitMs = Math.min(retryAfterSec * 1000, MAX_RETRY_WAIT_MS);
    console.warn(`[atlas-shared] 429 rate limited, waiting ${waitMs}ms before retry ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function lookupProjectDetails(kv, projectId) {
  if (!projectId) return null;
  const cacheKey = `${PROJECT_NAME_CACHE_PREFIX}${projectId}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  let jobRole = null, companyName = null;
  try {
    const res = await fetchAtlasWithRetry(
      `https://api.recruitwithatlas.com/api/v1/projects/${projectId}`,
      { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
    );
    if (res.ok) {
      const json = await res.json();
      // Two genuinely different fields, both on this same response, and
      // both needed for two genuinely different purposes — conflating
      // them into one was a real bug this session: "CitSec Options" (the
      // value EXCLUDED_PROJECT_NAME checks against) is the PROJECT's own
      // title (jobRole, e.g. "Aaron Rosen: PDT - SWE Pipeline"), while
      // the candidate breakdown shown to users needs the actual client
      // company (company.name, e.g. "PDT Partners") — a genuinely
      // different value. Fixing the exclusion check to use jobRole
      // (confirmed correct) then had this same function ALSO feed the
      // breakdown's displayed "project" field, which duplicated the job
      // role text instead of showing the company — visible directly in
      // a real breakdown, where every entry showed the same text twice.
      const data = json.data || {};
      jobRole = data.jobRole || null;
      companyName = (data.company && data.company.name) || null;
    }
  } catch (e) {
    console.error("[atlas-shared] project details lookup failed:", e.message);
  }
  const result = { jobRole, companyName };
  // A genuinely missing name is deliberately NOT cached — a transient
  // miss shouldn't calcify into a permanent one.
  if (jobRole !== null || companyName !== null) await kv.set(cacheKey, result);
  return result;
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
  // (lookupProjectDetails().companyName, e.g. "PDT Partners"), and
  // confirmed sitting right here in this SAME candidate-detail response
  // already being fetched (data.project.jobRole), so no separate lookup
  // or extra Atlas call is needed to get it.
  const jobRole = (data.project && data.project.jobRole) || null;
  return { email: owner ? owner.email : null, name, jobRole };
}

const CANDIDATE_OWNER_CACHE_PREFIX = "atlas-candidate-owner:"; // one key per candidate — email | null
// A cached wrapper around the lookup above — used by any live, on-the-fly
// computation (e.g. the KPI page's own live query) that may need to look
// the same candidate up repeatedly across page loads. A candidate's owner
// rarely changes, so caching trades a small amount of staleness risk for
// a large reduction in repeated API calls. NOT used by the webhook, which
// deliberately looks up fresh every time — a webhook event is rare enough
// (one per stage move) that a stale cached owner would be a worse trade
// there than it is here, where the same candidate can appear many times
// across a single computation. One key per candidate, not one shared
// object holding every candidate ever seen — a shared object means every
// touch reads and rewrites the whole thing, and concurrent lookups (this
// runs many at once) writing back to that same key can silently
// overwrite each other's additions, losing entries that then have to be
// re-fetched and re-cached again later.
async function lookupCandidateOwnerEmailCached(kv, projectId, candidateId) {
  const cacheKey = `${CANDIDATE_OWNER_CACHE_PREFIX}${candidateId}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  let email = null;
  try {
    email = await lookupCandidateOwnerEmail(projectId, candidateId);
  } catch (e) {
    console.error("[atlas-shared] cached candidate owner lookup failed:", e.message);
    return null; // deliberately NOT cached — a transient failure shouldn't poison the cache
  }
  if (email !== null) await kv.set(cacheKey, email);
  return email;
}

const CANDIDATE_DETAILS_CACHE_PREFIX = "atlas-candidate-detail:"; // one key per candidate — { email, name, jobRole } | null
// Same caching principle as lookupCandidateOwnerEmailCached above, its
// own separate cache key prefix and shape ({email, name, jobRole}
// objects, not bare email strings) so it can't collide with or be
// corrupted by the existing owner-only cache, or vice versa. One key per
// candidate rather than one shared object — same reasoning as above:
// every touch on a shared object means reading and rewriting the whole,
// ever-growing thing, and concurrent lookups (up to 15 at once) writing
// back to that one key can silently overwrite each other's additions.
async function lookupCandidateDetailsCached(kv, projectId, candidateId) {
  const cacheKey = `${CANDIDATE_DETAILS_CACHE_PREFIX}${candidateId}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  let details = null;
  try {
    details = await lookupCandidateDetails(projectId, candidateId);
  } catch (e) {
    console.error("[atlas-shared] cached candidate details lookup failed:", e.message);
    return null; // deliberately NOT cached — a transient failure shouldn't poison the cache
  }
  // A genuine failure to find a name at all is also deliberately NOT
  // cached — caching a null name forever was exactly the bug this
  // lookup already had to be fixed for once, so this must not
  // reintroduce the same failure mode for any future edge case.
  if (details && details.name) {
    await kv.set(cacheKey, details);
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
//
// progressKey (optional) is the piece that makes running this multiple
// times in a row actually advance through a busy month, rather than
// each run independently re-fetching from page 1 and getting a
// different, disconnected slice depending on how far it got before
// time ran out — which is exactly what two real runs showed happening
// (1200 events seen, then 1400 on the next, neither building on the
// other, since nothing about where the first run stopped was ever
// remembered). When provided, this function loads whatever an earlier,
// incomplete run left off at (the fetch cursor, everything counted so
// far, and any pairs found but not yet resolved), continues from
// exactly there, and saves the updated state back if it's still not
// finished — genuine forward progress across runs, not several
// independent, overlapping attempts at the same early slice.
async function computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs = 45000, progressKey = null) {
  const PROGRESS_CACHE_PREFIX = "atlas-kpi-progress-v2:";
  // "-v2" because this cache's own stored SHAPE changed mid-session —
  // {metrics: Set} became {projectId, candidateId, events: [{metric,
  // movedAt}]} once the counting logic needed each pair's actual
  // chronological history, not just which metrics it had ever touched.
  // Missing this exact lesson (already learned once earlier this same
  // session for the candidate-details and project-name caches) is
  // precisely what took the whole site down: a progress entry saved
  // under the OLD shape has no `.events` array at all, so the newest
  // code's `events.map(...)` throws outright the moment it tries to
  // resume from it — not a graceful error, a genuine crash, surfacing to
  // every page as a 502 since week-live and kpi-live-monthly both run
  // through this same function on every load. Renaming the key clears
  // every stale entry out in one move, the same fix already proven for
  // this exact failure mode elsewhere in this file.
  const progressCacheKey = progressKey ? `${PROGRESS_CACHE_PREFIX}${progressKey}` : null;
  let saved = progressCacheKey ? await kv.get(progressCacheKey) : null;
  // Defends against exactly the failure that took the whole site down
  // once already: a saved entry in a shape this version of the code
  // doesn't recognise (an old deployment's leftover state, or any other
  // future shape change someone forgets to version the key for) must
  // never crash the request outright — it should just be treated as "no
  // usable progress", the same as if nothing had been saved at all, and
  // let the fetch start fresh. A bare "does it have unresolvedPairs" is
  // not enough on its own — it's specifically checking each entry has
  // the CURRENT shape (an events array, not the old metrics Set) that
  // matters, since a stale entry can have the right top-level keys and
  // still crash the moment something inside it is read.
  if (saved && Array.isArray(saved.unresolvedPairs) && !saved.unresolvedPairs.every(([, v]) => v && Array.isArray(v.events))) {
    console.error(`[atlas-shared] discarding incompatible saved progress for ${progressKey} — not the current shape`);
    saved = null;
  }
  // A persistent 500 from Atlas — surviving even the retry above, on a
  // request Atlas's own UI shows nothing wrong with — pointed at the one
  // other thing this specific request carries that a fresh one wouldn't:
  // a resumed cursor, saved from an earlier, separate run, potentially
  // hours old across a session with many "Warm" attempts. If Atlas's own
  // cursor tokens have some validity window, an old one going stale
  // would plausibly surface exactly this way — a genuine request Atlas
  // simply can't make sense of, errored out as a 500 rather than a
  // clean "expired" response. A saved entry with no timestamp at all
  // (from before this safeguard existed) is treated the same as an
  // expired one — there's no way to know its real age, so the safe
  // assumption is that it's too old to trust.
  const PROGRESS_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
  if (saved && (!saved.savedAt || Date.now() - saved.savedAt > PROGRESS_MAX_AGE_MS)) {
    console.warn(`[atlas-shared] discarding saved progress for ${progressKey} — too old to trust its cursor (age: ${saved.savedAt ? Math.round((Date.now() - saved.savedAt) / 60000) + "min" : "unknown"})`);
    saved = null;
  }

  const people = saved ? saved.people : {}; // { [consultantId]: { cvsOut, interviews, onsite, offers } }
  // Same counts as `people` above, but broken down to the actual
  // candidates behind each number — added so a mismatched week/month
  // can be reconciled against Atlas by name, not just a bare count.
  // { [consultantId]: { cvsOut: [{candidateName, projectName}], interviews: [...], ... } }
  const peopleDetails = saved ? saved.peopleDetails : {};
  const seenDedupeKeys = new Set(saved ? saved.seenDedupeKeys : []); // Atlas's own event id, or a synthetic fallback when missing
  // `${candidateId}:${projectId}` -> { projectId, candidateId, events: [{metric, movedAt}] }
  // — every genuinely distinct mapped stage-move event seen for this
  // pair, kept in full (not deduped down to a Set of which metrics were
  // EVER touched) so the resolve step below can look at the pair's
  // actual chronological order and decide what their current, final
  // state really is — pairs found but not yet resolved, whether from
  // earlier runs (resumed below) or this one's own fetching.
  const pairsToResolve = new Map(saved ? saved.unresolvedPairs : []);
  let eventsSeen = saved ? saved.eventsSeen : 0;
  let eventsCounted = saved ? saved.eventsCounted : 0;
  let cursorDate = saved ? saved.cursorDate : null;
  let cursorId = saved ? saved.cursorId : null;
  let pagesFetched = 0;
  // A busy month (several consultants with 100+ CVs each) genuinely
  // exceeds the old cap of 20 pages / 2000 events, and that cap was
  // being hit SILENTLY — no error, no warning, just an undercount, which
  // is exactly what was throwing the comparison against Atlas's own
  // numbers off. Raised generously; still bounded so a genuinely
  // pathological range can't run away entirely.
  const MAX_PAGES = 100; // 100 * 100 = 10,000 events
  const LOOKUP_CONCURRENCY = 15; // stays well inside Atlas's own 1200 requests/60s limit
  const startTime = Date.now();
  let hitPageCap = false;
  let fetchComplete = false;
  // Fetching pages and resolving owners were sharing ONE clock — on a
  // genuinely busy month, fetching more pages (needed to avoid the
  // silent-truncation bug above) simply left less of that shared budget
  // for resolving, which is the slower, rate-limited half. A real run
  // showed this directly: raising the page cap fetched MORE events
  // (2221 vs 2000) but resolved FEWER pairs (328 vs 441) in the same
  // 45s, because more of it was spent just fetching. Giving fetching
  // its own, smaller ceiling means resolving is always guaranteed a
  // real, substantial share of the total budget, regardless of how
  // busy the fetch phase turns out to be. Running out of fetch time
  // early is treated exactly like hitting the page cap (hitPageCap =
  // true) rather than a hard failure — a partial, honestly-labelled
  // result is far more useful than throwing away everything resolved
  // so far over a single slow phase.
  const FETCH_PHASE_TIME_BUDGET_MS = Math.min(20000, timeBudgetMs * 0.45);

  while (pagesFetched < MAX_PAGES) {
    if (Date.now() - startTime > FETCH_PHASE_TIME_BUDGET_MS) {
      hitPageCap = true;
      break;
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
      // Atlas gives each project pipeline its own, separate "candidate"
      // record — the SAME real person submitted to three different
      // roles gets three different candidate.id values, one per
      // pipeline. candidate.person.id is the one field that stays
      // constant across all of them, the actual human underneath.
      // candidateId above stays the key for per-pipeline tracking
      // (pairing, and the existing cross-period CVs/Interviews/etc
      // dedup, which is deliberately scoped per pipeline) — personId
      // exists specifically for the Offers dedup below, which needs the
      // real person, not any one of their per-pipeline records.
      // Confirmed directly against real production data: Ethan Stone's
      // three separate offers each had a different candidate.id, which
      // is exactly why keying the dedup on candidateId never once
      // caught them as the same person.
      const personId = event.candidate && event.candidate.person && event.candidate.person.id;
      if (!projectId || !candidateId) continue;

      // Deduped by the EVENT's own id now, not by candidate:project:metric
      // — a real scenario showed exactly why the old key was wrong: a
      // candidate moved to Onsite, then moved straight back to 1st Stage
      // Interview (a genuine correction of a wrong click, confirmed
      // directly), and the old dedup key would have permanently locked in
      // "reached onsite" the moment that first event was seen, with no
      // way for the later, corrective move to ever be considered at all,
      // since candidate:project:onsite was already marked seen. Deduping
      // by event id instead still protects against the same literal
      // event being processed twice (e.g. Atlas redelivering it, or
      // pagination overlap), while preserving every genuinely distinct
      // transition — including a backward one — for the ranking logic
      // below to actually use.
      const dedupeKey = event.id || `${candidateId}:${projectId}:${metric}:${event.movedAt}`;
      if (seenDedupeKeys.has(dedupeKey)) continue;
      seenDedupeKeys.add(dedupeKey);

      const pairKey = `${candidateId}:${projectId}`;
      if (!pairsToResolve.has(pairKey)) {
        pairsToResolve.set(pairKey, { projectId, candidateId, personId, events: [] });
      }
      pairsToResolve.get(pairKey).events.push({ metric, movedAt: event.movedAt || null });
    }

    const pagination = json.pagination || {};
    if (!pagination.hasMore) { fetchComplete = true; break; }
    cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
    cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
    if (!cursorDate || !cursorId) { fetchComplete = true; break; }
  }
  // The loop above can only exit three ways: genuinely ran out of data
  // (fetchComplete = true), or the page cap, or the fetch phase's own
  // time ceiling — the latter two both mean there's more left to fetch,
  // whether that shows up as the while condition itself going false or
  // the explicit time-based break above.
  if (pagesFetched >= MAX_PAGES) hitPageCap = true;
  if (hitPageCap) fetchComplete = false;

  const pairs = Array.from(pairsToResolve.values());
  // Snapshotted BEFORE the resolve loop below starts deleting entries
  // from pairsToResolve as it goes (needed so an incomplete run can
  // persist exactly which pairs are still pending) — pairsToResolve.size
  // now means something different by the time this function returns
  // (how many are STILL unresolved, ideally 0), not how many existed in
  // total. Reusing that same field for "how many were resolved" was a
  // real, contradictory-looking bug: a run that finished catching up
  // entirely reported "0 pairs resolved" alongside a genuinely nonzero
  // events-counted figure, since 0 remaining were left in the map, not
  // because nothing was actually processed.
  const totalPairsThisCall = pairs.length;
  // Resolving a pair's owner/project ALREADY caches it as it goes
  // (lookupCandidateDetailsCached / lookupProjectDetails each write their
  // own KV entry the moment they succeed) — so throwing away the whole
  // run on a timeout here was discarding a complete, aggregated result
  // for the sake of the pairs that DIDN'T finish in time, when most of
  // the ones that DID finish are already safely persisted regardless.
  // Returning a partial, honestly-flagged result (resolutionIncomplete)
  // instead means a busy month still produces something immediately
  // useful, and the pairs already resolved here won't need re-fetching
  // from Atlas on the next run either.
  let resolutionIncomplete = false;
  // Resolving is now gated entirely behind the fetch phase having
  // genuinely finished (fetchComplete) — this is the actual fix for a
  // real, confirmed bug: a pair resolved here with only a PARTIAL view
  // of its events (because the fetch phase ran out of its own budget
  // before reaching that pair's later activity) gets removed from
  // pairsToResolve and its result pushed to peopleDetails — so when a
  // LATER, resumed run's fetch phase reaches that pair's remaining,
  // genuinely new events, it finds no existing entry to append to
  // (since the earlier one was already resolved and removed), creates a
  // fresh one containing only the new events, and resolves THAT too —
  // producing a second, duplicate entry for a candidate who was already
  // correctly counted once. Confirmed directly against four real,
  // duplicated candidates in production (Conan Keaveney, Daria
  // Gavrilova, Weide Zhang, Omar Mejia) — every single one had a
  // genuinely new event land days after an earlier cluster that would
  // already have been resolved, and every clean, non-duplicated pair
  // for the same candidates had no such later activity. Deferring ALL
  // resolution until the ENTIRE month's fetch is done, every time,
  // means a pair is only ever resolved once it has EVERY event it's
  // ever going to have for this run — there is no earlier, partial
  // resolution left behind for a later event to duplicate against.
  // Costs some responsiveness on a busy month (several "Warm" clicks
  // may pass with pagesFetched increasing but pairsResolved staying at
  // 0, until fetch itself finally completes), but a correct number a
  // little later beats a wrong one immediately.
  if (fetchComplete) {
  // Accumulates every offers-eligible pair across EVERY batch in this
  // run (batches resolve sequentially, one after another, but pairs
  // WITHIN a batch resolve concurrently — see the comment at this
  // array's own synchronous processing pass, after this whole loop,
  // for why the actual dedup can only safely happen there).
  const pendingOfferCandidates = [];
  for (let i = 0; i < pairs.length; i += LOOKUP_CONCURRENCY) {
    if (Date.now() - startTime > timeBudgetMs) {
      resolutionIncomplete = true;
      break;
    }
    const batch = pairs.slice(i, i + LOOKUP_CONCURRENCY);
    const resolved = await Promise.all(batch.map(async ({ projectId, candidateId, personId, events }) => {
      const projectDetails = await lookupProjectDetails(kv, projectId);
      const projectJobRole = projectDetails ? projectDetails.jobRole : null;
      // The exclusion check compares against the PROJECT's own title
      // (jobRole, e.g. "CitSec Options") — confirmed directly, not the
      // client company name, which is a genuinely different field used
      // below for what's actually shown to a person reading the
      // breakdown.
      if (projectJobRole && projectJobRole.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) return null;
      const details = await lookupCandidateDetailsCached(kv, projectId, candidateId);
      const email = details ? details.email : null;
      const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
      if (!consultantId) return null;
      // The candidate's chronologically LAST recorded event decides what
      // genuinely counts — sorted here rather than trusted to already
      // arrive in order, since events for the same pair can land across
      // different pages, or even different resumed runs. Its metric's
      // rank sets the ceiling: everything at or below that rank counts
      // (a candidate currently at Onsite genuinely did pass through CV
      // Sent and Interview too), but nothing ABOVE it does, even if an
      // earlier event in their history briefly touched a higher stage —
      // that's precisely the "moved to Onsite, moved straight back"
      // scenario this whole restructure exists to handle correctly.
      const sorted = events.slice().sort((a, b) => new Date(a.movedAt || 0) - new Date(b.movedAt || 0));
      const finalMetric = sorted[sorted.length - 1].metric;
      const finalRank = METRIC_RANK[finalMetric];
      // Confirmed by Scott: reaching a stage implies every earlier one in
      // the funnel genuinely happened too, even without its own separate,
      // discrete event recorded — BUT that inference was tried
      // unconditionally at first, and it caused a real, visible
      // over-count: this function only ever sees events within ONE
      // month (or week) at a time, so a candidate whose CV was genuinely
      // sent back in August, who simply continues an ongoing pipeline
      // into a September interview, would have September's own fetch
      // see only the interview event — and inferring downward without
      // limit manufactured a SEPTEMBER cvsOut credit for them regardless,
      // duplicating a CV-sent count that August's own numbers had almost
      // certainly already counted correctly.
      //
      // The fix: only fill the gap BETWEEN whatever's genuinely evidenced
      // within THIS SAME window — never invent anything BELOW the lowest
      // rank actually seen here. A candidate whose only event in this
      // window is Onsite, with no CV Sent or Interview event of their own
      // in this same range, gets ONLY Onsite (their CV Sent almost
      // certainly happened in an earlier period, already counted there).
      // But a candidate with BOTH a CV Sent event AND an Onsite event in
      // this same window has their Interview correctly inferred in
      // between, even with no separate event of its own — that gap is
      // safely bounded by two real, same-window touchpoints, not reaching
      // outside this window to invent one. The final rank still lowers
      // the ceiling for a genuine backward move, same as before.
      const actualRanks = events.map((e) => METRIC_RANK[e.metric]);
      const minRankEvidenced = Math.min(...actualRanks);
      let metricsToCount = Object.entries(METRIC_RANK)
        .filter(([, rank]) => rank >= minRankEvidenced && rank <= finalRank)
        .map(([m]) => m);
      // Cross-period dedup — confirmed by Scott: a candidate should only
      // ever count toward a given metric once, ever, not once per period.
      // Only applied when there's an actual period identity to dedup
      // against (progressKey); every real caller (computeMonthlyKpiLive,
      // computeWeeklyKpiLive) always provides one, but this stays
      // optional so a caller with no well-defined "period" concept isn't
      // forced into it. Deliberately one combined key per pair, holding
      // all four metrics together, rather than one key per metric — a
      // pair with several metrics to check costs exactly one read and at
      // most one write here either way, not one of each per metric.
      if (progressKey && metricsToCount.length > 0) {
        const [granularity, periodKey] = [progressKey.slice(0, progressKey.indexOf(":")), progressKey.slice(progressKey.indexOf(":") + 1)];
        const firstReachedKey = `${FIRST_REACHED_CACHE_PREFIX}${granularity}:${candidateId}:${projectId}`;
        const firstReached = (await kv.get(firstReachedKey)) || {};
        // Restored, now that its actual precondition is met: a genuine,
        // ordered backfill (June through the current month, oldest
        // first — see the KPI page's own backfill tool) establishes a
        // complete, trustworthy "first reached" history before this
        // extension is relied on for anything. That backfill is what
        // makes "nothing has claimed this" a genuinely reliable signal
        // rather than "nobody's checked yet" — confirmed by Scott
        // directly: a candidate dropped straight into an interview
        // stage (HR call, HRX, etc.), with no separate CV Sent event
        // ever recorded for them, anywhere, should still count as a
        // genuine CV Sent, the same "implies every earlier stage
        // happened" rule already applied within one window, extended
        // across periods now that the backfill makes it safe. Checked
        // per rank, individually, not as an all-or-nothing block: a
        // candidate whose interview was genuinely claimed by an earlier
        // period, but whose CV Sent was never claimed by anyone,
        // correctly gets ONLY CV Sent inferred here, not a redundant
        // interview alongside it.
        // RESTORED (fourth attempt), now with the actual root cause
        // genuinely found and fixed — this specific logic was never the
        // real bug across any of the three prior attempts. The true
        // cause: a pair could be resolved before the fetch phase for
        // its whole period had genuinely finished, and if that same
        // pair later got a new event once fetch resumed, it had no way
        // of knowing it was already counted once, and got a second,
        // duplicate entry. Confirmed directly against five real
        // candidates (Conan Keaveney, Daria Gavrilova, Weide Zhang,
        // Omar Mejia, Tarun Yellu), all previously duplicated, all
        // clean once resolving was gated behind fetch genuinely
        // completing (see the fetchComplete gate around the resolve
        // loop above). With that root cause fixed, a pair is only ever
        // resolved once it has its full, true history — so this
        // extension's own "has any period already claimed this rank"
        // check now always sees a complete, trustworthy picture, not a
        // partial one from a still-in-progress fetch.
        for (let rank = 1; rank < minRankEvidenced; rank++) {
          const metric = Object.keys(METRIC_RANK).find((m) => METRIC_RANK[m] === rank);
          // Re-warming the SAME period must still re-include its own,
          // previously-inferred claim here too — checking only
          // "never claimed by anyone" would incorrectly exclude it on a
          // second run, since by then this exact period is the one that
          // claimed it the first time around.
          if (!firstReached[metric] || firstReached[metric] === periodKey) metricsToCount.push(metric);
        }
        // A metric stays countable in THIS period if: nothing's recorded
        // yet, this IS the period already recorded (so re-warming the
        // same period doesn't lose its own count), or this period is
        // chronologically EARLIER than whatever's recorded — periods
        // aren't always computed in order (an older month can genuinely
        // be re-warmed after a newer one already ran), and the true
        // first occurrence must always win, not whichever one happened
        // to be computed first. Both keys are zero-padded (2026-09,
        // 2026-W38), so plain string comparison sorts chronologically.
        const stillNew = metricsToCount.filter((m) => !firstReached[m] || firstReached[m] === periodKey || periodKey < firstReached[m]);
        const updated = { ...firstReached };
        let changed = false;
        for (const m of stillNew) {
          if (!updated[m] || periodKey < updated[m]) { updated[m] = periodKey; changed = true; }
        }
        if (changed) await kv.set(firstReachedKey, updated);
        metricsToCount = stillNew;
      }
      // The offer-specific candidate-level dedup itself (see
      // OFFER_DEDUP_PREFIX's own comment) happens later, as a single,
      // synchronous pass after every pair in this whole run has
      // resolved — deliberately NOT here. Pairs within one batch resolve
      // CONCURRENTLY (see the Promise.all this return sits inside), so a
      // read-then-write check placed here would race: the same
      // candidate's several offers, across different projects, could
      // all read "nothing counted yet" before any of them had written
      // back, and all count as new. Only this pair's own offer date is
      // computed here; candidateOfferDate is null when this pair didn't
      // reach the offers stage at all.
      const offerEvents = events.filter((e) => e.metric === "offers" && e.movedAt);
      const candidateOfferDate = offerEvents.length > 0
        ? new Date(Math.max(...offerEvents.map((e) => new Date(e.movedAt).getTime()))).toISOString()
        : null;
      // projectName here is deliberately the CLIENT COMPANY (e.g. "PDT
      // Partners"), not the project's own title — jobRole is already
      // shown as its own, separate field below, so showing it twice
      // under two different labels was a real, visible bug: every
      // candidate in a breakdown showed the identical text twice
      // instead of the job title alongside the actual client.
      return { consultantId, candidateId, personId, metrics: metricsToCount, candidateOfferDate, candidateName: (details && details.name) || null, projectName: (projectDetails && projectDetails.companyName) || null, jobRole: (details && details.jobRole) || null };
    }));

    for (let bi = 0; bi < batch.length; bi++) {
      pairsToResolve.delete(`${batch[bi].candidateId}:${batch[bi].projectId}`);
    }

    for (const r of resolved) {
      if (!r) continue;
      if (!people[r.consultantId]) people[r.consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
      if (!peopleDetails[r.consultantId]) peopleDetails[r.consultantId] = { cvsOut: [], interviews: [], onsite: [], offers: [] };
      for (const metric of r.metrics) {
        // The breakdown list always gets every real event, unconditionally
        // — opening "who?" must always show the true, complete history.
        peopleDetails[r.consultantId][metric].push({ candidateName: r.candidateName, projectName: r.projectName, jobRole: r.jobRole });
        eventsCounted++;
        if (metric === "offers") {
          // The headline COUNT for offers is deferred to a single,
          // synchronous pass after every batch in this whole run has
          // resolved (see pendingOfferCandidates below, and its own pass
          // further down) — never incremented here, and deliberately
          // not in the same concurrent resolution above, both for the
          // same reason: this same candidate's other offers, across
          // different projects, may still be resolving concurrently
          // elsewhere in this very batch.
          pendingOfferCandidates.push({ consultantId: r.consultantId, personId: r.personId || r.candidateId, offerDate: r.candidateOfferDate });
          continue;
        }
        people[r.consultantId][metric] += 1;
      }
    }
  }
  // The actual offers dedup, now that every pair in this whole run has
  // resolved and nothing is running concurrently anymore — safe to read
  // and write the persistent anchor per candidate exactly once each,
  // with no race against this same candidate's other, still-resolving
  // offers (see pendingOfferCandidates' own comment above for why this
  // couldn't safely happen any earlier). Two layers, in order:
  // 1) within THIS run's own pending offers, group by candidate and keep
  //    only the earliest in each 3-month cluster (several of this run's
  //    own offers for the same candidate, across different projects,
  //    must dedup against EACH OTHER first, in memory, not just against
  //    whatever's already stored from an earlier run);
  // 2) whichever ones survive that get checked against the persistent,
  //    cross-run anchor, exactly once per candidate.
  const offersByPersonId = {};
  for (const o of pendingOfferCandidates) {
    if (!offersByPersonId[o.personId]) offersByPersonId[o.personId] = [];
    offersByPersonId[o.personId].push(o);
  }
  for (const [personId, offersForCandidate] of Object.entries(offersByPersonId)) {
    // Sort earliest-first so an undated entry (offerDate somehow null --
    // not expected in practice, but failing open rather than silently
    // dropping a real offer) always counts, having nothing to compare
    // its date against.
    const sorted = offersForCandidate.slice().sort((a, b) => {
      if (!a.offerDate) return -1;
      if (!b.offerDate) return 1;
      return new Date(a.offerDate) - new Date(b.offerDate);
    });
    let inRunAnchor = null; // the most recent offerDate THIS run has already decided counts
    const offerDedupKey = `${OFFER_DEDUP_PREFIX}${personId}`;
    const persistedIso = await kv.get(offerDedupKey);
    let persistedAnchor = persistedIso ? new Date(persistedIso) : null;
    for (const o of sorted) {
      const thisDate = o.offerDate ? new Date(o.offerDate) : null;
      let countsTowardOffers = true;
      if (thisDate && inRunAnchor) {
        const windowEnd = new Date(inRunAnchor);
        windowEnd.setUTCMonth(windowEnd.getUTCMonth() + OFFER_DEDUP_WINDOW_MONTHS);
        if (thisDate < windowEnd) countsTowardOffers = false;
      }
      if (countsTowardOffers && thisDate && persistedAnchor) {
        const windowEnd = new Date(persistedAnchor);
        windowEnd.setUTCMonth(windowEnd.getUTCMonth() + OFFER_DEDUP_WINDOW_MONTHS);
        if (thisDate < windowEnd) countsTowardOffers = false;
      }
      if (countsTowardOffers) {
        people[o.consultantId].offers += 1;
        if (thisDate && (!inRunAnchor || thisDate > inRunAnchor)) inRunAnchor = thisDate;
        if (thisDate && (!persistedAnchor || thisDate > persistedAnchor)) {
          persistedAnchor = thisDate;
          await kv.set(offerDedupKey, thisDate.toISOString());
        }
      }
    }
  }
  } else {
    // Fetch itself didn't finish this run — resolving nothing at all
    // this time, on purpose (see the comment on the fetchComplete gate
    // above). Every pair collected so far, with its full event history
    // intact, stays in pairsToResolve to be saved below exactly as-is.
    resolutionIncomplete = true;
  }

  const isFullyComplete = fetchComplete && !resolutionIncomplete;
  if (progressCacheKey) {
    if (isFullyComplete) {
      // Genuinely done — nothing left to resume, so nothing left to remember.
      await kv.del(progressCacheKey).catch(() => {});
    } else {
      await kv.set(progressCacheKey, {
        cursorDate, cursorId, people, peopleDetails,
        seenDedupeKeys: Array.from(seenDedupeKeys),
        unresolvedPairs: Array.from(pairsToResolve.entries()),
        eventsSeen, eventsCounted,
        savedAt: Date.now(),
      });
    }
  }

  return { people, peopleDetails, eventsSeen, eventsCounted, pairsResolved: totalPairsThisCall - pairsToResolve.size, pairsPending: pairsToResolve.size, pagesFetched, hitPageCap, resolutionIncomplete, isFullyComplete };
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
  // Resumable progress restored — briefly disabled while a persistent
  // Atlas 500 was being investigated, on the theory that a cursor carried
  // over from an earlier, separate request might be the trigger. Ruled
  // out directly: even with this removed entirely (every call starting
  // completely fresh, no cursor at all), the identical failure persisted
  // — and Atlas's own side confirmed the real cause once their outage
  // resolved. This mechanism was never the problem, so there's no reason
  // to keep it off.
  return computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs, `month:${year}-${monthStr}`);
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
  // Resumable progress restored — same reasoning as
  // computeMonthlyKpiLive's own copy of this comment above.
  return computeKpiLiveForRange(kv, createdAfter, createdBefore, timeBudgetMs, `week:${weekKey}`);
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
  CVS_OUT_STAGES,
  INTERVIEW_STAGES,
  ONSITE_STAGES,
  OFFER_STAGES,
  CVS_OUT_COUNTED_KEY,
  INTERVIEW_COUNTED_KEY,
  ONSITE_COUNTED_KEY,
  OFFER_COUNTED_KEY,
  PROJECT_NAME_CACHE_PREFIX,
  EXCLUDED_PROJECT_NAME,
  EMAIL_TO_CONSULTANT,
  DEDUPE_KEY_BY_METRIC,
  isoWeekKey,
  metricForStageName,
  fetchAtlasWithRetry,
  lookupProjectDetails,
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
