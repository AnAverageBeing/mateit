(() => {
  "use strict";

  // Sync Chess.com Analysis, completed games, and live-game pages.
  function getRoute() {
    const pathname = location.pathname;
    return {
      isAnalysis: /^\/analysis(?:\/|$)/i.test(pathname),
      isGame: /^\/game(?:\/|$)/i.test(pathname),
      isLiveGame: /^\/game\/live(?:\/|$)/i.test(pathname)
    };
  }
  if (!getRoute().isAnalysis && !getRoute().isGame) return;

  const Chess = globalThis.MateItChess;
  if (!Chess) return;

  const BOARD_SELECTOR = "wc-chess-board, chess-board";
  const LIST_SELECTOR = "wc-move-list, wc-simple-move-list, wc-vertical-move-list";
  const NODE_SELECTOR = "[data-node], .node";
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  let board = null;
  let moveList = null;
  let observer = null;
  let frame = 0;
  let lastSignature = "";
  let pendingSignature = "";
  let lastObservedPlacement = "";
  let inferredTurn = "w";
  let bridgeState = null;
  const BRIDGE_CHANNEL = "mateit-study-page-bridge-v1";

  // The page-world bridge is the authoritative source for Chess.com's board
  // controller. Isolated-world scripts cannot read board.game expandos.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== BRIDGE_CHANNEL || message?.type !== "snapshot") return;
    const payload = message.payload;
    if (!payload || typeof payload.fen !== "string" || !payload.fen.trim()) {
      bridgeState = null;
      schedule();
      return;
    }
    try {
      const fen = new Chess(payload.fen.trim()).fen({ forceEnpassantSquare: true });
      bridgeState = {
        fen,
        modeName: typeof payload.modeName === "string" ? payload.modeName : null,
        result: typeof payload.result === "string" ? payload.result : null,
        playingAs: payload.playingAs === "w" || payload.playingAs === "b" ? payload.playingAs : null,
        flipped: Boolean(payload.flipped),
        analysisAllowed: payload.analysisAllowed === true,
        autoAnalyze: payload.autoAnalyze === true,
        boardId: typeof payload.boardId === "string" ? payload.boardId : "",
        receivedAt: Date.now()
      };
      schedule();
    } catch {
      // Ignore malformed/partial controller state during board animations.
    }
  }, true);

  function isVisible(element) {
    return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  }

  function queryPieces(root) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll(".piece")];
  }

  function getPiecePlacement(element) {
    const pieces = new Map();
    const roots = [element, element?.shadowRoot].filter(Boolean);
    for (const root of roots) {
      for (const piece of queryPieces(root)) {
        const classes = [...(piece.classList || [])];
        const squareClass = classes.find((name) => /^square-[1-8]{2}$/.test(name));
        const pieceClass = classes.find((name) => /^[wb][pnbrqk]$/i.test(name));
        if (!squareClass || !pieceClass) continue;
        const square = squareClass.slice(-2);
        const color = pieceClass[0].toLowerCase();
        const type = pieceClass[1].toLowerCase();
        if (pieces.has(square)) return null;
        pieces.set(square, color === "w" ? type.toUpperCase() : type);
      }
    }
    const values = [...pieces.values()];
    if (values.filter((piece) => piece === "K").length !== 1 || values.filter((piece) => piece === "k").length !== 1) return null;
    return Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 8 }, (_, file) => pieces.get(`${file + 1}${8 - row}`) || "1")
        .join("")
        .replace(/1+/g, (run) => String(run.length))
    ).join("/");
  }

  function normalizeTurn(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (/^(?:w|white|white-to-move|white_turn|white-turn)$/.test(text)) return "w";
    if (/^(?:b|black|black-to-move|black_turn|black-turn)$/.test(text)) return "b";
    return null;
  }

  function elementAncestors(element, limit = 6) {
    const result = [];
    for (let current = element, depth = 0; current && depth < limit; current = current.parentElement, depth += 1) {
      result.push(current);
      if (current === document.body) break;
    }
    return result;
  }

  function readExplicitFen(element, placement = "") {
    const candidates = [];
    // Isolated content scripts can read DOM attributes but cannot see
    // Chess.com's page-world board.game expando. The MAIN-world bridge handles
    // that controller API; this function is only the attribute fallback.
    for (const current of elementAncestors(element, 7)) {
      for (const name of ["data-fen", "fen", "data-position-fen", "position-fen", "data-current-fen", "current-fen", "position"]) {
        const value = current.getAttribute?.(name);
        if (value) candidates.push(value);
      }
    }

    for (const node of document.querySelectorAll("[data-fen], [fen], [data-position-fen]")) {
      if (node === element || node.contains?.(element) || element.contains?.(node)) {
        candidates.push(node.getAttribute("data-fen") || node.getAttribute("fen") || node.getAttribute("data-position-fen") || "");
      }
    }

    let firstValid = "";
    for (const candidate of candidates) {
      try {
        const normalized = new Chess(String(candidate).trim()).fen({ forceEnpassantSquare: true });
        if (normalized.split(" ").length < 4) continue;
        if (!firstValid) firstValid = normalized;
        if (!placement || normalized.split(" ")[0] === placement) return normalized;
      } catch { /* Try the next possible FEN source. */ }
    }
    return firstValid;
  }

  function readTurnFromAttributes(element) {
    const names = [
      "data-turn", "turn", "data-side-to-move", "side-to-move",
      "data-active-color", "active-color", "data-player-to-move"
    ];
    for (const current of elementAncestors(element, 7)) {
      for (const name of names) {
        const turn = normalizeTurn(current.getAttribute?.(name));
        if (turn) return turn;
      }
      const classes = [...(current.classList || [])].join(" ").toLowerCase();
      if (/(?:^|[\s_-])(?:white-to-move|turn-white|white-turn|is-white-turn)(?:$|[\s_-])/.test(classes)) return "w";
      if (/(?:^|[\s_-])(?:black-to-move|turn-black|black-turn|is-black-turn)(?:$|[\s_-])/.test(classes)) return "b";
    }
    return null;
  }

  function readTurnFromClocks(element) {
    const flipped = Boolean(element.classList?.contains("flipped"));
    const clocks = [...document.querySelectorAll("wc-chess-clock, [class*='clock'], [data-cy*='clock']")].slice(0, 100);
    for (const clock of clocks) {
      const chain = elementAncestors(clock, 4);
      const context = chain.map((node) => {
        const classes = [...(node.classList || [])].join(" ");
        return `${classes} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("data-color") || ""} ${node.getAttribute?.("data-side") || ""}`;
      }).join(" ").toLowerCase();
      if (!/(?:active|running|current|turn)/.test(context)) continue;
      if (/\bblack\b/.test(context)) return "b";
      if (/\bwhite\b/.test(context)) return "w";
      if (/clock-bottom|player-bottom|bottom-player/.test(context)) return flipped ? "b" : "w";
      if (/clock-top|player-top|top-player/.test(context)) return flipped ? "w" : "b";
    }
    return null;
  }

  function readTurnFromPage(element) {
    const nodes = [element, document.body].filter(Boolean);
    for (const node of nodes) {
      const classes = [...(node.classList || [])].join(" ").toLowerCase();
      if (/(?:^|[\s_-])(?:white-to-move|turn-white|white-turn|is-white-turn)(?:$|[\s_-])/.test(classes)) return "w";
      if (/(?:^|[\s_-])(?:black-to-move|turn-black|black-turn|is-black-turn)(?:$|[\s_-])/.test(classes)) return "b";
    }
    return readTurnFromClocks(element);
  }

  function noteObservedPosition(placement, boardElement, explicitFen, replayTurn, replayMatchesBoard) {
    const explicitFields = explicitFen ? explicitFen.split(/\s+/) : [];
    const explicitTurn = explicitFields[0] === placement ? explicitFields[1] : null;
    const discoveredTurn = readTurnFromAttributes(boardElement) || readTurnFromPage(boardElement);
    const reliableTurn = explicitTurn === "w" || explicitTurn === "b"
      ? explicitTurn
      : discoveredTurn || (replayMatchesBoard ? replayTurn : null);

    if (placement && placement !== lastObservedPlacement) {
      if (reliableTurn === "w" || reliableTurn === "b") inferredTurn = reliableTurn;
      else if (lastObservedPlacement) inferredTurn = inferredTurn === "w" ? "b" : "w";
      else if (placement === START_PLACEMENT) inferredTurn = "w";
      lastObservedPlacement = placement;
    } else if (reliableTurn === "w" || reliableTurn === "b") {
      inferredTurn = reliableTurn;
    }
    return reliableTurn || inferredTurn;
  }

  function liveFallbackFen(placement, turn, explicitFen) {
    const fullmove = explicitFen ? Number(explicitFen.split(/\s+/)[5]) || 1 : 1;
    const candidate = `${placement} ${turn} - - 0 ${fullmove}`;
    try {
      return new Chess(candidate).fen();
    } catch {
      return "";
    }
  }

  function moveText(node) {
    const content = node.querySelector(".node-highlight-content") || node;
    const figurine = content.querySelector("[data-figurine]")?.getAttribute("data-figurine") || "";
    const text = content.textContent.trim();
    return (figurine && !text.startsWith(figurine) ? figurine + text : text).replace(/[!?]+$/, "");
  }

  // Preserve Chess.com's selected main-line / variation path, not every sibling
  // variation that happens to exist in the DOM.
  function readSelectedSan(list) {
    if (!list) return [];
    const all = [...list.querySelectorAll(NODE_SELECTOR)];
    const selected = all.find((node) => node.matches(".selected, [aria-current='true']") || node.querySelector(".selected, [aria-current='true']"));
    const mainLine = all.filter((node) => !node.closest(".variation-line"));
    const selectedIndex = mainLine.indexOf(selected);
    let nodes = selectedIndex < 0 ? mainLine : mainLine.slice(0, selectedIndex + 1);

    const variationAncestors = [];
    for (let line = selected?.closest(".variation-line"); line; line = line.parentElement?.closest(".variation-line")) {
      variationAncestors.unshift(line);
    }
    for (const line of variationAncestors) {
      const lineNodes = all.filter((node) => node.closest(".variation-line") === line);
      const first = lineNodes[0];
      const numberText = first?.closest(".inline-move")?.querySelector(".move-number")?.textContent;
      const moveNumber = Number.parseInt(numberText, 10);
      if (!moveNumber) return [];
      const ply = (moveNumber - 1) * 2 + Number(first.classList.contains("black-move"));
      if (ply > nodes.length) return [];
      const selectedInLine = lineNodes.indexOf(selected);
      nodes = nodes.slice(0, ply).concat(selectedInLine < 0 ? lineNodes : lineNodes.slice(0, selectedInLine + 1));
    }
    return nodes.map(moveText).filter(Boolean);
  }

  function discover() {
    const candidates = [...document.querySelectorAll(`${BOARD_SELECTOR}, ${LIST_SELECTOR}`)];
    const exactBoards = candidates.filter((element) => element.matches(BOARD_SELECTOR) && isVisible(element));
    // Chess.com occasionally wraps the board custom element in a themed board
    // container. Only accept a fallback container when it exposes a valid
    // eight-by-eight position, which avoids accidentally selecting side panels.
    const fallbackBoards = exactBoards.length ? [] : [...document.querySelectorAll(
      '[data-cy*="board" i], [class*="chess-board" i], [class~="board"], [id*="chess-board" i]'
    )].filter((element) => isVisible(element) && getPiecePlacement(element));
    const boards = exactBoards.length ? exactBoards : fallbackBoards;
    const nextBoard = boards.sort((a, b) => {
      const area = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      return area(b) - area(a);
    })[0] || null;
    const lists = nextBoard ? candidates.filter((element) => element.matches(LIST_SELECTOR)) : [];
    const nextList = lists.find((element) => nextBoard.id && element.getAttribute("board-id") === nextBoard.id)
      || (boards.length === 1 ? lists.find((element) => !element.hasAttribute("board-id") && isVisible(element)) : null)
      || null;

    if (nextBoard !== board || nextList !== moveList) {
      board = nextBoard;
      moveList = nextList;
      observer?.disconnect();
      observer = new MutationObserver(schedule);
      if (board) observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-fen", "fen", "data-turn", "turn"] });
      if (board?.shadowRoot) observer.observe(board.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-fen", "fen"] });
      if (moveList) observer.observe(moveList, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-current", "data-node"] });
    }
  }

  function makeSnapshot() {
    const route = getRoute();
    if (!route.isAnalysis && !route.isGame) return null;
    if (!board?.isConnected) discover();

    const placement = board ? (getPiecePlacement(board) || "") : "";
    // Prefer the MAIN-world controller FEN. This is required on live Chess.com
    // pages because board.game is a page-world expando, not visible here.
    let bridgeFen = "";
    if (bridgeState?.fen) {
      try { bridgeFen = new Chess(bridgeState.fen).fen({ forceEnpassantSquare: true }); } catch { bridgeFen = ""; }
    }
    const explicitFen = bridgeFen || (board ? readExplicitFen(board, placement) : "");
    if (!board && !explicitFen) return null;

    const sanMoves = readSelectedSan(moveList);
    const game = new Chess();
    for (const san of sanMoves) {
      try {
        if (!game.move(san)) break;
      } catch {
        break;
      }
    }

    const history = game.history({ verbose: true });
    const replayPositions = history.length
      ? [history[0].before, ...history.map((move) => move.after)]
      : [game.fen()];
    const replayFen = replayPositions[replayPositions.length - 1];
    const explicitPlacement = explicitFen ? explicitFen.split(" ")[0] : "";
    const explicitMatchesBoard = Boolean(explicitFen && (!placement || explicitPlacement === placement));
    const replayMatchesBoard = !placement || replayFen.split(" ")[0] === placement;
    const trustedExplicitFen = explicitMatchesBoard ? explicitFen : "";
    const fallbackTurn = placement
      ? noteObservedPosition(placement, board, trustedExplicitFen, game.turn(), replayMatchesBoard)
      : (explicitFen?.split(/\s+/)[1] || "w");

    let fen = "";
    let positions = [];
    let moves = [];

    if (route.isLiveGame && bridgeFen) {
      // Live controller FEN is the current displayed position, including the
      // true side-to-move, castling rights and en-passant target. A single-FEN
      // snapshot is safer than reconstructing partial live history from markup.
      fen = bridgeFen;
      positions = [fen];
      moves = [];
    } else if (explicitMatchesBoard && (replayMatchesBoard || !history.length)) {
      fen = explicitFen;
      positions = replayPositions.slice();
      moves = history;
      if (!history.length) positions = [fen];
      else positions[positions.length - 1] = fen;
    } else if (replayMatchesBoard && placement) {
      fen = replayFen;
      positions = replayPositions;
      moves = history;
    } else if (route.isGame && explicitMatchesBoard) {
      fen = explicitFen;
      positions = [fen];
      moves = [];
    } else if (route.isGame && placement) {
      // Fallback for Chess.com layouts where neither a controller FEN nor a
      // move list is exposed. The board is still mirrored from visible pieces.
      fen = liveFallbackFen(placement, fallbackTurn, trustedExplicitFen);
      if (!fen) return null;
      positions = [fen];
      moves = [];
    } else if (explicitMatchesBoard) {
      // Bridge-only fallback: the controller is available but this layout
      // does not expose a recognised board element to the isolated world.
      fen = explicitFen;
      positions = [fen];
      moves = [];
    } else {
      return null;
    }

    // Do not reject a controller FEN just because the piece DOM is midway
    // through an animation. For scraped positions, still require a match.
    if (placement && !bridgeFen && fen.split(" ")[0] !== placement) return null;
    if (positions.length !== moves.length + 1) {
      positions = [fen];
      moves = [];
    }

    const liveAnalysisAllowed = !route.isLiveGame ? true : Boolean(bridgeState?.analysisAllowed);
    return {
      fen,
      positions,
      moves: moves.map((move) => ({
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        color: move.color,
        before: move.before,
        after: move.after
      })),
      flipped: bridgeFen ? Boolean(bridgeState?.flipped) : Boolean(board?.classList?.contains("flipped")),
      sourceTitle: route.isLiveGame ? "Chess.com Live Game" : (document.title || "Chess.com Analysis"),
      sourceUrl: location.href,
      liveMode: bridgeState?.modeName || null,
      liveResult: bridgeState?.result || null,
      playingAs: bridgeState?.playingAs || null,
      analysisAllowed: liveAnalysisAllowed,
      autoAnalyze: route.isLiveGame && Boolean(bridgeState?.autoAnalyze) && liveAnalysisAllowed,
      bridgeConnected: Boolean(bridgeFen),
      syncedAt: Date.now()
    };
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  }

  async function sync() {
    discover();
    const snapshot = makeSnapshot();
    if (!snapshot) return;
    const signature = JSON.stringify([
      snapshot.fen,
      snapshot.moves.map((move) => move.san),
      snapshot.flipped,
      snapshot.sourceUrl,
      snapshot.liveMode,
      snapshot.liveResult,
      snapshot.playingAs,
      snapshot.analysisAllowed,
      snapshot.autoAnalyze,
      snapshot.bridgeConnected
    ]);
    if (signature === lastSignature || signature === pendingSignature) return;

    pendingSignature = signature;
    try {
      const response = await chrome.runtime.sendMessage({ type: "mateit-study-snapshot", snapshot });
      if (response?.ok) lastSignature = signature;
    } catch { /* A later DOM update or live-page poll will retry the snapshot. */ }
    finally {
      if (pendingSignature === signature) pendingSignature = "";
    }
  }

  const pageObserver = new MutationObserver((records) => {
    if (records.some((record) => {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      return !target?.closest("wc-chess-board, chess-board, wc-move-list, wc-simple-move-list, wc-vertical-move-list");
    })) discover();
    schedule();
  });
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "aria-hidden", "board-id", "id", "data-fen", "fen", "data-turn", "turn"]
  });
  window.addEventListener("popstate", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  window.setInterval(() => { if (getRoute().isLiveGame) schedule(); }, 650);
  discover();
  sync();
})();
