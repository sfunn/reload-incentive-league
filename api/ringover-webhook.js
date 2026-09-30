import { kv } from "@vercel/kv";
import jwt from "jsonwebtoken";
import { getUserFromRequest } from "./_authHelpers.js";

// ============================================================================
// Ringover "Calls ended" webhook (event: hangup, resource: call) — fires
// once per call that actually connected and then hung up, carrying the
// real duration. Point Ringover's "Calls ended" URL field at this exact
// endpoint. Confirmed against Ringover's own published API docs AND against
// real captured payloads (via the ?action=recent-logs stub phase) — not
// guessed.
//
// Signature verification (V1, JWT HS512 — Ringover's documented default):
// the whole event is delivered as a JWT in the X-Ringover-Webhook-Signature
// header, signed with the webhook's own Key (shown in the Ringover
// dashboard, NOT the same thing as ATLAS_WEBHOOK_SECRET or any other
// secret already in this project). Once verified, the decoded JWT's own
// `payload` claim IS the trusted event body — that's what this handler
// reads, not req.body directly, so nothing unverified is ever tallied.
//
// Consultant identification: confirmed from real captured payloads that
// data.user.email is present and matches exactly the same @reloadsearch.com
// addresses already used everywhere else in this app — so this reuses the
// same email -> consultant mapping as auth.js, rather than Ringover's own
// internal numeric/string user_id, which nothing else in this app knows
// about. Keep this table in sync with auth.js's EMAIL_TO_CONSULTANT by
// hand if either ever changes — this codebase duplicates the mapping per
// file rather than sharing an import, matching every other webhook here.
//
// Scope, per Scott's explicit decisions:
//   - Calls that hit an answering machine/voicemail (is_internal false,
//     answering_machine_detection "MACHINE") count the SAME as a real
//     human conversation — both represent genuine calling effort.
//   - Internal calls (staff calling staff, is_internal true) are EXCLUDED
//     entirely — this tally is meant to reflect client/candidate-facing
//     phone activity only.
//
// Storage: ONE key holding everything ({ [weekKey]: { [consultantId]:
// {...} } }), matching how the rest of this codebase stores its domain
// data (reload-league-weeks, etc. are each a single blob, never one KV
// key per record) — not the per-week-key design this file started with,
// which doesn't scan efficiently and was inconsistent with everything
// else here.
// ============================================================================

const RINGOVER_WEBHOOK_KEY = process.env.RINGOVER_WEBHOOK_KEY;
const RECENT_LOGS_KEY = "ringover-webhook-recent-logs";
const MAX_LOGS = 20;
const TALLY_KEY = "ringover-tally"; // { [ISO week]: { [consultantId]: {calls, seconds, inboundCalls, inboundSeconds, outboundCalls, outboundSeconds} } }
// A genuinely separate store from TALLY_KEY, updated from each call's own
// real timestamp at the moment it's ingested, not derived from a week
// after the fact. That distinction matters specifically because an ISO
// week can straddle two calendar months (e.g. 2026-W40 runs Mon Sep 28
// through Sun Oct 4) — deriving a whole week's month from its Sunday,
// as the old monthly-tally read used to, silently moved every call from
// the Sep 28-30 portion of that week into October, while September lost
// them entirely. Confirmed directly against the real, current week
// straddling exactly this boundary. Storing each call's own true month
// as it arrives is the only way to get every call in the right month,
// including the days on either side of a boundary within the same week.
const MONTHLY_TALLY_KEY = "ringover-monthly-tally"; // { [YYYY-MM] : { [consultantId]: {calls, seconds, inboundCalls, inboundSeconds, outboundCalls, outboundSeconds} } }
const MIGRATED_WEEKS_KEY = "ringover-monthly-tally-migrated-weeks"; // string[] of weekKeys already folded into MONTHLY_TALLY_KEY by the one-time migration below -- makes re-running it safe, never double-counting a week already migrated once

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

// Matches league.js's own isoWeekKey exactly, so both files always agree
// on which real-world Monday–Sunday window a given date falls into.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Given an ISO week key, returns both the Monday and Sunday it covers —
// needed specifically by the one-time monthly-tally migration below, to
// tell a straddling week (Monday and Sunday in different calendar
// months) apart from a clean one, since only a clean week's total can
// be safely carried over into the new, correctly-attributed monthly
// store; a straddling week's own days were never recorded separately,
// so there's no way to split it accurately after the fact.
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
  return { monday, sunday };
}

function monthOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function verifyAndDecode(req) {
  const token = req.headers["x-ringover-webhook-signature"];
  if (!token || !RINGOVER_WEBHOOK_KEY) return null;
  try {
    // Ringover signs the JWT itself with HS512 using the webhook key as
    // the HMAC secret; once verified, the JWT's own `payload` claim is
    // the actual, trusted event body.
    const decoded = jwt.verify(token, RINGOVER_WEBHOOK_KEY, { algorithms: ["HS512"] });
    return decoded && decoded.payload ? decoded.payload : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET" && req.query.action === "recent-logs") {
    // TODO before this goes further: gate to Super Admin only, matching
    // every other admin-only read in this codebase. Left open for now
    // purely to keep setup friction low during initial verification.
    const logs = (await kv.get(RECENT_LOGS_KEY)) || [];
    return res.status(200).json({ logs });
  }

  if (req.method === "GET" && req.query.action === "tally") {
    // Direct view of the accumulated tally for one ISO week (e.g.
    // ?action=tally&week=2026-W35), so a real test call's effect can be
    // confirmed without having to reason about a raw log entry.
    const week = req.query.week;
    if (!week) return res.status(400).json({ error: "week query param required, e.g. ?action=tally&week=2026-W35" });
    const allTally = (await kv.get(TALLY_KEY)) || {};
    return res.status(200).json({ week, tally: allTally[week] || {} });
  }

  if (req.method === "GET" && req.query.action === "monthly-tally") {
    // What the Consultant KPIs page actually consumes: every call folded
    // directly into the calendar month it genuinely happened in, read
    // straight from MONTHLY_TALLY_KEY (see that constant's own comment
    // for why this is no longer derived from the weekly tally at read
    // time — that derivation was the actual bug, silently moving a
    // straddling week's early days into the wrong month). One KV read
    // regardless of how many months of history exist. Shape:
    // { [monthKey]: { [consultantId]: { calls, seconds } } }.
    const byMonth = (await kv.get(MONTHLY_TALLY_KEY)) || {};
    return res.status(200).json({ byMonth });
  }

  if (req.method === "POST" && req.query.action === "migrate-monthly-tally") {
    // One-time migration: MONTHLY_TALLY_KEY starts genuinely empty, since
    // it's a brand-new store fed only from calls arriving from here on —
    // this carries forward whatever history already exists in the old,
    // per-week TALLY_KEY, but ONLY for weeks that don't straddle a month
    // boundary. A clean week (Monday and Sunday in the same calendar
    // month) is unambiguous, its whole total belongs to that one month,
    // exactly like the old derivation already had it. A straddling week
    // is different in kind, not just degree: its own days were never
    // recorded separately, so there is no way to know how many of its
    // calls happened before the boundary versus after — carrying its
    // total into either month would just move the same inaccuracy
    // somewhere else, not fix it. Straddling weeks are named explicitly
    // in the result rather than silently skipped, so it's clear exactly
    // which history couldn't be recovered this way and would need a
    // real answer from Scott if it matters (there's no correct number to
    // manufacture from what's actually stored for those specific weeks).
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }
    const allTally = (await kv.get(TALLY_KEY)) || {};
    const monthlyTally = (await kv.get(MONTHLY_TALLY_KEY)) || {};
    // Tracks exactly which weeks have already contributed to
    // monthlyTally via this migration — running it again (say, after
    // deploying with more history since the last run) must only add
    // whatever's genuinely new, never re-add a week already folded in
    // once, which would silently double it.
    const migratedWeekKeys = new Set((await kv.get(MIGRATED_WEEKS_KEY)) || []);
    const migratedWeeks = [];
    const skippedStraddlingWeeks = [];
    const alreadyMigratedWeeks = [];
    for (const [weekKey, weekTally] of Object.entries(allTally)) {
      const { monday, sunday } = isoWeekToDates(weekKey);
      const mondayMonth = monthOf(monday);
      const sundayMonth = monthOf(sunday);
      if (mondayMonth !== sundayMonth) {
        skippedStraddlingWeeks.push({ weekKey, mondayMonth, sundayMonth });
        continue;
      }
      if (migratedWeekKeys.has(weekKey)) {
        alreadyMigratedWeeks.push(weekKey);
        continue;
      }
      const monthKey = mondayMonth;
      if (!monthlyTally[monthKey]) monthlyTally[monthKey] = {};
      for (const [consultantId, stats] of Object.entries(weekTally)) {
        if (!monthlyTally[monthKey][consultantId]) {
          monthlyTally[monthKey][consultantId] = { calls: 0, seconds: 0, inboundCalls: 0, inboundSeconds: 0, outboundCalls: 0, outboundSeconds: 0 };
        }
        monthlyTally[monthKey][consultantId].calls += stats.calls || 0;
        monthlyTally[monthKey][consultantId].seconds += stats.seconds || 0;
        monthlyTally[monthKey][consultantId].inboundCalls += stats.inboundCalls || 0;
        monthlyTally[monthKey][consultantId].inboundSeconds += stats.inboundSeconds || 0;
        monthlyTally[monthKey][consultantId].outboundCalls += stats.outboundCalls || 0;
        monthlyTally[monthKey][consultantId].outboundSeconds += stats.outboundSeconds || 0;
      }
      migratedWeekKeys.add(weekKey);
      migratedWeeks.push(weekKey);
    }
    await kv.set(MONTHLY_TALLY_KEY, monthlyTally);
    await kv.set(MIGRATED_WEEKS_KEY, Array.from(migratedWeekKeys));
    return res.status(200).json({ ok: true, migratedWeeks, alreadyMigratedWeeks, skippedStraddlingWeeks });
  }

  if (req.method === "POST" && req.query.action === "force-assign-straddling-week") {
    // A deliberate, manual override for exactly the weeks the automatic
    // migration above correctly refuses to guess at — this is Scott's
    // own judgment call about where a specific straddling week's history
    // genuinely, mostly belongs, not an automatic rule. Two real cases
    // this was actually built for: a week that's overwhelmingly one
    // month with only a sliver in the other (e.g. Mon Aug 31 - Sun Sep 6
    // — one day in August, six in September — putting the whole week in
    // September loses far less accuracy than leaving it out entirely),
    // and the CURRENT week, where "today" is still within it and hasn't
    // reached its own later month yet, so the whole week's pre-fix
    // history genuinely, entirely belongs to the earlier month for now.
    // Requires an explicit weekKey AND targetMonth every time — nothing
    // here is inferred or defaulted, precisely because this is a
    // judgment call, not a safe, generic rule the way the automatic
    // migration's clean-week case is. Uses the exact same
    // MIGRATED_WEEKS_KEY tracking as that migration, so a week handled
    // this way is correctly recognized as already settled if the
    // regular migration is ever run again, and this itself can't be
    // run twice on the same week by accident.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }
    const { weekKey, targetMonth } = req.body || {};
    if (!weekKey || !targetMonth) {
      return res.status(400).json({ error: 'weekKey and targetMonth are both required in the request body, e.g. { "weekKey": "2026-W36", "targetMonth": "2026-09" }' });
    }
    const migratedWeekKeys = new Set((await kv.get(MIGRATED_WEEKS_KEY)) || []);
    if (migratedWeekKeys.has(weekKey)) {
      return res.status(400).json({ error: `${weekKey} has already been migrated or force-assigned once — nothing done, to avoid counting it twice.` });
    }
    const allTally = (await kv.get(TALLY_KEY)) || {};
    const weekTally = allTally[weekKey];
    if (!weekTally) {
      return res.status(400).json({ error: `No history at all exists for ${weekKey} in the old weekly tally — nothing to assign.` });
    }
    const monthlyTally = (await kv.get(MONTHLY_TALLY_KEY)) || {};
    if (!monthlyTally[targetMonth]) monthlyTally[targetMonth] = {};
    for (const [consultantId, stats] of Object.entries(weekTally)) {
      if (!monthlyTally[targetMonth][consultantId]) {
        monthlyTally[targetMonth][consultantId] = { calls: 0, seconds: 0, inboundCalls: 0, inboundSeconds: 0, outboundCalls: 0, outboundSeconds: 0 };
      }
      monthlyTally[targetMonth][consultantId].calls += stats.calls || 0;
      monthlyTally[targetMonth][consultantId].seconds += stats.seconds || 0;
      monthlyTally[targetMonth][consultantId].inboundCalls += stats.inboundCalls || 0;
      monthlyTally[targetMonth][consultantId].inboundSeconds += stats.inboundSeconds || 0;
      monthlyTally[targetMonth][consultantId].outboundCalls += stats.outboundCalls || 0;
      monthlyTally[targetMonth][consultantId].outboundSeconds += stats.outboundSeconds || 0;
    }
    migratedWeekKeys.add(weekKey);
    await kv.set(MONTHLY_TALLY_KEY, monthlyTally);
    await kv.set(MIGRATED_WEEKS_KEY, Array.from(migratedWeekKeys));
    return res.status(200).json({ ok: true, weekKey, targetMonth });
  }

  if (req.method === "POST" && req.query.action === "clear-tally") {
    // Deletes one week's worth of tallied data from the single blob.
    // Super Admin only -- this is a destructive action (unlike
    // set-kpi-override on the KPI page, which only ever corrects one
    // field and can always be reverted), so it's gated more strictly than
    // the rest of this file.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required." });
    }
    const week = (req.body || {}).week;
    if (!week) return res.status(400).json({ error: "week is required in the request body, e.g. { \"week\": \"2026-W35\" }" });
    const allTally = (await kv.get(TALLY_KEY)) || {};
    delete allTally[week];
    await kv.set(TALLY_KEY, allTally);
    return res.status(200).json({ ok: true, week, cleared: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const verifiedPayload = verifyAndDecode(req);

  // Everything below builds up ONE result object -- verification status,
  // AND the tally outcome (tallied yes/no, why, which consultant, which
  // week) -- so a single log entry tells the whole story.
  const result = { verified: !!verifiedPayload, tallied: false, reason: null, consultantId: null, weekKey: null, monthKey: null };

  if (!verifiedPayload) {
    result.reason = "signature did not verify (wrong/missing key, or malformed token)";
  } else if (verifiedPayload.resource !== "call" || verifiedPayload.event !== "hangup") {
    result.reason = "not a call.hangup event";
  } else {
    const data = verifiedPayload.data || {};
    if (data.is_internal === true) {
      result.reason = "internal call, excluded by design";
    } else {
      const email = data.user && typeof data.user.email === "string" ? data.user.email.toLowerCase() : null;
      const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
      const startTime = data.start_time || data.hangup_time || verifiedPayload.timestamp;

      if (!consultantId) {
        result.reason = "no consultant mapped for this email";
      } else if (!startTime) {
        result.reason = "missing start_time";
      } else {
        const durationSeconds = Number(data.duration_in_seconds) || 0;
        const direction = data.direction === "outbound" ? "outbound" : "inbound";
        const callDate = new Date(startTime * 1000);
        const weekKey = isoWeekKey(callDate.toISOString());
        const monthKey = monthOf(callDate); // the call's own, true month -- never derived from its week, see MONTHLY_TALLY_KEY's own comment for why

        const allTally = (await kv.get(TALLY_KEY)) || {};
        if (!allTally[weekKey]) allTally[weekKey] = {};
        if (!allTally[weekKey][consultantId]) {
          allTally[weekKey][consultantId] = { calls: 0, seconds: 0, inboundCalls: 0, inboundSeconds: 0, outboundCalls: 0, outboundSeconds: 0 };
        }
        allTally[weekKey][consultantId].calls += 1;
        allTally[weekKey][consultantId].seconds += durationSeconds;
        allTally[weekKey][consultantId][`${direction}Calls`] += 1;
        allTally[weekKey][consultantId][`${direction}Seconds`] += durationSeconds;
        await kv.set(TALLY_KEY, allTally);

        const allMonthlyTally = (await kv.get(MONTHLY_TALLY_KEY)) || {};
        if (!allMonthlyTally[monthKey]) allMonthlyTally[monthKey] = {};
        if (!allMonthlyTally[monthKey][consultantId]) {
          allMonthlyTally[monthKey][consultantId] = { calls: 0, seconds: 0, inboundCalls: 0, inboundSeconds: 0, outboundCalls: 0, outboundSeconds: 0 };
        }
        allMonthlyTally[monthKey][consultantId].calls += 1;
        allMonthlyTally[monthKey][consultantId].seconds += durationSeconds;
        allMonthlyTally[monthKey][consultantId][`${direction}Calls`] += 1;
        allMonthlyTally[monthKey][consultantId][`${direction}Seconds`] += durationSeconds;
        await kv.set(MONTHLY_TALLY_KEY, allMonthlyTally);

        result.tallied = true;
        result.consultantId = consultantId;
        result.weekKey = weekKey;
        result.monthKey = monthKey;
      }
    }
  }

  // Always log the attempt, including the full tally outcome, so setup
  // problems (or successes) are visible via ?action=recent-logs rather
  // than requiring a separate check.
  const logs = (await kv.get(RECENT_LOGS_KEY)) || [];
  logs.unshift({
    receivedAt: new Date().toISOString(),
    ...result,
    rawBody: req.body,
    payload: verifiedPayload,
  });
  await kv.set(RECENT_LOGS_KEY, logs.slice(0, MAX_LOGS));

  // 200 either way (even an unverified signature) so Ringover doesn't
  // treat it as a delivery failure and retry forever -- nothing gets
  // tallied without a valid signature regardless of the response code.
  return res.status(200).json({ ok: true, ...result });
}
