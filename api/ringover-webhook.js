import { kv } from "@vercel/kv";
import jwt from "jsonwebtoken";

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
// ============================================================================

const RINGOVER_WEBHOOK_KEY = process.env.RINGOVER_WEBHOOK_KEY;
const RECENT_LOGS_KEY = "ringover-webhook-recent-logs";
const MAX_LOGS = 20;
const TALLY_PREFIX = "ringover-tally:"; // ringover-tally:{ISO week} -> { [consultantId]: {...} }

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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const verifiedPayload = verifyAndDecode(req);

  // Always log the attempt (verified or not) so setup problems are visible
  // via ?action=recent-logs rather than silently failing forever.
  const logs = (await kv.get(RECENT_LOGS_KEY)) || [];
  logs.unshift({
    receivedAt: new Date().toISOString(),
    verified: !!verifiedPayload,
    rawBody: req.body,
    payload: verifiedPayload,
  });
  await kv.set(RECENT_LOGS_KEY, logs.slice(0, MAX_LOGS));

  if (!verifiedPayload) {
    // Don't tell an attacker WHY it failed; 200 either way so Ringover
    // doesn't treat a bad signature as a delivery failure and retry
    // forever, but nothing gets tallied without a valid signature.
    return res.status(200).json({ ok: true, tallied: false });
  }

  // Only ever tally genuine call-hangup events, even if this URL is ever
  // accidentally wired to a different event type in the dashboard.
  if (verifiedPayload.resource !== "call" || verifiedPayload.event !== "hangup") {
    return res.status(200).json({ ok: true, tallied: false, reason: "not a call.hangup event" });
  }

  const data = verifiedPayload.data || {};

  // Internal (staff-to-staff) calls are deliberately excluded -- this
  // tally is meant to reflect client/candidate-facing phone activity only.
  if (data.is_internal === true) {
    return res.status(200).json({ ok: true, tallied: false, reason: "internal call, excluded by design" });
  }

  const email = data.user && typeof data.user.email === "string" ? data.user.email.toLowerCase() : null;
  const consultantId = email ? EMAIL_TO_CONSULTANT[email] : null;
  const durationSeconds = Number(data.duration_in_seconds) || 0;
  const direction = data.direction === "outbound" ? "outbound" : "inbound"; // Ringover's own two values
  const startTime = data.start_time || data.hangup_time || verifiedPayload.timestamp;

  if (!consultantId || !startTime) {
    // Either an unmapped Ringover user (e.g. Scott/Lee aren't consultants
    // and have no leaderboard entry to tally into) or a malformed event --
    // both are safe, silent no-ops rather than errors.
    return res.status(200).json({ ok: true, tallied: false, reason: consultantId ? "missing start_time" : "no consultant mapped for this email" });
  }

  const weekKey = isoWeekKey(new Date(startTime * 1000).toISOString());
  const tallyKey = `${TALLY_PREFIX}${weekKey}`;
  const tally = (await kv.get(tallyKey)) || {};
  if (!tally[consultantId]) {
    tally[consultantId] = { calls: 0, seconds: 0, inboundCalls: 0, inboundSeconds: 0, outboundCalls: 0, outboundSeconds: 0 };
  }
  tally[consultantId].calls += 1;
  tally[consultantId].seconds += durationSeconds;
  tally[consultantId][`${direction}Calls`] += 1;
  tally[consultantId][`${direction}Seconds`] += durationSeconds;
  await kv.set(tallyKey, tally);

  return res.status(200).json({ ok: true, tallied: true, weekKey, consultantId });
}
