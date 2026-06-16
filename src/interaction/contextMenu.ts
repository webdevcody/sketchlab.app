export interface MenuItem {
  label: string;
  /** right-aligned shortcut hint, e.g. "=" */
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** Lightweight right-click menu rendered into the (positioned) canvas host. */
export class ContextMenu {
  private el: HTMLDivElement | null = null;

  constructor(private root: HTMLElement) {}

  get active(): boolean {
    return !!this.el;
  }

  /** dismiss when a pointer goes down anywhere outside the menu */
  private onDocPointerDown = (e: PointerEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) {
      // let the outside click both close the menu and reach the canvas normally
      this.close();
    }
  };

  /** Esc closes the menu regardless of where focus currently is */
  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.el) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  /** scrolling/zooming the canvas underneath should dismiss the menu */
  private onScroll = (): void => this.close();

  /** Open at a client (page) coordinate; the menu is clamped to stay on-screen. */
  open(clientX: number, clientY: number, items: MenuItem[]): void {
    this.close();
    if (!items.length) return;

    const el = document.createElement("div");
    el.className = "ctx-menu";
    for (const item of items) {
      const row = document.createElement("button");
      row.className = "ctx-menu__item";
      row.type = "button";
      if (item.disabled) row.disabled = true;

      const label = document.createElement("span");
      label.className = "ctx-menu__label";
      label.textContent = item.label;
      row.appendChild(label);

      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "ctx-menu__hint";
        hint.textContent = item.hint;
        row.appendChild(hint);
      }

      // act on pointerdown (mirrors the icon palette) so the action fires before
      // the document-level outside-pointer handler and never reaches the canvas
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        this.close();
        item.onSelect();
      });
      el.appendChild(row);
    }

    this.root.appendChild(el);
    this.el = el;

    // position relative to the host using local coords, then clamp inside it
    const rootRect = this.root.getBoundingClientRect();
    const menuRect = el.getBoundingClientRect();
    let x = clientX - rootRect.left;
    let y = clientY - rootRect.top;
    if (x + menuRect.width > rootRect.width) x = rootRect.width - menuRect.width - 4;
    if (y + menuRect.height > rootRect.height) y = rootRect.height - menuRect.height - 4;
    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${Math.max(4, y)}px`;

    // capture-phase so an outside click / Esc is caught before it reaches the canvas
    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    document.addEventListener("keydown", this.onDocKeyDown, true);
    this.root.addEventListener("wheel", this.onScroll, { passive: true });
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
    this.root.removeEventListener("wheel", this.onScroll);
    this.el.remove();
    this.el = null;
  }
}
