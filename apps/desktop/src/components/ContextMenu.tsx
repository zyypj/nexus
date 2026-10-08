import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useNexus } from "../lib/nexus";
import { Icon, type IconName } from "./Icon";

/**
 * Right-click menus. One host is mounted for the whole app and the menu is
 * built by a function, re-run whenever the relevant state changes, so
 * checkboxes (roles) and labels (friend status) stay live while it is open.
 */
export type MenuEntry =
  | {
      label: string;
      icon?: IconName;
      danger?: boolean;
      disabled?: boolean;
      /** Toggle row (roles): shows a check and keeps the menu open. */
      checked?: boolean;
      color?: string;
      run?: () => void;
      submenu?: MenuEntry[];
    }
  | { separator: true }
  | { reactions: readonly string[]; pick: (emoji: string) => void }
  | false
  | null
  | undefined;

type Item = Exclude<MenuEntry, false | null | undefined>;

interface MenuState {
  open: { x: number; y: number; build: () => MenuEntry[] } | null;
}

const useMenu = create<MenuState>()(() => ({ open: null }));

export function closeContextMenu() {
  useMenu.setState({ open: null });
}

/** Opens a menu at the pointer (or under an element, for keyboard/buttons). */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, build: () => MenuEntry[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  useMenu.setState({ open: { x: e.clientX, y: e.clientY, build } });
}

/** Opens a menu below a button (the "..." buttons). */
export function openMenuAt(el: HTMLElement, build: () => MenuEntry[]) {
  const r = el.getBoundingClientRect();
  useMenu.setState({ open: { x: r.left, y: r.bottom + 4, build } });
}

function clean(entries: MenuEntry[]): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    if (!e) continue;
    // No leading, trailing or doubled separators.
    if ("separator" in e && (out.length === 0 || "separator" in (out[out.length - 1] as Item))) continue;
    out.push(e);
  }
  while (out.length && "separator" in (out[out.length - 1] as Item)) out.pop();
  return out;
}

export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  // Re-render (and re-build) when the state the menus read changes.
  useNexus((s) => s.servers);
  useNexus((s) => s.friends);
  useNexus((s) => s.incoming);
  useNexus((s) => s.outgoing);
  useNexus((s) => s.blocked);
  if (!open) return null;
  return createPortal(<Menu x={open.x} y={open.y} items={clean(open.build())} root />, document.body);
}

function Menu({
  x,
  y,
  items,
  root,
  flipX,
  focusFirst,
}: { x: number; y: number; items: Item[]; root?: boolean; flipX?: number; focusFirst?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; kb: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Submenus open to the right of their row, or to the left when there is no room.
    let left = x;
    if (left + w + m > window.innerWidth) left = flipX !== undefined ? flipX - w : window.innerWidth - w - m;
    const top = Math.max(m, Math.min(y, window.innerHeight - h - m));
    setPos({ left: Math.max(m, left), top });
  }, [x, y, flipX]);

  const placed = pos !== null;
  useEffect(() => {
    // Keyboard users land on the first item (once visible: hidden elements
    // cannot take focus).
    if (placed && (root || focusFirst))
      ref.current?.querySelector<HTMLButtonElement>(":scope > button:not(:disabled)")?.focus({ preventScroll: true });
  }, [placed, root, focusFirst]);

  useEffect(() => {
    if (!root) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".ctx-menu")) closeContextMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    document.addEventListener("scroll", closeContextMenu, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      document.removeEventListener("scroll", closeContextMenu, true);
    };
  }, [root]);

  const openSub = (index: number, el: HTMLElement, kb = false) => {
    const r = el.getBoundingClientRect();
    setSub({ index, x: r.right + 4, y: r.top - 6, flipX: r.left - 4, kb });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === "ArrowRight" && i >= 0) {
      const idx = Number(buttons[i]?.dataset.index);
      if (items[idx] && "submenu" in (items[idx] as Item)) {
        e.preventDefault();
        e.stopPropagation();
        openSub(idx, buttons[i] as HTMLElement, true);
      }
    } else if (e.key === "ArrowLeft" && !root) {
      e.preventDefault();
      e.stopPropagation();
      (ref.current?.parentElement?.closest(".ctx-menu")?.querySelector("button.sub-open") as HTMLElement | null)?.focus();
    }
  };

  const subItem = sub ? (items[sub.index] as Item) : undefined;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if ("separator" in item) return <div key={`sep${i}`} className="ctx-sep" />;
        if ("reactions" in item)
          return (
            <div key="reactions" className="ctx-reactions">
              {item.reactions.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  title={`Reagir com ${emoji}`}
                  onClick={() => {
                    closeContextMenu();
                    item.pick(emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          );
        const hasSub = !!item.submenu;
        const isToggle = item.checked !== undefined;
        return (
          <button
            type="button"
            key={item.label}
            data-index={i}
            role={isToggle ? "menuitemcheckbox" : "menuitem"}
            aria-checked={isToggle ? item.checked : undefined}
            aria-haspopup={hasSub || undefined}
            disabled={item.disabled}
            className={`${item.danger ? "danger" : ""}${sub?.index === i ? " sub-open" : ""}`}
            onMouseEnter={(e) => (hasSub ? openSub(i, e.currentTarget) : setSub(null))}
            onClick={(e) => {
              if (hasSub) {
                openSub(i, e.currentTarget);
                return;
              }
              if (!isToggle) closeContextMenu();
              item.run?.();
            }}
          >
            {isToggle && (
              <span className={`ctx-check${item.checked ? " on" : ""}`} style={item.color ? ({ "--role": item.color } as React.CSSProperties) : undefined}>
                {item.checked && <Icon name="check" size={12} />}
              </span>
            )}
            <span className="ctx-label" style={isToggle && item.color ? { color: item.color } : undefined}>
              {item.label}
            </span>
            {hasSub ? <Icon name="chevronRight" size={14} /> : item.icon ? <Icon name={item.icon} size={16} /> : null}
          </button>
        );
      })}
      {sub && subItem && "submenu" in subItem && subItem.submenu && (
        <Menu key={sub.index} x={sub.x} y={sub.y} flipX={sub.flipX} focusFirst={sub.kb} items={clean(subItem.submenu)} />
      )}
    </div>
  );
}
