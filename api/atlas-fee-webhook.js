import { kv } from "@vercel/kv";
import { Webhook } from "svix";

// ============================================================================
// CONFIG
// ============================================================================
// This map is SEPARATE from the one in atlas-webhook.js on purpose: the Deal
// Lead Award includes James and Josh (team leaders), whereas the CVs Out /
// Interviews league table does not.
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
  "scott@reloadsearch.com": "scott-finn",
  "lee@reloadsearch.com": "lee-mamo",
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

function yearFromDateStr(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.getUTCFullYear();
}

// Every fee event includes a projectId even when there's no placement
// connected yet — and a project always belongs to a client company in
// Atlas. So when a fee has no linked placement (and therefore no client
// name from that route), this gives us a real fallback instead of a blank.
async function lookupProjectClientName(projectId) {
  if (!projectId) return null;
  try {
    const res = await fetch(
      `https://api.recruitwithatlas.com/api/v1/projects/${projectId}`,
      { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const company = json.data && json.data.company;
    return company ? company.name : null;
  } catch (e) {
    console.error("[atlas-fee-webhook] project client lookup failed:", e.message);
    return null;
  }
}

// Fee/split "share" is treated as a percentage (e.g. "50" meaning 50%) when
// present. If a split has no share (or there's only one split), it gets
// full credit for the fee amount.
function computeShareAmount(totalAmount, share, splitCount) {
  const amount = parseFloat(totalAmount);
  if (isNaN(amount)) return null;
  if (share === null || share === undefined || share === "") {
    // No explicit share — if there's only one split, they get it all;
    // if there are multiple splits with no share info, divide evenly
    // as a safe fallback (better than double-counting or dropping it).
    return splitCount > 1 ? amount / splitCount : amount;
  }
  const pct = parseFloat(share);
  if (isNaN(pct)) return splitCount > 1 ? amount / splitCount : amount;
  return amount * (pct / 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);

  console.log("[atlas-fee-webhook] rawBody length:", rawBody.length);

  const svixHeaders = {
    "svix-id": req.headers["svix-id"] || req.headers["webhook-id"],
    "svix-timestamp": req.headers["svix-timestamp"] || req.headers["webhook-timestamp"],
    "svix-signature": req.headers["svix-signature"] || req.headers["webhook-signature"],
  };

  let payload;
  try {
    const wh = new Webhook(process.env.ATLAS_FEE_WEBHOOK_SECRET);
    payload = wh.verify(rawBody, svixHeaders);
  } catch (e) {
    console.error("[atlas-fee-webhook] verification failed:", e.message);
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  if (payload.event !== "financial.feeCreated" && payload.event !== "financial.feeUpdated") {
    console.log("[atlas-fee-webhook] skipped: not a fee event. event was:", payload.event);
    return res.status(200).json({ ok: true, skipped: true, reason: "not a fee event" });
  }

  const data = payload.data || {};
  const { id: feeId, feeDate, amount, currency, splits, placementId, projectId, notes } = data;

  if (!feeId || !amount || !currency || !Array.isArray(splits) || splits.length === 0) {
    console.log("[atlas-fee-webhook] skipped: missing fields. data was:", JSON.stringify(data));
    return res.status(200).json({ ok: true, skipped: true, reason: "missing fields" });
  }

  const year = yearFromDateStr(feeDate) || new Date().getUTCFullYear();

  // Only bother calling out to Atlas for the project's client when there's
  // no placement connected — if a placement exists, its own webhook will
  // supply the client name via the normal join, so this avoids an
  // unnecessary API call on the common case.
  const projectClientName = placementId ? null : await lookupProjectClientName(projectId);

  // Load existing records, strip out any prior entries for this fee (so
  // financial.feeUpdated replaces cleanly instead of duplicating), then
  // add fresh entries — one per split.
  const RECORDS_KEY = "atlas-fee-records";
  const existing = (await kv.get(RECORDS_KEY)) || [];
  // Preserve any "paid" status already set on a matching split before we
  // rebuild it below — a financial.feeUpdated re-send shouldn't silently
  // wipe out a deal Scott/Lee already marked as paid.
  const priorPaidBySplit = {};
  existing.forEach((r) => {
    if (r.feeId === feeId) {
      priorPaidBySplit[r.splitId] = {
        paid: r.paid,
        paidMarkedAt: r.paidMarkedAt,
        monthOverrides: r.monthOverrides,
        source: r.source,
        coordinatorId: r.coordinatorId,
        consultantEmail: r.consultantEmail,
        consultantId: r.consultantId,
        consultantName: r.consultantName,
      };
    }
  });
  const filtered = existing.filter((r) => r.feeId !== feeId);

  const newRecords = [];
  for (const split of splits) {
    const prior = priorPaidBySplit[split.id] || {
      paid: false, paidMarkedAt: null, monthOverrides: {}, source: null, coordinatorId: null,
      consultantEmail: null, consultantId: null, consultantName: null,
    };

    // Atlas uses TWO DIFFERENT shapes for fee-earner info depending on the
    // event type: financial.feeCreated nests it as split.feeEarner.email,
    // while financial.feeUpdated flattens it to split.feeEarnerEmail. Not
    // handling both meant every single feeUpdated event silently read as
    // "no owner" — this line fixes that at the source, with the "keep
    // whatever we already knew" fallback below as a safety net for any
    // future case where an event genuinely has neither.
    const incomingEmail = (split.feeEarner && split.feeEarner.email) || split.feeEarnerEmail || null;
    const incomingName = (split.feeEarner && split.feeEarner.name) || split.feeEarnerName || null;
    const email = incomingEmail || prior.consultantEmail;
    const consultantId = incomingEmail
      ? (EMAIL_TO_CONSULTANT[incomingEmail] || null)
      : prior.consultantId;
    const consultantName = incomingEmail ? incomingName : prior.consultantName;
    const shareAmount = computeShareAmount(amount, split.share, splits.length);

    const record = {
      feeId,
      splitId: split.id,
      feeDate: feeDate || null,
      year,
      currency,
      totalAmount: parseFloat(amount),
      share: split.share || null,
      shareAmount,
      consultantEmail: email || null,
      consultantId,
      consultantName,
      placementId: placementId || null,
      notes: notes || null,
      projectClientName: projectClientName || null,
      paid: prior.paid,
      paidMarkedAt: prior.paidMarkedAt,
      monthOverrides: prior.monthOverrides || {},
      source: prior.source || null,
      coordinatorId: prior.coordinatorId || null,
      updatedAt: new Date().toISOString(),
    };

    console.log(
      "[atlas-fee-webhook] recorded split:",
      JSON.stringify({ feeId, email, consultantId, shareAmount, currency, keptFromPrior: !incomingEmail })
    );

    if (!consultantId) {
      console.log("[atlas-fee-webhook] note: no consultant mapped for owner email:", email);
    }

    newRecords.push(record);
  }

  const updated = [...filtered, ...newRecords];
  await kv.set(RECORDS_KEY, updated);

  return res.status(200).json({ ok: true, feeId, recordsAdded: newRecords.length, year });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
