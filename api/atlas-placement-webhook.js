import { kv } from "@vercel/kv";
import { Webhook } from "svix";

const PLACEMENTS_KEY = "atlas-placements";

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

  console.log("[atlas-placement-webhook] rawBody length:", rawBody.length);

  const svixHeaders = {
    "svix-id": req.headers["svix-id"] || req.headers["webhook-id"],
    "svix-timestamp": req.headers["svix-timestamp"] || req.headers["webhook-timestamp"],
    "svix-signature": req.headers["svix-signature"] || req.headers["webhook-signature"],
  };

  let payload;
  try {
    const wh = new Webhook(process.env.ATLAS_PLACEMENT_WEBHOOK_SECRET);
    payload = wh.verify(rawBody, svixHeaders);
  } catch (e) {
    console.error("[atlas-placement-webhook] verification failed:", e.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  if (payload.event !== "placement.created" && payload.event !== "placement.updated") {
    console.log("[atlas-placement-webhook] skipped: not a placement event. event was:", payload.event);
    return res.status(200).json({ ok: true, skipped: true, reason: "not a placement event" });
  }

  const data = payload.data || {};
  const { id: placementId, startDate, candidate, client } = data;

  if (!placementId) {
    console.log("[atlas-placement-webhook] skipped: missing placement id");
    return res.status(200).json({ ok: true, skipped: true, reason: "missing placement id" });
  }

  const all = (await kv.get(PLACEMENTS_KEY)) || {};
  all[placementId] = {
    candidateName: (candidate && candidate.name) || null,
    clientCompanyName: (client && client.companyName) || null,
    startDate: startDate || null,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(PLACEMENTS_KEY, all);

  console.log(
    "[atlas-placement-webhook] recorded placement:",
    JSON.stringify({ placementId, candidateName: all[placementId].candidateName })
  );

  return res.status(200).json({ ok: true, placementId });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
