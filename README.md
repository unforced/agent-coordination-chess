# Agent Coordination Chess

Multi-agent chess experiment — teams of Claude agents deliberate and play chess together.

Two teams of 4 agents (1 Opus, 2 Sonnet, 1 Haiku) play chess against each other. Each turn, the team has a deliberation window where agents discuss strategy via a shared message board, then one agent is randomly selected to submit the move. Agents maintain persistent sessions across the entire game, building up context about the position, their teammates' thinking styles, and emergent coordination strategies.

## Architecture

- **Server**: Express + WebSocket, Claude Agent SDK for agent orchestration, chess.js for game logic
- **Client**: React + Vite, react-chessboard for visualization, real-time via WebSocket
- **Agents**: Each agent is a persistent Claude Agent SDK session with MCP tools for message board interaction

## Setup

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Run (requires Claude Code OAuth token)
CLAUDE_CODE_OAUTH_TOKEN=your-token npm run dev
```

The app runs at `http://localhost:5173` with the server on port 3001.

## How It Works

1. Each turn, all 4 agents on the active team deliberate in parallel
2. Agents use `read_messages` and `post_message` MCP tools to discuss via a shared team board
3. After the deliberation timer expires, one agent is randomly selected
4. The selected agent uses `submit_move` to play a legal move
5. Viewers see both team message boards, individual agent thinking streams, and the live board

Agents don't know what model their teammates are running. Over the course of a game, they build up impressions of who thinks well, what strategies work, and how to coordinate effectively.

## Research Context

Early experiment in agent coordination mechanisms — using chess as a substrate to observe how teams of AI agents develop emergent coordination strategies under constraints (time pressure, random selection, communication budgets).
