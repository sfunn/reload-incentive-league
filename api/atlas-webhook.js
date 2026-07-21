const { kv } = require("@vercel/kv");
const { Webhook } = require("svix");

// ============================================================================
// CONFIG — confirm/adjust these two things once you know for sure:
// 1. STAGE_INTERVIEW below — confirm with Atlas/your team whether "Candidates
//    to IV stage" means only "1st Stage Interview", or also "HR call"/"HRX".
//    If it's more than one stage, change INTERVIEW_STAGES to include them all.
// 2. EMAIL_TO_CONSULTANT — fill this in using the real response from
//    GET /api/v1/users (match each consultant's Atlas email to their id from
//    public/index.html's INITIAL_CONSULTANTS list).
// ============================================================================
const CVS_OUT_STAGE = "CV Sent";
const INTERVIEW_STAGES = ["1st Stage Interview"]; // add "HR call" / "HRX" here if needed

const EMAIL_TO_CONSULTANT = {
  // "alex.silverman@example.com": "alex-silverman",
  // "ash.thiara@example.com": "ash-thiara",
  // "jack.thompson@example.com": "jack-thompson",
  // "max.hart@example.com": "max-hart",
  // "oleg.sokyrka@example.com": "oleg-sokyrka",
  // "alex.aparo@example.com": "alex-aparo",
  // "jack.routledge@example.com": "jack-routledge",
  // "joe.purton@example.com": "joe-purton",
  // "josh.davis@example.com": "josh-davis",
  // "natasha.barnard@example.com": "natasha-barnard",
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

async function lookupAtlasUserEmail(userId) {
  const res = await fetch("https://api.recruitwithatlas.com/api/v1/users?pageSize=100", {
    headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Atlas users lookup failed: ${res.status}`);
  const json = await res.json();
  const user = (json.data || []).find((u) => u.id === userId);
  return user ? user.email : null;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);

  console.log("[atlas-webhook] rawBody length:", rawBody.length);
  console.log("[atlas-webhook] rawBody preview:", rawBody.slice(0, 120));
  console.log("[atlas-webhook] svix-id present:", !!req.headers["svix-id"]);
  console.log("[atlas-webhook] svix-timestamp present:", !!req.headers["svix-timestamp"]);
  console.log("[atlas-webhook] svix-signature present:", !!req.headers["svix-signature"]);
  console.log("[atlas-webhook] secret configured:", !!process.env.ATLAS_WEBHOOK_SECRET, "length:", (process.env.ATLAS_WEBHOOK_SECRET || "").length);

  let payload;
  try {
    const wh = new Webhook(process.env.ATLAS_WEBHOOK_SECRET);
    payload = wh.verify(rawBody, {
      "svix-id": req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"],
    });
  } catch (e) {
    console.error("[atlas-webhook] verification failed:", e.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // Only handle stage-move events; acknowledge (200) everything else so
  // Atlas doesn't keep retrying events we don't care about.
  if (payload.event !== "candidate.stageMoved") {
    return res.status(200).json({ ok: true, skipped: true, reason: "not a stage move" });
  }

  const { newStage, movedByUserId, movedAt } = payload.data || {};
  if (!newStage || !movedByUserId || !movedAt) {
    return res.status(200).json({ ok: true, skipped: true, reason: "missing fields" });
  }

  let metric = null;
  if (newStage.name === CVS_OUT_STAGE) metric = "cvsOut";
  else if (INTERVIEW_STAGES.includes(newStage.name)) metric = "interviews";
  else return res.status(200).json({ ok: true, skipped: true, reason: "not a tracked stage" });

  let consultantId = null;
  try {
    const email = await lookupAtlasUserEmail(movedByUserId);
    if (email) consultantId = EMAIL_TO_CONSULTANT[email] || null;
  } catch (e) {
    // Still acknowledge receipt so Atlas doesn't retry indefinitely on our error
    return res.status(200).json({ ok: true, error: "user lookup failed" });
  }

  if (!consultantId) {
    return res.status(200).json({ ok: true, skipped: true, reason: "unmapped Atlas user" });
  }

  const weekKey = `atlas-tally:${isoWeekKey(movedAt)}`;
  const current = (await kv.get(weekKey)) || {};
  if (!current[consultantId]) current[consultantId] = { cvsOut: 0, interviews: 0 };
  current[consultantId][metric] += 1;
  await kv.set(weekKey, current);

  return res.status(200).json({ ok: true, consultantId, metric, weekKey });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
