import { kv } from "@vercel/kv";
import { Webhook } from "svix";
import atlasShared from "./_atlasShared.js";

const {
  EXCLUDED_PROJECT_NAME,
  EMAIL_TO_CONSULTANT,
  DEDUPE_KEY_BY_METRIC,
  metricForStageName,
  lookupProjectName,
  lookupCandidateOwnerEmail,
  writeTally,
} = atlasShared;
// ============================================================================

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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

  const projectName = await lookupProjectName(kv, projectId);
  if (projectName && projectName.trim().toLowerCase() === EXCLUDED_PROJECT_NAME) {
    console.log("[atlas-webhook] skipped: CitSec Options project is excluded from all KPI numbers");
    return res.status(200).json({ ok: true, skipped: true, reason: "excluded project (CitSec Options)" });
  }

  const metric = metricForStageName(newStage.name);
  if (!metric) {
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

  // Interview, Onsite, and Offer stages each only ever count once per
  // candidate per process — check (and record) that here, before touching
  // the tally at all. Each metric uses its OWN independent counted-key, so
  // a candidate's interview, onsite, and offer counts never interfere with
  // one another even though they follow the same pattern.
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

  const { weekKey, monthKey } = await writeTally(kv, consultantId, metric, movedAt);

  return res.status(200).json({ ok: true, consultantId, metric, weekKey, monthKey });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
