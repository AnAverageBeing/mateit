(() => {
  "use strict";

  // Runs in Chess.com's MAIN world because custom-element expandos such as
  // wc-chess-board.game are intentionally invisible to isolated content scripts.
  // This bridge is read-only: it never calls move(), resign(), or setters.
  const CHANNEL = "mateit-study-page-bridge-v1";
  const LIVE_ROUTE = /^\/game\/live(?:\/|$)/i;
  const PAGE_ROUTE = /^\/(?:analysis|game)(?:\/|$)/i;
  const POLL_MS = 350;

  function normalizeSide(value) {
    if (value && typeof value === "object") value = value.color ?? value.side ?? value.name;
    const text = String(value ?? "").trim().toLowerCase();
    if (value === 1 || /^(?:1|w|white)$/.test(text)) return "w";
    if (value === 2 || /^(?:2|b|black)$/.test(text)) return "b";
    return null;
  }

  function boardElements() {
    return [...document.querySelectorAll("wc-chess-board, chess-board")].sort((a, b) => {
      const area = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      return area(b) - area(a);
    });
  }

  function call(game, method) {
    try {
      return typeof game?.[method] === "function" ? game[method]() : null;
    } catch {
      return null;
    }
  }

  function readSnapshot() {
    if (!PAGE_ROUTE.test(location.pathname)) return null;
    const route = LIVE_ROUTE.test(location.pathname) ? "live" : "game";
    for (const board of boardElements()) {
      const game = board.game;
      const rawFen = call(game, "getFEN") ?? call(game, "getFen");
      if (typeof rawFen !== "string" || !rawFen.trim()) continue;

      const mode = call(game, "getMode");
      const modeName = String(mode?.name ?? mode ?? "").trim().toLowerCase() || null;
      const resultValue = call(game, "getResult");
      const result = resultValue == null ? null : String(resultValue).trim();
      const playingAs = normalizeSide(call(game, "getPlayingAs"));
      const observing = modeName === "observing" && playingAs === null;
      const completed = Boolean(result && result !== "*");
      // Never offer engine assistance to a player in an active live game.
      // Spectator review and post-game analysis remain available.
      const analysisAllowed = route !== "live" || observing || completed;

      let turn = call(game, "getTurn");
      turn = turn === 1 || turn === "1" ? "w" : turn === 2 || turn === "2" ? "b" : normalizeSide(turn);
      return {
        fen: rawFen.trim(),
        turn,
        modeName,
        result,
        playingAs,
        flipped: Boolean(board.classList?.contains("flipped")),
        analysisAllowed,
        autoAnalyze: route === "live" && analysisAllowed,
        route,
        boardId: String(board.id || "").slice(0, 100)
      };
    }
    return { fen: "", route, boardFound: false, analysisAllowed: false, autoAnalyze: false };
  }

  function publish() {
    const payload = readSnapshot();
    if (!payload) return;
    try {
      window.postMessage({ channel: CHANNEL, type: "snapshot", payload }, location.origin);
    } catch {
      // The source content script will report that no live board was found.
    }
  }

  // Poll because live moves can update the board controller without changing
  // any observed DOM attribute or text node.
  publish();
  window.setInterval(publish, POLL_MS);
  window.addEventListener("pageshow", publish);
  window.addEventListener("popstate", publish);
})();
