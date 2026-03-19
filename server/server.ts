import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type {
  GameConfig,
  AgentConfig,
  SeriesConfig,
  SeriesState,
  ServerEvent,
  ClientEvent,
} from "../shared/types.js";
import { GameOrchestrator } from "./orchestrator.js";
import { runSeries, getActiveSeries, getAllActiveSeries } from "./series.js";
import { PERSONALITIES } from "./personalities.js";

// ── State ────────────────────────────────────────────────────────────

const games = new Map<string, GameOrchestrator>();
const gameConfigs = new Map<string, GameConfig>();

// WebSocket subscriptions
const gameSubscriptions = new Map<string, Set<WebSocket>>();
const seriesSubscriptions = new Map<string, Set<WebSocket>>();

function broadcastToGame(gameId: string, event: ServerEvent): void {
  const subs = gameSubscriptions.get(gameId);
  if (!subs) return;
  const data = JSON.stringify(event);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastToSeries(seriesId: string, state: SeriesState): void {
  const subs = seriesSubscriptions.get(seriesId);
  if (!subs) return;
  const event: ServerEvent = { type: "series:state", payload: state };
  const data = JSON.stringify(event);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function sendGameInit(ws: WebSocket, gameId: string, orchestrator: GameOrchestrator): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const config = gameConfigs.get(gameId) ?? orchestrator.getConfig();
  ws.send(JSON.stringify({ type: "game:config", payload: config } satisfies ServerEvent));
  ws.send(JSON.stringify({ type: "game:state", payload: orchestrator.getState() } satisfies ServerEvent));
}

function registerGame(gameId: string, orchestrator: GameOrchestrator): void {
  games.set(gameId, orchestrator);
  gameConfigs.set(gameId, orchestrator.getConfig());
  orchestrator.on((event) => broadcastToGame(gameId, event));

  // Auto-subscribe all series watchers to the new game
  // Find which series this game belongs to by checking active series
  for (const [seriesId, subs] of seriesSubscriptions) {
    const runner = getActiveSeries(seriesId);
    if (runner?.state.currentGameId === gameId) {
      if (!gameSubscriptions.has(gameId)) {
        gameSubscriptions.set(gameId, new Set());
      }
      for (const ws of subs) {
        gameSubscriptions.get(gameId)!.add(ws);
        sendGameInit(ws, gameId, orchestrator);
      }
    }
  }
}

// ── Default configs ──────────────────────────────────────────────────

function createDefaultSeriesConfig(): SeriesConfig {
  return {
    id: uuidv4(),
    totalGames: 3,
    white: {
      personalityIds: ["fischer", "petrosian", "tal", "rookie"],
    },
    black: {
      personalityIds: ["kasparov", "capablanca", "morphy", "patzer"],
    },
    gameTimeSec: 15 * 60,
    agentTurnTimeSec: 15,
    createdAt: new Date().toISOString(),
  };
}

// Also keep a simple single-game config for backwards compat
function createDefaultGameConfig(): GameConfig {
  const id = uuidv4();
  const makeAgent = (name: string, team: "white" | "black", pid: string): AgentConfig => ({
    id: uuidv4(),
    name: PERSONALITIES[pid].name,
    model: PERSONALITIES[pid].model,
    team,
    personalityId: pid,
  });

  return {
    id,
    white: {
      agents: [
        makeAgent("Fischer", "white", "fischer"),
        makeAgent("Petrosian", "white", "petrosian"),
        makeAgent("Tal", "white", "tal"),
        makeAgent("Rookie", "white", "rookie"),
      ],
    },
    black: {
      agents: [
        makeAgent("Kasparov", "black", "kasparov"),
        makeAgent("Capablanca", "black", "capablanca"),
        makeAgent("Morphy", "black", "morphy"),
        makeAgent("Patzer", "black", "patzer"),
      ],
    },
    gameTimeSec: 15 * 60,
    agentTurnTimeSec: 15,
    createdAt: new Date().toISOString(),
  };
}

// ── Express App ──────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// Single game (no series)
app.post("/api/games", (_req, res) => {
  const config = createDefaultGameConfig();
  const orchestrator = new GameOrchestrator(config);

  games.set(config.id, orchestrator);
  gameConfigs.set(config.id, config);
  orchestrator.on((event) => broadcastToGame(config.id, event));

  res.json({ gameId: config.id, config, state: orchestrator.getState() });
});

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

app.get("/api/games/:id", (req, res) => {
  const orchestrator = games.get(req.params.id);
  if (!orchestrator) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const config = gameConfigs.get(req.params.id);
  res.json({ config, state: orchestrator.getState() });
});

// Series endpoints
app.post("/api/series", (req, res) => {
  const config: SeriesConfig = {
    ...createDefaultSeriesConfig(),
    ...req.body,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };

  // Start series in background
  runSeries(
    config,
    (gameId, orchestrator) => registerGame(gameId, orchestrator),
    (state) => broadcastToSeries(config.id, state)
  ).catch((err) => {
    console.error("Series error:", err);
  });

  res.json({ seriesId: config.id, config });
});

app.get("/api/series/:id", (req, res) => {
  const runner = getActiveSeries(req.params.id);
  if (!runner) {
    res.status(404).json({ error: "Series not found or completed" });
    return;
  }

  res.json({
    config: runner.config,
    state: runner.state,
    currentGameState: runner.currentOrchestrator?.getState() ?? null,
  });
});

// What's currently running? Used by frontend to rejoin on page load.
app.get("/api/active", (_req, res) => {
  // Check for active series first
  const series = getAllActiveSeries();
  if (series.length > 0) {
    const runner = series[0]; // just return the first active one
    res.json({
      type: "series",
      seriesId: runner.seriesId,
      seriesState: runner.state,
      currentGameId: runner.state.currentGameId,
      currentGameState: runner.currentOrchestrator?.getState() ?? null,
      config: runner.config,
    });
    return;
  }

  // Check for active single games
  for (const [gameId, orchestrator] of games) {
    const state = orchestrator.getState();
    if (state.phase !== "complete") {
      const config = gameConfigs.get(gameId);
      res.json({
        type: "game",
        gameId,
        gameState: state,
        config,
      });
      return;
    }
  }

  res.json({ type: "none" });
});

app.get("/api/personalities", (_req, res) => {
  res.json(Object.values(PERSONALITIES).map((p) => ({
    id: p.id,
    name: p.name,
    model: p.model,
    description: p.systemPromptFragment.slice(0, 100) + "...",
  })));
});

// ── HTTP + WebSocket Server ──────────────────────────────────────────

const PORT = 3001;
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let subscribedGameId: string | null = null;
  let subscribedSeriesId: string | null = null;

  ws.on("message", (raw) => {
    try {
      const event: ClientEvent = JSON.parse(raw.toString());

      switch (event.type) {
        case "game:subscribe": {
          const { gameId } = event.payload;
          subscribedGameId = gameId;

          if (!gameSubscriptions.has(gameId)) {
            gameSubscriptions.set(gameId, new Set());
          }
          gameSubscriptions.get(gameId)!.add(ws);

          const orchestrator = games.get(gameId);
          if (orchestrator) {
            sendGameInit(ws, gameId, orchestrator);
          }
          break;
        }

        case "series:subscribe": {
          const { seriesId } = event.payload;
          subscribedSeriesId = seriesId;

          if (!seriesSubscriptions.has(seriesId)) {
            seriesSubscriptions.set(seriesId, new Set());
          }
          seriesSubscriptions.get(seriesId)!.add(ws);

          const runner = getActiveSeries(seriesId);
          if (runner) {
            ws.send(JSON.stringify({
              type: "series:state",
              payload: runner.state,
            } satisfies ServerEvent));

            if (runner.state.currentGameId && runner.currentOrchestrator) {
              const gid = runner.state.currentGameId;
              if (!gameSubscriptions.has(gid)) {
                gameSubscriptions.set(gid, new Set());
              }
              gameSubscriptions.get(gid)!.add(ws);
              subscribedGameId = gid;

              sendGameInit(ws, gid, runner.currentOrchestrator);
            }
          }
          break;
        }

        case "game:create": {
          const config = createDefaultGameConfig();
          const orchestrator = new GameOrchestrator(config);
          games.set(config.id, orchestrator);
          gameConfigs.set(config.id, config);
          orchestrator.on((evt) => broadcastToGame(config.id, evt));

          sendGameInit(ws, config.id, orchestrator);
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
      gameSubscriptions.get(subscribedGameId)?.delete(ws);
    }
    if (subscribedSeriesId) {
      seriesSubscriptions.get(subscribedSeriesId)?.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chess orchestration server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
