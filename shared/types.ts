// ── Models ──────────────────────────────────────────────────────────

export type ClaudeModel = "opus" | "sonnet" | "haiku";

// ── Personalities ───────────────────────────────────────────────────

export type PersonalityId = string;

export interface AgentPersonality {
  id: PersonalityId;
  name: string;
  systemPromptFragment: string;
  model: ClaudeModel;
}

// ── Agents ──────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  model: ClaudeModel;
  team: Team;
  personalityId?: PersonalityId;
}

export type Team = "white" | "black";

export interface TeamConfig {
  agents: AgentConfig[];
}

// ── Notepads ────────────────────────────────────────────────────────

export interface IndividualNotepad {
  agentName: string;
  content: string; // max 500 chars
  updatedAt: string;
}

export interface TeamNotepad {
  team: Team;
  content: string; // max 1000 chars
  updatedAt: string;
}

export const INDIVIDUAL_NOTEPAD_LIMIT = 500;
export const TEAM_NOTEPAD_LIMIT = 1000;

// ── Game ─────────────────────────────────────────────────────────────

export interface GameConfig {
  id: string;
  white: TeamConfig;
  black: TeamConfig;
  gameTimeSec: number;
  agentTurnTimeSec: number;
  createdAt: string;
}

export type GamePhase =
  | "waiting"
  | "deliberation"
  | "post_game_deliberation"
  | "complete";

export interface GameState {
  gameId: string;
  fen: string;
  moveHistory: MoveRecord[];
  currentTurn: Team;
  phase: GamePhase;
  turnNumber: number;
  winner: Team | "draw" | null;
  deliberation: DeliberationState | null;
  clockWhite: number;
  clockBlack: number;
}

export interface DeliberationState {
  team: Team;
  startedAt: number;
  messages: BoardMessage[];
  activeAgentId: string | null;
  selectedAgentId: string | null;
  submittedMove: string | null;
}

// ── Message Board ───────────────────────────────────────────────────

export interface BoardMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
  turnNumber: number;
}

// ── Move Record ─────────────────────────────────────────────────────

export interface MoveRecord {
  turnNumber: number;
  team: Team;
  move: string;
  fen: string;
  timestamp: number;
  selectedAgentId: string;
  selectedAgentName: string;
  deliberation: {
    messages: BoardMessage[];
    durationMs: number;
  };
}

// ── Series ──────────────────────────────────────────────────────────

export interface SeriesConfig {
  id: string;
  totalGames: number;
  white: SeriesTeamConfig;
  black: SeriesTeamConfig;
  gameTimeSec: number;
  agentTurnTimeSec: number;
  createdAt: string;
}

export interface SeriesTeamConfig {
  personalityIds: PersonalityId[];
}

export interface SeriesState {
  seriesId: string;
  currentGameIndex: number;
  currentGameId: string | null;
  results: GameResult[];
  status: "in_progress" | "complete";
}

export interface GameResult {
  gameIndex: number;
  gameId: string;
  winner: Team | "draw" | null;
  totalMoves: number;
  durationMs: number;
  endedAt: string;
}

// ── WebSocket Events ────────────────────────────────────────────────

export type ServerEvent =
  | { type: "game:state"; payload: GameState }
  | { type: "game:phase"; payload: { phase: GamePhase; team?: Team } }
  | { type: "deliberation:message"; payload: BoardMessage }
  | { type: "deliberation:active_agent"; payload: { agentId: string; agentName: string } }
  | { type: "clock:tick"; payload: { clockWhite: number; clockBlack: number } }
  | { type: "move:submitted"; payload: MoveRecord }
  | { type: "game:complete"; payload: { winner: Team | "draw" } }
  | { type: "agent:thinking"; payload: { agentId: string; agentName: string; content: string } }
  | { type: "game:config"; payload: GameConfig }
  | { type: "eval:update"; payload: { score: number; mate: number | null } }
  | { type: "series:state"; payload: SeriesState }
  | { type: "notepad:updated"; payload: { agentName: string; team: Team; notepadType: "individual" | "team" } };

export type ClientEvent =
  | { type: "game:create"; payload: { config: Omit<GameConfig, "id" | "createdAt"> } }
  | { type: "game:start"; payload: { gameId: string } }
  | { type: "game:subscribe"; payload: { gameId: string } }
  | { type: "series:subscribe"; payload: { seriesId: string } };
