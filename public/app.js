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

const joinBtn = document.getElementById("joinBtn");
const resetBtn = document.getElementById("resetBtn");

// Tablas
const offerDrawBtn = document.getElementById("offerDrawBtn");
const claimDrawBtn = document.getElementById("claimDrawBtn");
const drawBar = document.getElementById("drawBar");
const drawBarText = document.getElementById("drawBarText");
const drawAcceptBtn = document.getElementById("drawAcceptBtn");
const drawDeclineBtn = document.getElementById("drawDeclineBtn");

// Modal nombre
const nameModal = document.getElementById("nameModal");
const nameInput = document.getElementById("nameInput");
const nameOk = document.getElementById("nameOk");
const nameCancel = document.getElementById("nameCancel");

// Modal promoción
const promoModal = document.getElementById("promoModal");
const promoBtns = document.querySelectorAll(".promoBtn");
const promoCancel = document.getElementById("promoCancel");

let myName = "";
let joined = false;
let myColor = null; // 'w'|'b'
let currentState = null;

let selected = null;
let lastBad = null;

// para promoción
let pendingPromotionMove = null; // {from,to}

const SVG_CACHE = new Map();
const SVG_PROMISES = new Map();

/**
 * Carga SVG desde /public/pieces/
 * - Prioriza archivos específicos por color: wk.svg, bq.svg, etc.
 * - Fallback a genéricos por tipo: k.svg, q.svg, r.svg, b.svg, n.svg, p.svg
 *
 * Para cambiar los iconos: reemplaza esos archivos en /public/pieces/
 * (idealmente usando fill="currentColor" dentro del SVG).
 */
function fetchSvgFile(name) {
  if (SVG_CACHE.has(name)) return Promise.resolve(SVG_CACHE.get(name));
  if (SVG_PROMISES.has(name)) return SVG_PROMISES.get(name);

  const p = fetch(`/pieces/${name}.svg`, { cache: "no-store" })
    .then(r => (r.ok ? r.text() : null))
    .then(txt => {
      if (txt) SVG_CACHE.set(name, txt);
      return txt;
    })
    .catch(() => null);

  SVG_PROMISES.set(name, p);
  return p;
}

function getSvgForPiece(piece) {
  const specific = `${piece.color}${piece.type}`; // wk, bp...
  const generic = `${piece.type}`; // k,q,r,b,n,p
  return SVG_CACHE.get(specific) || SVG_CACHE.get(generic) || null;
}

async function ensureSvgForPiece(piece) {
  const specific = `${piece.color}${piece.type}`;
  const generic = `${piece.type}`;

  let svg = SVG_CACHE.get(specific) || SVG_CACHE.get(generic);
  if (svg) return svg;

  svg = await fetchSvgFile(specific);
  if (!svg) svg = await fetchSvgFile(generic);
  return svg;
}

function updatePromoIcons() {
  // pinta iconos de promoción según mi color (si aún no tengo, usa blancas)
  const c = myColor || "w";
  promoBtns.forEach(btn => {
    const t = btn.dataset.p; // q r b n
    const svg = getSvgForPiece({ color: c, type: t });
    if (svg) {
      btn.innerHTML = svg;
      // Por si el SVG no trae class="svgPiece"
      const el = btn.querySelector("svg");
      if (el) el.classList.add("svgPiece");
    }
  });
}

// Precarga los SVG base (y si existen los específicos por color)
(function preloadSvgs() {
  const types = ["k", "q", "r", "b", "n", "p"];
  const jobs = [];
  for (const t of types) {
    jobs.push(fetchSvgFile(t));
    jobs.push(fetchSvgFile(`w${t}`));
    jobs.push(fetchSvgFile(`b${t}`));
  }
  Promise.all(jobs).then(() => {
    updatePromoIcons();
    if (currentState) renderBoard(currentState);
  });
})();


function setConn(online) {
  dot.classList.toggle("on", online);
  dot.classList.toggle("off", !online);
  connText.textContent = online ? "Conectado" : "Desconectado";
}

function setJoinUI(state) {
  // 'idle' | 'searching' | 'playing'
  if (state === "idle") {
    joinBtn.disabled = false;
    joinBtn.textContent = "Entrar a jugar";
    matchText.textContent = "-";
    roleText.textContent = "Rol: -";
    msg.textContent = "Presiona “Entrar a jugar” para comenzar.";
    offerDrawBtn.disabled = true;
    claimDrawBtn.disabled = true;
    hideDrawBar();
  }
  if (state === "searching") {
    joinBtn.disabled = true;
    joinBtn.textContent = "Buscando rival…";
    matchText.textContent = "Buscando rival…";
    roleText.textContent = "Rol: -";
    msg.textContent = "Buscando rival…";
    offerDrawBtn.disabled = true;
    claimDrawBtn.disabled = true;
    hideDrawBar();
  }
  if (state === "playing") {
    joinBtn.disabled = true;
    joinBtn.textContent = "En partida";
  }
}

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
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 18);
  return clean || defaultName();
}

function openNameModal() {
  nameModal.classList.remove("hidden");
  nameModal.setAttribute("aria-hidden", "false");
  nameInput.value = sessionStorage.getItem("ajedrez_name") || "";
  setTimeout(() => nameInput.focus(), 0);
}
function closeNameModal() {
  nameModal.classList.add("hidden");
  nameModal.setAttribute("aria-hidden", "true");
}

function openPromoModal() {
  promoModal.classList.remove("hidden");
  promoModal.setAttribute("aria-hidden", "false");
}
function closePromoModal() {
  promoModal.classList.add("hidden");
  promoModal.setAttribute("aria-hidden", "true");
  pendingPromotionMove = null;
}

function showDrawBar(text) {
  drawBarText.textContent = text;
  drawBar.classList.remove("hidden");
}
function hideDrawBar() {
  drawBar.classList.add("hidden");
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

  const svg = getSvgForPiece(piece);
  if (svg) {
    span.innerHTML = svg;
    // Por si el SVG no trae class="svgPiece"
    const el = span.querySelector("svg");
    if (el) el.classList.add("svgPiece");
  } else {
    // fallback temporal (por si el SVG aún no cargó o no existe)
    span.textContent = "";
    ensureSvgForPiece(piece).then(s => {
      if (s) {
        span.innerHTML = s;
        const el = span.querySelector("svg");
        if (el) el.classList.add("svgPiece");
      }
    });
  }

  return span;
}


function renderEmptyBoard() {
  currentState = null;
  selected = null;
  lastBad = null;
  clearHighlights();
  hideDrawBar();

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

function updateDrawButtons(state) {
  const playing = !!state && !!myColor && !state.gameOver && state.players?.w && state.players?.b;
  offerDrawBtn.disabled = !playing;
  claimDrawBtn.disabled = !(playing && state.claimDraw?.available);
}

function renderBoard(state) {
  currentState = state;

  whiteName.textContent = state.players.w?.name || "-";
  blackName.textContent = state.players.b?.name || "-";
  turnName.textContent = state.turn === "w" ? "Blancas" : "Negras";

  boardEl.classList.toggle("flipped", myColor === "b");

  matchText.textContent = (!state.players.w || !state.players.b) ? "Buscando rival…" : "Partida en curso";
  roleText.textContent = myColor ? `Rol: ${myColor === "w" ? "Blancas" : "Negras"}` : "Rol: -";

  updateDrawButtons(state);

  if (state.gameOver) {
    msg.textContent = `Partida finalizada: ${state.outcome || "Fin"}`;
    hideDrawBar();
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

  // si hay oferta de tablas y NO es de mí, muestro bar
  if (!state.gameOver && state.drawOffer?.byName) {
    const isMine = (myColor && state.drawOffer.by === myColor) || false;
    if (!isMine) showDrawBar(`${state.drawOffer.byName} ofreció tablas.`);
    else hideDrawBar();
  } else {
    hideDrawBar();
  }
}

function isPromotionNeeded(from, to) {
  const piece = getPieceAtSquare(from);
  if (!piece) return false;
  if (piece.type !== "p") return false;

  // rank final
  const toRank = to[1];
  return (piece.color === "w" && toRank === "8") || (piece.color === "b" && toRank === "1");
}

function sendMove(from, to, promotion = "q") {
  socket.emit("move", { from, to, promotion }, (res) => {
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

/* =========================================
   CLICK EN TABLERO
   ✅ NO existe regla falsa de “pieza protegida”
   ✅ Solo el servidor (chess.js) decide legalidad
   ========================================= */
function onSquareClick(sq) {
  if (!currentState || currentState.gameOver) return;

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

  // si clickeas otra pieza tuya, cambias selección
  if (canSelectPiece(piece)) {
    selected = sq;
    highlightSquare(selected, "sel");
    return;
  }

  const from = selected;
  const to = sq;

  // promoción completa
  if (isPromotionNeeded(from, to)) {
    pendingPromotionMove = { from, to };
    openPromoModal();
    highlightSquare(from, "sel");
    return;
  }

  sendMove(from, to, "q");
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

/* ===== BOTONES ===== */
joinBtn.addEventListener("click", () => {
  if (!socket.connected) {
    msg.textContent = "No hay conexión. Intenta de nuevo…";
    return;
  }
  openNameModal();
});

resetBtn.addEventListener("click", () => {
  sessionStorage.removeItem("ajedrez_name");
  location.reload();
});

// tablas
offerDrawBtn.addEventListener("click", () => {
  if (!currentState || currentState.gameOver) return;
  socket.emit("offerDraw", {}, (res) => {
    if (!res?.ok) msg.textContent = res?.error || "No se pudo ofrecer tablas.";
  });
});

claimDrawBtn.addEventListener("click", () => {
  socket.emit("claimDraw", {}, (res) => {
    if (!res?.ok) msg.textContent = res?.error || "No se pudo reclamar tablas.";
  });
});

drawAcceptBtn.addEventListener("click", () => {
  socket.emit("respondDraw", { accept: true }, () => {});
  hideDrawBar();
});
drawDeclineBtn.addEventListener("click", () => {
  socket.emit("respondDraw", { accept: false }, () => {});
  hideDrawBar();
});

/* ===== MODAL NOMBRE ===== */
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

/* ===== MODAL PROMOCIÓN ===== */
promoCancel.addEventListener("click", () => {
  closePromoModal();
  // no deselecciono, para que el usuario pueda elegir otro destino
  if (selected) highlightSquare(selected, "sel");
});

promoBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    if (!pendingPromotionMove) return;
    const p = btn.dataset.p; // q r b n
    const { from, to } = pendingPromotionMove;
    closePromoModal();
    sendMove(from, to, p);
  });
});

socket.on("chat", ({ name, text }) => addChatLine(name, text));
socket.on("system", ({ text }) => addChatLine("Sistema", text));

socket.on("waiting", () => {
  if (joined) setJoinUI("searching");
});

socket.on("matchFound", ({ color, state }) => {
  myColor = color;
  updatePromoIcons();
  setJoinUI("playing");
  renderBoard(state);
});

socket.on("state", (state) => state && renderBoard(state));

socket.on("drawOffered", ({ byName }) => {
  if (!currentState || currentState.gameOver) return;
  showDrawBar(`${byName} ofreció tablas.`);
});

socket.on("drawDeclined", ({ byName }) => {
  msg.textContent = `${byName} rechazó tablas.`;
});

socket.on("opponentLeft", () => {
  myColor = null;
  updatePromoIcons();
  selected = null;
  lastBad = null;
  pendingPromotionMove = null;
  closePromoModal();

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
