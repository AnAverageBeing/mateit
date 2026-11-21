# MateIt Study 2.4.4

MateIt Study opens a **separate normal Chrome window** for reviewing chess positions. The Chess.com page itself is a read-only source; MateIt does not draw an overlay, add a menu, or run the engine there.

## What changed

- New dedicated study workspace with an independent chessboard, move list, board navigation, flip control, and source-follow toggle.
- Local Stockfish analysis runs only from the study window, on positions from Chess.com Analysis, PGNs, and permitted spectator/post-game live positions.
- Ranked candidate lines (1–10), score display, selectable rank arrows and numbered arrowheads are rendered only on the separate study board.
- Game review and live-game page syncing are supported on Chess.com `/game/*` pages, or by importing a `.pgn` file / pasting PGN directly into MateIt.
- Live-game sync uses a read-only MAIN-world page bridge to read Chess.com’s board controller FEN (`board.game.getFEN()`), side to move, display mode and result. This is necessary because `board.game` is a page-world property that isolated content scripts cannot access.
- The page bridge polls the live board controller every 350 ms, and the isolated content script also schedules a 650 ms sync fallback. This catches board updates even when Chess.com changes controller state without a DOM mutation.
- The Stockfish panel includes a persistent **Auto: On/Off** control. When enabled, each new source position (or manually selected review position) starts local Stockfish analysis; changed positions cancel stale searches and analyze the latest FEN. The setting is saved in extension storage and survives closing/reopening the study window.
- Spectator live positions retain their prior automatic-analysis default until the user explicitly chooses Auto On or Off. Engine assistance remains disabled when the bridge identifies the user as a player in an active live game; post-game and spectator analysis remain available.
- The extension whitelist includes Chess.com `/analysis*` and `/game/*` pages on both `www.chess.com` and `chess.com`, including `/game/live` and its subroutes.
- No web-accessible resources are declared. Positions are cached in `chrome.storage.session`; the extension does not transmit them to a remote service.

## Install

1. Open `chrome://extensions`.
2. Remove the older MateIt Study build.
3. Extract this archive.
4. Enable Developer mode and click **Load unpacked**.
5. Select the extracted folder that contains `manifest.json` directly.
6. Click the MateIt toolbar icon and choose **Open study window**.

## Chess.com sync

1. Open a Chess.com game page, including `/game/live` for live games.
2. Open the MateIt Study window. The page-world bridge reads the board controller's current FEN, then forwards each new live position to the separate window.
3. On live spectator pages, MateIt automatically starts local Stockfish analysis after each new position. When you are a participant in an active game, the board still mirrors but engine analysis is disabled until the game ends.
4. Use **Following source** to mirror the source position. Turn it off to navigate an available move list independently; turn it on again to jump to the latest source position.

The board-controller FEN preserves the side to move, castling rights and en-passant target. Live pages may not expose a complete move history, so MateIt represents them as current-position snapshots rather than fabricating earlier moves.

## PGN review

Use **Import PGN** to choose a `.pgn` file, or **Paste PGN** to paste notation. This works without a Chess.com tab.

## Engine controls

Choose depth or time, select 1–10 lines, optionally draw every ranked arrow, then click **Analyze position** for a one-off search. Click **Auto: On** to analyze every new position automatically, or **Auto: Off** to return to manual analysis. The preference persists across study-window restarts. In active live games where you are a participant, the board continues syncing but engine analysis remains paused until spectator or post-game review. Stockfish and the WASM engine are bundled; analysis is local to the browser.

## Validation

The package includes the Stockfish engine and its existing GPL license file. JavaScript syntax, manifest file references, ZIP integrity, the MAIN-world bridge, controller-FEN forwarding, live-route gating, and study-window snapshot handling were checked with local fixtures. End-to-end synchronization against an authenticated Chess.com account still requires a real Chrome/account session.
