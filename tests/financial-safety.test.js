// Financial safety regression tests.
//
// These exist because two things in this codebase can never be allowed to
// quietly break, no matter who edits commission.js, deals.js, league.js, or
// team-lead-bonus.js in the future:
//
//   1. Natasha Barnard's Citadel commission uplift must apply ONLY inside
//      her own commission.js compute -- never on deals.js (Yearly Deal
//      Table) or team-lead-bonus.js (Development Bonus milestones).
//   2. James Lancer's / Josh Stark's own personal Atlas activity
//      (leadRows) must never leak into Team Lead Bonus's Pillar 1/2 team
//      volume figures (which only ever read rows).
//
// This file is wired into .github/workflows/financial-safety.yml, which
// runs it automatically on every push/PR touching those four files. It
// does not depend on anyone remembering to run it by hand.
//
// Run it yourself any time with: node tests/financial-safety.test.js

process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "test-secret";
const jwt = require("jsonwebtoken");
const path = require("path");

const commission = require(path.join(__dirname, "..", "api", "commission.js"));
const dealsHandler = require(path.join(__dirname, "..", "api", "deals.js"));
const teamLeadBonus = require(path.join(__dirname, "..", "api", "team-lead-bonus.js"));

let failures = 0;

function makeRes() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}${detail ? " -- " + detail : ""}`);
    failures++;
  }
}

async function testNatashaUpliftIsolation() {
  console.log("\n--- Natasha Barnard / Citadel uplift isolation ---");
  global.__fakeStore = {};
  global.__fakeStore["auth-users"] = {
    "natasha@reloadsearch.com": { consultantId: "natasha-barnard", name: "Natasha Barnard", isAdmin: false, isSuperAdmin: false },
    "alex@reloadsearch.com": { consultantId: "alex-aparo", name: "Alex Aparo", isAdmin: false, isSuperAdmin: false },
    "josh@reloadsearch.com": { consultantId: null, name: "Josh Stark", isAdmin: true, isSuperAdmin: false },
    "scott@reloadsearch.com": { consultantId: null, name: "Scott Finn", isAdmin: true, isSuperAdmin: true },
  };

  // Sized so 1.2x lands exactly on the $250k Development Bonus threshold --
  // if the uplift ever leaked into team-lead-bonus.js, this would trip it.
  const DEAL_AMOUNT = 208333.33;
  global.__fakeStore["atlas-fee-records"] = [
    {
      feeId: "fee-test-1", splitId: "split-1", feeDate: "2026-03-01", currency: "USD",
      totalAmount: DEAL_AMOUNT, shareAmount: DEAL_AMOUNT, consultantId: "natasha-barnard",
      consultantName: "Natasha Barnard", placementId: "placement-1", notes: null,
      projectClientName: "Citadel Securities", paid: false, paidMarkedAt: null,
      monthOverrides: {}, source: "atlas", coordinatorId: null,
    },
  ];
  global.__fakeStore["atlas-placements"] = {
    "placement-1": { candidateName: "Test Candidate", clientCompanyName: "Citadel Securities", startDate: "2026-03-01" },
  };
  global.__fakeStore["atlas-fx-rates"] = { "2026-03": { GBP: 1.27 } };
  global.__fakeStore["commission-settings"] = {};

  // Her own compute: should show the uplifted ~$250,000.
  const natashaToken = jwt.sign({ email: "natasha@reloadsearch.com" }, process.env.AUTH_JWT_SECRET);
  const res1 = makeRes();
  await commission({ method: "GET", query: { action: "compute", consultantId: "natasha-barnard", year: "2026" }, headers: { authorization: `Bearer ${natashaToken}` } }, res1);
  const lines = (res1.body && res1.body.lines) || [];
  const totalUsd = lines.reduce((s, l) => s + l.usdAmount, 0);
  check("her own commission.js compute totals ~$250,000 (uplift applied)", Math.abs(totalUsd - 250000) < 0.01, `got ${totalUsd}`);

  // deals.js: should show the TRUE unmodified figure.
  const scottToken = jwt.sign({ email: "scott@reloadsearch.com" }, process.env.AUTH_JWT_SECRET);
  const res2 = makeRes();
  await dealsHandler({ method: "GET", query: { detail: "true", year: "2026" }, headers: { authorization: `Bearer ${scottToken}` } }, res2);
  const dealRecord = res2.body && res2.body.records && res2.body.records.find((r) => r.feeId === "fee-test-1");
  check("deals.js (Yearly Deal Table) shows true unmodified $208,333.33", dealRecord && Math.abs(dealRecord.usdAmount - DEAL_AMOUNT) < 0.01, `got ${dealRecord && dealRecord.usdAmount}`);

  // team-lead-bonus.js: Development Bonus should show ZERO milestone crossings.
  const res3 = makeRes();
  await teamLeadBonus({ method: "GET", query: { action: "compute", teamLeadId: "josh-stark", period: "H1-2026" }, headers: { authorization: `Bearer ${scottToken}` } }, res3);
  const crossings = res3.body && res3.body.developmentBonus && res3.body.developmentBonus.milestoneCrossings;
  check("team-lead-bonus.js Development Bonus shows zero milestone crossings for this deal", Array.isArray(crossings) && crossings.length === 0, `got ${JSON.stringify(crossings)}`);

  // Access control: only Natasha or a Super Admin can view her compute.
  const res4 = makeRes();
  const alexToken = jwt.sign({ email: "alex@reloadsearch.com" }, process.env.AUTH_JWT_SECRET);
  await commission({ method: "GET", query: { action: "compute", consultantId: "natasha-barnard", year: "2026" }, headers: { authorization: `Bearer ${alexToken}` } }, res4);
  check("another consultant cannot view Natasha's commission compute", res4.statusCode === 401, `got status ${res4.statusCode}`);

  const res5 = makeRes();
  const joshToken = jwt.sign({ email: "josh@reloadsearch.com" }, process.env.AUTH_JWT_SECRET);
  await commission({ method: "GET", query: { action: "compute", consultantId: "natasha-barnard", year: "2026" }, headers: { authorization: `Bearer ${joshToken}` } }, res5);
  check("a team lead admin (not Super Admin) cannot view Natasha's commission compute", res5.statusCode === 401, `got status ${res5.statusCode}`);
}

async function testLeadRowsIsolation() {
  console.log("\n--- James Lancer / Josh Stark leadRows isolation ---");
  global.__fakeStore = {};
  global.__fakeStore["auth-users"] = {
    "scott@reloadsearch.com": { consultantId: null, name: "Scott Finn", isAdmin: true, isSuperAdmin: true },
  };

  // James has a deliberately huge, obvious personal number in leadRows.
  // Real Team James members have small, normal activity in rows.
  global.__fakeStore["reload-league-weeks"] = [
    {
      id: "auto-2026-W07", date: "2026-02-15", metric: "cvsOut", threshold: null,
      rows: {
        "alex-silverman": { cvs: 10, interviews: 3, onsite: 1, offers: 0, team: "james", metricValue: 10, excluded: false },
        "ash-thiara": { cvs: 8, interviews: 2, onsite: 0, offers: 0, team: "james", metricValue: 8, excluded: false },
        "jack-thompson": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "james", metricValue: 0, excluded: false },
        "max-hart": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "james", metricValue: 0, excluded: false },
        "oleg-sokyrka": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "james", metricValue: 0, excluded: false },
        "alex-aparo": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh", metricValue: 0, excluded: false },
        "jack-routledge": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh", metricValue: 0, excluded: false },
        "joe-purton": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh", metricValue: 0, excluded: false },
        "josh-davis": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh", metricValue: 0, excluded: false },
        "natasha-barnard": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh", metricValue: 0, excluded: false },
      },
      leadRows: {
        "james-lancer": { cvs: 50, interviews: 20, onsite: 5, offers: 2, team: "james" },
        "josh-stark": { cvs: 0, interviews: 0, onsite: 0, offers: 0, team: "josh" },
      },
      autoFinalized: true,
    },
  ];
  global.__fakeStore["atlas-fee-records"] = [];
  global.__fakeStore["atlas-placements"] = {};
  global.__fakeStore["consultant-teams"] = {};
  global.__fakeStore["atlas-fx-rates"] = {};
  global.__fakeStore["team-lead-bonus-records"] = {};

  const token = jwt.sign({ email: "scott@reloadsearch.com" }, process.env.AUTH_JWT_SECRET);
  const res = makeRes();
  await teamLeadBonus({ method: "GET", query: { action: "compute", teamLeadId: "james-lancer", period: "H1-2026" }, headers: { authorization: `Bearer ${token}` } }, res);

  const feb = res.body && res.body.monthlyBreakdown && res.body.monthlyBreakdown.find((m) => m.month === "2026-02");
  check("team CVs for Feb 2026 is 18 (10+8), not inflated by James's 50", feb && feb.cvs === 18, `got ${feb && feb.cvs}`);
  check("team interviews for Feb 2026 is 5 (3+2), not inflated by James's 20", feb && feb.interviews === 5, `got ${feb && feb.interviews}`);
}

async function main() {
  await testNatashaUpliftIsolation();
  await testLeadRowsIsolation();

  console.log("\n===================================");
  if (failures > 0) {
    console.log(`${failures} CHECK(S) FAILED. Do not deploy until fixed.`);
    process.exit(1);
  } else {
    console.log("ALL CHECKS PASSED.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("TEST SCRIPT CRASHED:", e);
  process.exit(1);
});
