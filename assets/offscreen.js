(function () {
  function formatScore(type, value) {
    if (type === "mate") return `${value > 0 ? "+" : "-"}M${Math.abs(value)}`;
    const score = value / 100;
    return `${score > 0 ? "+" : ""}${score.toFixed(2)}`;
  }

  function parseInfo(line) {
    if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
    const multipv = Number(line.match(/\bmultipv\s+(\d+)/)?.[1] || 1);
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);
    if (!scoreMatch || !pvMatch || !Number.isInteger(multipv)) return null;
    const pv = pvMatch[1].trim().split(/\s+/).filter((move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move));
    if (!pv.length) return null;
    const score = formatScore(scoreMatch[1], Number(scoreMatch[2]));
    const depth = Number(line.match(/\bdepth\s+(\d+)/)?.[1] || 0);
    return { rank: multipv, move: pv[0], score, pv, depth };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "mateit-offscreen-ping") return false;
    sendResponse({ ready: true });
    return false;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "mateit-engine") return;

    let worker = null;
    let job = null;
    let phase = "idle";
    let timeoutId = null;
    let infoLines = new Map();

    function clearWorker() {
      clearTimeout(timeoutId);
      timeoutId = null;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      worker = null;
      phase = "idle";
      infoLines = new Map();
    }

    function fail(message) {
      const active = job;
      job = null;
      clearWorker();
      if (active) port.postMessage({ id: active.id, error: message });
    }

    function beginSearch() {
      if (!worker || !job) return;
      clearTimeout(timeoutId);
      const { fen, limit } = job;
      const count = Math.max(1, Math.min(10, Number(limit.lines) || 1));
      worker.postMessage(`setoption name MultiPV value ${count}`);
      worker.postMessage(`position fen ${fen}`);
      const isTime = limit.type === "time";
      phase = "search";
      timeoutId = setTimeout(
        () => fail("Stockfish search timed out"),
        isTime ? Math.max(10000, Number(limit.value) + 10000) : 120000
      );
      worker.postMessage(`go ${isTime ? "movetime" : "depth"} ${Number(limit.value)}`);
    }

    function handleLine(line) {
      if (line === "uciok") {
        phase = "ready-check";
        worker.postMessage("isready");
        return;
      }
      if (line === "readyok" && phase === "ready-check") {
        beginSearch();
        return;
      }
      if (!job) return;
      const parsed = parseInfo(line);
      if (parsed) infoLines.set(parsed.rank, parsed);

      const bestMatch = line.match(/^bestmove\s+(\S+)/);
      if (!bestMatch) return;

      const active = job;
      job = null;
      const count = Math.max(1, Math.min(10, Number(active.limit.lines) || 1));
      const lines = Array.from({ length: count }, (_, index) => infoLines.get(index + 1)).filter(Boolean);
      const bestMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMatch[1]) ? bestMatch[1] : null;
      if (!lines.length && bestMove) lines.push({ rank: 1, move: bestMove, score: "0.00", pv: [bestMove], depth: 0 });
      port.postMessage({
        id: active.id,
        bestMove: lines[0]?.move || bestMove,
        score: lines[0]?.score || null,
        lines
      });
      clearWorker();
    }

    port.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "cancel") {
        if (job?.id === message.id) {
          job = null;
          clearWorker();
        }
        return;
      }

      if (message.type !== "search") return;
      if (worker) clearWorker();

      const fen = String(message.fen || "");
      if (fen.length > 200 || !/^[rnbqkpRNBQKP1-8/]+\s+[wb]\s+[-KQkq]+\s+[-a-h1-8]+\s+\d+\s+\d+$/.test(fen)) {
        port.postMessage({ id: message.id, error: "Invalid chess position" });
        return;
      }
      const limit = message.limit || {};
      const type = limit.type === "time" ? "time" : "depth";
      const value = Number(limit.value);
      if (!Number.isInteger(value) || value < 1 || value > (type === "time" ? 60000 : 60)) {
        port.postMessage({ id: message.id, error: "Invalid search limit" });
        return;
      }

      job = {
        id: message.id,
        fen,
        limit: {
          type,
          value,
          lines: Math.max(1, Math.min(10, Number(limit.lines) || 1))
        }
      };
      try {
        worker = new Worker(chrome.runtime.getURL("engine/stockfish.js"));
        worker.onmessage = ({ data }) => {
          if (typeof data !== "string") return;
          for (const line of data.split("\n")) handleLine(line.trim());
        };
        worker.onerror = (event) => fail(event.message || "Stockfish worker failed");
        timeoutId = setTimeout(() => fail("Stockfish startup timed out"), 15000);
        phase = "uci";
        worker.postMessage("uci");
      } catch (error) {
        fail(error?.message || "Could not start Stockfish");
      }
    });

    port.onDisconnect.addListener(() => {
      job = null;
      clearWorker();
    });

    // A small handshake prevents the content script from sending a search
    // before this offscreen document has registered its message handlers.
    try {
      port.postMessage({ type: "mateit-engine-ready" });
    } catch (error) {
      console.warn("MateIt could not acknowledge the engine connection", error);
    }
  });
})();
