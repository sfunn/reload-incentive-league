const { kv } = require("@vercel/kv");
const { getUserFromRequest } = require("./_authHelpers");

const RECORDS_KEY = "atlas-fee-records";
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";
const CLIENT_AREAS_KEY = "deal-client-areas"; // { [clientCompanyName]: string[] } -- SHARED with the Directors site, same KV key
const AREA_VARIANT_MAP_KEY = "deal-area-variant-map"; // { [clientCompanyName]: { [normalizedRawText]: canonicalAreaName } } -- SHARED with the Directors site, same KV key
const EMPLOYERS_LIST_KEY = "previous-employers-list"; // string[] -- SHARED with the Directors site, same KV key
const EMPLOYER_VARIANT_MAP_KEY = "previous-employer-variant-map"; // { [normalizedRawText]: canonicalEmployerName } -- SHARED with the Directors site, same KV key, deliberately GLOBAL (not per-client, unlike areas)

// ============================================================================
// Area tracking — copied verbatim from the Directors site's own spec so the
// resolution logic is byte-identical between the two sites. Both read and
// write the SAME two KV keys above; this is one feature with two front
// doors, not two separate copies that could silently diverge.
// ============================================================================
function normalizeAreaKey(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// Only resolves when EXACTLY one canonical area is genuinely close —
// refuses to guess if two areas could both plausibly be what was meant.
function findFuzzyAreaMatch(normalizedText, canonicalAreas) {
  if (normalizedText.length < 5) return null;
  const withinRange = [];
  for (const area of canonicalAreas || []) {
    const normalizedArea = normalizeAreaKey(area);
    if (normalizedArea.length < 5) continue;
    const distance = levenshteinDistance(normalizedText, normalizedArea);
    const threshold = Math.max(1, Math.floor(Math.max(normalizedText.length, normalizedArea.length) * 0.2));
    if (distance > 0 && distance <= threshold) withinRange.push(area);
  }
  return withinRange.length === 1 ? withinRange[0] : null;
}

function resolveAreaForDeal(rawNotes, canonicalAreas, variantMap) {
  const trimmed = (rawNotes || "").trim();
  if (!trimmed) return { area: null, source: "none" };
  const normalized = normalizeAreaKey(trimmed);
  const exactMatch = (canonicalAreas || []).find((a) => normalizeAreaKey(a) === normalized);
  if (exactMatch) return { area: exactMatch, source: "atlas" };
  const mapped = (variantMap || {})[normalized];
  if (mapped) return { area: mapped, source: "atlas" };
  const fuzzyMatch = findFuzzyAreaMatch(normalized, canonicalAreas);
  if (fuzzyMatch) return { area: fuzzyMatch, source: "atlas-fuzzy" };
  return { area: null, source: "unmapped", rawText: trimmed };
}

// ============================================================================
// "Where Candidates Came From" — parses a single Atlas notes field into its
// two independent parts (area, previous employer). Copied verbatim from the
// Directors site's own spec so both sites agree on every note, always.
//
// Critical backward-compatibility rule: any note written before this feature
// existed (no "|", no standalone word "from") resolves EXACTLY as it always
// did — the whole note is the area, employer is none. Nothing needs
// re-entering.
// ============================================================================
function parseNote(rawNotes) {
  const text = (rawNotes || "").trim();
  if (!text) return { areaText: null, employerText: null };

  if (text.includes("|")) {
    const segments = text.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    let areaText = null, employerText = null, foundLabel = false;
    for (const seg of segments) {
      const areaMatch = seg.match(/^area:?\s*/i);
      const fromMatch = seg.match(/^from:?\s*/i);
      if (areaMatch) {
        areaText = seg.slice(areaMatch[0].length).trim() || null;
        foundLabel = true;
      } else if (fromMatch) {
        employerText = seg.slice(fromMatch[0].length).trim() || null;
        foundLabel = true;
      }
    }
    // No segment carried a recognizable label at all, and there's only one
    // real segment to begin with — this isn't genuine pipe-delimited usage,
    // fall back to the same backward-compatible rule as a plain note.
    if (!foundLabel && segments.length === 1) {
      return { areaText: text, employerText: null };
    }
    return { areaText, employerText };
  }

  // No "|" — look for the word "from" as a genuine standalone word, not a
  // substring inside another word (e.g. "Fromage Desk" must not match).
  const fromWordMatch = text.match(/\bfrom\b:?\s*/i);
  if (fromWordMatch) {
    const idx = fromWordMatch.index;
    const employerText = text.slice(idx + fromWordMatch[0].length).trim() || null;
    let areaText = text.slice(0, idx).trim();
    areaText = areaText.replace(/^area:?\s*/i, "").trim() || null;
    return { areaText, employerText };
  }

  // Neither a label nor "from" anywhere — the entire note is the area,
  // unchanged, exactly as it always resolved before this feature existed.
  return { areaText: text, employerText: null };
}

// Identical precedence and safety rules to resolveAreaForDeal, just against
// the GLOBAL employer list (never scoped to a client, unlike areas).
function resolveEmployerForDeal(employerText, canonicalEmployers, variantMap) {
  const trimmed = (employerText || "").trim();
  if (!trimmed) return { employer: null, source: "none" };
  const normalized = normalizeAreaKey(trimmed);
  const exactMatch = (canonicalEmployers || []).find((e) => normalizeAreaKey(e) === normalized);
  if (exactMatch) return { employer: exactMatch, source: "atlas" };
  const mapped = (variantMap || {})[normalized];
  if (mapped) return { employer: mapped, source: "atlas" };
  const fuzzyMatch = findFuzzyAreaMatch(normalized, canonicalEmployers);
  if (fuzzyMatch) return { employer: fuzzyMatch, source: "atlas-fuzzy" };
  return { employer: null, source: "unmapped", rawText: trimmed };
}

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Prefers the REAL rate from the month a deal was actually paid, once
// Scott/Lee have set one for that specific month. Otherwise — not paid
// yet, or paid but that exact month has no rate entered — falls back to
// whichever month they most recently set a rate for. This is deliberately
// NEVER tied to today's literal calendar date: rates are set manually,
// so "today" might not have one yet, and using it would either wrongly
// show "held back" or silently disagree with what's already on screen.
// Each currency independently finds its own most recent set month, rather
// than all currencies being tied to a single "latest month" — otherwise,
// if GBP gets re-entered every month but EUR was only ever set once a
// while back, EUR deals would wrongly show "no rate" despite a perfectly
// valid EUR rate still existing from that earlier month.
function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}

function getRateForCurrency(record, allRates, currency) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    const paidRate = allRates[paidMonthKey] && allRates[paidMonthKey][currency];
    if (paidRate) return paidRate;
    // Paid but that month never had this specific currency set — fall
    // through to the same latest-set fallback as an unpaid deal would use.
  }
  const latestKey = latestSetMonthKeyForCurrency(allRates, currency);
  return latestKey ? allRates[latestKey][currency] : null;
}

async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const rate = getRateForCurrency(record, allRates, record.currency);
  if (!rate) return null; // no rate set for that currency in any month yet
  return record.shareAmount * rate;
}

// Same conversion logic as commission.js's convertToGBP, duplicated here
// exactly (matching how every API file in this codebase keeps its own
// copy of small helpers instead of importing across routes, and matching
// the project's explicit preference for hardcoded, narrowly-scoped logic
// over generalized logic for anything financial) — run the SAME monthly
// rates in reverse for GBP itself, and via USD as a bridge for EUR only.
async function convertToGBP(record, allRates) {
  if (record.currency === "GBP") return record.shareAmount;
  const gbpRate = getRateForCurrency(record, allRates, "GBP");
  if (!gbpRate) return null; // no GBP rate set for any applicable month yet
  if (record.currency === "USD") return record.shareAmount / gbpRate;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    const usdEquivalent = record.shareAmount * eurRate;
    return usdEquivalent / gbpRate;
  }
  return null;
}

// Which year a deal counts toward — for the leaderboard, the admin table,
// and commission — is based on the candidate's START DATE, not the
// signed/fee date. That way editing a fee's recorded date in Atlas (e.g.
// correcting it to the real signed date) never shifts which year's page a
// deal lives on. Falls back to the fee's own date only when there's no
// linked placement start date yet (e.g. the placement webhook hasn't
// fired), so a deal is never simply dropped for lacking data.
function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

// Same start-date-first ordering as the commission engine uses, so the
// admin table and commission sheets always read as the same sequence.
function orderDateOf(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  return (placement && placement.startDate) || record.feeDate || "";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    // --- "Where Candidates Came From" reads — Super Admin only (unlike
    // Area Concentration, which stays visible to everyone). Employer list
    // is GLOBAL, never scoped to a client, unlike areas.
    if (["employer-list", "employer-unmapped", "explorer-employers", "explorer-candidates"].includes(req.query.action)) {
      const user = await getUserFromRequest(req);
      if (!user || !user.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

      const employers = (await kv.get(EMPLOYERS_LIST_KEY)) || [];
      if (req.query.action === "employer-list") {
        return res.status(200).json({ employers });
      }

      const employerVariantMap = (await kv.get(EMPLOYER_VARIANT_MAP_KEY)) || {};
      const records = (await kv.get(RECORDS_KEY)) || [];
      const placements = (await kv.get(PLACEMENTS_KEY)) || {};
      const allRates = (await kv.get(FX_KEY)) || {};

      // Genuine placements only, optionally scoped to one client — "all"
      // or no client param means every client.
      const clientParam = req.query.client;
      const genuineRecords = records.filter((r) => {
        const placement = r.placementId ? placements[r.placementId] : null;
        const hasPlacementName = !!(placement && placement.candidateName);
        if (!hasPlacementName) return false;
        if (clientParam && clientParam !== "all") {
          const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
          if (clientCompanyName !== clientParam) return false;
        }
        return true;
      });

      if (req.query.action === "employer-unmapped") {
        const unmappedTexts = new Set();
        for (const r of genuineRecords) {
          const { employerText } = parseNote(r.notes);
          const resolved = resolveEmployerForDeal(employerText, employers, employerVariantMap);
          if (resolved.source === "unmapped") unmappedTexts.add(resolved.rawText);
        }
        return res.status(200).json({ unmappedTexts: [...unmappedTexts] });
      }

      const yearParam = req.query.year;
      const currentYear = new Date().getUTCFullYear();
      const scopedRecords = yearParam === "all"
        ? genuineRecords
        : genuineRecords.filter((r) => effectiveYear(r, placements) === (yearParam ? parseInt(yearParam, 10) : currentYear));

      if (req.query.action === "explorer-employers") {
        const byEmployer = {};
        let totalDeals = 0, untaggedCount = 0, unmappedCount = 0;
        for (const r of scopedRecords) {
          const { employerText } = parseNote(r.notes);
          const resolved = resolveEmployerForDeal(employerText, employers, employerVariantMap);
          totalDeals += 1;
          if (resolved.source === "none") {
            untaggedCount += 1;
          } else if (resolved.source === "unmapped") {
            unmappedCount += 1;
          } else {
            const gbp = await convertToGBP(r, allRates);
            if (!byEmployer[resolved.employer]) byEmployer[resolved.employer] = { employer: resolved.employer, gbp: 0, deals: 0 };
            byEmployer[resolved.employer].deals += 1;
            if (gbp !== null) byEmployer[resolved.employer].gbp += gbp;
          }
        }
        return res.status(200).json({
          client: clientParam || "all",
          year: yearParam === "all" ? "all" : (yearParam ? parseInt(yearParam, 10) : currentYear),
          totalDeals, untaggedCount, unmappedCount,
          byEmployer: Object.values(byEmployer).sort((a, b) => b.deals - a.deals),
        });
      }

      if (req.query.action === "explorer-candidates") {
        // Only in Candidate mode: dedupe repeated fee records sharing the
        // same placement. If exactly one carries a "from" note, keep that
        // one; otherwise keep any single representative. This never
        // touches Employer/Area mode's own totals — those sum every real
        // fee record, since each one is genuinely separate revenue.
        const byPlacement = new Map();
        for (const r of scopedRecords) {
          const key = r.placementId;
          const { employerText } = parseNote(r.notes);
          if (!byPlacement.has(key)) {
            byPlacement.set(key, r);
          } else {
            const existing = byPlacement.get(key);
            const existingHasEmployer = !!parseNote(existing.notes).employerText;
            if (!existingHasEmployer && employerText) byPlacement.set(key, r);
          }
        }
        const candidates = [];
        const clientAreasForCandidates = (await kv.get(CLIENT_AREAS_KEY)) || {};
        const areaVariantMapForCandidates = (await kv.get(AREA_VARIANT_MAP_KEY)) || {};
        for (const r of byPlacement.values()) {
          const placement = r.placementId ? placements[r.placementId] : null;
          const { areaText, employerText } = parseNote(r.notes);
          const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
          const resolvedArea = resolveAreaForDeal(areaText, clientAreasForCandidates[clientCompanyName], areaVariantMapForCandidates[clientCompanyName]).area;
          const resolvedEmployer = resolveEmployerForDeal(employerText, employers, employerVariantMap).employer;
          candidates.push({
            candidateName: placement.candidateName,
            client: clientCompanyName,
            area: resolvedArea,
            employer: resolvedEmployer,
            startDate: placement.startDate || null,
          });
        }
        return res.status(200).json({
          client: clientParam || "all",
          year: yearParam === "all" ? "all" : (yearParam ? parseInt(yearParam, 10) : currentYear),
          candidates,
        });
      }
    }

    // --- Area tracking reads — viewing is open to everyone logged in.
    // Editing (the POST actions further down) stays Super Admin only. ---
    if (req.query.action === "area-list" || req.query.action === "area-concentration" || req.query.action === "area-unmapped") {
      // Viewing is open to everyone logged in — only editing (the POST
      // actions below) stays Super Admin only.
      const user = await getUserFromRequest(req);
      if (!user) {
        return res.status(401).json({ error: "Login required" });
      }
      const clientAreas = (await kv.get(CLIENT_AREAS_KEY)) || {};

      if (req.query.action === "area-list") {
        const client = req.query.client;
        if (client) return res.status(200).json({ client, areas: clientAreas[client] || [] });
        // No client specified — return every client that either already
        // has an area list OR has at least one genuine placement, so a
        // client can be picked and started fresh even before its first
        // area is ever added (otherwise it could never appear at all).
        // Optional year param: if given (and not "all"), only clients with
        // a genuine placement IN THAT YEAR specifically appear — so the
        // client list reflects whichever year is currently selected,
        // rather than every client that's ever had a placement at all.
        const placements = (await kv.get(PLACEMENTS_KEY)) || {};
        const records = (await kv.get(RECORDS_KEY)) || [];
        const yearParam = req.query.year;
        const allAreas = { ...clientAreas };
        const clientsWithPlacementsThisScope = new Set();
        for (const r of records) {
          const placement = r.placementId ? placements[r.placementId] : null;
          const hasPlacementName = !!(placement && placement.candidateName);
          if (!hasPlacementName) continue;
          if (yearParam && yearParam !== "all" && effectiveYear(r, placements) !== parseInt(yearParam, 10)) continue;
          const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
          if (clientCompanyName) clientsWithPlacementsThisScope.add(clientCompanyName);
        }
        if (yearParam && yearParam !== "all") {
          // Year-scoped: only clients with a genuine placement in THAT year.
          const scopedAreas = {};
          for (const c of clientsWithPlacementsThisScope) scopedAreas[c] = allAreas[c] || [];
          return res.status(200).json({ areas: scopedAreas });
        }
        // No year param, or "all": every client ever, same as before.
        for (const c of clientsWithPlacementsThisScope) {
          if (!allAreas[c]) allAreas[c] = [];
        }
        return res.status(200).json({ areas: allAreas });
      }

      const client = req.query.client;
      if (!client) return res.status(400).json({ error: "client query param is required" });
      const variantMap = (await kv.get(AREA_VARIANT_MAP_KEY)) || {};
      const records = (await kv.get(RECORDS_KEY)) || [];
      const allRates = (await kv.get(FX_KEY)) || {};
      const placements = (await kv.get(PLACEMENTS_KEY)) || {};
      const areasForClient = clientAreas[client] || [];
      const variantMapForClient = variantMap[client] || {};

      // Genuine placements for this client only — onsite fees never get an
      // area at all, per spec.
      const clientPlacementRecords = records.filter((r) => {
        const placement = r.placementId ? placements[r.placementId] : null;
        const hasPlacementName = !!(placement && placement.candidateName);
        if (!hasPlacementName) return false;
        const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
        return clientCompanyName === client;
      });

      if (req.query.action === "area-unmapped") {
        const unmappedTexts = new Set();
        for (const r of clientPlacementRecords) {
          const resolved = resolveAreaForDeal(parseNote(r.notes).areaText, areasForClient, variantMapForClient);
          if (resolved.source === "unmapped") unmappedTexts.add(resolved.rawText);
        }
        return res.status(200).json({ client, unmappedTexts: [...unmappedTexts] });
      }

      // area-concentration: per year, or "all" combining every year.
      const yearParam = req.query.year;
      const scopedRecords = yearParam === "all"
        ? clientPlacementRecords
        : clientPlacementRecords.filter((r) => effectiveYear(r, placements) === (yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear()));

      const byArea = {};
      let totalGBP = 0, totalDeals = 0, untaggedCount = 0, unmappedCount = 0;
      for (const r of scopedRecords) {
        const gbp = await convertToGBP(r, allRates);
        const resolved = resolveAreaForDeal(parseNote(r.notes).areaText, areasForClient, variantMapForClient);
        totalDeals += 1;
        if (gbp !== null) totalGBP += gbp;
        if (resolved.source === "none") {
          untaggedCount += 1;
        } else if (resolved.source === "unmapped") {
          unmappedCount += 1;
        } else {
          if (!byArea[resolved.area]) byArea[resolved.area] = { area: resolved.area, gbp: 0, deals: 0 };
          byArea[resolved.area].deals += 1;
          if (gbp !== null) byArea[resolved.area].gbp += gbp;
        }
      }
      return res.status(200).json({
        client,
        year: yearParam === "all" ? "all" : (yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear()),
        totalGBP,
        totalDeals,
        untaggedCount,
        unmappedCount,
        byArea: Object.values(byArea).sort((a, b) => b.gbp - a.gbp),
      });
    }

    const records = (await kv.get(RECORDS_KEY)) || [];
    const allRates = (await kv.get(FX_KEY)) || {};
    const placements = (await kv.get(PLACEMENTS_KEY)) || {};
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
    // Shared by both the detail (Super Admin) and public branches below —
    // parses dates as real Date objects and compares timestamps, so it
    // can't be thrown off by inconsistent date formatting (e.g.
    // "2026-3-5" vs "2026-03-05" would compare wrong as raw strings but
    // correctly once parsed).
    const todayTs = Date.now();
    function hasPassedIfSet(dateStr) {
      if (!dateStr) return false;
      const ts = new Date(dateStr).getTime();
      return !isNaN(ts) && ts <= todayTs;
    }

    // Super Admin only: full detail view, including unconverted deals
    // (missing an FX rate for their month) so they know a rate needs setting.
    if (req.query.detail === "true") {
      const user = await getUserFromRequest(req);
      if (!user || !user.isSuperAdmin) {
        return res.status(401).json({ error: "Super Admin access required" });
      }
      const clientAreas = (await kv.get(CLIENT_AREAS_KEY)) || {};
      const variantMap = (await kv.get(AREA_VARIANT_MAP_KEY)) || {};
      const yearRecords = records
        .filter((r) => effectiveYear(r, placements) === year)
        .sort((a, b) => orderDateOf(a, placements).localeCompare(orderDateOf(b, placements)));
      const withUSD = await Promise.all(
        yearRecords.map(async (r) => {
          const placement = r.placementId ? placements[r.placementId] : null;
          const hasPlacementName = !!(placement && placement.candidateName);
          const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
          // An onsite fee never gets an area at all, per spec — only
          // resolved for genuine placements.
          const resolvedArea = hasPlacementName
            ? resolveAreaForDeal(parseNote(r.notes).areaText, clientAreas[clientCompanyName], variantMap[clientCompanyName]).area
            : null;
          return {
            ...r,
            usdAmount: await convertToUSD(r, allRates),
            gbpAmount: await convertToGBP(r, allRates),
            candidateName: (placement && placement.candidateName) || r.notes || null,
            hasPlacementName,
            clientCompanyName,
            placementStartDate: (placement && placement.startDate) || r.feeDate || null,
            monthOverrides: r.monthOverrides || {},
            coordinatorId: r.coordinatorId || null,
            source: r.source || null,
            resolvedArea,
          };
        })
      );

      // Firm/Client breakdown — Super Admin only. Uses the Client field
      // captured from Atlas's placement webhook. Deals with no linked
      // placement yet (or from an unmapped owner) fall into "Unknown" so
      // the percentages still add up to the full total. GBP is tracked
      // alongside USD the same way it already is on individual deal rows —
      // a deal missing its GBP rate for the month simply doesn't add to
      // totalGBP (silently understating it slightly until that rate is
      // set), same "never guess" behavior as usdAmount already has.
      const byClient = {};
      let clientGrandTotal = 0;
      for (const r of withUSD) {
        if (r.usdAmount === null || !r.consultantId) continue;
        const firm = r.clientCompanyName || "Unknown";
        if (!byClient[firm]) byClient[firm] = { firm, totalUSD: 0, totalGBP: 0, deals: 0, onsites: 0 };
        byClient[firm].totalUSD += r.usdAmount;
        if (r.gbpAmount !== null) byClient[firm].totalGBP += r.gbpAmount;
        // Deals and onsites are two SEPARATE, non-overlapping counts, not
        // one nested inside the other — "deals" means genuine placements
        // only (a real candidateName), "onsites" means onsite-fee-type
        // records. Revenue (USD/GBP above) still includes both, since
        // onsite fees are real revenue — only the COUNT semantics split.
        if (r.hasPlacementName) byClient[firm].deals += 1;
        else byClient[firm].onsites += 1;
        clientGrandTotal += r.usdAmount;
      }
      const clientBreakdown = Object.values(byClient)
        .map((c) => ({ ...c, percentage: clientGrandTotal > 0 ? (c.totalUSD / clientGrandTotal) * 100 : 0 }))
        .sort((a, b) => b.totalUSD - a.totalUSD);

      return res.status(200).json({ year, records: withUSD, clientBreakdown, clientGrandTotal });
    }

    // Public leaderboard: totals per consultant, in USD, for the given year.
    // Deals missing an FX rate for their month are silently excluded from
    // the total (rather than guessing) — they'll appear once Scott/Lee set
    // that month's rate.
    const yearRecords = records.filter((r) => effectiveYear(r, placements) === year && r.consultantId);
    const totals = {};
    const bySource = {};
    let yearTotalUSD = 0;
    const starters = { usd: 0, gbp: 0, deals: 0, onsites: 0 };
    // Scott and Lee's own deals count toward Source and Client Breakdown
    // (so those totals reflect everything, not just the tracked consultants)
    // but they're deliberately left off the individual leaderboard ranking —
    // that's meant to be the consultants' own competition, not theirs.
    const EXCLUDED_FROM_LEADERBOARD = new Set(["scott-finn", "lee-mamo"]);
    for (const r of yearRecords) {
      const usd = await convertToUSD(r, allRates);
      if (usd === null) continue;
      const placement = r.placementId ? placements[r.placementId] : null;
      const hasPlacementName = !!(placement && placement.candidateName);
      if (!EXCLUDED_FROM_LEADERBOARD.has(r.consultantId)) {
        if (!totals[r.consultantId]) {
          totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalUSD: 0, totalGBP: 0, deals: 0, onsites: 0 };
        }
        totals[r.consultantId].totalUSD += usd;
        const gbpForLeaderboard = await convertToGBP(r, allRates);
        if (gbpForLeaderboard !== null) totals[r.consultantId].totalGBP += gbpForLeaderboard;
        // Same separation as byClient/bySource: deals = genuine placements
        // only, onsites = onsite-fee-type records, never both at once.
        if (hasPlacementName) totals[r.consultantId].deals += 1;
        else totals[r.consultantId].onsites += 1;
      }

      // Source breakdown — visible to everyone, same as the leaderboard.
      // Deals without a source set yet just aren't counted here (rather
      // than guessing), so this total may be a bit less than the full
      // leaderboard total until every deal has a source recorded. GBP is
      // tracked the same "never guess, just may understate slightly until
      // the rate is set" way as usdAmount already is everywhere else.
      // Onsites uses the same genuine-placement-vs-onsite-fee distinction
      // as commission.js's own Placements-vs-Onsite-Fees split (Pillar 4):
      // a record only counts as a genuine placement if it links to a real
      // candidate name; everything else is an onsite-fee-type record.
      const gbp = await convertToGBP(r, allRates);
      if (r.source) {
        if (!bySource[r.source]) bySource[r.source] = { source: r.source, deals: 0, onsites: 0, valueUSD: 0, valueGBP: 0 };
        if (hasPlacementName) bySource[r.source].deals += 1;
        else bySource[r.source].onsites += 1;
        bySource[r.source].valueUSD += usd;
        if (gbp !== null) bySource[r.source].valueGBP += gbp;
      }

      // "Revenue on starters" — visible to everyone. This is a REVENUE
      // total (deliberately broader than the "Deals" definition used
      // elsewhere), so it includes both genuine placements AND onsite
      // fees. What "started" means differs by type: a genuine placement
      // uses its REAL start date (never falling back to feeDate — no
      // confirmed start date means it hasn't started, full stop); an
      // onsite fee has no meaningful "start" event of its own, so it uses
      // feeDate ("Date Signed") instead. Live filter, not a stored value.
      yearTotalUSD += usd;
      let started;
      if (hasPlacementName) started = hasPassedIfSet(placement && placement.startDate);
      else started = hasPassedIfSet(r.feeDate);
      if (started) {
        starters.usd += usd;
        if (gbp !== null) starters.gbp += gbp;
        if (hasPlacementName) starters.deals += 1;
        else starters.onsites += 1;
      }
    }
    const leaderboardGrandTotalUSD = Object.values(totals).reduce((s, r) => s + r.totalUSD, 0);
    const leaderboard = Object.values(totals)
      .map((t) => ({ ...t, percentage: leaderboardGrandTotalUSD > 0 ? (t.totalUSD / leaderboardGrandTotalUSD) * 100 : 0 }))
      .sort((a, b) => b.totalUSD - a.totalUSD);
    const sourceGrandTotalUSD = Object.values(bySource).reduce((s, r) => s + r.valueUSD, 0);
    const sourceBreakdown = Object.values(bySource)
      .map((s) => ({ ...s, percentage: sourceGrandTotalUSD > 0 ? (s.valueUSD / sourceGrandTotalUSD) * 100 : 0 }))
      .sort((a, b) => b.valueUSD - a.valueUSD);
    starters.percentage = yearTotalUSD > 0 ? (starters.usd / yearTotalUSD) * 100 : 0;
    return res.status(200).json({ year, leaderboard, sourceBreakdown, starters });
  }

  if (req.method === "POST") {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Not authorized" });

    // --- Employer management writes (Super Admin only) — global list,
    // never scoped to a client, unlike areas. ---
    if (["employer-add", "employer-rename", "employer-confirm-mapping"].includes(req.query.action)) {
      if (!user.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

      if (req.query.action === "employer-add") {
        const { employer } = req.body || {};
        if (!employer) return res.status(400).json({ error: "employer is required" });
        const employers = (await kv.get(EMPLOYERS_LIST_KEY)) || [];
        const alreadyExists = employers.some((e) => normalizeAreaKey(e) === normalizeAreaKey(employer));
        if (!alreadyExists) employers.push(employer);
        await kv.set(EMPLOYERS_LIST_KEY, employers);
        return res.status(200).json({ ok: true, employers });
      }

      if (req.query.action === "employer-rename") {
        const { oldName, newName } = req.body || {};
        if (!oldName || !newName) return res.status(400).json({ error: "oldName and newName are required" });
        const employers = (await kv.get(EMPLOYERS_LIST_KEY)) || [];
        const employerVariantMap = (await kv.get(EMPLOYER_VARIANT_MAP_KEY)) || {};
        const newNameAlreadyExists = employers.some((e) => normalizeAreaKey(e) === normalizeAreaKey(newName));
        const updatedEmployers = employers.filter((e) => normalizeAreaKey(e) !== normalizeAreaKey(oldName));
        if (!newNameAlreadyExists) updatedEmployers.push(newName);
        for (const key of Object.keys(employerVariantMap)) {
          if (employerVariantMap[key] === oldName) employerVariantMap[key] = newName;
        }
        await kv.set(EMPLOYERS_LIST_KEY, updatedEmployers);
        await kv.set(EMPLOYER_VARIANT_MAP_KEY, employerVariantMap);
        return res.status(200).json({ ok: true, employers: updatedEmployers });
      }

      if (req.query.action === "employer-confirm-mapping") {
        const { rawText, canonicalEmployer } = req.body || {};
        if (!rawText || !canonicalEmployer) return res.status(400).json({ error: "rawText and canonicalEmployer are required" });
        const employerVariantMap = (await kv.get(EMPLOYER_VARIANT_MAP_KEY)) || {};
        employerVariantMap[normalizeAreaKey(rawText)] = canonicalEmployer;
        await kv.set(EMPLOYER_VARIANT_MAP_KEY, employerVariantMap);
        return res.status(200).json({ ok: true });
      }
    }

    // --- Area tracking writes (Super Admin only) ---
    if (["area-add", "area-remove", "area-rename", "area-confirm-mapping"].includes(req.query.action)) {
      if (!user.isSuperAdmin) return res.status(401).json({ error: "Super Admin access required" });

      if (req.query.action === "area-add") {
        const { client, area } = req.body || {};
        if (!client || !area) return res.status(400).json({ error: "client and area are required" });
        const clientAreas = (await kv.get(CLIENT_AREAS_KEY)) || {};
        if (!clientAreas[client]) clientAreas[client] = [];
        // Compare normalized, not exact — two differently-cased entries
        // that normalize the same would make resolveAreaForDeal's exact
        // match silently pick whichever came first in the list.
        const alreadyExists = clientAreas[client].some((a) => normalizeAreaKey(a) === normalizeAreaKey(area));
        if (!alreadyExists) clientAreas[client].push(area);
        await kv.set(CLIENT_AREAS_KEY, clientAreas);
        return res.status(200).json({ ok: true, areas: clientAreas[client] });
      }

      if (req.query.action === "area-remove") {
        const { client, area } = req.body || {};
        if (!client || !area) return res.status(400).json({ error: "client and area are required" });
        const clientAreas = (await kv.get(CLIENT_AREAS_KEY)) || {};
        clientAreas[client] = (clientAreas[client] || []).filter((a) => normalizeAreaKey(a) !== normalizeAreaKey(area));
        await kv.set(CLIENT_AREAS_KEY, clientAreas);
        return res.status(200).json({ ok: true, areas: clientAreas[client] });
      }

      if (req.query.action === "area-rename") {
        const { client, oldName, newName } = req.body || {};
        if (!client || !oldName || !newName) return res.status(400).json({ error: "client, oldName, and newName are required" });
        const clientAreas = (await kv.get(CLIENT_AREAS_KEY)) || {};
        const variantMap = (await kv.get(AREA_VARIANT_MAP_KEY)) || {};
        const list = clientAreas[client] || [];
        const newNameAlreadyExists = list.some((a) => normalizeAreaKey(a) === normalizeAreaKey(newName));
        // Remove the old name; only add the new one if it isn't already
        // there (merge, don't duplicate).
        clientAreas[client] = list.filter((a) => normalizeAreaKey(a) !== normalizeAreaKey(oldName));
        if (!newNameAlreadyExists) clientAreas[client].push(newName);
        // Rewrite any variant-map entries that pointed at the old name so
        // they point at the new one instead — otherwise deals resolved via
        // a confirmed mapping would silently keep showing the retired name.
        if (variantMap[client]) {
          for (const key of Object.keys(variantMap[client])) {
            if (variantMap[client][key] === oldName) variantMap[client][key] = newName;
          }
        }
        await kv.set(CLIENT_AREAS_KEY, clientAreas);
        await kv.set(AREA_VARIANT_MAP_KEY, variantMap);
        return res.status(200).json({ ok: true, areas: clientAreas[client] });
      }

      if (req.query.action === "area-confirm-mapping") {
        const { client, rawText, canonicalArea } = req.body || {};
        if (!client || !rawText || !canonicalArea) return res.status(400).json({ error: "client, rawText, and canonicalArea are required" });
        const variantMap = (await kv.get(AREA_VARIANT_MAP_KEY)) || {};
        if (!variantMap[client]) variantMap[client] = {};
        variantMap[client][normalizeAreaKey(rawText)] = canonicalArea;
        await kv.set(AREA_VARIANT_MAP_KEY, variantMap);
        return res.status(200).json({ ok: true });
      }
    }

    const { feeId, splitId, paid, paidDate, monthOverrides, source, coordinatorId, recalibrateToMonth } = req.body || {};
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Paid, paidDate, monthOverrides, coordinatorId, and recalibrateToMonth
    // are financial/admin decisions — Super Admin only. Source is just
    // "how did this deal come in", which the consultant themselves can
    // also set on their own deals.
    const changingRestrictedFields =
      paid !== undefined || paidDate !== undefined || monthOverrides !== undefined ||
      coordinatorId !== undefined || recalibrateToMonth !== undefined;
    if (changingRestrictedFields && !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    if (source !== undefined && !user.isSuperAdmin && user.consultantId !== records[idx].consultantId) {
      return res.status(401).json({ error: "You can only set the source on your own deals" });
    }

    if (paid !== undefined) {
      records[idx].paid = !!paid;
      if (!paid) {
        records[idx].paidMarkedAt = null;
      } else if (!records[idx].paidMarkedAt) {
        // Only default to "right now" the first time it's marked Paid —
        // if it's already paid and just the date is being edited (see
        // paidDate below), this won't stomp on that.
        records[idx].paidMarkedAt = new Date().toISOString();
      }
    }
    // A separate, explicit date lets Scott/Lee backfill deals that were
    // genuinely paid months ago, so the 4-month clock starts from the real
    // payment date rather than from whenever they happened to tick the box.
    if (paidDate !== undefined && records[idx].paid) {
      const d = new Date(paidDate);
      if (!isNaN(d.getTime())) records[idx].paidMarkedAt = d.toISOString();
    }
    // Marking a specific month "Due" from the Commission page doesn't set
    // a sticky flag — it corrects paidMarkedAt itself, so that month
    // naturally computes as due THIS real month, and everything before
    // and after it keeps auto-advancing correctly forever with no further
    // manual upkeep. Clears any existing overrides since the whole row's
    // timeline has just been resynced to reality.
    if (recalibrateToMonth !== undefined) {
      const now = new Date();
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - recalibrateToMonth, 1));
      records[idx].paid = true;
      records[idx].paidMarkedAt = target.toISOString();
      records[idx].monthOverrides = {};
    }
    if (monthOverrides !== undefined) {
      records[idx].monthOverrides = (monthOverrides && typeof monthOverrides === "object") ? monthOverrides : {};
    }
    if (source !== undefined) {
      records[idx].source = source || null;
    }
    if (coordinatorId !== undefined) {
      records[idx].coordinatorId = coordinatorId || null;
    }

    await kv.set(RECORDS_KEY, records);
    return res.status(200).json({ ok: true, record: records[idx] });
  }

  if (req.method === "DELETE") {
    // Super Admin only. Removes the record entirely — since commission and
    // the leaderboard are both calculated live from this data, the deleted
    // deal disappears from that person's commission sheet and the Deal Lead
    // Award total the moment it's gone, with nothing else to update.
    const user = await getUserFromRequest(req);
    if (!user || !user.isSuperAdmin) {
      return res.status(401).json({ error: "Super Admin access required" });
    }
    const { feeId, splitId } = req.body || {};
    if (!feeId || !splitId) {
      return res.status(400).json({ error: "feeId and splitId are required" });
    }
    const records = (await kv.get(RECORDS_KEY)) || [];
    const idx = records.findIndex((r) => r.feeId === feeId && r.splitId === splitId);
    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }
    records.splice(idx, 1);
    await kv.set(RECORDS_KEY, records);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
