import { kv } from "@vercel/kv";
import { Webhook } from "svix";

// ============================================================================
// CONFIG — confirm/adjust these two things once you know for sure:
// 1. INTERVIEW_STAGES below — confirm with Atlas/your team whether "Candidates
//    to IV stage" means only "1st Stage Interview", or also "HR call"/"HRX".
//    If it's more than one stage, add them all to the array.
// 2. EMAIL_TO_CONSULTANT — already filled in with real Atlas emails.
// ============================================================================
const CVS_OUT_STAGE = "CV Sent";
const INTERVIEW_STAGES = ["1st Stage Interview", "HRX", "HR call"];
// Confirmed directly against Atlas's own pipeline stage names — kept as
// arrays (like INTERVIEW_STAGES above) so a future variant name can be
// added without changing anything else.
const ONSITE_STAGES = ["Onsite"];
const OFFER_STAGES = ["Offer"];

// A candidate's interview PROCESS is one thing, even if it involves several
// stages (HR call, then HRX, then 1st Stage Interview) — this should only
// ever count as ONE interview per candidate per process, not one per stage
// they pass through. This persists forever (not scoped to any single week)
// since the different stages for the same process can span multiple weeks —
// once a candidate+project pair has been counted, it never counts again,
// no matter which further interview-type stage they later move through.
const INTERVIEW_COUNTED_KEY = "atlas-interview-counted"; // { "candidateId:projectId": true, ... }
// Same one-per-candidate-per-process dedup, separately for Onsite and
// Offer — each stage gets its own independent counted-key, so a candidate
// bouncing back into an earlier stage (e.g. re-offered after a renegotiation)
// never double-counts, and so that Onsite and Offer counts stay genuinely
// independent of each other and of the interview count.
const ONSITE_COUNTED_KEY = "atlas-onsite-counted";
const OFFER_COUNTED_KEY = "atlas-offer-counted";


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
  // Team leads — tracked here identically to everyone else. The distinction
  // between "regular consultant" and "team lead" is NOT enforced in this
  // file at all — it's enforced downstream in league.js, which reads the
  // same tally data this file writes and deliberately routes james-lancer
  // and josh-stark into a separate `leadRows` field, never `rows`, so their
  // own activity can never leak into the League Table or Team Lead Bonus's
  // team volume figures. See league.js's TEAM_LEAD_BY_CONSULTANT for the
  // actual enforcement point.
  "james@reloadsearch.com": "james-lancer",
  "josh@reloadsearch.com": "josh-stark",
};
// ============================================================================

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ISO 8601 week key, e.g. "2026-W30" — a stable bucket to tally into.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function lookupCandidateOwnerEmail(projectId, candidateId) {
  const res = await fetch(
    `https://api.recruitwithatlas.com/api/v1/projects/${projectId}/candidates/${candidateId}`,
    { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Atlas candidate lookup failed: ${res.status}`);
  const json = await res.json();
  const owner = json.data && json.data.owner;
  return owner ? owner.email : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);

  console.log("[atlas-webhook] rawBody length:", rawBody.length);
  console.log("[atlas-webhook] secret configured, length:", (process.env.ATLAS_WEBHOOK_SECRET || "").length);

  const svixHeaders = {
    "svix-id": req.headers["svix-id"] || req.headers["webhook-id"],
    "svix-timestamp": req.headers["svix-timestamp"] || req.headers["webhook-timestamp"],
    "svix-signature": req.headers["svix-signature"] || req.headers["webhook-signature"],
  };

  let payload;
  try {
    const wh = new Webhook(process.env.ATLAS_WEBHOOK_SECRET);
    payload = wh.verify(rawBody, svixHeaders);
  } catch (e) {
    console.error("[atlas-webhook] verification failed:", e.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // Only handle stage-move events; acknowledge (200) everything else so
  // Atlas doesn't keep retrying events we don't care about.
  if (payload.event !== "candidate.stageMoved") {
    console.log("[atlas-webhook] skipped: not a stage move. event was:", payload.event);
    return res.status(200).json({ ok: true, skipped: true, reason: "not a stage move" });
  }

  const { newStage, candidateId, projectId, movedAt } = payload.data || {};
  if (!newStage || !candidateId || !projectId || !movedAt) {
    console.log("[atlas-webhook] skipped: missing fields. data was:", JSON.stringify(payload.data));
    return res.status(200).json({ ok: true, skipped: true, reason: "missing fields" });
  }

  let metric = null;
  if (newStage.name === CVS_OUT_STAGE) metric = "cvsOut";
  else if (INTERVIEW_STAGES.includes(newStage.name)) metric = "interviews";
  else if (ONSITE_STAGES.includes(newStage.name)) metric = "onsite";
  else if (OFFER_STAGES.includes(newStage.name)) metric = "offers";
  else {
    console.log("[atlas-webhook] skipped: not a tracked stage. newStage.name was:", JSON.stringify(newStage.name));
    return res.status(200).json({ ok: true, skipped: true, reason: "not a tracked stage" });
  }

  let consultantId = null;
  try {
    // Credit goes to whoever OWNS the candidate, not whoever physically moved
    // the pipeline stage — so admin/manager moves made on a consultant's
    // behalf still count correctly for that consultant.
    const email = await lookupCandidateOwnerEmail(projectId, candidateId);
    console.log("[atlas-webhook] candidate owner email:", email);

    if (email) consultantId = EMAIL_TO_CONSULTANT[email] || null;
  } catch (e) {
    console.error("[atlas-webhook] owner lookup failed:", e.message);
    // Still acknowledge receipt so Atlas doesn't retry indefinitely on our error
    return res.status(200).json({ ok: true, error: "candidate owner lookup failed" });
  }

  if (!consultantId) {
    console.log("[atlas-webhook] skipped: no consultant mapped for this owner email");
    return res.status(200).json({ ok: true, skipped: true, reason: "unmapped candidate owner" });
  }

  const weekKey = `atlas-tally:${isoWeekKey(movedAt)}`;

  // Interview, Onsite, and Offer stages each only ever count once per
  // candidate per process — check (and record) that here, before touching
  // the weekly tally at all. Each metric uses its OWN independent counted-
  // key, so a candidate's interview, onsite, and offer counts never
  // interfere with one another even though they follow the same pattern.
  const DEDUPE_KEY_BY_METRIC = {
    interviews: INTERVIEW_COUNTED_KEY,
    onsite: ONSITE_COUNTED_KEY,
    offers: OFFER_COUNTED_KEY,
  };
  if (DEDUPE_KEY_BY_METRIC[metric]) {
    const dedupeStoreKey = DEDUPE_KEY_BY_METRIC[metric];
    const dedupeKey = `${candidateId}:${projectId}`;
    const alreadyCounted = (await kv.get(dedupeStoreKey)) || {};
    if (alreadyCounted[dedupeKey]) {
      console.log(`[atlas-webhook] skipped: this candidate's ${metric} process was already counted`, dedupeKey);
      return res.status(200).json({ ok: true, skipped: true, reason: `${metric} already counted for this candidate/process` });
    }
    alreadyCounted[dedupeKey] = true;
    await kv.set(dedupeStoreKey, alreadyCounted);
  }

  const current = (await kv.get(weekKey)) || {};
  // Handles two cases: a consultant with no entry at all this week yet, AND
  // a consultant who already has a cvsOut/interviews entry from earlier in
  // the week but has never had onsite/offers fields before (either because
  // this deploy is brand new, or their entry predates this change) — both
  // need the missing fields patched in before incrementing, or an onsite/
  // offer move would try to add 1 to `undefined` and silently store NaN.
  if (!current[consultantId]) {
    current[consultantId] = { cvsOut: 0, interviews: 0, onsite: 0, offers: 0 };
  } else {
    if (current[consultantId].onsite === undefined) current[consultantId].onsite = 0;
    if (current[consultantId].offers === undefined) current[consultantId].offers = 0;
  }
  current[consultantId][metric] += 1;
  await kv.set(weekKey, current);

  return res.status(200).json({ ok: true, consultantId, metric, weekKey });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
