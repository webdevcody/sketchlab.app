import "./styles.css";
import { loadBoardById, listBoards, saveBoard } from "./persistence/db";
import { decodeBoard } from "./persistence/share";
import { installRenderPerfDevtools } from "./render/perfDevtools";
import { createStarterBoard } from "./state/starterBoard";
import type { Board } from "./state/types";
import { mountEditor, type MountedView } from "./ui/editor";

const app = document.getElementById("app") as HTMLElement;
installRenderPerfDevtools();

let current: MountedView | null = null;
let rendering = false;
let pendingRerender = false;

async function resolveBoard(): Promise<{ board: Board; shared?: boolean }> {
  const url = new URL(location.href);
  const sharedCode = url.searchParams.get("b");
  if (sharedCode) {
    const board = decodeBoard(sharedCode);
    history.replaceState(null, "", location.pathname + (location.hash || "#/"));
    if (board) return { board, shared: true };
  }

  const hash = location.hash.replace(/^#/, "");
  const match = hash.match(/^\/board\/(.+)$/);
  if (match) {
    const board = await loadBoardById(decodeURIComponent(match[1]));
    if (board) return { board };
  }

  const boards = await listBoards();
  if (boards.length > 0) {
    const board = await loadBoardById(boards[0].id);
    if (board) return { board };
  }

  const starter = createStarterBoard();
  await saveBoard(starter);
  return { board: starter };
}

async function render(): Promise<void> {
  if (rendering) {
    pendingRerender = true;
    return;
  }
  rendering = true;

  if (current) {
    current.destroy();
    current = null;
  }

  try {
    const { board, shared } = await resolveBoard();
    const targetHash = `#/board/${board.id}`;
    if (!shared && location.hash !== targetHash) {
      history.replaceState(null, "", targetHash);
    }
    current = await mountEditor(app, board, { shared: !!shared });
  } finally {
    rendering = false;
    if (pendingRerender) {
      pendingRerender = false;
      void render();
    }
  }
}

window.addEventListener("hashchange", () => void render());
void render();
