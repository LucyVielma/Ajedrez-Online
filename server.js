const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   Config: Wallet / Apuestas
   ========================= */
const STARTING_COINS = Number(process.env.STARTING_COINS || 150);
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT || 0.05);

// Rango recomendado (editable por ENV)
const MIN_WAGER = Number(process.env.MIN_WAGER || 20);
const MAX_WAGER = Number(process.env.MAX_WAGER || 50);

// “Banca” de la plataforma (solo para mostrar que el fee existe)
let platformBank = 0;

function asInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const i = Math.floor(x);
  if (i <= 0) return null;
  return i;
}

/* =========================
   Helpers compat chess.js
   ========================= */
function hasFn(obj, fn) {
  return obj && typeof obj[fn] === "function";
}
function callAny(obj, names, fallback = false) {
  for (const n of names) {
    if (hasFn(obj, n)) {
      try { return !!obj[n](); } catch { /* ignore */ }
    }
  }
  return fallback;
}
function getTurn(chess) {
  if (hasFn(chess, "turn")) return chess.turn();
  if (hasFn(chess, "turnColor")) return chess.turnColor();
  return "w";
}
function getBoard(chess) {
  // chess.board() suele existir
  const b = hasFn(chess, "board") ? chess.board() : [];
  return b.map(row =>
    row.map(p => (p ? { type: p.type, color: p.color } : null))
  );
}
function getInCheck(chess) {
  return callAny(chess, ["inCheck", "isCheck", "in_check"], false);
}
function isGameOver(chess) {
  return callAny(chess, ["isGameOver", "game_over", "isGameOver"], false);
}
function isCheckmate(chess) {
  return callAny(chess, ["isCheckmate", "inCheckmate", "in_checkmate"], false);
}
function isStalemate(chess) {
  return callAny(chess, ["isStalemate", "inStalemate", "in_stalemate"], false);
}
function isInsufficient(chess) {
  return callAny(chess, ["isInsufficientMaterial", "insufficientMaterial", "insufficient_material"], false);
}
function isThreefold(chess) {
  return callAny(chess, ["isThreefoldRepetition", "inThreefoldRepetition", "in_threefold_repetition"], false);
}
function isFiftyMoves(chess) {
  return callAny(chess, ["isDrawByFiftyMoves", "inFiftyMoveRule", "in_draw_by_fifty_moves"], false);
}
function getResultString(chess) {
  // No dependemos de chess.result() porque varía por versión.
  if (isCheckmate(chess)) return "Jaque mate";
  if (isStalemate(chess)) return "Tablas por ahogado";
  if (isInsufficient(chess)) return "Tablas por material insuficiente";
  if (isThreefold(chess)) return "Tablas por triple repetición";
  if (isFiftyMoves(chess)) return "Tablas por regla de 50 movimientos";
  if (callAny(chess, ["isDraw", "inDraw", "in_draw"], false)) return "Tablas";
  if (isGameOver(chess)) return "Fin de partida";
  return null;
}

/* =========================
   Apuestas: estado y settlement
   ========================= */
function initWager() {
  return {
    offer: null,     // { bySocketId, byColor, byName, amount }
    active: false,   // true cuando ambos depositan y hay pote
    amount: 0,       // amount por jugador cuando está activa
    pot: 0,          // amount*2
    feePct: PLATFORM_FEE_PCT,
    last: null       // { type:'win'|'draw', amount, pot, fee, winnerColor, winnerName, netToWinner }
  };
}

function winnerColorFromCheckmate(chess) {
  if (!isCheckmate(chess)) return null;
  // En ajedrez: si hay jaque mate, le toca mover al que perdió.
  const turn = getTurn(chess);
  return turn === "w" ? "b" : "w";
}

function maybeFinalizeFromChess(room, roomId) {
  if (!room || room.ended) return;

  if (!isGameOver(room.chess)) return;

  const outcome = getResultString(room.chess) || "Fin de partida";

  if (isCheckmate(room.chess)) {
    const winnerColor = winnerColorFromCheckmate(room.chess);
    room.ended = { type: "win", outcome, winnerColor };
    room.drawOffer = null;
    if (room.wager) room.wager.offer = null;

    const winnerName = room.players[winnerColor]?.name || "Jugador";
    io.to(roomId).emit("system", { text: `¡${outcome}! Ganan ${winnerName}.` });
  } else {
    room.ended = { type: "draw", outcome };
    room.drawOffer = null;
    if (room.wager) room.wager.offer = null;

    io.to(roomId).emit("system", { text: outcome });
  }

  settleWagerIfNeeded(room, roomId);
}

function settleWagerIfNeeded(room, roomId) {
  if (!room?.wager?.active) return;
  if (!room.ended) return;

  const amt = room.wager.amount;
  const pot = room.wager.pot;

  // Por seguridad
  room.wager.active = false;
  room.wager.amount = 0;
  room.wager.pot = 0;

  if (room.ended.type === "win" && room.ended.winnerColor) {
    const winnerColor = room.ended.winnerColor;
    const fee = Math.floor(pot * room.wager.feePct);
    const net = pot - fee;

    room.wallets[winnerColor] = (room.wallets[winnerColor] || 0) + net;
    platformBank += fee;

    const winnerName = room.players[winnerColor]?.name || "Jugador";
    room.wager.last = {
      type: "win",
      amount: amt,
      pot,
      fee,
      winnerColor,
      winnerName,
      netToWinner: net,
    };

    io.to(roomId).emit("system", {
      text: `Apuesta resuelta: ${winnerName} gana ${net} 🪙. Fee plataforma: ${fee} 🪙 (5%).`
    });
    return;
  }

  // draw → se devuelve lo apostado
  room.wallets.w = (room.wallets.w || 0) + amt;
  room.wallets.b = (room.wallets.b || 0) + amt;

  room.wager.last = {
    type: "draw",
    amount: amt,
    pot,
    fee: 0,
    winnerColor: null,
    winnerName: null,
    netToWinner: 0,
  };

  io.to(roomId).emit("system", { text: `Apuesta anulada por tablas: se devolvieron ${amt} 🪙 a cada jugador.` });
}

/* =========================
   Matchmaking simple (sin códigos de sala)
   ========================= */
let waiting = null; // socket esperando
const rooms = new Map(); // roomId -> roomObj

function makeRoomId(a, b) {
  return `room_${a}_${b}`;
}

function stateFromRoom(room) {
  const chess = room.chess;

  const ended = room.ended; // { type:'draw'|'win', outcome:string, winnerColor? }
  const chessOver = isGameOver(chess);

  const claimReasons = [];
  if (isThreefold(chess)) claimReasons.push("triple");
  if (isFiftyMoves(chess)) claimReasons.push("fifty");

  const outcome =
    ended?.outcome ||
    (chessOver ? getResultString(chess) : null);

  return {
    board: getBoard(chess),
    turn: getTurn(chess),
    inCheck: getInCheck(chess),

    gameOver: !!ended || chessOver,
    outcome: outcome,

    players: {
      w: room.players.w ? { name: room.players.w.name, wallet: room.wallets?.w ?? STARTING_COINS } : null,
      b: room.players.b ? { name: room.players.b.name, wallet: room.wallets?.b ?? STARTING_COINS } : null,
    },

    // tablas
    drawOffer: room.drawOffer
      ? { by: room.drawOffer.byColor, byName: room.drawOffer.byName }
      : null,

    claimDraw: {
      available: claimReasons.length > 0 && !ended && !chessOver,
      reasons: claimReasons, // ['triple','fifty']
    },

    // apuestas
    wager: {
      offer: room.wager?.offer
        ? { by: room.wager.offer.byColor, byName: room.wager.offer.byName, amount: room.wager.offer.amount }
        : null,
      active: room.wager?.active
        ? { amount: room.wager.amount, pot: room.wager.pot, feePct: room.wager.feePct }
        : null,
      last: room.wager?.last || null,
    }
  };
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("state", stateFromRoom(room));
}

function opponentOf(room, color) {
  return color === "w" ? room.players.b?.socket : room.players.w?.socket;
}

/* =========================
   Socket
   ========================= */
io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.data.color = null;
  socket.data.name = null;

  socket.on("findMatch", ({ name } = {}) => {
    const cleanName = (String(name || "").trim().replace(/\s+/g, " ").slice(0, 18)) || "Jugador";
    socket.data.name = cleanName;

    // ya en partida
    if (socket.data.roomId) return;

    // si hay alguien esperando, crear partida
    if (waiting && waiting.id !== socket.id && io.sockets.sockets.get(waiting.id)) {
      const roomId = makeRoomId(waiting.id, socket.id);
      const chess = new Chess();

      const room = {
        chess,
        ended: null,
        drawOffer: null,
        wager: initWager(),

        wallets: { w: STARTING_COINS, b: STARTING_COINS },

        players: {
          w: { socket: waiting, name: waiting.data.name || "Jugador" },
          b: { socket, name: socket.data.name || "Jugador" },
        }
      };

      rooms.set(roomId, room);

      waiting.data.roomId = roomId;
      waiting.data.color = "w";
      socket.data.roomId = roomId;
      socket.data.color = "b";

      waiting.join(roomId);
      socket.join(roomId);

      const st = stateFromRoom(room);
      waiting.emit("matchFound", { color: "w", state: st });
      socket.emit("matchFound", { color: "b", state: st });

      io.to(roomId).emit("system", {
        text: `Partida encontrada: ${room.players.w.name} (Blancas) vs ${room.players.b.name} (Negras) — Wallet inicial: ${STARTING_COINS} 🪙`
      });

      waiting = null;
      return;
    }

    // si no, esperar
    waiting = socket;
    socket.emit("waiting");
    socket.emit("system", { text: "Buscando rival…" });
  });

  /* =========================
     MOVER (IMPORTANTÍSIMO)
     ✅ Aquí NO existe la regla falsa de “pieza protegida”
     ✅ Solo valida chess.js (legalidad real del ajedrez)
     ========================= */
  socket.on("move", (payload, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en una partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      // si terminó por acuerdo u otra razón
      if (room.ended || isGameOver(room.chess)) {
        return cb?.({ ok: false, error: "La partida ya terminó." });
      }

      const myColor = socket.data.color;
      if (!myColor) return cb?.({ ok: false, error: "Sin color asignado." });

      if (getTurn(room.chess) !== myColor) return cb?.({ ok: false, error: "No es tu turno." });

      const { from, to, promotion } = payload || {};
      if (!from || !to) return cb?.({ ok: false, error: "Movimiento inválido." });

      // ⚠️ chess.js decide si es legal. Punto.
      const move = room.chess.move({ from, to, promotion: promotion || "q" });

      if (!move) return cb?.({ ok: false, error: "Movimiento inválido." });

      // al hacer un movimiento válido, cualquier oferta de tablas queda cancelada
      room.drawOffer = null;

      // si la partida termina por reglas de chess.js, la finalizamos y resolvemos apuesta
      maybeFinalizeFromChess(room, roomId);

      broadcastState(roomId);
      return cb?.({ ok: true });
    } catch (e) {
      return cb?.({ ok: false, error: "Movimiento inválido." });
    }
  });

  /* =========================
     APUESTAS: Ofrecer / Responder
     ========================= */
  socket.on("offerWager", ({ amount } = {}, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      if (room.ended || isGameOver(room.chess)) return cb?.({ ok: false, error: "La partida ya terminó." });

      const myColor = socket.data.color;
      const myName = socket.data.name || "Jugador";
      if (!myColor) return cb?.({ ok: false, error: "Sin color asignado." });

      if (room.wager?.active) return cb?.({ ok: false, error: "Ya hay una apuesta activa." });
      if (room.wager?.offer) return cb?.({ ok: false, error: "Ya hay una oferta de apuesta pendiente." });

      const amt = asInt(amount);
      if (!amt) return cb?.({ ok: false, error: "Monto inválido." });

      if (amt < MIN_WAGER || amt > MAX_WAGER) {
        return cb?.({ ok: false, error: `Monto fuera de rango. Debe ser entre ${MIN_WAGER} y ${MAX_WAGER}.` });
      }

      const myWallet = room.wallets?.[myColor] ?? STARTING_COINS;
      const oppColor = myColor === "w" ? "b" : "w";
      const oppWallet = room.wallets?.[oppColor] ?? STARTING_COINS;

      if (amt > myWallet) return cb?.({ ok: false, error: "No tienes suficientes monedas." });
      if (amt > oppWallet) return cb?.({ ok: false, error: "El rival no tiene suficientes monedas para esa apuesta." });

      room.wager.offer = { bySocketId: socket.id, byColor: myColor, byName: myName, amount: amt };

      const opp = opponentOf(room, myColor);
      if (opp) opp.emit("wagerOffered", { byName: myName, amount: amt });

      io.to(roomId).emit("system", { text: `${myName} propuso una apuesta de ${amt} 🪙 por jugador.` });
      broadcastState(roomId);

      return cb?.({ ok: true });
    } catch {
      return cb?.({ ok: false, error: "No se pudo proponer la apuesta." });
    }
  });

  socket.on("respondWager", ({ accept } = {}, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      if (room.ended || isGameOver(room.chess)) return cb?.({ ok: false, error: "La partida ya terminó." });

      if (!room.wager?.offer) return cb?.({ ok: false, error: "No hay oferta de apuesta." });

      // Evitar que el mismo que ofreció acepte su propia oferta
      if (room.wager.offer.bySocketId === socket.id) {
        return cb?.({ ok: false, error: "No puedes aceptar tu propia apuesta." });
      }

      const myName = socket.data.name || "Jugador";
      const offerBy = room.wager.offer.byName;
      const amt = room.wager.offer.amount;

      if (accept) {
        // validar saldo de ambos
        const wWallet = room.wallets?.w ?? STARTING_COINS;
        const bWallet = room.wallets?.b ?? STARTING_COINS;
        if (amt > wWallet || amt > bWallet) {
          room.wager.offer = null;
          broadcastState(roomId);
          return cb?.({ ok: false, error: "Saldo insuficiente. La oferta fue cancelada." });
        }

        room.wallets.w = wWallet - amt;
        room.wallets.b = bWallet - amt;

        room.wager.active = true;
        room.wager.amount = amt;
        room.wager.pot = amt * 2;
        room.wager.offer = null;

        io.to(roomId).emit("system", { text: `Apuesta aceptada (${offerBy} ↔ ${myName}): ${amt} 🪙 por jugador. Fee plataforma: 5%.` });
        broadcastState(roomId);
        return cb?.({ ok: true });
      } else {
        const offerSocket = io.sockets.sockets.get(room.wager.offer.bySocketId);
        room.wager.offer = null;

        if (offerSocket) offerSocket.emit("wagerDeclined", { byName: myName });
        io.to(roomId).emit("system", { text: `${myName} rechazó la apuesta.` });
        broadcastState(roomId);

        return cb?.({ ok: true });
      }
    } catch {
      return cb?.({ ok: false, error: "No se pudo responder la apuesta." });
    }
  });

  /* =========================
     TABLAS: Ofrecer / Responder
     ========================= */
  socket.on("offerDraw", (payload, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      if (room.ended || isGameOver(room.chess)) return cb?.({ ok: false, error: "La partida ya terminó." });

      const myColor = socket.data.color;
      const myName = socket.data.name || "Jugador";

      // guardar oferta
      room.drawOffer = { bySocketId: socket.id, byColor: myColor, byName: myName };

      // notificar rival
      const opp = opponentOf(room, myColor);
      if (opp) opp.emit("drawOffered", { byName: myName });

      io.to(roomId).emit("system", { text: `${myName} ofreció tablas.` });
      broadcastState(roomId);

      return cb?.({ ok: true });
    } catch {
      return cb?.({ ok: false, error: "No se pudo ofrecer tablas." });
    }
  });

  socket.on("respondDraw", ({ accept } = {}, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      if (!room.drawOffer) return cb?.({ ok: false, error: "No hay oferta de tablas." });

      // Evitar que el mismo que ofreció acepte su propia oferta
      if (room.drawOffer.bySocketId === socket.id) {
        return cb?.({ ok: false, error: "No puedes aceptar tus propias tablas." });
      }

      if (room.ended || isGameOver(room.chess)) return cb?.({ ok: false, error: "La partida ya terminó." });

      const myName = socket.data.name || "Jugador";
      const offerBy = room.drawOffer.byName;

      if (accept) {
        room.ended = { type: "draw", outcome: "Tablas por acuerdo" };
        room.drawOffer = null;
        if (room.wager) room.wager.offer = null;

        settleWagerIfNeeded(room, roomId);

        io.to(roomId).emit("system", { text: `Tablas acordadas (${offerBy} ↔ ${myName}).` });
        broadcastState(roomId);
        return cb?.({ ok: true });
      } else {
        // rechazar
        const offerSocket = io.sockets.sockets.get(room.drawOffer.bySocketId);
        room.drawOffer = null;

        if (offerSocket) offerSocket.emit("drawDeclined", { byName: myName });
        io.to(roomId).emit("system", { text: `${myName} rechazó tablas.` });
        broadcastState(roomId);

        return cb?.({ ok: true });
      }
    } catch {
      return cb?.({ ok: false, error: "No se pudo responder tablas." });
    }
  });

  /* =========================
     TABLAS: Reclamar (triple / 50)
     ========================= */
  socket.on("claimDraw", (payload, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return cb?.({ ok: false, error: "No estás en partida." });

      const room = rooms.get(roomId);
      if (!room) return cb?.({ ok: false, error: "Partida no encontrada." });

      if (room.ended || isGameOver(room.chess)) return cb?.({ ok: false, error: "La partida ya terminó." });

      const three = isThreefold(room.chess);
      const fifty = isFiftyMoves(room.chess);

      if (!three && !fifty) return cb?.({ ok: false, error: "No hay tablas reclamables ahora mismo." });

      const reason = fifty ? "Tablas por regla de 50 movimientos" : "Tablas por triple repetición";
      room.ended = { type: "draw", outcome: reason };
      room.drawOffer = null;
      if (room.wager) room.wager.offer = null;

      settleWagerIfNeeded(room, roomId);

      io.to(roomId).emit("system", { text: reason });
      broadcastState(roomId);

      return cb?.({ ok: true });
    } catch {
      return cb?.({ ok: false, error: "No se pudo reclamar tablas." });
    }
  });

  /* =========================
     Chat
     ========================= */
  socket.on("chat", ({ name, text } = {}) => {
    const roomId = socket.data.roomId;
    const safeName = (String(name || socket.data.name || "Jugador").trim().slice(0, 18)) || "Jugador";
    const safeText = String(text || "").trim().slice(0, 200);
    if (!safeText) return;

    if (roomId) io.to(roomId).emit("chat", { name: safeName, text: safeText });
    else socket.emit("chat", { name: safeName, text: safeText });
  });

  socket.on("disconnect", () => {
    if (waiting && waiting.id === socket.id) waiting = null;

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const myColor = socket.data.color;
    const opp = opponentOf(room, myColor);

    // limpiar rival
    if (opp && io.sockets.sockets.get(opp.id)) {
      opp.data.roomId = null;
      opp.data.color = null;
      opp.leave(roomId);
      opp.emit("opponentLeft");
    }

    rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
