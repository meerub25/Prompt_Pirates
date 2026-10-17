const crypto = require('node:crypto');
const { pool } = require('../db');
const { loadScore } = require('./score-reader');

function tiePoints(result, teamId, points) {
  if (result.winner_team_id === teamId) return points.win;
  if (result.outcome === 'draw') return points.draw;
  return points.loss;
}

function teamSide(result, teamId) {
  if (result.home.team_id === teamId) return { own: result.home, other: result.away };
  return { own: result.away, other: result.home };
}

function lotsKey(seed, leagueId, teamId) {
  return crypto.createHash('sha256')
    .update(`${seed}|${leagueId}|${teamId}`, 'utf8')
    .digest('hex');
}

function compareNumberDescending(left, right) {
  return right - left;
}

function buildStandings(league, results, sportConfig) {
  const { league_id: leagueId, teams, points } = league;
  const teamStats = new Map(teams.map(teamId => [teamId, {
    team_id: teamId,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    scored: 0,
    conceded: 0,
    diff: 0,
    points: 0,
    fair_play: 0,
    status: 'still_possible',
    resolved_by: null,
    runs_scored: 0,
    overs_faced: 0,
    runs_conceded: 0,
    overs_bowled: 0
  }]));
  const h2h = Object.create(null);
  for (const teamId of teams) {
    h2h[teamId] = Object.create(null);
    for (const opponentId of teams) {
      if (opponentId !== teamId) {
        h2h[teamId][opponentId] = {
          played: 0,
          points: 0,
          scored: 0,
          conceded: 0
        };
      }
    }
  }

  const completed = results.filter(result =>
    result && result.status === 'completed' && result.outcome !== 'undecided'
  );
  for (const result of completed) {
    const home = teamStats.get(result.home.team_id);
    const away = teamStats.get(result.away.team_id);
    if (!home || !away) continue;
    const homeWon = result.winner_team_id === home.team_id;
    const awayWon = result.winner_team_id === away.team_id;
    home.played += 1;
    away.played += 1;
    if (homeWon) {
      home.won += 1;
      away.lost += 1;
    } else if (awayWon) {
      away.won += 1;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
    }

    home.points += tiePoints(result, home.team_id, points);
    away.points += tiePoints(result, away.team_id, points);
    home.fair_play += result.home.fair_play;
    away.fair_play += result.away.fair_play;
    home.scored += result.home.score;
    home.conceded += result.away.score;
    away.scored += result.away.score;
    away.conceded += result.home.score;

    const homeH2h = h2h[home.team_id][away.team_id];
    const awayH2h = h2h[away.team_id][home.team_id];
    homeH2h.played += 1;
    awayH2h.played += 1;
    homeH2h.points += tiePoints(result, home.team_id, points);
    awayH2h.points += tiePoints(result, away.team_id, points);
    homeH2h.scored += result.home.score;
    homeH2h.conceded += result.away.score;
    awayH2h.scored += result.away.score;
    awayH2h.conceded += result.home.score;

    if (sportConfig.scoring_model === 'innings') {
      const ballsPerOver = sportConfig.periods.balls_per_over;
      const oversFor = side =>
        side.wickets >= sportConfig.periods.innings_per_team *
          sportConfig.periods.wickets_per_innings
          ? sportConfig.periods.innings_per_team * sportConfig.periods.overs_per_innings
          : side.balls / ballsPerOver;
      home.runs_scored += result.home.score;
      home.runs_conceded += result.away.score;
      home.overs_faced += oversFor(result.home);
      home.overs_bowled += oversFor(result.away);
      away.runs_scored += result.away.score;
      away.runs_conceded += result.home.score;
      away.overs_faced += oversFor(result.away);
      away.overs_bowled += oversFor(result.home);
    }
  }

  for (const stat of teamStats.values()) {
    stat.diff = sportConfig.scoring_model === 'innings'
      ? Number((
          (stat.overs_faced ? stat.runs_scored / stat.overs_faced : 0) -
          (stat.overs_bowled ? stat.runs_conceded / stat.overs_bowled : 0)
        ).toFixed(3))
      : sportConfig.scoring_model === 'round'
        ? stat.scored - stat.conceded
        : stat.scored - stat.conceded;
  }

  const tieBreakOrder = [...(league.tie_break_order || sportConfig.tie_break_order || [])]
    .filter((criterion, index, order) => criterion !== 'draw_lots' || order.indexOf(criterion) === index);
  if (!tieBreakOrder.includes('draw_lots')) tieBreakOrder.push('draw_lots');
  const seed = league.lots_seed === undefined ? 42 : league.lots_seed;

  function valueFor(teamId, criterion, tiedIds) {
    const stat = teamStats.get(teamId);
    if (criterion === 'h2h_points' || criterion === 'h2h_diff') {
      let scored = 0;
      let conceded = 0;
      let earned = 0;
      let runsScored = 0;
      let runsConceded = 0;
      let oversFaced = 0;
      let oversBowled = 0;
      for (const opponentId of tiedIds) {
        if (opponentId === teamId) continue;
        const head = h2h[teamId][opponentId];
        earned += head.points;
        scored += head.scored;
        conceded += head.conceded;
        if (sportConfig.scoring_model === 'innings') {
          for (const result of completed) {
            if (
              [result.home.team_id, result.away.team_id].includes(teamId) &&
              [result.home.team_id, result.away.team_id].includes(opponentId)
            ) {
              const own = teamSide(result, teamId);
              const other = own.other;
              const overs = side =>
                side.wickets >= sportConfig.periods.innings_per_team *
                  sportConfig.periods.wickets_per_innings
                  ? sportConfig.periods.innings_per_team * sportConfig.periods.overs_per_innings
                  : side.balls / sportConfig.periods.balls_per_over;
              runsScored += own.own.score;
              runsConceded += other.score;
              oversFaced += overs(own.own);
              oversBowled += overs(other);
            }
          }
        }
      }
      if (criterion === 'h2h_points') return earned;
      return sportConfig.scoring_model === 'innings'
        ? (oversFaced ? runsScored / oversFaced : 0) -
          (oversBowled ? runsConceded / oversBowled : 0)
        : scored - conceded;
    }
    if (criterion === 'overall_diff') return stat.diff;
    if (criterion === 'scored') return stat.scored;
    if (criterion === 'fair_play') return stat.fair_play;
    if (criterion === 'draw_lots') return lotsKey(seed, leagueId, teamId);
    return 0;
  }

  function resolve(group) {
    if (group.length < 2) return group;
    for (const criterion of tieBreakOrder) {
      const groups = new Map();
      for (const teamId of group) {
        const value = valueFor(teamId, criterion, group);
        const key = String(value);
        if (!groups.has(key)) groups.set(key, { value, teams: [] });
        groups.get(key).teams.push(teamId);
      }
      if (groups.size === 1) continue;
      const ordered = [...groups.values()].sort((a, b) => {
        if (criterion === 'draw_lots') return a.value.localeCompare(b.value);
        return compareNumberDescending(a.value, b.value);
      });
      const output = [];
      for (const item of ordered) {
        if (item.teams.length < group.length) {
          for (const teamId of item.teams) teamStats.get(teamId).resolved_by = criterion;
        }
        output.push(...(item.teams.length > 1 ? resolve(item.teams) : item.teams));
      }
      return output;
    }
    return group;
  }

  const byPoints = new Map();
  for (const stat of teamStats.values()) {
    if (!byPoints.has(stat.points)) byPoints.set(stat.points, []);
    byPoints.get(stat.points).push(stat.team_id);
  }
  const orderedTeams = [];
  for (const [, ids] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
    orderedTeams.push(...(ids.length > 1 ? resolve(ids) : ids));
  }

  function remainingMatches(teamId) {
    return league.fixtures.reduce((count, fixture) => {
      const participates = fixture.home === teamId || fixture.away === teamId;
      const result = results.find(candidate => candidate && candidate.match_id === fixture.match_id);
      const unplayed = !result || result.status !== 'completed' || result.outcome === 'undecided';
      return count + (participates && unplayed ? 1 : 0);
    }, 0);
  }

  for (const teamId of teams) {
    const stat = teamStats.get(teamId);
    const maxPoints = stat.points + points.win * remainingMatches(teamId);
    const spots = league.qualification.spots;
    const otherTeams = [...teamStats.values()].filter(other => other.team_id !== teamId);
    if (
      otherTeams.filter(other =>
        other.points + points.win * remainingMatches(other.team_id) >= stat.points
      ).length < spots
    ) {
      stat.status = 'clinched';
    } else if (otherTeams.filter(other => other.points > maxPoints).length >= spots) {
      stat.status = 'eliminated';
    }
  }

  return {
    league_id: leagueId,
    sport_id: league.sport_id,
    qualification_spots: league.qualification.spots,
    table: orderedTeams.map((teamId, index) => {
      const stat = teamStats.get(teamId);
      return {
        rank: index + 1,
        team_id: teamId,
        played: stat.played,
        won: stat.won,
        drawn: stat.drawn,
        lost: stat.lost,
        scored: stat.scored,
        conceded: stat.conceded,
        diff: stat.diff,
        points: stat.points,
        fair_play: stat.fair_play,
        status: stat.status,
        resolved_by: stat.resolved_by
      };
    }),
    h2h
  };
}

async function loadStandings(leagueId, queryable = pool) {
  const leagueResult = await queryable.query(
    'SELECT config FROM leagues WHERE league_id = $1',
    [leagueId]
  );
  if (leagueResult.rowCount === 0) return null;
  const league = leagueResult.rows[0].config;
  const sportResult = await queryable.query(
    'SELECT config FROM sports WHERE sport_id = $1',
    [league.sport_id]
  );
  if (sportResult.rowCount === 0) return null;
  const matchResult = await queryable.query(
    'SELECT match_id FROM matches WHERE league_id = $1',
    [leagueId]
  );
  const results = await Promise.all(
    matchResult.rows.map(match => loadScore(match.match_id, queryable))
  );
  return buildStandings(league, results, sportResult.rows[0].config);
}

module.exports = { buildStandings, loadStandings };
