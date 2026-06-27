import { deleteBoard, listBoards } from "../persistence/db";
import type { BoardMeta } from "../state/types";
import { confirmDialog } from "./confirmDialog";
import { h } from "./dom";

const DRAWER_WIDTH = 280;

function formatDate(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  if (diff < min) return "just now";
  if (diff < 60 * min) return `${Math.round(diff / min)}m ago`;
  if (diff < 24 * 60 * min) return `${Math.round(diff / (60 * min))}h ago`;
  return new Date(ts).toLocaleDateString();
}

export interface BoardDrawerOptions {
  activeBoardId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDeleted: (deletedId: string) => void;
  onOpenChange?: (open: boolean) => void;
}

export class BoardDrawer {
  private backdrop: HTMLDivElement;
  private panel: HTMLDivElement;
  private list: HTMLDivElement;
  private open_ = false;

  constructor(
    private editor: HTMLElement,
    private opts: BoardDrawerOptions,
  ) {
    this.backdrop = h("div", {
      class: "board-drawer__backdrop",
      onclick: () => this.close(),
    });

    const closeBtn = h(
      "button",
      {
        class: "board-drawer__close",
        type: "button",
        title: "Close",
        "aria-label": "Close boards menu",
        onclick: (e: Event) => {
          e.stopPropagation();
          this.close();
        },
      },
      "×",
    );

    const newBtn = h(
      "button",
      {
        class: "btn btn--accent board-drawer__new",
        type: "button",
        onclick: () => {
          this.close();
          this.opts.onCreate();
        },
      },
      "+ New board",
    );

    this.list = h("div", { class: "board-drawer__list" });

    this.panel = h(
      "div",
      {
        class: "board-drawer",
        style: { width: `${DRAWER_WIDTH}px` },
        role: "dialog",
        "aria-label": "Your boards",
      },
      h(
        "div",
        { class: "board-drawer__header" },
        h("h2", null, "Boards"),
        closeBtn,
      ),
      newBtn,
      this.list,
    );

    editor.append(this.backdrop, this.panel);
    editor.style.setProperty("--drawer-w", `${DRAWER_WIDTH}px`);

    this.onKeyDown = this.onKeyDown.bind(this);
    document.addEventListener("keydown", this.onKeyDown);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async refresh(): Promise<void> {
    const boards = await listBoards();
    this.list.replaceChildren();
    if (boards.length === 0) {
      this.list.appendChild(h("p", { class: "board-drawer__empty" }, "No boards yet."));
      return;
    }
    for (const meta of boards) this.list.appendChild(this.row(meta));
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.editor.classList.add("editor--drawer-open");
    this.backdrop.classList.add("is-visible");
    this.panel.classList.add("is-open");
    this.opts.onOpenChange?.(true);
    void this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.editor.classList.remove("editor--drawer-open");
    this.backdrop.classList.remove("is-visible");
    this.panel.classList.remove("is-open");
    this.opts.onOpenChange?.(false);
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  destroy(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.backdrop.remove();
    this.panel.remove();
    this.editor.classList.remove("editor--drawer-open");
    this.editor.style.removeProperty("--drawer-w");
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && this.open_) {
      e.preventDefault();
      this.close();
    }
  }

  private row(meta: BoardMeta): HTMLElement {
    const isActive = meta.id === this.opts.activeBoardId;
    const del = h(
      "button",
      {
        class: "board-drawer__delete",
        type: "button",
        title: "Delete board",
        "aria-label": `Delete ${meta.name}`,
        onclick: async (e: Event) => {
          e.stopPropagation();
          const ok = await confirmDialog({
            title: "Delete board",
            message: `Delete "${meta.name}"? This cannot be undone.`,
          });
          if (!ok) return;
          await deleteBoard(meta.id);
          this.opts.onDeleted(meta.id);
          await this.refresh();
        },
      },
      "🗑",
    );

    return h(
      "div",
      {
        class: "board-drawer__item",
        role: "button",
        tabindex: "0",
        "aria-current": isActive ? "true" : undefined,
        onclick: () => {
          if (meta.id === this.opts.activeBoardId) {
            this.close();
            return;
          }
          this.close();
          this.opts.onSelect(meta.id);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            (e.currentTarget as HTMLElement).click();
          }
        },
      },
      meta.thumbnail
        ? h("img", { class: "board-drawer__thumb", src: meta.thumbnail, alt: "" })
        : h("div", { class: "board-drawer__thumb board-drawer__thumb--empty" }, "✎"),
      h(
        "div",
        { class: "board-drawer__meta" },
        h("div", { class: "board-drawer__name" }, meta.name),
        h(
          "div",
          { class: "board-drawer__sub" },
          `${meta.shapeCount} shape${meta.shapeCount === 1 ? "" : "s"} · ${formatDate(meta.updatedAt)}`,
        ),
      ),
      del,
    );
  }
}
