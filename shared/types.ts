// ── Models ──────────────────────────────────────────────────────────

export type ClaudeModel = "opus" | "sonnet" | "haiku";

// ── Agents ──────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  model: ClaudeModel;
  team: Team;
}

export type Team = "white" | "black";

export interface TeamConfig {
  agents: AgentConfig[];
  tokenBudgetPerTurn: number; // max output tokens per agent per turn for messages
}

// ── Game ─────────────────────────────────────────────────────────────

export interface GameConfig {
  id: string;
  white: TeamConfig;
  black: TeamConfig;
  deliberationTimeSec: number; // wall clock per turn
  createdAt: string;
}

export type GamePhase = "waiting" | "deliberation" | "move_selection" | "complete";

export interface GameState {
  gameId: string;
  fen: string; // chess position
  moveHistory: MoveRecord[];
  currentTurn: Team;
  phase: GamePhase;
  turnNumber: number;
  winner: Team | "draw" | null;
  deliberation: DeliberationState | null;
}

export interface DeliberationState {
  team: Team;
  startedAt: number;
  endsAt: number;
  messages: BoardMessage[];
  tokenUsage: Record<string, number>; // agentId -> tokens used this turn
  selectedAgentId: string | null; // who was picked to move
  submittedMove: string | null;
}

// ── Message Board ───────────────────────────────────────────────────

export interface BoardMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
  tokenCount: number;
  turnNumber: number;
}

// ── Move Record ─────────────────────────────────────────────────────

export interface MoveRecord {
  turnNumber: number;
  team: Team;
  move: string; // SAN notation e.g. "e4", "Nf3"
  fen: string; // position after move
  selectedAgentId: string;
  selectedAgentName: string;
  deliberation: {
    messages: BoardMessage[];
    durationMs: number;
  };
}

// ── WebSocket Events ────────────────────────────────────────────────

export type ServerEvent =
  | { type: "game:state"; payload: GameState }
  | { type: "game:phase"; payload: { phase: GamePhase; team: Team } }
  | { type: "deliberation:message"; payload: BoardMessage }
  | { type: "deliberation:tick"; payload: { remainingSec: number } }
  | { type: "deliberation:agent_selected"; payload: { agentId: string; agentName: string } }
  | { type: "move:submitted"; payload: MoveRecord }
  | { type: "game:complete"; payload: { winner: Team | "draw" } }
  | { type: "agent:thinking"; payload: { agentId: string; agentName: string; content: string } };

export type ClientEvent =
  | { type: "game:create"; payload: { config: Omit<GameConfig, "id" | "createdAt"> } }
  | { type: "game:start"; payload: { gameId: string } }
  | { type: "game:subscribe"; payload: { gameId: string } };
