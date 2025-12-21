const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

function stateFromGame(room) {
  const board = room.chess.board().map(row =>
    row.map(p => (p ? { type: p.type, color: p.color } : null))
  );

  return {
    board,
    turn: room.chess.turn(),
    inCheck: room.chess.inCheck(),
    gameOver: room.chess.isGameOver(),
    outcome: room.chess.isGameOver() ? room.chess.result() : null,
    players: {
      w: room.players.w ? { name: room.players.w.name } : null,
      b: room.players.b ? { name: room.players.b.name } : null,
    },
  };
}

let waiting = null;                 // socket esperando rival
const rooms = new Map();            // roomId -> { chess, players }

function cleanupRoom(roomId) {
  rooms.delete(roomId);
}

io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.data.color = null;
  socket.data.name = null;

  socket.on("findMatch", ({ name } = {}) => {
    const cleanName = (String(name || "").trim().slice(0, 18)) || "Jugador";
    socket.data.name = cleanName;

    // Si ya está en un room, no lo encolamos otra vez
    if (socket.data.roomId) return;

    // Si alguien estaba esperando y sigue conectado, matcheamos
    if (waiting && waiting.id !== socket.id && io.sockets.sockets.get(waiting.id)) {
      const roomId = `room_${waiting.id}_${socket.id}`;
      const chess = new Chess();

      const room = {
        chess,
        players: {
          w: { socket: waiting, name: waiting.data.name || "Jugador" },
          b: { socket, name: socket.data.name || "Jugador" },
        },
      };

      rooms.set(roomId, room);

      // set data
      waiting.data.roomId = roomId;
      waiting.data.color = "w";
      socket.data.roomId = roomId;
      socket.data.color = "b";

      // join
      waiting.join(roomId);
      socket.join(roomId);

      // notify
      const state = stateFromGame(room);
      waiting.emit("matchFound", { color: "w", state });
      socket.emit("matchFound", { color: "b", state });

      io.to(roomId).emit("system", {
        text: `Partida encontrada: ${room.players.w.name} (Blancas) vs ${room.players.b.name} (Negras)`
      });

      waiting = null;
      return;
    }

    // Si no hay nadie esperando, este espera
    waiting = socket;
    socket.emit("waiting");
    socket.emit("system", { text: "Buscando rival…" });
  });

  socket.on("move", (payload, cb) => {
    try {
      const { from, to, promotion } = payload || {};
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en una partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      const myColor = socket.data.color;
      if (!myColor) return cb?.({ ok: false, error: "Sin color asignado." });

      if (room.chess.turn() !== myColor) return cb?.({ ok: false, error: "No es tu turno." });

      const move = room.chess.move({ from, to, promotion: promotion || "q" });
      if (!move) return cb?.({ ok: false, error: "Movimiento inválido." });

      const state = stateFromGame(room);
      io.to(roomId).emit("state", state);
      cb?.({ ok: true });
    } catch (e) {
      // ✅ nunca crashear por un click inválido
      cb?.({ ok: false, error: "Movimiento inválido." });
    }
  });

  socket.on("chat", ({ name, text } = {}) => {
    const roomId = socket.data.roomId;
    const safeName = (String(name || socket.data.name || "Jugador").trim().slice(0, 18)) || "Jugador";
    const safeText = String(text || "").trim().slice(0, 200);
    if (!safeText) return;

    if (roomId) io.to(roomId).emit("chat", { name: safeName, text: safeText });
    else socket.emit("chat", { name: safeName, text: safeText });
  });

  socket.on("disconnect", () => {
    // Si estaba esperando
    if (waiting && waiting.id === socket.id) waiting = null;

    // Si estaba en un room, avisar al rival
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const opp = socket.data.color === "w" ? room.players.b?.socket : room.players.w?.socket;
    if (opp && io.sockets.sockets.get(opp.id)) {
      opp.data.roomId = null;
      opp.data.color = null;
      opp.leave(roomId);
      opp.emit("opponentLeft");
    }

    cleanupRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
