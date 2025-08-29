import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { Chess } from "chess.js";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Room state in-memory (OK for demo). In production, use a DB.
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      chess: new Chess(),
      players: { white: null, black: null },
      lastMove: null,
    });
  }
  return rooms.get(roomId);
}

io.on("connection", (socket) => {
  // Client requests to join a room with a color (or 'auto')
  socket.on("join", ({ roomId, color }) => {
    const room = getRoom(roomId);

    // Auto-assign if needed
    let chosen = color;
    if (color === "auto") {
      if (!room.players.white) {
        chosen = "white";
      } else if (!room.players.black) {
        chosen = "black";
      } else {
        chosen = null; // spectator
      }
    }

    // Reject if already taken
    if (chosen && room.players[chosen] && room.players[chosen] !== socket.id) {
      socket.emit("joinError", { message: `Color ${chosen} already taken` });
      return;
    }

    // Put socket in room
    socket.join(roomId);

    // Assign color if available
    if (chosen && !room.players[chosen]) {
      room.players[chosen] = socket.id;
      socket.data.color = chosen;
    }

    // ✅ Tell this socket what color it got
    if (chosen) {
      socket.emit("colorAssigned", { color: chosen });
    } else {
      socket.emit("colorAssigned", { color: "spectator" });
    }

    // Send current state to this client
    socket.emit("state", {
      fen: room.chess.fen(),
      turn: room.chess.turn(),
      lastMove: room.lastMove,
      players: {
        white: !!room.players.white,
        black: !!room.players.black,
      },
    });

    // Notify the room of current players
    io.to(roomId).emit("players", {
      white: !!room.players.white,
      black: !!room.players.black,
    });
  });

  // Attempt a move
  socket.on("move", ({ roomId, from, to, promotion }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const { chess } = room;

    // Enforce turn by color if socket has a color
    const color = socket.data.color; // 'white' or 'black' or undefined
    if (color) {
      const turnColor = chess.turn() === "w" ? "white" : "black";
      if (turnColor !== color) return; // not your turn
    }

    try {
      const move = chess.move({ from, to, promotion: promotion || "q" });
      if (move) {
        room.lastMove = { from, to, san: move.san };

        io.to(roomId).emit("state", {
          fen: chess.fen(),
          turn: chess.turn(),
          lastMove: room.lastMove,
        });

        if (chess.isGameOver()) {
          io.to(roomId).emit("gameOver", {
            checkmate: chess.isCheckmate(),
            draw: chess.isDraw(),
            stalemate: chess.isStalemate(),
            repetition: chess.isThreefoldRepetition(),
            insufficient: chess.isInsufficientMaterial(),
            winner: chess.isCheckmate()
              ? chess.turn() === "w"
                ? "black"
                : "white"
              : null,
          });
        }
      }
    } catch (e) {
      // invalid move ignored
    }
  });

  // Reset the board
  socket.on("reset", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.chess = new Chess();
    room.lastMove = null;

    io.to(roomId).emit("state", {
      fen: room.chess.fen(),
      turn: room.chess.turn(),
      lastMove: null,
    });
  });

  // Leave a room
  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      if (room.players.white === socket.id) room.players.white = null;
      if (room.players.black === socket.id) room.players.black = null;

      io.to(roomId).emit("players", {
        white: !!room.players.white,
        black: !!room.players.black,
      });
    }
    socket.leave(roomId);
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      if (room.players.white === socket.id) room.players.white = null;
      if (room.players.black === socket.id) room.players.black = null;

      io.to(roomId).emit("players", {
        white: !!room.players.white,
        black: !!room.players.black,
      });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () =>
  console.log(`Chess server running on http://localhost:${PORT}`)
);
