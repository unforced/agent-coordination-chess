import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  GameConfig,
  AgentConfig,
  TeamConfig,
  ServerEvent,
  ClientEvent,
} from "../shared/types.js";
import { GameOrchestrator } from "./orchestrator.js";

// ── Defaults ─────────────────────────────────────────────────────────

function createDefaultConfig(): GameConfig {
  const id = uuidv4();

  const whiteAgents: AgentConfig[] = [
    { id: uuidv4(), name: "Atlas", model: "opus", team: "white" },
    { id: uuidv4(), name: "Nova", model: "sonnet", team: "white" },
    { id: uuidv4(), name: "Cipher", model: "sonnet", team: "white" },
    { id: uuidv4(), name: "Echo", model: "haiku", team: "white" },
  ];

  const blackAgents: AgentConfig[] = [
    { id: uuidv4(), name: "Sage", model: "opus", team: "black" },
    { id: uuidv4(), name: "Blaze", model: "sonnet", team: "black" },
    { id: uuidv4(), name: "Drift", model: "sonnet", team: "black" },
    { id: uuidv4(), name: "Pulse", model: "haiku", team: "black" },
  ];

  const white: TeamConfig = {
    agents: whiteAgents,
    tokenBudgetPerTurn: 300,
  };

  const black: TeamConfig = {
    agents: blackAgents,
    tokenBudgetPerTurn: 300,
  };

  return {
    id,
    white,
    black,
    deliberationTimeSec: 45,
    createdAt: new Date().toISOString(),
  };
}

// ── State ────────────────────────────────────────────────────────────

const games = new Map<string, GameOrchestrator>();
const gameConfigs = new Map<string, GameConfig>();

// Track which WebSocket clients are subscribed to which games
const subscriptions = new Map<string, Set<WebSocket>>();

function broadcastToGame(gameId: string, event: ServerEvent): void {
  const subs = subscriptions.get(gameId);
  if (!subs) return;
  const data = JSON.stringify(event);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ── Express App ──────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// POST /api/games — create a new game with default config
app.post("/api/games", (_req, res) => {
  const config = createDefaultConfig();
  const orchestrator = new GameOrchestrator(config);

  games.set(config.id, orchestrator);
  gameConfigs.set(config.id, config);

  // Wire up event broadcasting
  orchestrator.on((event) => broadcastToGame(config.id, event));

  res.json({ gameId: config.id, config, state: orchestrator.getState() });
});

// POST /api/games/:id/start — start the game
app.post("/api/games/:id/start", (req, res) => {
  const orchestrator = games.get(req.params.id);
  if (!orchestrator) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  try {
    orchestrator.start();
    res.json({ status: "started", state: orchestrator.getState() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/games/:id — get current game state
app.get("/api/games/:id", (req, res) => {
  const orchestrator = games.get(req.params.id);
  if (!orchestrator) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const config = gameConfigs.get(req.params.id);
  res.json({ config, state: orchestrator.getState() });
});

// GET /api/games/:id/log — get full game log
app.get("/api/games/:id/log", (req, res) => {
  const orchestrator = games.get(req.params.id);
  if (!orchestrator) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  res.json({ log: orchestrator.getLog() });
});

// ── HTTP + WebSocket Server ──────────────────────────────────────────

const PORT = 3001;
const server = createServer(app);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let subscribedGameId: string | null = null;

  ws.on("message", (raw) => {
    try {
      const event: ClientEvent = JSON.parse(raw.toString());

      switch (event.type) {
        case "game:subscribe": {
          const { gameId } = event.payload;
          subscribedGameId = gameId;

          if (!subscriptions.has(gameId)) {
            subscriptions.set(gameId, new Set());
          }
          subscriptions.get(gameId)!.add(ws);

          // Send current state immediately
          const orchestrator = games.get(gameId);
          if (orchestrator) {
            ws.send(
              JSON.stringify({
                type: "game:state",
                payload: orchestrator.getState(),
              } satisfies ServerEvent)
            );
          }
          break;
        }

        case "game:create": {
          const config = createDefaultConfig();
          const orchestrator = new GameOrchestrator(config);
          games.set(config.id, orchestrator);
          gameConfigs.set(config.id, config);
          orchestrator.on((evt) => broadcastToGame(config.id, evt));

          ws.send(
            JSON.stringify({
              type: "game:state",
              payload: orchestrator.getState(),
            } satisfies ServerEvent)
          );
          break;
        }

        case "game:start": {
          const orchestrator = games.get(event.payload.gameId);
          if (orchestrator) {
            orchestrator.start();
          }
          break;
        }
      }
    } catch (err) {
      console.error("WebSocket message parse error:", err);
    }
  });

  ws.on("close", () => {
    if (subscribedGameId) {
      subscriptions.get(subscribedGameId)?.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chess orchestration server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
