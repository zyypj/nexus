/** Stage tile ids: someone's camera/avatar tile or their screen share. */
export const camTile = (identity: string) => `cam:${identity}`;
export const screenTile = (identity: string) => `screen:${identity}`;

export interface StageState {
  /** Other people's screen shares being watched (decoded and heard). */
  watching: string[];
  /** Enlarged tile; null = grid of everyone. */
  focus: string | null;
}

interface StageParticipant {
  identity: string;
  isLocal: boolean;
  hasScreen: boolean;
}

/**
 * Keeps the watched streams and the enlarged tile valid as people come and
 * go. A stream starting while none is watched opens by itself (a call with
 * one stream needs no click); any other waits for "Assistir". `known` holds
 * the remote streams seen so far, so one the user closed is not reopened.
 * Returns `prev` itself when nothing changed.
 */
export function syncStage(prev: StageState, participants: StageParticipant[], known: ReadonlySet<string>): StageState {
  const live = participants.filter((p) => p.hasScreen && !p.isLocal).map((p) => p.identity);
  let watching = prev.watching.filter((id) => live.includes(id));
  let focus = prev.focus;
  const fresh = live.find((id) => !known.has(id));
  if (fresh && watching.length === 0) {
    watching = [fresh];
    focus ??= screenTile(fresh);
  }
  const shown = (tile: string) =>
    participants.some(
      (p) =>
        tile === camTile(p.identity) ||
        (tile === screenTile(p.identity) && p.hasScreen && (p.isLocal || watching.includes(p.identity))),
    );
  if (focus && !shown(focus)) focus = watching[0] ? screenTile(watching[0]) : null;
  return focus === prev.focus && watching.join() === prev.watching.join() ? prev : { watching, focus };
}

/** Starts watching a stream (and enlarges it) or stops watching it. */
export function watchStream(prev: StageState, identity: string, on: boolean): StageState {
  const watching = prev.watching.filter((id) => id !== identity);
  if (on) watching.push(identity);
  const tile = screenTile(identity);
  const last = watching[watching.length - 1];
  const focus = on ? tile : prev.focus === tile ? (last ? screenTile(last) : null) : prev.focus;
  return { watching, focus };
}

/** Tiles on the call stage keep the shape of a camera / shared screen. */
export const TILE_RATIO = 16 / 9;

/**
 * Columns and tile width that give the largest 16:9 tiles for `count` of them
 * in a `width`×`height` box (the Discord-style automatic grid).
 */
export function gridLayout(count: number, width: number, height: number, gap = 8): { cols: number; tileWidth: number } {
  let best = { cols: 1, tileWidth: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = (width - gap * (cols - 1)) / cols;
    const byHeight = ((height - gap * (rows - 1)) / rows) * TILE_RATIO;
    const tileWidth = Math.floor(Math.min(byWidth, byHeight));
    if (tileWidth > best.tileWidth) best = { cols, tileWidth };
  }
  return best;
}

/** Call area height as a fraction of the chat, kept so both stay usable. */
export function clampCallSize(fraction: number, containerHeight: number, minCall = 180, minChat = 150): number {
  if (containerHeight <= 0) return fraction;
  const min = minCall / containerHeight;
  const max = Math.max(min, (containerHeight - minChat) / containerHeight);
  return Math.min(max, Math.max(min, fraction));
}
