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

// Scott's rule: CitSec Options is excluded from every consultant KPI
// number entirely, including "Deals Agreed" on the Consultant KPIs page,
// which is computed from these fee records over in league.js. Storing the
// project's own name on every record (not just when there's no placement)
// is what makes that filter possible downstream. Cached by project id
// (shared KV key with atlas-webhook.js's own identical lookup) so a
// project's name is only ever fetched from Atlas once, not on every fee
// event tied to that same project.
// Every webhook event this endpoint ignores gets a short, durable record
// in KV, not just a log line. Vercel only keeps logs for about an hour,
// which twice now has meant the evidence of what Atlas actually sent was
// gone before anyone could look at it. Stores the event name, the data's
// own id, and the SHAPE of the data (field names only, one level deep),
// never the values themselves, so no candidate, salary or fee details
// are retained. Capped, newest first, and strictly best effort: a failure
// here must never change what the webhook responds with.
const SKIPPED_EVENTS_KEY = "atlas-fee-webhook-skipped-events";
const MAX_SKIPPED_EVENTS = 20;
async function recordSkippedEvent(payload) {
  try {
    const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
    const dataShape = {};
    for (const [k, v] of Object.entries(data)) {
      dataShape[k] = Array.isArray(v) ? "array" : v && typeof v === "object" ? Object.keys(v) : typeof v;
    }
    const entry = { at: new Date().toISOString(), event: (payload && payload.event) || null, dataId: data.id || null, dataShape };
    const existing = (await kv.get(SKIPPED_EVENTS_KEY)) || [];
    await kv.set(SKIPPED_EVENTS_KEY, [entry, ...existing].slice(0, MAX_SKIPPED_EVENTS));
  } catch (e) {
    console.error("[atlas-fee-webhook] couldn't record skipped event:", e.message);
  }
}

// Placement events. Confirmed from a real production capture: Atlas
// sends "placement.updated" to this same endpoint (approving a placement
// fires it, one second after the placement's own updatedAt), and until
// now this handler threw every one of them away as "not a fee event",
// which is why an approved placement never reached the store that
// decides Deals Agreed and the Citadel uplift, and its fee sat in the
// onsite bucket. "placement.created" is handled the same way on the
// assumption it carries the same data; if it does not, the strict check
// below refuses to store it rather than store something incomplete.
// Stores exactly the four fields the existing records carry
// (candidateName, clientCompanyName, startDate, updatedAt), merged onto
// whatever is already there, never overwriting a good value with a blank.
const PLACEMENTS_KEY = "atlas-placements";
const PLACEMENT_EVENTS = new Set(["placement.created", "placement.updated"]);
async function handlePlacementEvent(payload, res) {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const placementId = data.id || null;
  const candidateName = data.candidate && typeof data.candidate.name === "string" ? data.candidate.name.trim() : "";
  const client = data.client && typeof data.client === "object" ? data.client : {};
  const clientCompanyName = client.companyName || (client.company && client.company.name) || null;
  if (!placementId || !candidateName) {
    console.log("[atlas-fee-webhook] placement event skipped: missing id or candidate name. event was:", payload.event);
    await recordSkippedEvent(payload);
    return res.status(200).json({ ok: true, skipped: true, reason: "placement event missing id or candidate name" });
  }
  const store = (await kv.get(PLACEMENTS_KEY)) || {};
  const incoming = {
    candidateName,
    clientCompanyName,
    startDate: data.startDate || null,
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
  const merged = { ...(store[placementId] || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== "") merged[k] = v;
  }
  store[placementId] = merged;
  await kv.set(PLACEMENTS_KEY, store);
  console.log("[atlas-fee-webhook] stored placement:", JSON.stringify({ placementId, clientCompanyName, startDate: merged.startDate || null }));
  return res.status(200).json({ ok: true, placementId, stored: true });
}

const PROJECT_NAME_CACHE_PREFIX = "atlas-project-name:"; // one key per project — SHARED with _atlasShared.js's own copy of this lookup
async function lookupProjectName(projectId) {
  if (!projectId) return null;
  const cacheKey = `${PROJECT_NAME_CACHE_PREFIX}${projectId}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  let name = null;
  try {
    const res = await fetch(
      `https://api.recruitwithatlas.com/api/v1/projects/${projectId}`,
      { headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` } }
    );
    if (res.ok) {
      const json = await res.json();
      // "CitSec Options" (the value the exclusion check compares
      // against) is the PROJECT's own title, e.g. "Aaron Rosen: PDT -
      // SWE Pipeline" — confirmed directly, not the client company name
      // (that's company.name, a genuinely different field, e.g. "PDT
      // Partners", used for projectClientName above). This function
      // guessed company.name for a while, on the assumption "CitSec
      // Options" was itself a company name — it isn't, so that guess
      // meant the exclusion this feeds was still checking the wrong
      // field even after that "fix". jobRole sits flat on this
      // project-detail response (json.data.jobRole), no nested lookup
      // needed. One key per project rather than one shared object for
      // every project ever seen, too — see _atlasShared.js's own copy of
      // this function for the fuller reasoning on that, since both must
      // stay on the identical key prefix.
      const data = json.data || {};
      name = data.jobRole || null;
    }
  } catch (e) {
    console.error("[atlas-fee-webhook] project name lookup failed:", e.message);
  }
  if (name !== null) await kv.set(cacheKey, name);
  return name;
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

  if (PLACEMENT_EVENTS.has(payload.event)) {
    return handlePlacementEvent(payload, res);
  }

  if (payload.event !== "financial.feeCreated" && payload.event !== "financial.feeUpdated") {
    console.log("[atlas-fee-webhook] skipped: not a fee event. event was:", payload.event);
    await recordSkippedEvent(payload);
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
  // Unlike the client-name lookup above, this one always runs regardless
  // of placement — every record needs its own project name so the
  // CitSec Options exclusion can be applied downstream in league.js.
  const projectName = await lookupProjectName(projectId);

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
      projectName: projectName || null,
      paid: prior.paid,
      paidMarkedAt: prior.paidMarkedAt,
      monthOverrides: prior.monthOverrides || {},
      source: prior.source || null,
      coordinatorId: prior.coordinatorId || null,
      updatedAt: new Date().toISOString(),
    };

    console.log(
      "[atlas-fee-webhook] recorded split:",
      JSON.stringify({ feeId, email, consultantId, shareAmount, currency, placementId: placementId || null, keptFromPrior: !incomingEmail })
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
