(() => {
  "use strict";

  const Chess = globalThis.MateItChess;
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const PIECES = {
    K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
    k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟︎"
  };
  const ARROW_COLORS = ["#56c6a4", "#73aee0", "#d6b06d", "#b3a0d7", "#dc91a0", "#6db9be", "#cf9b78", "#91b6a0", "#a9a9d2", "#c6ad7a"];
  const $ = (selector) => document.querySelector(selector);

  const ui = {
    board: $("#chessboard"),
    boardFrame: $(".board-frame"),
    arrows: $("#arrow-layer"),
    empty: $("#board-empty"),
    positionTitle: $("#position-title"),
    positionSubtitle: $("#position-subtitle"),
    plyCount: $("#ply-count"),
    syncState: $("#sync-state"),
    syncLabel: $("#sync-label"),
    historySource: $("#history-source"),
    historySummary: $("#history-summary"),
    moveList: $("#move-list"),
    followButton: $("#follow-source"),
    followLabel: $("#follow-label"),
    analyze: $("#analyze"),
    autoAnalyze: $("#auto-analyze"),
    analysisNotice: $("#analysis-notice"),
    stop: $("#stop"),
    engineStatus: $("#engine-status"),
    engineStatusText: $("#engine-status-text"),
    evalScore: $("#eval-score"),
    evalDepth: $("#eval-depth"),
    evalFill: $("#eval-fill"),
    evalWhiteRail: $("#board-eval-white"),
    evalBlackRail: $("#board-eval-black"),
    candidateList: $("#candidate-list"),
    candidateCount: $("#candidate-count"),
    copyLines: $("#copy-lines"),
    clearAnalysis: $("#clear-analysis"),
    fen: $("#fen-value"),
    copyFen: $("#copy-fen"),
    sourceDetail: $("#source-detail"),
    pgnFile: $("#pgn-file"),
    pgnDialog: $("#pgn-dialog"),
    pgnText: $("#pgn-text"),
    pgnError: $("#pgn-error")
  };

  const state = {
    positions: [START_FEN],
    moves: [],
    currentIndex: 0,
    flipped: false,
    followSource: true,
    source: "none",
    sourceTitle: "",
    sourceUrl: "",
    snapshot: null,
    analysisAllowed: true,
    autoAnalyze: false,
    autoAnalyzePreferenceExplicit: false,
    lines: [],
    selectedRank: 1,
    loading: false,
    requestId: 0,
    engineClient: null,
    currentScore: null,
    headers: {}
  };
  let autoAnalyzeTimer = 0;

  function setSyncState(kind, label) {
    ui.syncState.dataset.state = kind;
    ui.syncLabel.textContent = label;
  }

  function setEngineState(kind, label) {
    ui.engineStatus.dataset.state = kind;
    ui.engineStatusText.textContent = label;
  }

  function currentFen() {
    return state.positions[Math.max(0, Math.min(state.currentIndex, state.positions.length - 1))] || null;
  }

  function renderAutoAnalyzeControl() {
    if (!ui.autoAnalyze) return;
    ui.autoAnalyze.textContent = state.autoAnalyze ? "Auto: On" : "Auto: Off";
    ui.autoAnalyze.setAttribute("aria-pressed", String(state.autoAnalyze));
    ui.autoAnalyze.title = state.autoAnalyze
      ? "Automatic analysis is on. Click to turn it off."
      : "Automatically analyze each new position.";
  }

  function scheduleAutoAnalyze(expectedFen = currentFen()) {
    if (autoAnalyzeTimer) window.clearTimeout(autoAnalyzeTimer);
    autoAnalyzeTimer = 0;
    if (!state.autoAnalyze || !state.analysisAllowed || !expectedFen || state.source === "none") return;
    const expectedSource = state.source;
    autoAnalyzeTimer = window.setTimeout(() => {
      autoAnalyzeTimer = 0;
      if (state.autoAnalyze && state.analysisAllowed && state.source === expectedSource
        && currentFen() === expectedFen && !state.loading) analyze();
    }, 100);
  }

  function setAutoAnalyze(enabled) {
    const next = Boolean(enabled);
    const changed = state.autoAnalyze !== next;
    state.autoAnalyze = next;
    state.autoAnalyzePreferenceExplicit = true;
    render();
    chrome.storage.local.set({ mateitAutoAnalyze: next }).catch(() => {});
    if (!next) {
      if (autoAnalyzeTimer) window.clearTimeout(autoAnalyzeTimer);
      autoAnalyzeTimer = 0;
      return;
    }
    if (state.analysisAllowed && currentFen() && state.source !== "none") {
      if (changed) clearResults("Automatic analysis enabled. Starting Stockfish on the current position…");
      scheduleAutoAnalyze(currentFen());
    }
  }

  async function loadAutoAnalyzePreference() {
    try {
      const stored = await chrome.storage.local.get("mateitAutoAnalyze");
      if (!state.autoAnalyzePreferenceExplicit && typeof stored?.mateitAutoAnalyze === "boolean") {
        state.autoAnalyze = stored.mateitAutoAnalyze;
        state.autoAnalyzePreferenceExplicit = true;
      }
    } catch {
      // The control still works for this window if extension storage is unavailable.
    }
    renderAutoAnalyzeControl();
  }

  function parseFen(fen) {
    if (!fen || typeof fen !== "string") return null;
    const fields = fen.trim().split(/\s+/);
    if (fields.length < 4) return null;
    const rows = fields[0].split("/");
    if (rows.length !== 8) return null;
    const board = [];
    for (const row of rows) {
      const squares = [];
      for (const char of row) {
        if (/^[1-8]$/.test(char)) {
          for (let count = 0; count < Number(char); count += 1) squares.push(".");
        } else if (/^[prnbqkPRNBQK]$/.test(char)) {
          squares.push(char);
        } else return null;
      }
      if (squares.length !== 8) return null;
      board.push(squares);
    }
    return { board, turn: fields[1], halfmove: Number(fields[4] || 0), fullmove: Number(fields[5] || 1) };
  }

  function toSquare(row, col, flipped) {
    const file = flipped ? 7 - col : col;
    const rank = flipped ? row + 1 : 8 - row;
    return "abcdefgh"[file] + rank;
  }

  function renderBoard() {
    const fen = currentFen();
    const parsed = parseFen(fen);
    ui.board.replaceChildren();
    ui.arrows.replaceChildren();
    if (!parsed) {
      ui.empty.classList.add("is-visible");
      return;
    }
    ui.empty.classList.remove("is-visible");
    const lastMove = state.currentIndex > 0 ? state.moves[state.currentIndex - 1] : null;
    const squares = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const squareName = toSquare(row, col, state.flipped);
        const fileIndex = "abcdefgh".indexOf(squareName[0]);
        const rank = Number(squareName[1]);
        const piece = parsed.board[8 - rank][fileIndex];
        const square = document.createElement("div");
        square.className = `square ${((fileIndex + rank) % 2 === 0) ? "dark" : "light"}`;
        square.setAttribute("role", "gridcell");
        square.setAttribute("aria-label", `${squareName}${piece !== "." ? ` ${piece}` : " empty"}`);
        if (lastMove?.from === squareName) square.classList.add("last-from");
        if (lastMove?.to === squareName) square.classList.add("last-to");

        if (col === 0) {
          const coord = document.createElement("span");
          coord.className = "coord";
          coord.textContent = String(rank);
          square.appendChild(coord);
        }
        if (row === 7) {
          const coord = document.createElement("span");
          coord.className = "coord";
          coord.textContent = squareName[0];
          coord.style.left = "auto";
          coord.style.right = "4px";
          coord.style.top = "auto";
          coord.style.bottom = "2px";
          square.appendChild(coord);
        }
        if (piece !== ".") {
          const glyph = document.createElement("span");
          glyph.className = `piece ${piece === piece.toUpperCase() ? "white" : "black"}`;
          glyph.textContent = PIECES[piece];
          square.appendChild(glyph);
        }
        squares.push(square);
      }
    }
    ui.board.append(...squares);
    drawArrows();
  }

  function boardCoords(square, flipped) {
    const file = "abcdefgh".indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    return flipped ? { x: 7 - file, y: rank } : { x: file, y: 7 - rank };
  }

  function drawArrows() {
    ui.arrows.replaceChildren();
    if (!state.lines.length) return;
    const candidates = $("#all-arrows").checked
      ? state.lines
      : [state.lines.find((line) => line.rank === state.selectedRank) || state.lines[0]];
    const ordered = [...candidates].sort((a, b) => Number(b.rank === state.selectedRank) - Number(a.rank === state.selectedRank) || b.rank - a.rank);
    const ns = "http://www.w3.org/2000/svg";
    for (const line of ordered) {
      const move = line.pv?.[0] || line.move;
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move || "")) continue;
      const rank = Number(line.rank) || 1;
      const color = ARROW_COLORS[(rank - 1) % ARROW_COLORS.length];
      const selected = rank === state.selectedRank;
      const opacity = selected ? .98 : .72;
      const from = boardCoords(move.slice(0, 2), state.flipped);
      const to = boardCoords(move.slice(2, 4), state.flipped);
      const sx = from.x + .5, sy = from.y + .5, tx = to.x + .5, ty = to.y + .5;
      const dx = tx - sx, dy = ty - sy, distance = Math.hypot(dx, dy);
      if (distance < .25) continue;
      const ux = dx / distance, uy = dy / distance, px = -uy, py = ux;
      const tip = { x: tx - ux * .13, y: ty - uy * .13 };
      const headLength = Math.min(.48, Math.max(.34, distance * .43));
      const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
      const half = .21;
      const left = { x: base.x + px * half, y: base.y + py * half };
      const right = { x: base.x - px * half, y: base.y - py * half };
      const badge = { x: tip.x - ux * headLength * .7, y: tip.y - uy * headLength * .7 };
      const group = document.createElementNS(ns, "g");
      const lineElement = document.createElementNS(ns, "line");
      for (const [name, value] of Object.entries({ x1: sx + ux * .16, y1: sy + uy * .16, x2: base.x, y2: base.y, stroke: "#11201f", "stroke-width": selected ? .21 : .18, "stroke-linecap": "round", opacity: opacity * .55 })) lineElement.setAttribute(name, String(value));
      group.appendChild(lineElement);
      const colorLine = document.createElementNS(ns, "line");
      for (const [name, value] of Object.entries({ x1: sx + ux * .16, y1: sy + uy * .16, x2: base.x, y2: base.y, stroke: color, "stroke-width": selected ? .105 : .088, "stroke-linecap": "round", opacity })) colorLine.setAttribute(name, String(value));
      group.appendChild(colorLine);
      const head = document.createElementNS(ns, "path");
      head.setAttribute("d", `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`);
      head.setAttribute("fill", color);
      head.setAttribute("stroke", "#12211f");
      head.setAttribute("stroke-width", ".045");
      head.setAttribute("stroke-linejoin", "round");
      head.setAttribute("opacity", String(opacity));
      group.appendChild(head);
      const badgeWidth = rank >= 10 ? .38 : .29;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(badge.x - badgeWidth / 2));
      rect.setAttribute("y", String(badge.y - .13));
      rect.setAttribute("width", String(badgeWidth));
      rect.setAttribute("height", ".26");
      rect.setAttribute("rx", ".09");
      rect.setAttribute("fill", "#10201f");
      rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", selected ? ".05" : ".032");
      group.appendChild(rect);
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(badge.x));
      label.setAttribute("y", String(badge.y + .006));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.setAttribute("fill", "#f5f8f4");
      label.setAttribute("font-family", "ui-monospace, monospace");
      label.setAttribute("font-size", rank >= 10 ? ".145" : ".17");
      label.setAttribute("font-weight", "900");
      label.textContent = String(rank);
      group.appendChild(label);
      ui.arrows.appendChild(group);
    }
  }

  function setFollowing(value) {
    const previousFen = currentFen();
    state.followSource = Boolean(value);
    ui.followButton.classList.toggle("is-following", state.followSource);
    ui.followLabel.textContent = state.followSource ? "Following source" : "Paused · local review";
    if (state.followSource && state.source === "chesscom") {
      state.currentIndex = state.positions.length - 1;
      render();
      if (state.autoAnalyze && previousFen !== currentFen()) {
        clearResults("Latest source position selected. Starting automatic analysis…");
        scheduleAutoAnalyze(currentFen());
      }
    }
  }

  function renderMoveList() {
    ui.moveList.replaceChildren();
    if (!state.moves.length) {
      const empty = document.createElement("div");
      empty.className = "move-empty";
      empty.textContent = state.source === "chesscom" && /\/game\/live(?:\/|$)/i.test(state.sourceUrl)
        ? "Live board synced · move history is not exposed on this Chess.com view."
        : "No moves in this position yet.";
      ui.moveList.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < state.moves.length; index += 2) {
      const whiteMove = state.moves[index];
      const blackMove = state.moves[index + 1];
      const row = document.createElement("div");
      row.className = "move-row";
      const number = document.createElement("span");
      number.className = "move-number";
      number.textContent = String(Math.floor(index / 2) + 1);
      row.appendChild(number);
      for (const [move, plyIndex] of [[whiteMove, index], [blackMove, index + 1]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "move-cell";
        button.textContent = move?.san || "·";
        button.disabled = !move;
        button.setAttribute("aria-label", move ? `Go to ply ${plyIndex + 1}, ${move.san}` : "No black move");
        button.classList.toggle("is-current", state.currentIndex === plyIndex + 1);
        button.addEventListener("click", () => {
          state.currentIndex = plyIndex + 1;
          if (state.source === "chesscom") setFollowing(false);
          render();
        });
        row.appendChild(button);
      }
      fragment.appendChild(row);
    }
    ui.moveList.appendChild(fragment);
  }

  function render() {
    const fen = currentFen();
    const parsed = parseFen(fen);
    const total = state.moves.length;
    const turnText = parsed?.turn === "w" ? "White to move" : parsed?.turn === "b" ? "Black to move" : "Position unavailable";
    const liveSource = state.source === "chesscom" && /\/game\/live(?:\/|$)/i.test(state.sourceUrl);
    const sourceName = state.sourceTitle || (liveSource ? "Chess.com Live Game" : "Chess.com Analysis");
    ui.plyCount.textContent = String(state.currentIndex).padStart(2, "0");
    ui.positionTitle.textContent = state.source === "none" ? "Ready when you are." : state.currentIndex === total ? "Latest position" : `Move ${Math.ceil(state.currentIndex / 2) || 0} · ${turnText}`;
    ui.positionSubtitle.textContent = state.source === "chesscom"
      ? `${turnText} · Synced from ${sourceName}`
      : state.source === "pgn" ? `${turnText} · Imported game review` : "Open Chess.com Analysis or a game page, or load a PGN to begin reviewing.";
    ui.historySummary.textContent = total ? `${total} half-moves · ${Math.ceil(total / 2)} full moves` : (liveSource ? "Following live position" : "No moves yet");
    ui.historySource.textContent = state.source === "chesscom" ? (liveSource ? "CHESS.COM LIVE" : "CHESS.COM ANALYSIS") : state.source === "pgn" ? "IMPORTED PGN" : "WAITING";
    ui.fen.textContent = fen || "No position loaded.";
    ui.copyFen.disabled = !fen || state.source === "none";
    ui.analyze.disabled = !fen || state.source === "none" || state.loading || !state.analysisAllowed;
    renderAutoAnalyzeControl();
    const analysisLocked = state.source === "chesscom" && liveSource && !state.analysisAllowed;
    ui.analysisNotice.hidden = !analysisLocked && !state.autoAnalyze;
    ui.analysisNotice.textContent = analysisLocked
      ? (state.autoAnalyze
        ? "Auto-analysis is on, but Stockfish is paused while you are a participant in an active live game. It will resume for spectator or post-game positions."
        : "The live board will keep syncing, but Stockfish analysis is available only for spectator positions or after the game ends.")
      : state.autoAnalyze
        ? "Auto-analysis is on · Stockfish will analyze each new position locally."
        : "";
    $("#first-move").disabled = state.currentIndex <= 0;
    $("#previous-move").disabled = state.currentIndex <= 0;
    $("#next-move").disabled = state.currentIndex >= total;
    $("#last-move").disabled = state.currentIndex >= total;
    ui.empty.classList.toggle("is-visible", state.source === "none");
    ui.sourceDetail.textContent = state.source === "chesscom" ? `${sourceName} · read-only sync` : state.source === "pgn" ? "PGN loaded locally" : "No source connected";
    if (state.source === "chesscom") setSyncState("connected", `Synced from ${sourceName}`);
    else if (state.source === "pgn") setSyncState("imported", "PGN loaded locally");
    renderBoard();
    renderMoveList();
    if (state.source === "none") ui.candidateCount.textContent = "0 lines";
  }

  function setCurrentIndex(index) {
    const previousFen = currentFen();
    state.currentIndex = Math.max(0, Math.min(state.moves.length, Number(index) || 0));
    if (state.source === "chesscom" && state.currentIndex !== state.moves.length) setFollowing(false);
    render();
    if (state.autoAnalyze && previousFen !== currentFen()) {
      clearResults("Position changed. Starting automatic analysis…");
      scheduleAutoAnalyze(currentFen());
    }
  }

  function updateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot.fen !== "string" || !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.moves)) return;
    const positions = snapshot.positions.filter((fen) => parseFen(fen));
    const moves = snapshot.moves.slice(0, 1199).filter((move) => move && typeof move.san === "string");
    if (!positions.length || !parseFen(snapshot.fen)) return;
    const previousFen = currentFen();
    const previousSource = state.source;
    const previousAnalysisAllowed = state.analysisAllowed;
    const alignedMoves = moves.slice(0, Math.max(0, positions.length - 1));
    const alignedPositions = positions.slice(0, alignedMoves.length + 1);
    alignedPositions[alignedPositions.length - 1] = snapshot.fen;

    state.snapshot = snapshot;
    state.source = "chesscom";
    state.sourceTitle = snapshot.sourceTitle || "Chess.com Analysis";
    state.sourceUrl = snapshot.sourceUrl || "";
    state.positions = alignedPositions;
    state.moves = alignedMoves;
    state.flipped = Boolean(snapshot.flipped);
    state.analysisAllowed = snapshot.analysisAllowed !== false;
    // Before the user chooses a preference, retain the existing source default
    // (automatic for permitted spectator live games). An explicit UI choice
    // always takes precedence over source-page flags.
    if (!state.autoAnalyzePreferenceExplicit) {
      state.autoAnalyze = snapshot.autoAnalyze === true && state.analysisAllowed;
    }
    if (state.followSource) state.currentIndex = state.moves.length;
    else state.currentIndex = Math.min(state.currentIndex, state.moves.length);
    state.lines = [];
    state.selectedRank = 1;
    state.currentScore = null;
    render();
    clearResults(state.autoAnalyze && state.analysisAllowed
      ? "Position updated. Starting automatic Stockfish analysis…"
      : `Position updated from ${state.sourceTitle}. Analyze when ready.`);

    const nextFen = currentFen();
    const sourceChanged = previousSource !== state.source;
    const permissionGranted = !previousAnalysisAllowed && state.analysisAllowed;
    if (state.autoAnalyze && state.analysisAllowed
      && (previousFen !== nextFen || sourceChanged || permissionGranted)) {
      scheduleAutoAnalyze(nextFen);
    }
  }

  function importPgn(text, sourceName = "Imported PGN") {
    if (!Chess) throw new Error("The chess rules library could not load.");
    const game = new Chess();
    game.loadPgn(String(text || ""));
    const moves = game.history({ verbose: true });
    if (!moves.length) throw new Error("No legal moves were found in this PGN.");
    const headers = game.getHeaders ? game.getHeaders() : {};
    const positions = [moves[0].before, ...moves.map((move) => move.after)];
    state.source = "pgn";
    state.sourceTitle = sourceName;
    state.sourceUrl = "";
    state.positions = positions;
    state.moves = moves.map((move) => ({
      san: move.san, from: move.from, to: move.to, promotion: move.promotion || null,
      color: move.color, before: move.before, after: move.after
    }));
    state.currentIndex = state.moves.length;
    state.flipped = false;
    state.followSource = false;
    state.headers = headers;
    state.lines = [];
    state.selectedRank = 1;
    state.snapshot = null;
    state.analysisAllowed = true;
    setFollowing(false);
    render();
    clearResults(state.autoAnalyze
      ? `Loaded ${state.moves.length} plies. Starting automatic analysis…`
      : `Loaded ${state.moves.length} plies from ${sourceName}. Analyze when ready.`);
    if (state.autoAnalyze) scheduleAutoAnalyze(currentFen());
  }

  function setLoading(value) {
    state.loading = Boolean(value);
    ui.analyze.disabled = state.loading || state.source === "none" || !currentFen() || !state.analysisAllowed;
    ui.analyze.innerHTML = state.loading ? '<span class="spinner" aria-hidden="true"></span> Analyzing…' : 'Analyze position <span aria-hidden="true">↗</span>';
    ui.stop.hidden = !state.loading;
    if (state.loading) setEngineState("busy", "Searching");
  }

  function clearResults(message = "Results cleared.") {
    state.requestId += 1;
    state.engineClient?.cancel();
    state.lines = [];
    state.selectedRank = 1;
    state.currentScore = null;
    state.loading = false;
    ui.stop.hidden = true;
    ui.analyze.disabled = state.source === "none" || !currentFen() || !state.analysisAllowed;
    ui.candidateList.innerHTML = `<div class="candidate-empty"><span class="empty-mini-mark">↗</span><strong>No analysis yet</strong><span>${escapeHtml(message)}</span></div>`;
    ui.candidateCount.textContent = "0 lines";
    ui.copyLines.disabled = true;
    ui.clearAnalysis.disabled = true;
    ui.evalScore.textContent = "—";
    ui.evalDepth.textContent = "Awaiting analysis";
    ui.evalFill.style.width = "50%";
    ui.evalWhiteRail.style.height = "50%";
    ui.evalBlackRail.style.height = "50%";
    ui.arrows.replaceChildren();
    if (!state.loading) setEngineState("idle", "Standby");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function scoreForWhite(score, sideToMove) {
    if (!score) return "—";
    const sign = sideToMove === "b" ? -1 : 1;
    const mate = String(score).match(/^([+-]?)M(\d+)$/i);
    if (mate) {
      const raw = (mate[1] === "-" ? -1 : 1) * Number(mate[2]);
      const value = raw * sign;
      return `${value >= 0 ? "+" : "−"}M${Math.abs(value)}`;
    }
    const numeric = Number.parseFloat(String(score));
    if (!Number.isFinite(numeric)) return String(score);
    const value = numeric * sign;
    return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
  }

  function scorePercent(score) {
    if (!score) return 50;
    if (/M/.test(score)) return score.startsWith("−") || score.startsWith("-") ? 1 : 99;
    const value = Number.parseFloat(score.replace("−", "-"));
    if (!Number.isFinite(value)) return 50;
    return Math.max(2, Math.min(98, (Math.tanh(value / 3.5) + 1) * 50));
  }

  function variationSan(fen, pv) {
    try {
      const game = new Chess(fen);
      const san = [];
      for (const uci of pv || []) {
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
        const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
        if (uci.length === 5) move.promotion = uci[4];
        const parsed = game.move(move);
        if (!parsed) break;
        san.push(parsed.san);
      }
      return san;
    } catch {
      return [];
    }
  }

  function renderResults(lines) {
    state.lines = lines;
    ui.candidateList.replaceChildren();
    ui.candidateCount.textContent = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    ui.copyLines.disabled = !lines.length;
    ui.clearAnalysis.disabled = !lines.length;
    if (!lines.length) {
      const empty = document.createElement("div");
      empty.className = "candidate-empty";
      empty.innerHTML = '<span class="empty-mini-mark">↗</span><strong>No analysis yet</strong><span>Run Stockfish on the current position to see ranked lines.</span>';
      ui.candidateList.appendChild(empty);
      drawArrows();
      return;
    }
    for (const line of lines) {
      const card = document.createElement("article");
      card.className = `candidate-card${line.rank === state.selectedRank ? " is-selected" : ""}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = "candidate-select";
      const top = document.createElement("span");
      top.className = "candidate-topline";
      const rank = document.createElement("span");
      rank.className = "rank-badge";
      rank.textContent = String(line.rank);
      const move = document.createElement("strong");
      move.className = "candidate-move";
      move.textContent = line.san?.[0] || line.move || "—";
      const score = document.createElement("span");
      score.className = "candidate-score";
      score.textContent = scoreForWhite(line.score, currentFen()?.split(" ")[1]);
      top.append(rank, move, score);
      const pv = document.createElement("span");
      pv.className = "candidate-pv";
      const text = line.san.slice(0, 12).join(" · ");
      pv.textContent = text || line.move;
      select.append(top, pv);
      select.addEventListener("click", () => {
        state.selectedRank = line.rank;
        renderResults(state.lines);
        drawArrows();
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "candidate-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => copyText(formatLine(line)));
      card.append(select, copy);
      ui.candidateList.appendChild(card);
    }
    drawArrows();
  }

  function formatLine(line) {
    return `${line.rank}. ${(line.san || []).join(" ")} (${scoreForWhite(line.score, currentFen()?.split(" ")[1])})`;
  }

  function updateEvaluation(score, depth) {
    const whiteScore = scoreForWhite(score, currentFen()?.split(" ")[1]);
    ui.evalScore.textContent = whiteScore;
    ui.evalDepth.textContent = depth ? `Depth ${depth}` : "Engine evaluation";
    const percentage = scorePercent(whiteScore);
    ui.evalFill.style.width = `${percentage}%`;
    ui.evalWhiteRail.style.height = `${percentage}%`;
    ui.evalBlackRail.style.height = `${100 - percentage}%`;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      return true;
    } catch {
      const field = document.createElement("textarea");
      field.value = String(value || "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      return ok;
    }
  }

  class EngineClient {
    constructor() {
      this.port = null;
      this.opening = null;
      this.job = null;
      this.nextId = 1;
      this.lines = new Map();
      this.timeout = null;
    }

    async connect() {
      if (this.port) return this.port;
      if (this.opening) return this.opening;
      this.opening = (async () => {
        const response = await chrome.runtime.sendMessage({ type: "mateit-open-engine" });
        if (!response?.ready) throw new Error(response?.error || "Stockfish could not start.");
        const port = chrome.runtime.connect({ name: "mateit-engine" });
        this.port = port;
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(this.timeout);
            if (error) reject(error);
            else resolve();
          };
          this.timeout = setTimeout(() => finish(new Error("Stockfish did not acknowledge the connection.")), 8000);
          port.onMessage.addListener((message) => {
            if (message?.type === "mateit-engine-ready") {
              finish();
              return;
            }
            if (!this.job || message?.id !== this.job.id) return;
            const job = this.job;
            this.job = null;
            clearTimeout(this.timeout);
            if (message.error) job.reject(new Error(message.error));
            else job.resolve({
              bestMove: message.bestMove,
              score: message.score,
              lines: Array.isArray(message.lines) ? message.lines : []
            });
          });
          port.onDisconnect.addListener(() => {
            const reason = chrome.runtime.lastError?.message || "Stockfish disconnected.";
            finish(new Error(reason));
            if (this.port === port) this.port = null;
            if (this.job) {
              const job = this.job;
              this.job = null;
              job.reject(new Error(reason));
            }
          });
        });
        return port;
      })();
      try {
        return await this.opening;
      } finally {
        this.opening = null;
      }
    }

    cancel() {
      if (!this.job) return;
      const job = this.job;
      this.job = null;
      clearTimeout(this.timeout);
      try { this.port?.postMessage({ type: "cancel", id: job.id }); } catch {}
      job.resolve(null);
    }

    async search(fen, limit) {
      this.cancel();
      const id = this.nextId++;
      const result = new Promise((resolve, reject) => { this.job = { id, resolve, reject }; });
      try {
        const port = await this.connect();
        if (this.job?.id === id) {
          this.lines = new Map();
          port.postMessage({ type: "search", id, fen, limit });
          this.timeout = setTimeout(() => {
            if (this.job?.id === id) {
              const job = this.job;
              this.job = null;
              job.reject(new Error("Stockfish search timed out."));
            }
          }, limit.type === "time" ? Math.max(15000, limit.value + 12000) : 125000);
        }
      } catch (error) {
        if (this.job?.id === id) this.job = null;
        throw error;
      }
      return result;
    }
  }

  async function analyze() {
    const fen = currentFen();
    if (!fen || state.source === "none" || state.loading || !state.analysisAllowed) return;
    const requestId = ++state.requestId;
    state.engineClient ||= new EngineClient();
    state.engineClient.cancel();
    state.lines = [];
    state.selectedRank = 1;
    renderResults([]);
    setLoading(true);
    setEngineState("busy", "Starting engine");
    const limitType = $("#limit-type").value;
    const rawLimit = Number($("#limit-value").value);
    const limit = {
      type: limitType,
      value: limitType === "depth" ? Math.max(1, Math.min(60, Math.round(rawLimit || 16))) : Math.max(100, Math.min(60000, Math.round(rawLimit || 1500))),
      lines: Math.max(1, Math.min(10, Number($("#line-count").value) || 3))
    };
    try {
      const result = await state.engineClient.search(fen, limit);
      if (!result || requestId !== state.requestId) return;
      const lines = result.lines.slice(0, limit.lines).map((line, index) => ({
        ...line,
        rank: index + 1,
        san: variationSan(fen, line.pv || [line.move])
      }));
      state.lines = lines;
      state.selectedRank = 1;
      state.currentScore = result.score || lines[0]?.score || null;
      renderResults(lines);
      updateEvaluation(state.currentScore, lines[0]?.depth);
      setEngineState("ready", "Stockfish ready");
    } catch (error) {
      if (requestId === state.requestId) {
        setEngineState("error", "Engine error");
        ui.candidateList.innerHTML = `<div class="candidate-empty"><strong>Could not analyze</strong><span>${escapeHtml(error?.message || "Stockfish failed to start.")}</span></div>`;
      }
    } finally {
      if (requestId === state.requestId) setLoading(false);
    }
  }

  function stopAnalysis() {
    state.requestId += 1;
    state.engineClient?.cancel();
    setLoading(false);
    setEngineState("idle", "Stopped");
  }

  function navigateSourceAnalysis() {
    chrome.tabs.create({ url: "https://www.chess.com/analysis" });
  }

  function connectToSource() {
    try {
      const port = chrome.runtime.connect({ name: "mateit-study-window" });
      port.onMessage.addListener((message) => {
        if (message?.type === "mateit-study-snapshot") updateSnapshot(message.snapshot);
      });
      port.onDisconnect.addListener(() => setSyncState("waiting", "Source connection closed"));
    } catch {
      setSyncState("waiting", "Source sync unavailable");
    }
  }

  function bindEvents() {
    $("#open-source").addEventListener("click", navigateSourceAnalysis);
    $("#first-move").addEventListener("click", () => setCurrentIndex(0));
    $("#previous-move").addEventListener("click", () => setCurrentIndex(state.currentIndex - 1));
    $("#next-move").addEventListener("click", () => setCurrentIndex(state.currentIndex + 1));
    $("#last-move").addEventListener("click", () => setCurrentIndex(state.moves.length));
    $("#flip-board").addEventListener("click", () => { state.flipped = !state.flipped; renderBoard(); });
    ui.followButton.addEventListener("click", () => setFollowing(!state.followSource));
    ui.analyze.addEventListener("click", analyze);
    ui.autoAnalyze.addEventListener("click", () => setAutoAnalyze(!state.autoAnalyze));
    ui.stop.addEventListener("click", stopAnalysis);
    ui.copyFen.addEventListener("click", () => copyText(currentFen()));
    ui.copyLines.addEventListener("click", () => copyText(state.lines.map(formatLine).join("\n")));
    ui.clearAnalysis.addEventListener("click", () => clearResults());
    $("#all-arrows").addEventListener("change", drawArrows);
    $("#limit-type").addEventListener("change", () => {
      const type = $("#limit-type").value;
      $("#limit-label").textContent = type === "depth" ? "Depth (plies)" : "Time (ms)";
      $("#limit-value").min = type === "depth" ? "1" : "100";
      $("#limit-value").max = type === "depth" ? "60" : "60000";
      $("#limit-value").value = type === "depth" ? "16" : "1500";
    });
    $("#reset-settings").addEventListener("click", () => {
      $("#limit-type").value = "depth";
      $("#limit-value").value = "16";
      $("#line-count").value = "3";
      $("#all-arrows").checked = false;
      $("#limit-type").dispatchEvent(new Event("change"));
    });
    $("#paste-pgn").addEventListener("click", () => {
      ui.pgnError.textContent = "";
      ui.pgnDialog.showModal();
    });
    ui.pgnFile.addEventListener("change", async () => {
      const file = ui.pgnFile.files?.[0];
      if (!file) return;
      try {
        importPgn(await file.text(), file.name);
      } catch (error) {
        setSyncState("waiting", error?.message || "Could not import PGN");
      } finally {
        ui.pgnFile.value = "";
      }
    });
    $("#load-pgn").addEventListener("click", () => {
      try {
        importPgn(ui.pgnText.value, "Pasted PGN");
        ui.pgnDialog.close();
      } catch (error) {
        ui.pgnError.textContent = error?.message || "PGN could not be parsed.";
      }
    });
    window.addEventListener("resize", drawArrows, { passive: true });
  }

  bindEvents();
  render();
  clearResults("Run Stockfish on the current position to see ranked lines.");
  loadAutoAnalyzePreference().finally(connectToSource);

  // A small browser-test surface for fixture checks; it does not alter normal UI.
  globalThis.__MateItStudyTest = {
    importPgn,
    currentFen,
    setCurrentIndex,
    setAutoAnalyze,
    getState: () => ({ source: state.source, positions: state.positions.length, moves: state.moves.length, currentIndex: state.currentIndex, analysisAllowed: state.analysisAllowed, autoAnalyze: state.autoAnalyze, autoAnalyzePreferenceExplicit: state.autoAnalyzePreferenceExplicit })
  };
})();
