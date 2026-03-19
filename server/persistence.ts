import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  AgentProfile,
  GameNotepad,
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
    self_definition TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_notepads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    game_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(agent_name, game_number)
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

  CREATE TABLE IF NOT EXISTS agent_profile_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    game_number INTEGER NOT NULL,
    self_definition TEXT NOT NULL,
    strategy TEXT NOT NULL,
    snapshot_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_notes (
    author TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (author, subject)
  );

  INSERT OR IGNORE INTO arena_state (id, total_games_played, current_game_number, status)
  VALUES (1, 0, 0, 'running');
`);

// ── Prepared statements ──────────────────────────────────────────────

const stmts = {
  // Agent profiles
  upsertProfile: db.prepare(`
    INSERT INTO agent_profiles (name, personality_id, self_definition, strategy, updated_at)
    VALUES (@name, @personalityId, @selfDefinition, @strategy, @updatedAt)
    ON CONFLICT(name) DO UPDATE SET
      self_definition = @selfDefinition,
      strategy = @strategy,
      updated_at = @updatedAt
  `),
  getProfile: db.prepare(`SELECT * FROM agent_profiles WHERE name = ?`),
  getAllProfiles: db.prepare(`SELECT * FROM agent_profiles ORDER BY name`),

  // Game notepads
  upsertNotepad: db.prepare(`
    INSERT INTO game_notepads (agent_name, game_number, content, created_at)
    VALUES (@agentName, @gameNumber, @content, @createdAt)
    ON CONFLICT(agent_name, game_number) DO UPDATE SET
      content = @content, created_at = @createdAt
  `),
  getRecentNotepads: db.prepare(`
    SELECT * FROM game_notepads WHERE agent_name = ?
    ORDER BY game_number DESC LIMIT ?
  `),

  // Games
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

  // Arena state
  getArena: db.prepare(`SELECT * FROM arena_state WHERE id = 1`),
  updateArena: db.prepare(`
    UPDATE arena_state SET
      total_games_played = @totalGamesPlayed,
      current_game_number = @currentGameNumber,
      current_game_id = @currentGameId,
      status = @status
    WHERE id = 1
  `),

  // Post-game messages
  insertPostgameMsg: db.prepare(`
    INSERT OR IGNORE INTO postgame_messages (id, game_number, agent_name, content, timestamp)
    VALUES (@id, @gameNumber, @agentName, @content, @timestamp)
  `),
  getPostgameMsgs: db.prepare(`
    SELECT * FROM postgame_messages WHERE game_number = ? ORDER BY timestamp
  `),

  // Agent profile history (snapshots for evolution tracking)
  insertProfileSnapshot: db.prepare(`
    INSERT INTO agent_profile_history (agent_name, game_number, self_definition, strategy, snapshot_at)
    VALUES (@agentName, @gameNumber, @selfDefinition, @strategy, @snapshotAt)
  `),
  getProfileHistory: db.prepare(`
    SELECT * FROM agent_profile_history WHERE agent_name = ? ORDER BY game_number ASC
  `),

  // Agent notes (what one agent knows about another)
  upsertAgentNote: db.prepare(`
    INSERT INTO agent_notes (author, subject, content, updated_at)
    VALUES (@author, @subject, @content, @updatedAt)
    ON CONFLICT(author, subject) DO UPDATE SET
      content = @content, updated_at = @updatedAt
  `),
  getAgentNote: db.prepare(`SELECT * FROM agent_notes WHERE author = ? AND subject = ?`),
  getAgentNotes: db.prepare(`SELECT * FROM agent_notes WHERE author = ?`),
  getNotesForSubjects: db.prepare(`SELECT * FROM agent_notes WHERE author = ? AND subject IN (SELECT value FROM json_each(?))`),
};

// ── Agent Profiles ───────────────────────────────────────────────────

export function saveAgentProfile(profile: AgentProfile): void {
  stmts.upsertProfile.run({
    name: profile.name,
    personalityId: profile.personalityId,
    selfDefinition: profile.selfDefinition,
    strategy: profile.strategy,
    updatedAt: profile.updatedAt,
  });
}

export function loadAgentProfile(agentName: string): AgentProfile | null {
  const row = stmts.getProfile.get(agentName) as any;
  if (!row) return null;
  return {
    name: row.name,
    personalityId: row.personality_id,
    selfDefinition: row.self_definition,
    strategy: row.strategy,
    updatedAt: row.updated_at,
  };
}

export function loadAllAgentProfiles(): AgentProfile[] {
  const rows = stmts.getAllProfiles.all() as any[];
  return rows.map((row) => ({
    name: row.name,
    personalityId: row.personality_id,
    selfDefinition: row.self_definition,
    strategy: row.strategy,
    updatedAt: row.updated_at,
  }));
}

// ── Game Notepads ────────────────────────────────────────────────────

export function saveGameNotepad(agentName: string, notepad: GameNotepad): void {
  stmts.upsertNotepad.run({
    agentName,
    gameNumber: notepad.gameNumber,
    content: notepad.content,
    createdAt: notepad.createdAt,
  });
}

export function loadRecentNotepads(agentName: string, limit = 10): GameNotepad[] {
  const rows = stmts.getRecentNotepads.all(agentName, limit) as any[];
  return rows.map((row) => ({
    gameNumber: row.game_number,
    content: row.content,
    createdAt: row.created_at,
  }));
}

// ── Games ────────────────────────────────────────────────────────────

export function saveGameRecord(
  gameNumber: number,
  gameId: string,
  whiteAgents: string[],
  blackAgents: string[],
  winner: string | null,
  totalMoves: number,
  durationMs: number,
  moves: MoveRecord[],
  startedAt: string
): void {
  stmts.insertGame.run({
    gameNumber,
    gameId,
    whiteAgents: JSON.stringify(whiteAgents),
    blackAgents: JSON.stringify(blackAgents),
    winner,
    totalMoves,
    durationMs,
    movesJson: JSON.stringify(moves),
    startedAt,
    endedAt: new Date().toISOString(),
  });
}

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

export function loadRecentGames(limit = 20): GameRecord[] {
  const rows = stmts.getRecentGames.all(limit) as any[];
  return rows.map(parseGameRow);
}

export function loadGameByNumber(gameNumber: number): (GameRecord & { moves: MoveRecord[] }) | null {
  const row = stmts.getGame.get(gameNumber) as any;
  if (!row) return null;
  return {
    ...parseGameRow(row),
    moves: row.moves_json ? JSON.parse(row.moves_json) : [],
  };
}

function parseGameRow(row: any): GameRecord {
  return {
    gameNumber: row.game_number,
    gameId: row.game_id,
    whiteAgents: JSON.parse(row.white_agents),
    blackAgents: JSON.parse(row.black_agents),
    winner: row.winner,
    totalMoves: row.total_moves,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function loadAgentStats(agentName: string) {
  const rows = stmts.getAgentGames.all(`%${agentName}%`, `%${agentName}%`, 100) as any[];
  let wins = 0, losses = 0, draws = 0;
  for (const row of rows) {
    const whiteAgents: string[] = JSON.parse(row.white_agents);
    const blackAgents: string[] = JSON.parse(row.black_agents);
    const isWhite = whiteAgents.includes(agentName);
    const isBlack = blackAgents.includes(agentName);
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
    totalGamesPlayed: state.totalGamesPlayed,
    currentGameNumber: state.currentGameNumber,
    currentGameId: state.currentGameId,
    status: state.status,
  });
}

export function resetDatabase(): void {
  db.exec(`
    DELETE FROM agent_profiles;
    DELETE FROM game_notepads;
    DELETE FROM games;
    DELETE FROM postgame_messages;
    DELETE FROM agent_notes;
    DELETE FROM agent_profile_history;
    UPDATE arena_state SET total_games_played = 0, current_game_number = 0, current_game_id = NULL, status = 'running' WHERE id = 1;
  `);
  console.log("[db] Database reset to clean state.");
}

export function loadArenaState(): ArenaState | null {
  const row = stmts.getArena.get() as any;
  if (!row) return null;
  return {
    totalGamesPlayed: row.total_games_played,
    currentGameNumber: row.current_game_number,
    currentGameId: row.current_game_id,
    status: row.status,
  };
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

// ── Agent Notes ──────────────────────────────────────────────────────

export interface AgentNote {
  author: string;
  subject: string;
  content: string;
  updatedAt: string;
}

export function saveAgentNote(author: string, subject: string, content: string): void {
  stmts.upsertAgentNote.run({
    author, subject, content, updatedAt: new Date().toISOString(),
  });
}

export function loadAgentNotesForGame(authorName: string, otherAgentNames: string[]): AgentNote[] {
  if (otherAgentNames.length === 0) return [];
  const rows = stmts.getNotesForSubjects.all(authorName, JSON.stringify(otherAgentNames)) as any[];
  return rows.map((r) => ({
    author: r.author, subject: r.subject, content: r.content, updatedAt: r.updated_at,
  }));
}

// ── Agent Profile History ─────────────────────────────────────────────

export interface ProfileSnapshot {
  agentName: string;
  gameNumber: number;
  selfDefinition: string;
  strategy: string;
  snapshotAt: string;
}

export function snapshotAgentProfile(agentName: string, gameNumber: number): void {
  const profile = loadAgentProfile(agentName);
  if (!profile) return;
  stmts.insertProfileSnapshot.run({
    agentName,
    gameNumber,
    selfDefinition: profile.selfDefinition,
    strategy: profile.strategy,
    snapshotAt: new Date().toISOString(),
  });
}

export function loadProfileHistory(agentName: string): ProfileSnapshot[] {
  const rows = stmts.getProfileHistory.all(agentName) as any[];
  return rows.map((r) => ({
    agentName: r.agent_name,
    gameNumber: r.game_number,
    selfDefinition: r.self_definition,
    strategy: r.strategy,
    snapshotAt: r.snapshot_at,
  }));
}

export function loadAllAgentNotes(authorName: string): AgentNote[] {
  const rows = stmts.getAgentNotes.all(authorName) as any[];
  return rows.map((r) => ({
    author: r.author, subject: r.subject, content: r.content, updatedAt: r.updated_at,
  }));
}
