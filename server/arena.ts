import { v4 as uuidv4 } from "uuid";
import type { GameConfig, AgentConfig, ArenaState, Team } from "../shared/types.js";
import { GameOrchestrator, type EventCallback } from "./orchestrator.js";
import { getPersonality } from "./personalities.js";
import { saveArenaState, loadArenaState, loadAgentProfile, saveAgentProfile, resetDatabase } from "./persistence.js";

// ── Team compositions to rotate through ──────────────────────────────

const TEAM_COMPOSITIONS: { white: string[]; black: string[] }[] = [
  // 4v4 team games
  { white: ["fischer", "petrosian", "tal", "rookie"], black: ["kasparov", "capablanca", "morphy", "patzer"] },
  { white: ["kasparov", "tal", "morphy", "rookie"], black: ["fischer", "capablanca", "petrosian", "patzer"] },
  { white: ["fischer", "capablanca", "rookie", "patzer"], black: ["kasparov", "petrosian", "tal", "morphy"] },
  // 1v1 solo games
  { white: ["fischer"], black: ["kasparov"] },
  { white: ["tal"], black: ["petrosian"] },
  { white: ["capablanca"], black: ["morphy"] },
  // 2v2
  { white: ["fischer", "rookie"], black: ["kasparov", "patzer"] },
  { white: ["tal", "capablanca"], black: ["petrosian", "morphy"] },
];

function buildAgents(personalityIds: string[], team: Team): AgentConfig[] {
  return personalityIds.map((pid) => {
    const p = getPersonality(pid);
    return { id: uuidv4(), name: p.name, model: p.model, team, personalityId: p.id };
  });
}

// ── Ensure all agent profiles exist ──────────────────────────────────

function ensureProfiles(): void {
  const allPersonalities = [
    "fischer", "petrosian", "tal", "capablanca",
    "kasparov", "morphy", "rookie", "patzer",
  ];
  for (const pid of allPersonalities) {
    const p = getPersonality(pid);
    const existing = loadAgentProfile(p.name);
    if (!existing) {
      // Initialize with personality-based self-definition
      saveAgentProfile({
        name: p.name,
        personalityId: pid,
        memory: "",
        updatedAt: new Date().toISOString(),
      });
      console.log(`[arena] Created profile for ${p.name}`);
    }
  }
}

// ── Arena runner ─────────────────────────────────────────────────────

let currentOrchestrator: GameOrchestrator | null = null;
let arenaState: ArenaState;
let onGameEvent: EventCallback | null = null;
let arenaListeners: Set<(state: ArenaState) => void> = new Set();

export function getCurrentOrchestrator(): GameOrchestrator | null {
  return currentOrchestrator;
}

export function getArenaState(): ArenaState {
  return arenaState;
}

export function onArenaStateChange(cb: (state: ArenaState) => void): () => void {
  arenaListeners.add(cb);
  return () => arenaListeners.delete(cb);
}

function broadcastArenaState(): void {
  for (const cb of arenaListeners) cb(arenaState);
}

export async function startArena(
  gameEventCallback: EventCallback
): Promise<void> {
  onGameEvent = gameEventCallback;

  // Reset database if requested (start fresh)
  if (process.env.RESET_DB === "1") {
    console.log("[arena] RESET_DB=1 — wiping database and starting fresh");
    resetDatabase();
  }

  ensureProfiles();

  // Resume from saved state or start fresh
  const saved = loadArenaState();
  arenaState = saved ?? {
    totalGamesPlayed: 0,
    currentGameNumber: 0,
    currentGameId: null,
    status: "running",
  };
  arenaState.status = "running";

  console.log(`[arena] Starting continuous play from game ${arenaState.totalGamesPlayed + 1}`);

  while (arenaState.status === "running") {
    arenaState.currentGameNumber = arenaState.totalGamesPlayed + 1;

    // Pick team composition (rotate through)
    const compIdx = arenaState.totalGamesPlayed % TEAM_COMPOSITIONS.length;
    const comp = TEAM_COMPOSITIONS[compIdx];

    const whiteAgents = buildAgents(comp.white, "white");
    const blackAgents = buildAgents(comp.black, "black");

    const gameConfig: GameConfig = {
      id: uuidv4(),
      gameNumber: arenaState.currentGameNumber,
      white: { agents: whiteAgents },
      black: { agents: blackAgents },
      gameTimeSec: 15 * 60,
      agentTurnTimeSec: 15,
      createdAt: new Date().toISOString(),
    };

    arenaState.currentGameId = gameConfig.id;
    saveArenaState(arenaState);
    broadcastArenaState();

    console.log(`\n[arena] ═══ Game ${arenaState.currentGameNumber} ═══`);
    console.log(`[arena] White: ${whiteAgents.map((a) => a.name).join(", ")}`);
    console.log(`[arena] Black: ${blackAgents.map((a) => a.name).join(", ")}`);

    const orchestrator = new GameOrchestrator(gameConfig);
    currentOrchestrator = orchestrator;

    // Wire up event broadcasting
    if (onGameEvent) orchestrator.on(onGameEvent);

    await orchestrator.runToCompletion();

    const result = orchestrator.getResult();
    arenaState.totalGamesPlayed++;
    console.log(`[arena] Game ${arenaState.currentGameNumber} complete: ${result.winner ?? "draw"} (${result.totalMoves} moves)`);

    saveArenaState(arenaState);
    broadcastArenaState();

    currentOrchestrator = null;

    // Brief pause between games
    await new Promise((r) => setTimeout(r, 3000));
  }
}
