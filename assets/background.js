const OFFSCREEN_DOCUMENT = "src/engine/offscreen.html";
let openingOffscreen = null;
const studyPorts = new Set();
const STUDY_CACHE_KEY = "mateitStudyLastSnapshot";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getOffscreenContext() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)]
  });
  return contexts.length > 0;
}

async function waitForOffscreenReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mateit-offscreen-ping" });
      if (response?.ready === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(lastError?.message || "The local Stockfish worker did not finish starting.");
}

async function ensureOffscreenDocument() {
  if (openingOffscreen) return openingOffscreen;
  openingOffscreen = (async () => {
    if (!(await getOffscreenContext())) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: ["WORKERS"],
        justification: "Run the bundled Stockfish worker for user-requested analysis of completed games and Chess.com analysis positions."
      });
    }
    await waitForOffscreenReady();
  })();
  try {
    await openingOffscreen;
  } finally {
    openingOffscreen = null;
  }
}

function broadcastSnapshot(snapshot) {
  for (const port of [...studyPorts]) {
    try {
      port.postMessage({ type: "mateit-study-snapshot", snapshot });
    } catch {
      studyPorts.delete(port);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mateit-study-window") return;
  studyPorts.add(port);
  chrome.storage.session.get(STUDY_CACHE_KEY).then((stored) => {
    const snapshot = stored?.[STUDY_CACHE_KEY];
    if (snapshot && studyPorts.has(port)) {
      try { port.postMessage({ type: "mateit-study-snapshot", snapshot }); } catch {}
    }
  }).catch(() => {});
  port.onDisconnect.addListener(() => studyPorts.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "mateit-open-engine") {
    ensureOffscreenDocument().then(
      () => sendResponse({ ready: true }),
      (error) => sendResponse({ error: error?.message || "Could not start Stockfish." })
    );
    return true;
  }

  if (message?.type === "mateit-open-study-window") {
    chrome.windows.create({
      url: chrome.runtime.getURL("src/study/study.html"),
      type: "normal",
      width: 1440,
      height: 940,
      focused: true
    }).then((windowInfo) => sendResponse({ ok: true, windowId: windowInfo.id }), (error) => {
      sendResponse({ error: error?.message || "Could not open the study window." });
    });
    return true;
  }

  if (message?.type === "mateit-study-snapshot") {
    const senderUrl = sender?.url || "";
    let sourceUrl = null;
    let allowedSource = false;
    try {
      sourceUrl = new URL(senderUrl);
      const trustedHost = sourceUrl.protocol === "https:"
        && (sourceUrl.hostname === "chess.com" || sourceUrl.hostname.endsWith(".chess.com"));
      const analysisRoute = /^\/analysis(?:\/|$)/i.test(sourceUrl.pathname);
      const gameRoute = /^\/game(?:\/|$)/i.test(sourceUrl.pathname);
      allowedSource = trustedHost && (analysisRoute || gameRoute);
    } catch { /* Reject malformed sender URLs. */ }
    if (!sender?.tab?.id || !allowedSource) {
      sendResponse({ ok: false, error: "Only Chess.com Analysis or game pages can sync a study position." });
      return false;
    }

    const snapshot = message.snapshot || {};
    if (typeof snapshot.fen !== "string" || snapshot.fen.length > 200
      || !Array.isArray(snapshot.positions) || snapshot.positions.length > 1200
      || !Array.isArray(snapshot.moves) || snapshot.moves.length > 1199) {
      sendResponse({ ok: false, error: "Invalid study snapshot." });
      return false;
    }

    const isLiveSource = Boolean(sourceUrl?.pathname.toLowerCase().startsWith("/game/live"));
    const liveMode = typeof snapshot.liveMode === "string" ? snapshot.liveMode.slice(0, 40).toLowerCase() : null;
    const liveResult = typeof snapshot.liveResult === "string" ? snapshot.liveResult.slice(0, 20) : null;
    const playingAs = snapshot.playingAs === "w" || snapshot.playingAs === "b" ? snapshot.playingAs : null;
    const spectatorReview = liveMode === "observing" && playingAs === null;
    const gameFinished = Boolean(liveResult && liveResult !== "*");
    const analysisAllowed = !isLiveSource || spectatorReview || gameFinished;
    const safeSnapshot = {
      fen: snapshot.fen,
      positions: snapshot.positions.filter((fen) => typeof fen === "string" && fen.length <= 200),
      moves: snapshot.moves.slice(0, 1199).map((move) => ({
        san: String(move?.san || "").slice(0, 16),
        from: String(move?.from || "").slice(0, 2),
        to: String(move?.to || "").slice(0, 2),
        promotion: move?.promotion ? String(move.promotion).slice(0, 1) : null,
        color: move?.color === "b" ? "b" : "w",
        before: String(move?.before || "").slice(0, 200),
        after: String(move?.after || "").slice(0, 200)
      })),
      flipped: Boolean(snapshot.flipped),
      sourceTitle: String(snapshot.sourceTitle || (sourceUrl?.pathname.toLowerCase().startsWith("/game/live") ? "Chess.com Live Game" : "Chess.com Analysis")).slice(0, 160),
      sourceUrl: senderUrl.slice(0, 1000),
      liveMode,
      liveResult,
      playingAs,
      analysisAllowed,
      autoAnalyze: snapshot.autoAnalyze === true && analysisAllowed,
      bridgeConnected: snapshot.bridgeConnected === true,
      sourceTabId: sender.tab.id,
      syncedAt: Date.now()
    };
    chrome.storage.session.set({ [STUDY_CACHE_KEY]: safeSnapshot }).catch(() => {});
    broadcastSnapshot(safeSnapshot);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
