// Team move history: WHO was on WHICH team on a given date.
//
// Until this existed, a person's team was a single current value
// (consultant-teams in the database) with no date and no history, so moving
// someone retroactively moved ALL their past results to the new team's lead.
// This module records each move with an effective date and answers "which
// team was this person on then?" so results stay with the lead they were
// achieved under.
//
// Stored as { [consultantId]: [{ team, date }, ...] }, oldest first. Each entry
// means "from this date (inclusive) the person is on this team". There are
// only two teams, so before a person's FIRST recorded move they were on the
// OTHER team: a move necessarily changes team.
//
// A person with NO entries is deliberately not guessed at: callers fall back to
// exactly what they did before (current team / old weekly stamps), so nothing
// changes for anyone until their moves are recorded.
//
// Two different rules, both confirmed by Scott:
//   * By exact date (deals, development milestones): a result on or after the
//     move date belongs to the new team, before it to the old team.
//   * By month (pillars 1 to 3, which are worked out per month): a move on the
//     1st to the 15th means the OLD team keeps that whole month and the new team
//     starts the month after; a move from the 16th means the NEW team gets that
//     whole month. The 15th itself counts as "before".

const TEAM_HISTORY_KEY = "consultant-team-history";
const TEAM_IDS = ["james", "josh"];
const MONTH_RULE_LAST_OLD_TEAM_DAY = 15;

const otherTeam = (team) => (team === "james" ? "josh" : "james");

function isValidDateStr(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const monthKeyOf = (dateStr) => dateStr.slice(0, 7);

function nextMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// The first month the NEW team gets, for a move made on this date.
function effectiveMonthOfMove(dateStr) {
  const day = parseInt(dateStr.slice(8, 10), 10);
  const month = monthKeyOf(dateStr);
  return day <= MONTH_RULE_LAST_OLD_TEAM_DAY ? nextMonthKey(month) : month;
}

function entriesFor(history, consultantId) {
  const e = history && history[consultantId];
  return Array.isArray(e) ? e : [];
}

function hasHistory(history, consultantId) {
  return entriesFor(history, consultantId).length > 0;
}

function currentTeamFallback(consultantId, ctx) {
  return (ctx.overrides && ctx.overrides[consultantId]) || (ctx.defaults && ctx.defaults[consultantId]) || null;
}

// Which team on this exact date. ctx = { history, overrides, defaults }.
function teamOnDate(consultantId, dateStr, ctx) {
  const entries = entriesFor(ctx.history, consultantId);
  if (entries.length === 0) return currentTeamFallback(consultantId, ctx);
  let team = otherTeam(entries[0].team);
  for (const e of entries) {
    if (e.date <= dateStr) team = e.team;
    else break;
  }
  return team;
}

// Which team gets this whole month, under the 15th rule.
function teamForMonth(consultantId, monthKey, ctx) {
  const entries = entriesFor(ctx.history, consultantId);
  if (entries.length === 0) return currentTeamFallback(consultantId, ctx);
  let team = otherTeam(entries[0].team);
  for (const e of entries) {
    if (effectiveMonthOfMove(e.date) <= monthKey) team = e.team;
  }
  return team;
}

function latestTeam(history, consultantId) {
  const entries = entriesFor(history, consultantId);
  return entries.length ? entries[entries.length - 1].team : null;
}

// Adds (or replaces, if that date already has an entry) one move. Returns
// { history } with a NEW object, or { error }. `today` is "YYYY-MM-DD".
function applyMove(history, consultantId, team, date, today) {
  if (!TEAM_IDS.includes(team)) return { error: "team must be james or josh." };
  if (!isValidDateStr(date)) return { error: "The move date must be a real date, as YYYY-MM-DD." };
  if (date > today) return { error: "A move can't be dated in the future. Record it on the day it happens." };
  const existing = entriesFor(history, consultantId);
  const withoutSameDate = existing.filter((e) => e.date !== date);
  const next = [...withoutSameDate, { team, date }].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < next.length; i++) {
    if (next[i].team === next[i - 1].team) {
      return { error: `That would not be a move: they are already on that team at that point (${next[i - 1].date}).` };
    }
  }
  return { history: { ...(history || {}), [consultantId]: next } };
}

function removeMove(history, consultantId, date) {
  const existing = entriesFor(history, consultantId);
  const next = existing.filter((e) => e.date !== date);
  if (next.length === existing.length) return { error: "No recorded move on that date." };
  const out = { ...(history || {}) };
  if (next.length) out[consultantId] = next; else delete out[consultantId];
  return { history: out };
}

// People who have been moved (their current team differs from the roster
// default) but have no recorded move date. Their results are still counted
// under their current team, the old behaviour, until a date is recorded.
function unrecordedMoves(history, overrides, defaults, consultantIds) {
  return consultantIds.filter((id) => overrides && overrides[id] && overrides[id] !== defaults[id] && !hasHistory(history, id));
}

module.exports = {
  TEAM_HISTORY_KEY, TEAM_IDS, otherTeam, isValidDateStr, monthKeyOf, nextMonthKey, effectiveMonthOfMove,
  hasHistory, teamOnDate, teamForMonth, latestTeam, applyMove, removeMove, unrecordedMoves,
};
