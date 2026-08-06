// Standard commission ladder — the default for everyone. Individual
// consultants (e.g. Josh Stark) can have this fully overridden in
// commission-settings, band-for-band.
const STANDARD_BANDS = [
  { min: 0, max: 150000, rate: 0.10 },
  { min: 150000, max: 300000, rate: 0.125 },
  { min: 300000, max: 450000, rate: 0.15 },
  { min: 450000, max: 600000, rate: 0.175 },
  { min: 600000, max: 750000, rate: 0.20 },
  { min: 750000, max: 900000, rate: 0.225 },
  { min: 900000, max: 1000000, rate: 0.25 },
  { min: 1000000, max: null, rate: 0.30 }, // null = uncapped
];

// Walks a consultant's GBP-converted, non-excluded deals for a year — in
// order — through their band ladder, cumulatively. A deal that crosses a
// band boundary splits into two (or more) commission lines, each taxed at
// its own band's rate, exactly like a progressive tax calculation.
//
// `deals` must already be sorted into the order they should count (by
// placement start date, falling back to fee date) and each entry needs:
//   { feeId, splitId, gbpAmount, feeDate, paid, paidMarkedAt, source }
function computeCommissionLines(deals, bands) {
  const sortedBands = [...bands].sort((a, b) => a.min - b.min);
  let cumulative = 0;
  const lines = [];

  for (const deal of deals) {
    let remaining = deal.gbpAmount;
    if (remaining === null || remaining === undefined || isNaN(remaining)) continue;

    while (remaining > 0.005) {
      const band = sortedBands.find(
        (b) => cumulative >= b.min && (b.max === null || cumulative < b.max)
      );
      if (!band) break; // shouldn't happen if the ladder is uncapped at the top

      const spaceInBand = band.max === null ? Infinity : band.max - cumulative;
      const portion = Math.min(remaining, spaceInBand);
      const commission = portion * band.rate;

      lines.push({
        feeId: deal.feeId,
        splitId: deal.splitId,
        feeDate: deal.feeDate,
        gbpPortion: portion,
        rate: band.rate,
        bandMin: band.min,
        bandMax: band.max,
        commission,
        paid: deal.paid,
        paidMarkedAt: deal.paidMarkedAt,
        source: deal.source || null,
        candidateName: deal.candidateName || null,
        monthOverrides: deal.monthOverrides || {},
      });

      cumulative += portion;
      remaining -= portion;
    }
  }

  const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);
  return { lines, totalGBP: cumulative, totalCommission };
}

// Splits a commission line's payout into 4 equal monthly instalments,
// starting the month AFTER the deal was marked Paid. A month's status is
// worked out automatically from real dates by default, but Scott/Lee can
// manually override any single month to Paid/Due/Withheld — useful when
// backfilling deals that were actually paid months ago, or any other
// one-off correction — without ever changing the commission total itself.
//
//   "future"   — hasn't happened yet (or the deal isn't marked Paid yet)
//   "due"      — this is the current real calendar month, expected now
//   "paid"     — an earlier month that's passed
//   "withheld" — marked as a fine/withhold for this specific instalment
//
// Manually marking a month "Due" is treated as "this is genuinely being
// paid right now" — so that month's own label snaps to today's real
// calendar month (rather than whatever the original fixed schedule
// predicted), and any later still-"Auto" months shift forward in step,
// staying sequential after the corrected point rather than drifting out
// of sync with reality.
function payoutSchedule(line) {
  const perMonth = line.commission / 4;
  const overrides = line.monthOverrides || {};

  if (!line.paid || !line.paidMarkedAt) {
    return [1, 2, 3, 4].map((n) => ({
      label: `Month ${n}`,
      monthNumber: n,
      amount: perMonth,
      paidDate: null,
      status: overrides[n] || "future",
    }));
  }

  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  // Anchor = the highest-numbered month manually marked "due". Everything
  // from that point onward re-bases off "today" instead of the original
  // fixed paidMarkedAt math.
  let anchorIndex = null;
  for (let i = 1; i <= 4; i++) {
    if (overrides[i] === "due") anchorIndex = i;
  }

  const months = [];
  for (let i = 1; i <= 4; i++) {
    let d;
    if (anchorIndex && i >= anchorIndex) {
      const offset = i - anchorIndex;
      d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    } else {
      d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    }
    const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

    let status;
    if (overrides[i]) status = overrides[i];
    else if (anchorIndex && i > anchorIndex) status = "future"; // shifted-forward auto months aren't due yet
    else if (d.getTime() < currentMonthStart) status = "paid";
    else if (d.getTime() === currentMonthStart) status = "due";
    else status = "future";

    months.push({ label, monthNumber: i, amount: perMonth, paidDate: d.toISOString(), status });
  }
  return months;
}

// Coordinators get their whole flat fee in ONE lump sum, the month after
// the deal is marked Paid — not spread over 4 months like consultants.
// Same status logic (auto paid/due/future, with manual override support).
function singleMonthPayout(line) {
  const overrides = line.monthOverrides || {};

  if (!line.paid || !line.paidMarkedAt) {
    return [{
      label: "Month 1",
      monthNumber: 1,
      amount: line.commission,
      paidDate: null,
      status: overrides[1] || "future",
    }];
  }

  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  let status;
  if (overrides[1]) status = overrides[1];
  else if (d.getTime() < currentMonthStart) status = "paid";
  else if (d.getTime() === currentMonthStart) status = "due";
  else status = "future";

  return [{ label, monthNumber: 1, amount: line.commission, paidDate: d.toISOString(), status }];
}

module.exports = { STANDARD_BANDS, computeCommissionLines, payoutSchedule, singleMonthPayout };
