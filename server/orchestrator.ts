import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  GameConfig,
  GameState,
  GamePhase,
  Team,
  AgentConfig,
  BoardMessage,
  MoveRecord,
  DeliberationState,
  ServerEvent,
} from "../shared/types.js";
import {
  createGame,
  validateMove,
  applyMove,
  getGameStatus,
  getLegalMoves,
  boardToAscii,
} from "./game.js";

// ── Model mapping ────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

// ── Prompts ──────────────────────────────────────────────────────────

function buildAgentSystemPrompt(
  agent: AgentConfig,
  teamAgents: AgentConfig[],
  team: Team
): string {
  const teammates = teamAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => a.name)
    .join(", ");

  return `You are ${agent.name}, one of four agents on the ${team} team in a collaborative chess game.

YOUR TEAM: ${teamAgents.map((a) => a.name).join(", ")}
YOUR TEAMMATES: ${teammates}
YOU PLAY AS: ${team.toUpperCase()}

This is a long-running game. You will be called upon each turn to deliberate with your team. Your memory persists across turns — you can reference prior discussions, remember what strategies worked, and build relationships with your teammates.

HOW TO INTERACT:
- Use the read_messages tool to see what your teammates have said on the shared message board for THIS turn.
- Use the post_message tool to share your analysis, candidate moves, and strategic ideas.
- Read messages first, then contribute, then check for responses. Try 2-3 rounds of discussion per turn.
- When you are selected to submit a move, use the submit_move tool.

RULES:
- After each deliberation period, one agent is RANDOMLY selected to submit the final move.
- You do not know who will be selected, so always participate fully.
- The message board resets each turn, but YOUR memory of the game persists.

CHESS GUIDELINES:
- Reason from first principles. Evaluate material, position, king safety, pawn structure, piece activity, and tactics.
- Share concrete analysis — specific moves, variations, and threats.
- Build on teammates' ideas. Respectfully disagree when you see something different.
- Do NOT access external tools, chess engines, or databases.
- You don't know what model your teammates run — treat everyone as a fellow thinker.`;
}

function buildFirstTurnPrompt(fen: string, legalMoves: string[]): string {
  const ascii = boardToAscii(fen);
  return `The game begins! Here is the starting position:

BOARD:
\`\`\`
${ascii}
\`\`\`
FEN: ${fen}
LEGAL MOVES: ${legalMoves.join(", ")}

This is your first turn. Use read_messages to see if any teammates have posted, then share your opening analysis with post_message. What opening ideas do you like? What should the team's strategy be?`;
}

function buildTurnPrompt(
  fen: string,
  legalMoves: string[],
  turnNumber: number,
  lastMove: MoveRecord | null
): string {
  const ascii = boardToAscii(fen);
  const lastMoveInfo = lastMove
    ? `\nLast move: ${lastMove.selectedAgentName} (opponent) played ${lastMove.move}.`
    : "";

  return `Turn ${turnNumber}. It's your team's move.${lastMoveInfo}

BOARD:
\`\`\`
${ascii}
\`\`\`
FEN: ${fen}
LEGAL MOVES: ${legalMoves.join(", ")}

Use read_messages to see your teammates' analysis, then contribute with post_message. What's the best response here?`;
}

function buildMoveSelectionPrompt(
  fen: string,
  legalMoves: string[],
  messages: BoardMessage[]
): string {
  const ascii = boardToAscii(fen);
  const messageHistory = messages.length > 0
    ? messages.map((m) => `[${m.agentName}]: ${m.content}`).join("\n")
    : "(No discussion happened this turn)";

  return `YOU HAVE BEEN RANDOMLY SELECTED to submit the move for your team this turn.

CURRENT POSITION:
\`\`\`
${ascii}
\`\`\`
FEN: ${fen}
LEGAL MOVES: ${legalMoves.join(", ")}

TEAM DISCUSSION THIS TURN:
${messageHistory}

Based on the team's discussion and your own analysis, use the submit_move tool to submit a legal move.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export type EventCallback = (event: ServerEvent) => void;

export class GameOrchestrator {
  private config: GameConfig;
  private state: GameState;
  private listeners: Set<EventCallback> = new Set();
  private abortController: AbortController | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // Persistent agent sessions — each agent keeps context across the whole game
  private agentSessions: Map<string, string> = new Map(); // agentId → sessionId

  constructor(config: GameConfig) {
    this.config = config;

    const fen = createGame();
    this.state = {
      gameId: config.id,
      fen,
      moveHistory: [],
      currentTurn: "white",
      phase: "waiting",
      turnNumber: 1,
      winner: null,
      deliberation: null,
    };
  }

  // ── Event system ───────────────────────────────────────────────────

  on(callback: EventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Event listener error:", e);
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  getState(): GameState {
    return { ...this.state };
  }

  getLog(): MoveRecord[] {
    return [...this.state.moveHistory];
  }

  async start(): Promise<void> {
    if (this.state.phase !== "waiting") {
      throw new Error("Game already started");
    }
    this.runGameLoop().catch((err) => {
      console.error("Game loop error:", err);
    });
  }

  stop(): void {
    this.abortController?.abort();
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ── Game loop ──────────────────────────────────────────────────────

  private async runGameLoop(): Promise<void> {
    while (true) {
      const status = getGameStatus(this.state.fen);

      if (status === "checkmate") {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete";
        this.state.winner = winner;
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() });
        return;
      }

      if (status === "stalemate" || status === "draw") {
        this.state.phase = "complete";
        this.state.winner = "draw";
        this.emit({ type: "game:complete", payload: { winner: "draw" } });
        this.emit({ type: "game:state", payload: this.getState() });
        return;
      }

      await this.runTurn();
    }
  }

  private async runTurn(): Promise<void> {
    const team = this.state.currentTurn;
    const teamConfig = team === "white" ? this.config.white : this.config.black;
    const agents = teamConfig.agents;

    // ── 1. Set up deliberation state for this turn ──────────────

    const now = Date.now();
    const deliberation: DeliberationState = {
      team,
      startedAt: now,
      endsAt: now + this.config.deliberationTimeSec * 1000,
      messages: [],
      tokenUsage: Object.fromEntries(agents.map((a) => [a.id, 0])),
      selectedAgentId: null,
      submittedMove: null,
    };

    this.state.phase = "deliberation";
    this.state.deliberation = deliberation;

    this.emit({ type: "game:phase", payload: { phase: "deliberation", team } });
    this.emit({ type: "game:state", payload: this.getState() });

    // ── 2. Start countdown ticker ───────────────────────────────

    this.tickInterval = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.ceil((deliberation.endsAt - Date.now()) / 1000)
      );
      this.emit({
        type: "deliberation:tick",
        payload: { remainingSec: remaining },
      });
    }, 1000);

    // ── 3. Run agent deliberation in parallel ───────────────────

    this.abortController = new AbortController();
    const legalMoves = getLegalMoves(this.state.fen);

    const agentPromises = agents.map((agent) =>
      this.runAgentDeliberation(agent, agents, team, deliberation, legalMoves)
    );

    const timerPromise = new Promise<void>((resolve) => {
      const remaining = deliberation.endsAt - Date.now();
      setTimeout(() => {
        this.abortController?.abort();
        resolve();
      }, Math.max(0, remaining));
    });

    await Promise.race([Promise.allSettled(agentPromises), timerPromise]);
    this.abortController?.abort();
    await Promise.allSettled(agentPromises);

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // ── 4. Select an agent and get the move ─────────────────────

    this.state.phase = "move_selection";
    this.emit({ type: "game:phase", payload: { phase: "move_selection", team } });

    const selectedAgent = agents[Math.floor(Math.random() * agents.length)];
    deliberation.selectedAgentId = selectedAgent.id;

    this.emit({
      type: "deliberation:agent_selected",
      payload: { agentId: selectedAgent.id, agentName: selectedAgent.name },
    });

    const move = await this.requestMove(
      selectedAgent, agents, team, deliberation, legalMoves
    );

    deliberation.submittedMove = move;

    // ── 5. Apply the move ───────────────────────────────────────

    const newFen = applyMove(this.state.fen, move);
    const moveRecord: MoveRecord = {
      turnNumber: this.state.turnNumber,
      team,
      move,
      fen: newFen,
      selectedAgentId: selectedAgent.id,
      selectedAgentName: selectedAgent.name,
      deliberation: {
        messages: [...deliberation.messages],
        durationMs: Date.now() - deliberation.startedAt,
      },
    };

    this.state.fen = newFen;
    this.state.moveHistory.push(moveRecord);
    this.state.currentTurn = team === "white" ? "black" : "white";
    this.state.turnNumber++;
    this.state.deliberation = null;

    this.emit({ type: "move:submitted", payload: moveRecord });
    this.emit({ type: "game:state", payload: this.getState() });
  }

  // ── MCP tool factories ─────────────────────────────────────────────
  // Tools capture closures over the current turn's deliberation state.
  // A new MCP server is created each turn so tools always reference
  // the live deliberation object.

  private createDeliberationServer(
    agent: AgentConfig,
    team: Team,
    deliberation: DeliberationState
  ) {
    const orchestrator = this;
    const abortSignal = this.abortController?.signal;

    const readMessagesTool = tool(
      "read_messages",
      "Read all messages from your team's shared message board for this turn.",
      {},
      async () => {
        const msgs = deliberation.messages;
        if (msgs.length === 0) {
          return {
            content: [{ type: "text" as const, text: "(No messages yet — you're first! Share your analysis.)" }],
          };
        }
        const formatted = msgs
          .map((m) => `[${m.agentName}]: ${m.content}`)
          .join("\n\n");
        return { content: [{ type: "text" as const, text: formatted }] };
      }
    );

    const postMessageTool = tool(
      "post_message",
      "Post a message to your team's shared message board.",
      { message: z.string().describe("Your chess analysis, candidate moves, or response to teammates") },
      async (args: { message: string }) => {
        if (abortSignal?.aborted) {
          return { content: [{ type: "text" as const, text: "Deliberation time has ended." }] };
        }

        const msg: BoardMessage = {
          id: uuidv4(),
          agentId: agent.id,
          agentName: agent.name,
          content: args.message,
          timestamp: Date.now(),
          tokenCount: 0,
          turnNumber: orchestrator.state.turnNumber,
        };

        deliberation.messages.push(msg);
        orchestrator.emit({ type: "deliberation:message", payload: msg });

        return { content: [{ type: "text" as const, text: "Message posted." }] };
      }
    );

    return createSdkMcpServer({
      name: `chess-delib-${team}-${agent.name.toLowerCase()}`,
      tools: [readMessagesTool, postMessageTool],
    });
  }

  private createMoveSelectionServer(
    agent: AgentConfig,
    deliberation: DeliberationState,
    legalMoves: string[],
    onMoveSubmitted: (move: string) => void
  ) {
    const fen = this.state.fen;

    const submitMoveTool = tool(
      "submit_move",
      "Submit your chosen chess move. Must be in SAN notation and legal.",
      { move: z.string().describe("Chess move in SAN notation (e.g. e4, Nf3, Bxc6, O-O)") },
      async (args: { move: string }) => {
        if (validateMove(fen, args.move)) {
          onMoveSubmitted(args.move);
          return { content: [{ type: "text" as const, text: `Move ${args.move} submitted.` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Illegal move: ${args.move}. Legal moves: ${legalMoves.join(", ")}`,
          }],
        };
      }
    );

    const readMessagesTool = tool(
      "read_messages",
      "Read the team's discussion from this turn's deliberation.",
      {},
      async () => {
        const msgs = deliberation.messages;
        if (msgs.length === 0) {
          return { content: [{ type: "text" as const, text: "(No discussion this turn)" }] };
        }
        const formatted = msgs.map((m) => `[${m.agentName}]: ${m.content}`).join("\n\n");
        return { content: [{ type: "text" as const, text: formatted }] };
      }
    );

    return createSdkMcpServer({
      name: `chess-move-${agent.name.toLowerCase()}`,
      tools: [submitMoveTool, readMessagesTool],
    });
  }

  // ── Agent deliberation (persistent session) ────────────────────────

  private async runAgentDeliberation(
    agent: AgentConfig,
    teamAgents: AgentConfig[],
    team: Team,
    deliberation: DeliberationState,
    legalMoves: string[]
  ): Promise<void> {
    const abortSignal = this.abortController?.signal;
    const existingSessionId = this.agentSessions.get(agent.id);
    const isFirstTurn = !existingSessionId;

    const server = this.createDeliberationServer(agent, team, deliberation);

    // First turn: full init with system prompt and model.
    // Subsequent turns: resume the existing session — agent retains
    // all prior thinking, game history, and teammate impressions.
    const lastMove = this.state.moveHistory.length > 0
      ? this.state.moveHistory[this.state.moveHistory.length - 1]
      : null;

    const prompt = isFirstTurn
      ? buildFirstTurnPrompt(this.state.fen, legalMoves)
      : buildTurnPrompt(this.state.fen, legalMoves, this.state.turnNumber, lastMove);

    const options = isFirstTurn
      ? {
          model: resolveModel(agent.model),
          systemPrompt: buildAgentSystemPrompt(agent, teamAgents, team),
          mcpServers: { chess: server },
          maxTurns: 8,
          allowedTools: [] as string[],
        }
      : {
          resume: existingSessionId,
          mcpServers: { chess: server },
          maxTurns: 8,
        };

    try {
      for await (const message of query({ prompt, options })) {
        if (abortSignal?.aborted) break;

        // Capture session ID on first init so we can resume later
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as any).type === "system" &&
          (message as any).subtype === "init"
        ) {
          const sessionId = (message as any).session_id;
          if (sessionId) {
            this.agentSessions.set(agent.id, sessionId);
          }
        }

        // Capture agent output for the thinking stream viewer
        if ("result" in message && typeof (message as any).result === "string") {
          this.emit({
            type: "agent:thinking",
            payload: {
              agentId: agent.id,
              agentName: agent.name,
              content: (message as any).result,
            },
          });
        }
      }
    } catch (err: any) {
      if (!abortSignal?.aborted) {
        console.error(`Agent ${agent.name} deliberation error:`, err);
      }
    }
  }

  // ── Move selection (resumes agent's persistent session) ────────────

  private async requestMove(
    agent: AgentConfig,
    teamAgents: AgentConfig[],
    team: Team,
    deliberation: DeliberationState,
    legalMoves: string[]
  ): Promise<string> {
    let chosenMove: string | null = null;
    const sessionId = this.agentSessions.get(agent.id);

    const server = this.createMoveSelectionServer(
      agent,
      deliberation,
      legalMoves,
      (move) => { chosenMove = move; }
    );

    const prompt = buildMoveSelectionPrompt(
      this.state.fen, legalMoves, deliberation.messages
    );

// Resume the agent's session if we have one — the agent already has
    // full context from the deliberation phase and all prior turns.
    const options = sessionId
      ? {
          resume: sessionId,
          mcpServers: { chess: server },
          maxTurns: 5,
        }
      : {
          model: resolveModel(agent.model),
          systemPrompt: buildAgentSystemPrompt(agent, teamAgents, team),
          mcpServers: { chess: server },
          maxTurns: 5,
          allowedTools: [] as string[],
        };

    try {
      for await (const message of query({ prompt, options })) {
        if (chosenMove) break;

        // Capture session ID if this is somehow the first query
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as any).type === "system" &&
          (message as any).subtype === "init"
        ) {
          const sid = (message as any).session_id;
          if (sid) this.agentSessions.set(agent.id, sid);
        }

        if ("result" in message && typeof (message as any).result === "string") {
          this.emit({
            type: "agent:thinking",
            payload: {
              agentId: agent.id,
              agentName: agent.name,
              content: (message as any).result,
            },
          });
        }
      }
    } catch (err) {
      console.error(`Agent ${agent.name} move selection error:`, err);
    }

    if (!chosenMove) {
      console.warn(`Agent ${agent.name} failed to submit a move. Picking random.`);
      chosenMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    }

    return chosenMove;
  }
}
