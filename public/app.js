const socket = io();

const dot = document.getElementById("dot");
const connText = document.getElementById("connText");
const matchText = document.getElementById("matchText");
const roleText = document.getElementById("roleText");

const whiteName = document.getElementById("whiteName");
const blackName = document.getElementById("blackName");
const turnName = document.getElementById("turnName");
const msg = document.getElementById("msg");

const boardEl = document.getElementById("board");

const chatLog = document.getElementById("chatLog");
const chatText = document.getElementById("chatText");
const sendBtn = document.getElementById("sendBtn");

// ✅ Botones como 3 en línea
const joinBtn = document.getElementById("joinBtn");
const resetBtn = document.getElementById("resetBtn");

// ✅ Modal nombre
const nameModal = document.getElementById("nameModal");
const nameInput = document.getElementById("nameInput");
const nameOk = document.getElementById("nameOk");
const nameCancel = document.getElementById("nameCancel");

let myName = "";
let joined = false;      // si ya presionó "Entrar a jugar" y está en matchmaking
let myColor = null;      // 'w' | 'b'
let currentState = null;

let selected = null;
let lastBad = null;

const PIECES = {
  w: { k:"♔", q:"♕", r:"♖", b:"♗", n:"♘", p:"♙" },
  b: { k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟" }
};

function setConn(online) {
  dot.classList.toggle("on", online);
  dot.classList.toggle("off", !online);
  connText.textContent = online ? "Conectado" : "Desconectado";
}

function setJoinUI(state) {
  // state: 'idle' | 'searching' | 'playing'
  if (state === "idle") {
    joinBtn.disabled = false;
    joinBtn.textContent = "Entrar a jugar";
    matchText.textContent = "-";
    roleText.textContent = "Rol: -";
    msg.textContent = "Presiona “Entrar a jugar” para comenzar.";
  }
  if (state === "searching") {
    joinBtn.disabled = true;
    joinBtn.textContent = "Buscando rival…";
    matchText.textContent = "Buscando rival…";
    roleText.textContent = "Rol: -";
    msg.textContent = "Buscando rival…";
  }
  if (state === "playing") {
    joinBtn.disabled = true;
    joinBtn.textContent = "En partida";
  }
}

/* nombre único por pestaña (si hace falta default) */
function getTabId() {
  let id = sessionStorage.getItem("ajedrez_tabId");
  if (!id) {
    id = Math.random().toString(36).slice(2, 6).toUpperCase();
    sessionStorage.setItem("ajedrez_tabId", id);
  }
  return id;
}
function defaultName() {
  return `Jugador-${getTabId()}`;
}
function sanitizeName(name) {
  const clean = String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18);
  return clean || defaultName();
}

function openNameModal() {
  nameModal.classList.remove("hidden");
  nameModal.setAttribute("aria-hidden", "false");
  const last = sessionStorage.getItem("ajedrez_name") || "";
  nameInput.value = last;
  setTimeout(() => nameInput.focus(), 0);
}
function closeNameModal() {
  nameModal.classList.add("hidden");
  nameModal.setAttribute("aria-hidden", "true");
}

function fileRankToSquare(fileIdx, rankIdx) {
  const file = String.fromCharCode("a".charCodeAt(0) + fileIdx);
  const rank = 8 - rankIdx;
  return `${file}${rank}`;
}
function squareToCoords(sq) {
  const f = sq.charCodeAt(0) - 97;
  const r = 8 - parseInt(sq[1], 10);
  return { r, f };
}
function getPieceAtSquare(sq) {
  if (!currentState) return null;
  const { r, f } = squareToCoords(sq);
  if (r < 0 || r > 7 || f < 0 || f > 7) return null;
  return currentState.board[r][f];
}

function clearHighlights() {
  boardEl.querySelectorAll(".square.sel, .square.bad")
    .forEach(el => el.classList.remove("sel", "bad"));
}
function highlightSquare(sq, cls) {
  const el = boardEl.querySelector(`.square[data-square="${sq}"]`);
  if (el) el.classList.add(cls);
}

function canSelectPiece(piece) {
  if (!piece) return false;
  if (!myColor) return false;
  if (!currentState) return false;
  if (currentState.gameOver) return false;
  if (currentState.turn !== myColor) return false;
  return piece.color === myColor;
}

function makePieceEl(piece) {
  const span = document.createElement("span");
  span.className = `piece ${piece.color === "w" ? "pw" : "pb"}`;
  span.textContent = PIECES[piece.color][piece.type];
  return span;
}

function renderEmptyBoard() {
  currentState = null;
  selected = null;
  lastBad = null;
  clearHighlights();

  boardEl.classList.remove("flipped");
  boardEl.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = fileRankToSquare(f, r);
      const isLight = ((r + f) % 2 === 0);

      const cell = document.createElement("div");
      cell.className = `square ${isLight ? "light" : "dark"}`;
      cell.dataset.square = sq;

      boardEl.appendChild(cell);
    }
  }
}

function renderBoard(state) {
  currentState = state;

  whiteName.textContent = state.players.w?.name || "-";
  blackName.textContent = state.players.b?.name || "-";
  turnName.textContent = state.turn === "w" ? "Blancas" : "Negras";

  boardEl.classList.toggle("flipped", myColor === "b");

  matchText.textContent = (!state.players.w || !state.players.b) ? "Buscando rival…" : "Partida en curso";
  roleText.textContent = myColor ? `Rol: ${myColor === "w" ? "Blancas" : "Negras"}` : "Rol: -";

  if (state.gameOver) {
    msg.textContent = `Partida finalizada: ${state.outcome || "Fin"}`;
  } else {
    const yourTurn = myColor && state.turn === myColor;
    msg.textContent = yourTurn
      ? (state.inCheck ? "¡Jaque! Es tu turno." : "Es tu turno.")
      : (state.inCheck ? "¡Jaque!" : "Turno del rival.");
  }

  boardEl.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = fileRankToSquare(f, r);
      const isLight = ((r + f) % 2 === 0);

      const cell = document.createElement("div");
      cell.className = `square ${isLight ? "light" : "dark"}`;
      cell.dataset.square = sq;

      const p = state.board[r][f];
      if (p) cell.appendChild(makePieceEl(p));

      cell.addEventListener("click", () => onSquareClick(sq));
      boardEl.appendChild(cell);
    }
  }

  if (selected) highlightSquare(selected, "sel");
  if (lastBad) highlightSquare(lastBad, "bad");
}

function onSquareClick(sq) {
  lastBad = null;
  clearHighlights();

  const piece = getPieceAtSquare(sq);

  if (!selected) {
    if (canSelectPiece(piece)) {
      selected = sq;
      highlightSquare(selected, "sel");
    }
    return;
  }

  if (selected === sq) {
    selected = null;
    return;
  }

  if (canSelectPiece(piece)) {
    selected = sq;
    highlightSquare(selected, "sel");
    return;
  }

  const from = selected;
  const to = sq;

  socket.emit("move", { from, to, promotion: "q" }, (res) => {
    if (!res?.ok) {
      lastBad = to;
      highlightSquare(from, "sel");
      highlightSquare(to, "bad");
      msg.textContent = res?.error || "Movimiento inválido";
      return;
    }
    selected = null;
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function addChatLine(name, text) {
  const p = document.createElement("p");
  p.className = "chatLine";
  p.innerHTML = `<span class="chatName">${escapeHtml(name)}:</span> <span class="chatText">${escapeHtml(text)}</span>`;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  const text = chatText.value.trim();
  if (!text) return;
  socket.emit("chat", { name: myName || "Jugador", text });
  chatText.value = "";
}

sendBtn.addEventListener("click", sendChat);
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

/* ====== BOTONES ====== */
joinBtn.addEventListener("click", () => {
  if (!socket.connected) {
    msg.textContent = "No hay conexión. Intenta de nuevo…";
    return;
  }
  openNameModal();
});

resetBtn.addEventListener("click", () => {
  // reinicio simple como 3 en línea (vuelve al estado inicial)
  sessionStorage.removeItem("ajedrez_name");
  location.reload();
});

/* ====== MODAL ====== */
nameCancel.addEventListener("click", closeNameModal);
nameOk.addEventListener("click", () => {
  const name = sanitizeName(nameInput.value);
  sessionStorage.setItem("ajedrez_name", name);
  myName = name;

  closeNameModal();

  joined = true;
  setJoinUI("searching");
  addChatLine("Sistema", `Conectado como ${myName}. Buscando rival…`);
  renderEmptyBoard();

  socket.emit("findMatch", { name: myName });
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameOk.click();
  if (e.key === "Escape") closeNameModal();
});

socket.on("chat", ({ name, text }) => addChatLine(name, text));
socket.on("system", ({ text }) => addChatLine("Sistema", text));

socket.on("waiting", () => {
  if (joined) setJoinUI("searching");
});

socket.on("matchFound", ({ color, state }) => {
  myColor = color;
  setJoinUI("playing");
  renderBoard(state);
});

socket.on("state", (state) => state && renderBoard(state));

socket.on("opponentLeft", () => {
  myColor = null;
  selected = null;
  lastBad = null;

  whiteName.textContent = "-";
  blackName.textContent = "-";
  turnName.textContent = "-";
  roleText.textContent = "Rol: -";

  renderEmptyBoard();

  if (joined && myName) {
    addChatLine("Sistema", "El rival se fue. Buscando otro rival…");
    setJoinUI("searching");
    socket.emit("findMatch", { name: myName });
  } else {
    addChatLine("Sistema", "El rival se fue.");
    setJoinUI("idle");
  }
});

socket.on("connect", () => {
  setConn(true);

  // ✅ NO auto-entrar, como pediste
  myName = sessionStorage.getItem("ajedrez_name") || "";
  renderEmptyBoard();
  setJoinUI("idle");
  addChatLine("Sistema", "Conectado. Presiona “Entrar a jugar” para comenzar.");
});

socket.on("disconnect", () => {
  setConn(false);
  matchText.textContent = "Desconectado";
  msg.textContent = "Desconectado";
});
