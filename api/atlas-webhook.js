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
};

// Team leaders — real consultants in Atlas, but excluded from the league
// table on purpose. Candidates they own are acknowledged and skipped,
// not treated as an error.
const TEAM_LEADER_EMAILS = new Set([
  "james@reloadsearch.com",
  "josh@reloadsearch.com",
]);
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

    if (email && TEAM_LEADER_EMAILS.has(email)) {
      console.log("[atlas-webhook] skipped: owner is a team leader, not tracked on
