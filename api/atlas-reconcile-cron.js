const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");
const {
  EXCLUDED_PROJECT_NAME,
  EMAIL_TO_CONSULTANT,
  DEDUPE_KEY_BY_METRIC,
  metricForStageName,
  lookupProjectName,
  lookupCandidateOwnerEmail,
  isoWeekKey,
  computeMonthlyKpiLive,
  computeWeeklyKpiLive,
  writeTally,
} = require("./_atlasShared.js");

// This exists because a webhook is a push notification, not a guarantee —
// if Atlas fails to deliver one (a timeout, a dropped retry, a bulk action
// that doesn't fire per-candidate), that event is simply gone from our
// side forever, with no way to know it ever happened. This job closes
// that gap by periodically asking Atlas directly, via
// GET /api/v1/candidate-stage-events, for everything that's happened
// since the last successful check — an authoritative source, not a
// hopeful one. It applies the EXACT SAME stage-name mapping, CitSec
// Options exclusion, owner-lookup, and per-candidate-per-project dedup
// logic the webhook itself uses (via _atlasShared.js), so an event this
// job counts is indistinguishable from one the webhook would have
// counted — the dedup keys are what make it safe to run this
// unconditionally, on a schedule, without ever double-counting something
// the webhook already got to first.

const CURSOR_KEY = "atlas-stage-events-cursor"; // { createdAfter: <ISO date> }
// How far back to look on the very first run ever, before any cursor
// exists. Deliberately NOT "the beginning of time" — this job exists for
// ongoing reconciliation of recent gaps, not as a full historical
// backfill (that's what the separate, manual backfill/reconcile actions
// in league.js are for). Seven days comfortably covers any realistic gap
// between scheduled runs without re-processing years of history.
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Atlas's own docs note this feed is "eventually consistent (populated
// asynchronously)" — an event might not be immediately queryable the
// instant it happens. Rather than advance the cursor all the way to "now"
// after a run (which risks permanently skipping an event still being
// written when we checked), the next cursor is set this far behind the
// latest event actually seen, giving Atlas time to catch up before we
// treat that window as fully checked.
const CONSISTENCY_BUFFER_MS = 15 * 60 * 1000;
// Safety cap on pages fetched per invocation, so a very large backlog
// (e.g. a much longer gap than expected) can't run this function past
// its execution time limit. Progress is saved incrementally per page, so
// an interrupted run simply continues from where it left off on the next
// scheduled invocation, rather than losing progress or needing to restart.
const MAX_PAGES_PER_RUN = 20;
const PAGE_SIZE = 100;

module.exports = async function handler(req, res) {
  // Two ways in: Vercel's own scheduled cron calls (signed with
  // CRON_SECRET, sent automatically, never known to any person), or a
  // Super Admin manually triggering a run from the Consultant KPIs page
  // to actually SEE what a run does right now, rather than waiting for
  // the schedule and having no way to tell whether "nothing changed"
  // meant "nothing was wrong" or "this silently isn't running at all".
  const expectedCronAuth = `Bearer ${process.env.CRON_SECRET}`;
  const isCron = !!process.env.CRON_SECRET && req.headers.authorization === expectedCronAuth;
  let triggeredBy = isCron ? "cron" : null;

  if (!isCron) {
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    triggeredBy = "manual";
  }

  // This one function now does two genuinely different jobs, split by a
  // query param rather than as two separate files — kept as one file
  // deliberately, since a new, separate function would push this project
  // over its 12-function Hobby-plan cap. Each invocation only ever does
  // ONE of the two, never both together, so neither job risks running
  // long enough to push into the other's own time budget.
  if (req.query && req.query.task === "warm-kpi-cache") {
    return warmKpiCache(req, res);
  }

  const cursorState = (await kv.get(CURSOR_KEY)) || null;
  const createdAfter = cursorState && cursorState.createdAfter
    ? cursorState.createdAfter
    : new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const resumeCursorDate = cursorState && cursorState.resumeCursorDate;
  const resumeCursorId = cursorState && cursorState.resumeCursorId;

  let eventsSeen = 0;
  let eventsCounted = 0;
  let eventsSkippedNotTracked = 0;
  let eventsSkippedExcludedProject = 0;
  let eventsSkippedUnmappedOwner = 0;
  let eventsSkippedAlreadyCounted = 0;
  let eventsSkippedReverted = 0;
  let eventsErrored = 0;
  let latestMovedAtSeen = null;
  let pagesFetched = 0;
  let cursorDate = resumeCursorDate || null;
  let cursorId = resumeCursorId || null;
  let hitPageLimit = false;

  try {
    while (pagesFetched < MAX_PAGES_PER_RUN) {
      const params = new URLSearchParams({ createdAfter, pageSize: String(PAGE_SIZE) });
      if (cursorDate && cursorId) {
        params.set("cursorDate", cursorDate);
        params.set("cursorId", cursorId);
      }
      const apiRes = await fetch(
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

        if (event.isReverted) { eventsSkippedReverted++; continue; }

        if (event.movedAt && (!latestMovedAtSeen || event.movedAt > latestMovedAtSeen)) {
          latestMovedAtSeen = event.movedAt;
        }

        const stageName = event.stageTo && event.stageTo.name;
        const metric = metricForStageName(stageName);
        if (!metric) { eventsSkippedNotTracked++; continue; }

        const projectId = event.project && event.project.id;
        const candidateId = event.candidate && event.candidate.id;
        if (!projectId || !candidateId) { eventsSkippedNotTracked++; continue; }

        try {
          const projectName = await lookupProjectName(kv, projectId);
          if (projectName && projectName.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) {
            eventsSkippedExcludedProject++;
            continue;
          }

          // Credit goes to whoever OWNS the candidate, same rule as the
          // webhook — NOT event.movedBy, which is who performed the move,
          // often a different person (e.g. a director moving a stage on
          // a consultant's behalf).
          const email = await lookupCandidateOwnerEmail(projectId, candidateId);
          const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
          if (!consultantId) { eventsSkippedUnmappedOwner++; continue; }

          const dedupeStoreKey = DEDUPE_KEY_BY_METRIC[metric];
          if (dedupeStoreKey) {
            const dedupeKey = `${candidateId}:${projectId}`;
            const alreadyCounted = (await kv.get(dedupeStoreKey)) || {};
            if (alreadyCounted[dedupeKey]) {
              eventsSkippedAlreadyCounted++;
              continue;
            }
            alreadyCounted[dedupeKey] = true;
            await kv.set(dedupeStoreKey, alreadyCounted);
          }

          await writeTally(kv, consultantId, metric, event.movedAt);
          eventsCounted++;
        } catch (e) {
          console.error("[atlas-reconcile-cron] error processing event", event.id, e.message);
          eventsErrored++;
        }
      }

      const pagination = json.pagination || {};
      if (!pagination.hasMore) break;
      cursorDate = pagination.nextCursor && pagination.nextCursor.cursorDate;
      cursorId = pagination.nextCursor && pagination.nextCursor.cursorId;
      if (!cursorDate || !cursorId) break;
    }

    if (pagesFetched >= MAX_PAGES_PER_RUN) hitPageLimit = true;

    // Only advance the cursor past createdAfter if this run actually
    // completed a full pass (hit the end of available data, not the
    // page-count safety limit) — otherwise the next run resumes exactly
    // where cursor pagination left off, rather than jumping ahead and
    // silently skipping whatever remained beyond MAX_PAGES_PER_RUN.
    if (!hitPageLimit) {
      const nextCreatedAfter = latestMovedAtSeen
        ? new Date(new Date(latestMovedAtSeen).getTime() - CONSISTENCY_BUFFER_MS).toISOString()
        : createdAfter;
      await kv.set(CURSOR_KEY, { createdAfter: nextCreatedAfter });
    } else {
      await kv.set(CURSOR_KEY, { createdAfter, resumeCursorDate: cursorDate, resumeCursorId: cursorId });
    }

    return res.status(200).json({
      ok: true,
      triggeredBy,
      createdAfter,
      pagesFetched,
      hitPageLimit,
      eventsSeen,
      eventsCounted,
      eventsSkippedNotTracked,
      eventsSkippedExcludedProject,
      eventsSkippedUnmappedOwner,
      eventsSkippedAlreadyCounted,
      eventsSkippedReverted,
      eventsErrored,
    });
  } catch (e) {
    console.error("[atlas-reconcile-cron] run failed:", e.message);
    return res.status(500).json({ ok: false, error: e.message, eventsSeen, eventsCounted });
  }
};

// Each event needs its own round-trip to Atlas for an owner lookup (plus a
// The second job this file does — see the branch near the top of the
// main handler. Keeps BOTH the KPI page's current-month cache
// (?action=kpi-live-monthly, atlas-kpi-cache-v2:{monthKey}) AND the Weekly
// Incentive's current-week cache (?action=week-live,
// atlas-week-cache-v2:{weekKey}) warm ahead of time, using the EXACT SAME
// proven computation each page itself uses on demand (computeMonthlyKpiLive
// / computeWeeklyKpiLive, both in _atlasShared.js) — not a second,
// different implementation with its own accuracy question, the identical
// logic, just triggered by a schedule instead of a page load. Only the
// CURRENT month and week are warmed here: those are the ones whose cache
// windows are short enough (15 minutes each) to plausibly go cold
// between visits, and where new events are still genuinely arriving. A
// past, settled month or week lasts long enough (30 days) that
// proactively warming it isn't worth the Atlas calls it would cost. The
// two are independent — a failure warming one (e.g. a transient Atlas
// issue) doesn't prevent the other from still completing and being
// reported accurately.
async function warmKpiCache(req, res) {
  const expectedCronAuth = `Bearer ${process.env.CRON_SECRET}`;
  const isCron = !!process.env.CRON_SECRET && req.headers.authorization === expectedCronAuth;
  let triggeredBy = isCron ? "cron" : null;

  if (!isCron) {
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    triggeredBy = "manual";
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const weekKey = isoWeekKey(now.toISOString());

  const result = { ok: true, triggeredBy, monthKey, weekKey };

  try {
    const live = await computeMonthlyKpiLive(kv, year, month);
    // Same "-v2" key as league.js's own read path, and now genuinely
    // including monthlyDetails too — this warming job was previously
    // writing to a different key than the one actually being read
    // (harmless once caught, but meant this job's warming was silently
    // doing nothing), and was never including the candidate breakdown
    // at all, which would have forced a live recompute on every real
    // page load regardless of how "warm" this made the cache look.
    await kv.set(`atlas-kpi-cache-v2:${monthKey}`, { monthly: live.people, monthlyDetails: live.peopleDetails, cachedAt: Date.now() });
    result.month = {
      ok: true,
      pagesFetched: live.pagesFetched,
      eventsSeen: live.eventsSeen,
      eventsCounted: live.eventsCounted,
      pairsResolved: live.pairsResolved,
    };
  } catch (e) {
    console.error("[warm-kpi-cache] month warm failed:", e.message);
    result.month = { ok: false, error: e.message };
  }

  try {
    const liveWeek = await computeWeeklyKpiLive(kv, weekKey);
    // Same reasoning as the month cache just above.
    await kv.set(`atlas-week-cache-v2:${weekKey}`, { people: liveWeek.people, peopleDetails: liveWeek.peopleDetails, cachedAt: Date.now() });
    result.week = {
      ok: true,
      pagesFetched: liveWeek.pagesFetched,
      eventsSeen: liveWeek.eventsSeen,
      eventsCounted: liveWeek.eventsCounted,
      pairsResolved: liveWeek.pairsResolved,
    };
  } catch (e) {
    console.error("[warm-kpi-cache] week warm failed:", e.message);
    result.week = { ok: false, error: e.message };
  }

  // Only a genuine, total failure (both the month and the week failed)
  // is reported as an overall error status — a partial success (one
  // warmed, one didn't) still returns 200 with each result clearly
  // broken out, since that's genuinely useful, actionable information,
  // not a reason to hide the half that DID work.
  const overallOk = result.month.ok || result.week.ok;
  return res.status(overallOk ? 200 : 502).json(result);
}

// cached-per-project name lookup), so a run processing hundreds of events
// can genuinely take tens of seconds — a real backlog (e.g. after the
// schedule hasn't run in a while) could exceed a short default limit.
// Vercel Hobby plans commonly cap functions around 10s by default; this
// raises it explicitly so a legitimately large, safe run isn't cut off
// mid-way. If your actual plan's own maximum is lower than this, Vercel
// will just use its own ceiling instead — this only ever raises the
// limit, never bypasses whatever your plan genuinely allows.
module.exports.config = {
  maxDuration: 60,
};
