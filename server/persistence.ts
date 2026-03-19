import fs from "fs";
import path from "path";
import type {
  SeriesConfig,
  SeriesState,
  IndividualNotepad,
  TeamNotepad,
  GameResult,
  MoveRecord,
  Team,
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

function seriesDir(seriesId: string): string {
  return path.join(DATA_DIR, "series", seriesId);
}

// ── Series ───────────────────────────────────────────────────────────

export function createSeriesDir(seriesId: string): void {
  const dir = seriesDir(seriesId);
  ensureDir(path.join(dir, "notepads", "individual"));
  ensureDir(path.join(dir, "notepads", "team"));
  ensureDir(path.join(dir, "games"));
}

export function saveSeriesConfig(seriesId: string, config: SeriesConfig): void {
  writeJson(path.join(seriesDir(seriesId), "config.json"), config);
}

export function loadSeriesConfig(seriesId: string): SeriesConfig | null {
  return readJson<SeriesConfig>(path.join(seriesDir(seriesId), "config.json"));
}

export function saveSeriesState(seriesId: string, state: SeriesState): void {
  writeJson(path.join(seriesDir(seriesId), "state.json"), state);
}

export function loadSeriesState(seriesId: string): SeriesState | null {
  return readJson<SeriesState>(path.join(seriesDir(seriesId), "state.json"));
}

// ── Notepads ─────────────────────────────────────────────────────────

export function saveIndividualNotepad(
  seriesId: string,
  agentName: string,
  notepad: IndividualNotepad
): void {
  writeJson(
    path.join(seriesDir(seriesId), "notepads", "individual", `${agentName}.json`),
    notepad
  );
}

export function loadIndividualNotepad(
  seriesId: string,
  agentName: string
): IndividualNotepad | null {
  return readJson<IndividualNotepad>(
    path.join(seriesDir(seriesId), "notepads", "individual", `${agentName}.json`)
  );
}

export function saveTeamNotepad(
  seriesId: string,
  team: Team,
  notepad: TeamNotepad
): void {
  writeJson(
    path.join(seriesDir(seriesId), "notepads", "team", `${team}.json`),
    notepad
  );
}

export function loadTeamNotepad(
  seriesId: string,
  team: Team
): TeamNotepad | null {
  return readJson<TeamNotepad>(
    path.join(seriesDir(seriesId), "notepads", "team", `${team}.json`)
  );
}

// ── Game Results ─────────────────────────────────────────────────────

export function saveGameResult(
  seriesId: string,
  gameIndex: number,
  result: GameResult
): void {
  writeJson(
    path.join(seriesDir(seriesId), "games", String(gameIndex), "result.json"),
    result
  );
}

export function saveGameMoves(
  seriesId: string,
  gameIndex: number,
  moves: MoveRecord[]
): void {
  writeJson(
    path.join(seriesDir(seriesId), "games", String(gameIndex), "moves.json"),
    moves
  );
}

export function loadGameResult(
  seriesId: string,
  gameIndex: number
): GameResult | null {
  return readJson<GameResult>(
    path.join(seriesDir(seriesId), "games", String(gameIndex), "result.json")
  );
}
