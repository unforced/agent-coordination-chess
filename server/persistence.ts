import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  AgentProfile,
  MoveRecord,
  ArenaState,
} from "../shared/types.js";

// ── Database setup ───────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "chess.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_profiles (
    name TEXT PRIMARY KEY,
    personality_id TEXT NOT NULL,
    memory TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_memory_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    game_number INTEGER NOT NULL,
    memory TEXT NOT NULL,
    snapshot_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    game_number INTEGER PRIMARY KEY,
    game_id TEXT NOT NULL,
    white_agents TEXT NOT NULL,
    black_agents TEXT NOT NULL,
    winner TEXT,
    total_moves INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    moves_json TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS arena_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_games_played INTEGER NOT NULL DEFAULT 0,
    current_game_number INTEGER NOT NULL DEFAULT 0,
    current_game_id TEXT,
    status TEXT NOT NULL DEFAULT 'running'
  );

  CREATE TABLE IF NOT EXISTS postgame_messages (
    id TEXT PRIMARY KEY,
    game_number INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO arena_state (id, total_games_played, current_game_number, status)
  VALUES (1, 0, 0, 'running');
`);

// ── Prepared statements ──────────────────────────────────────────────

const stmts = {
  upsertProfile: db.prepare(`
    INSERT INTO agent_profiles (name, personality_id, memory, updated_at)
    VALUES (@name, @personalityId, @memory, @updatedAt)
    ON CONFLICT(name) DO UPDATE SET
      memory = @memory, updated_at = @updatedAt
  `),
  getProfile: db.prepare(`SELECT * FROM agent_profiles WHERE name = ?`),
  getAllProfiles: db.prepare(`SELECT * FROM agent_profiles ORDER BY name`),

  insertMemorySnapshot: db.prepare(`
    INSERT INTO agent_memory_history (agent_name, game_number, memory, snapshot_at)
    VALUES (@agentName, @gameNumber, @memory, @snapshotAt)
  `),
  getMemoryHistory: db.prepare(`
    SELECT * FROM agent_memory_history WHERE agent_name = ? ORDER BY game_number ASC
  `),

  insertGame: db.prepare(`
    INSERT OR REPLACE INTO games (game_number, game_id, white_agents, black_agents, winner, total_moves, duration_ms, moves_json, started_at, ended_at)
    VALUES (@gameNumber, @gameId, @whiteAgents, @blackAgents, @winner, @totalMoves, @durationMs, @movesJson, @startedAt, @endedAt)
  `),
  getGame: db.prepare(`SELECT * FROM games WHERE game_number = ?`),
  getRecentGames: db.prepare(`SELECT * FROM games ORDER BY game_number DESC LIMIT ?`),
  getAgentGames: db.prepare(`
    SELECT * FROM games WHERE white_agents LIKE ? OR black_agents LIKE ?
    ORDER BY game_number DESC LIMIT ?
  `),

  getArena: db.prepare(`SELECT * FROM arena_state WHERE id = 1`),
  updateArena: db.prepare(`
    UPDATE arena_state SET
      total_games_played = @totalGamesPlayed,
      current_game_number = @currentGameNumber,
      current_game_id = @currentGameId,
      status = @status
    WHERE id = 1
  `),

  insertPostgameMsg: db.prepare(`
    INSERT OR IGNORE INTO postgame_messages (id, game_number, agent_name, content, timestamp)
    VALUES (@id, @gameNumber, @agentName, @content, @timestamp)
  `),
  getPostgameMsgs: db.prepare(`
    SELECT * FROM postgame_messages WHERE game_number = ? ORDER BY timestamp
  `),
};

// ── Agent Profiles ───────────────────────────────────────────────────

export function saveAgentProfile(profile: AgentProfile): void {
  stmts.upsertProfile.run({
    name: profile.name,
    personalityId: profile.personalityId,
    memory: profile.memory,
    updatedAt: profile.updatedAt,
  });
}

export function loadAgentProfile(agentName: string): AgentProfile | null {
  const row = stmts.getProfile.get(agentName) as any;
  if (!row) return null;
  return {
    name: row.name,
    personalityId: row.personality_id,
    memory: row.memory,
    updatedAt: row.updated_at,
  };
}

export function loadAllAgentProfiles(): AgentProfile[] {
  const rows = stmts.getAllProfiles.all() as any[];
  return rows.map((row) => ({
    name: row.name,
    personalityId: row.personality_id,
    memory: row.memory,
    updatedAt: row.updated_at,
  }));
}

// ── Memory History ───────────────────────────────────────────────────

export function snapshotMemory(agentName: string, gameNumber: number): void {
  const profile = loadAgentProfile(agentName);
  if (!profile) return;
  stmts.insertMemorySnapshot.run({
    agentName, gameNumber, memory: profile.memory, snapshotAt: new Date().toISOString(),
  });
}

export interface MemorySnapshot {
  agentName: string;
  gameNumber: number;
  memory: string;
  snapshotAt: string;
}

export function loadMemoryHistory(agentName: string): MemorySnapshot[] {
  const rows = stmts.getMemoryHistory.all(agentName) as any[];
  return rows.map((r) => ({
    agentName: r.agent_name, gameNumber: r.game_number,
    memory: r.memory, snapshotAt: r.snapshot_at,
  }));
}

// ── Games ────────────────────────────────────────────────────────────

export interface GameRecord {
  gameNumber: number;
  gameId: string;
  whiteAgents: string[];
  blackAgents: string[];
  winner: string | null;
  totalMoves: number;
  durationMs: number;
  startedAt: string;
  endedAt: string | null;
}

function parseGameRow(row: any): GameRecord {
  return {
    gameNumber: row.game_number, gameId: row.game_id,
    whiteAgents: JSON.parse(row.white_agents), blackAgents: JSON.parse(row.black_agents),
    winner: row.winner, totalMoves: row.total_moves, durationMs: row.duration_ms,
    startedAt: row.started_at, endedAt: row.ended_at,
  };
}

export function saveGameRecord(
  gameNumber: number, gameId: string, whiteAgents: string[], blackAgents: string[],
  winner: string | null, totalMoves: number, durationMs: number,
  moves: MoveRecord[], startedAt: string
): void {
  stmts.insertGame.run({
    gameNumber, gameId, whiteAgents: JSON.stringify(whiteAgents),
    blackAgents: JSON.stringify(blackAgents), winner, totalMoves, durationMs,
    movesJson: JSON.stringify(moves), startedAt, endedAt: new Date().toISOString(),
  });
}

export function loadRecentGames(limit = 20): GameRecord[] {
  return (stmts.getRecentGames.all(limit) as any[]).map(parseGameRow);
}

export function loadGameByNumber(gameNumber: number): (GameRecord & { moves: MoveRecord[] }) | null {
  const row = stmts.getGame.get(gameNumber) as any;
  if (!row) return null;
  return { ...parseGameRow(row), moves: row.moves_json ? JSON.parse(row.moves_json) : [] };
}

export function loadAgentStats(agentName: string) {
  const rows = stmts.getAgentGames.all(`%${agentName}%`, `%${agentName}%`, 100) as any[];
  let wins = 0, losses = 0, draws = 0;
  for (const row of rows) {
    const wa: string[] = JSON.parse(row.white_agents);
    const ba: string[] = JSON.parse(row.black_agents);
    const isWhite = wa.includes(agentName);
    const isBlack = ba.includes(agentName);
    if (!isWhite && !isBlack) continue;
    if (row.winner === "draw") draws++;
    else if ((row.winner === "white" && isWhite) || (row.winner === "black" && isBlack)) wins++;
    else losses++;
  }
  return { wins, losses, draws, totalGames: wins + losses + draws };
}

// ── Arena State ──────────────────────────────────────────────────────

export function saveArenaState(state: ArenaState): void {
  stmts.updateArena.run({
    totalGamesPlayed: state.totalGamesPlayed, currentGameNumber: state.currentGameNumber,
    currentGameId: state.currentGameId, status: state.status,
  });
}

export function loadArenaState(): ArenaState | null {
  const row = stmts.getArena.get() as any;
  if (!row) return null;
  return {
    totalGamesPlayed: row.total_games_played, currentGameNumber: row.current_game_number,
    currentGameId: row.current_game_id, status: row.status,
  };
}

export function resetDatabase(): void {
  db.exec(`
    DELETE FROM agent_profiles;
    DELETE FROM agent_memory_history;
    DELETE FROM games;
    DELETE FROM postgame_messages;
    UPDATE arena_state SET total_games_played = 0, current_game_number = 0, current_game_id = NULL, status = 'running' WHERE id = 1;
  `);
  console.log("[db] Database reset.");
}

// ── Post-game Messages ───────────────────────────────────────────────

export function savePostgameMessage(
  id: string, gameNumber: number, agentName: string, content: string, timestamp: number
): void {
  stmts.insertPostgameMsg.run({ id, gameNumber, agentName, content, timestamp });
}

export function loadPostgameMessages(gameNumber: number) {
  return stmts.getPostgameMsgs.all(gameNumber) as any[];
}
