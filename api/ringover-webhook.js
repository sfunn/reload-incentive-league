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

// Matches league.js's own isoWeekToDates exactly -- the SUNDAY (end of
// week) that a given ISO week key covers. league.js stores each week
// record's own .date field as that Sunday (not the Monday), and buckets
// months off it that way (w.date === sunday) -- this mirrors that exact
// convention so a week's totals land in the same calendar month here as
// they do for CVs/Interviews/etc elsewhere in this app, not a different
// one just because a week happens to straddle a month boundary.
function isoWeekSunday(weekKey) {
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
  return sunday;
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
    // What the Consultant KPIs page actually consumes: every week folded
    // into calendar months (same monthOf convention as CVs/Interviews/etc
    // elsewhere in this app), one KV read regardless of how many weeks of
    // history exist. Shape: { [monthKey]: { [consultantId]: { calls,
    // seconds } } }.
    const allTally = (await kv.get(TALLY_KEY)) || {};
    const byMonth = {};
    for (const [weekKey, weekTally] of Object.entries(allTally)) {
      const monthKey = monthOf(isoWeekSunday(weekKey));
      if (!byMonth[monthKey]) byMonth[monthKey] = {};
      for (const [consultantId, stats] of Object.entries(weekTally)) {
        if (!byMonth[monthKey][consultantId]) byMonth[monthKey][consultantId] = { calls: 0, seconds: 0 };
        byMonth[monthKey][consultantId].calls += stats.calls || 0;
        byMonth[monthKey][consultantId].seconds += stats.seconds || 0;
      }
    }
    return res.status(200).json({ byMonth });
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
  const result = { verified: !!verifiedPayload, tallied: false, reason: null, consultantId: null, weekKey: null };

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
        const weekKey = isoWeekKey(new Date(startTime * 1000).toISOString());

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

        result.tallied = true;
        result.consultantId = consultantId;
        result.weekKey = weekKey;
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
