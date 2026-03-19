import { v4 as uuidv4 } from "uuid";
import type {
  SeriesConfig,
  SeriesState,
  GameConfig,
  GameResult,
  AgentConfig,
  Team,
} from "../shared/types.js";
import {
  GameOrchestrator,
  type EventCallback,
  type SeriesContext,
  type NotepadState,
} from "./orchestrator.js";
import { getPersonality } from "./personalities.js";
import {
  createSeriesDir,
  saveSeriesConfig,
  saveSeriesState,
  saveGameResult,
  loadIndividualNotepad,
  loadTeamNotepad,
} from "./persistence.js";

// ── Build game config from series config ─────────────────────────────

function buildAgentsFromPersonalities(
  personalityIds: string[],
  team: Team
): AgentConfig[] {
  return personalityIds.map((pid) => {
    const p = getPersonality(pid);
    return {
      id: uuidv4(),
      name: p.name,
      model: p.model,
      team,
      personalityId: p.id,
    };
  });
}

function buildGameConfig(
  seriesConfig: SeriesConfig,
  agentIds: { white: AgentConfig[]; black: AgentConfig[] }
): GameConfig {
  return {
    id: uuidv4(),
    white: { agents: agentIds.white },
    black: { agents: agentIds.black },
    gameTimeSec: seriesConfig.gameTimeSec,
    agentTurnTimeSec: seriesConfig.agentTurnTimeSec,
    createdAt: new Date().toISOString(),
  };
}

// ── Load notepads for a series ───────────────────────────────────────

function loadNotepads(
  seriesId: string,
  whiteAgents: AgentConfig[],
  blackAgents: AgentConfig[]
): NotepadState {
  const individual = new Map<string, string>();
  const team = new Map<Team, string>();

  for (const agent of [...whiteAgents, ...blackAgents]) {
    const np = loadIndividualNotepad(seriesId, agent.name);
    if (np) individual.set(agent.name, np.content);
  }

  const whiteNp = loadTeamNotepad(seriesId, "white");
  if (whiteNp) team.set("white", whiteNp.content);

  const blackNp = loadTeamNotepad(seriesId, "black");
  if (blackNp) team.set("black", blackNp.content);

  return { individual, team };
}

// ── Series runner ────────────────────────────────────────────────────

export interface SeriesRunner {
  seriesId: string;
  config: SeriesConfig;
  state: SeriesState;
  currentOrchestrator: GameOrchestrator | null;
}

const activeSeries = new Map<string, SeriesRunner>();

export function getActiveSeries(seriesId: string): SeriesRunner | undefined {
  return activeSeries.get(seriesId);
}

export function getAllActiveSeries(): SeriesRunner[] {
  return [...activeSeries.values()];
}

export async function runSeries(
  config: SeriesConfig,
  onGameCreated: (gameId: string, orchestrator: GameOrchestrator) => void,
  broadcastSeriesState: (state: SeriesState) => void
): Promise<void> {
  const seriesId = config.id;

  createSeriesDir(seriesId);
  saveSeriesConfig(seriesId, config);

  const state: SeriesState = {
    seriesId,
    currentGameIndex: 0,
    currentGameId: null,
    results: [],
    status: "in_progress",
  };

  // Create persistent agent IDs that carry across games
  // (sessions reset between games, but names/personalities persist)
  const whiteAgents = buildAgentsFromPersonalities(
    config.white.personalityIds, "white"
  );
  const blackAgents = buildAgentsFromPersonalities(
    config.black.personalityIds, "black"
  );

  const runner: SeriesRunner = {
    seriesId,
    config,
    state,
    currentOrchestrator: null,
  };
  activeSeries.set(seriesId, runner);

  console.log(`[series] Starting series ${seriesId}: ${config.totalGames} games`);
  console.log(`[series] White: ${whiteAgents.map((a) => a.name).join(", ")}`);
  console.log(`[series] Black: ${blackAgents.map((a) => a.name).join(", ")}`);

  for (let i = 0; i < config.totalGames; i++) {
    state.currentGameIndex = i;

    // Build fresh agent IDs each game (but same names/personalities)
    const gameWhite = whiteAgents.map((a) => ({ ...a, id: uuidv4() }));
    const gameBlack = blackAgents.map((a) => ({ ...a, id: uuidv4() }));

    const gameConfig = buildGameConfig(config, {
      white: gameWhite,
      black: gameBlack,
    });

    state.currentGameId = gameConfig.id;
    saveSeriesState(seriesId, state);
    broadcastSeriesState(state);

    console.log(`\n[series] === Game ${i + 1} of ${config.totalGames} ===`);

    // Load notepads from previous games
    const notepads = loadNotepads(seriesId, gameWhite, gameBlack);
    if (notepads.individual.size > 0 || notepads.team.size > 0) {
      console.log(`[series] Loaded notepads: ${notepads.individual.size} individual, ${notepads.team.size} team`);
    }

    const seriesContext: SeriesContext = { seriesId, gameIndex: i };
    const orchestrator = new GameOrchestrator(gameConfig, seriesContext, notepads);

    runner.currentOrchestrator = orchestrator;

    // Register for broadcasting
    onGameCreated(gameConfig.id, orchestrator);

    const startTime = Date.now();
    await orchestrator.runToCompletion();

    const result: GameResult = {
      gameIndex: i,
      gameId: gameConfig.id,
      winner: orchestrator.getResult().winner,
      totalMoves: orchestrator.getResult().totalMoves,
      durationMs: Date.now() - startTime,
      endedAt: new Date().toISOString(),
    };

    state.results.push(result);
    saveGameResult(seriesId, i, result);
    saveSeriesState(seriesId, state);
    broadcastSeriesState(state);

    const wins = { white: 0, black: 0, draw: 0 };
    for (const r of state.results) {
      if (r.winner === "white") wins.white++;
      else if (r.winner === "black") wins.black++;
      else wins.draw++;
    }
    console.log(`[series] Score after game ${i + 1}: White ${wins.white} - Black ${wins.black} (Draws: ${wins.draw})`);
  }

  state.status = "complete";
  state.currentGameId = null;
  saveSeriesState(seriesId, state);
  broadcastSeriesState(state);

  runner.currentOrchestrator = null;
  activeSeries.delete(seriesId);

  console.log(`[series] Series ${seriesId} complete.`);
}
