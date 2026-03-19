import fs from "fs";
import path from "path";
import type {
  AgentProfile,
  GameNotepad,
  MoveRecord,
  Team,
  ArenaState,
} from "../shared/types.js";

const DATA_DIR = path.join(process.cwd(), "data");

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Agent Profiles ───────────────────────────────────────────────────

function agentDir(agentName: string): string {
  return path.join(DATA_DIR, "agents", agentName);
}

export function saveAgentProfile(profile: AgentProfile): void {
  writeJson(path.join(agentDir(profile.name), "profile.json"), profile);
}

export function loadAgentProfile(agentName: string): AgentProfile | null {
  return readJson<AgentProfile>(path.join(agentDir(agentName), "profile.json"));
}

// ── Game Notepads ────────────────────────────────────────────────────

export function saveGameNotepad(agentName: string, notepad: GameNotepad): void {
  writeJson(
    path.join(agentDir(agentName), "notepads", `game-${notepad.gameNumber}.json`),
    notepad
  );
}

export function loadRecentNotepads(agentName: string, limit = 10): GameNotepad[] {
  const dir = path.join(agentDir(agentName), "notepads");
  ensureDir(dir);

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith("game-") && f.endsWith(".json"))
      .sort((a, b) => {
        const numA = parseInt(a.replace("game-", "").replace(".json", ""));
        const numB = parseInt(b.replace("game-", "").replace(".json", ""));
        return numB - numA; // newest first
      })
      .slice(0, limit);

    return files
      .map((f) => readJson<GameNotepad>(path.join(dir, f)))
      .filter((n): n is GameNotepad => n !== null);
  } catch {
    return [];
  }
}

// ── Game Results ─────────────────────────────────────────────────────

export function saveGameMoves(gameNumber: number, moves: MoveRecord[]): void {
  writeJson(
    path.join(DATA_DIR, "games", String(gameNumber), "moves.json"),
    moves
  );
}

export function saveGameResult(gameNumber: number, result: unknown): void {
  writeJson(
    path.join(DATA_DIR, "games", String(gameNumber), "result.json"),
    result
  );
}

// ── Arena State ──────────────────────────────────────────────────────

export function saveArenaState(state: ArenaState): void {
  writeJson(path.join(DATA_DIR, "arena.json"), state);
}

export function loadArenaState(): ArenaState | null {
  return readJson<ArenaState>(path.join(DATA_DIR, "arena.json"));
}
