import { type CSSProperties, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ParticipantView, calls, setCallUi, useCall } from "../call/callStore";
import { camTile, clampCallSize, gridLayout, screenTile } from "../call/stageLayout";
import { Avatar } from "../components/Avatar";
import { type MenuEntry, openContextMenu } from "../components/ContextMenu";
import { streamVolumeEntry, volumeEntry } from "../components/UserVolume";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";
import { isTauri, setWindowFullscreen } from "../lib/platform";
import { useUi } from "../lib/ui";
import { userMenu } from "./menus";

interface StageTile {
  id: string;
  kind: "cam" | "screen";
  p: ParticipantView;
}

interface TileProps {
  tile: StageTile;
  /** Showing video: a camera tile always may, a stream only while watched. */
  live: boolean;
  full: boolean;
  onPick: () => void;
  onUnfocus: () => void;
  onFullscreen: (on: boolean) => void;
}

const GRID_GAP = 8;
/** Fullscreen hides the pointer and the controls after this long without moving. */
const IDLE_MS = 3000;

/**
 * Call stage, Discord style. Every camera/avatar and every screen share is a
 * tile: all of them in an automatic grid, or one enlarged with the rest in a
 * strip below (click a tile). Screen shares of other people are only decoded
 * and heard once watched ("Assistir"); the first one of a call opens by itself.
 * Unwatched and hidden tiles cost no video: LiveKit adaptiveStream pauses
 * tracks that are not attached to a visible element.
 *
 * `solo`: nothing below the stage (voice channels), so it takes the whole area.
 */
export function CallPanel({ solo = false }: { solo?: boolean }) {
  const participants = useCall((s) => s.participants);
  const status = useCall((s) => s.status);
  const screenNotice = useCall((s) => s.screenNotice);
  const screenQuality = useCall((s) => s.screenQuality);
  const watching = useCall((s) => s.watching);
  const focusId = useCall((s) => s.focus);
  const expanded = useCall((s) => s.stageExpanded) && !solo;
  const callSize = useUi((s) => s.callSize);
  const [strip, setStrip] = useState(true);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Streams first, as the thing people most likely came to see.
  const tiles: StageTile[] = [
    ...participants.filter((p) => p.hasScreen).map((p): StageTile => ({ id: screenTile(p.identity), kind: "screen", p })),
    ...participants.map((p): StageTile => ({ id: camTile(p.identity), kind: "cam", p })),
  ];
  const focused = tiles.find((t) => t.id === focusId);
  const others = tiles.filter((t) => t !== focused);
  const hasVideo = tiles.some((t) => t.kind === "screen" || t.p.hasCamera);

  const fullRef = useRef(false);
  const setFullscreen = useCallback((on: boolean) => {
    fullRef.current = on;
    setFull(on);
    void setWindowFullscreen(on);
  }, []);
  // Leaving the call or the conversation must not strand the window in fullscreen.
  useEffect(() => () => void (fullRef.current && setWindowFullscreen(false)), []);

  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => {
      // Esc closes an open menu first.
      if (e.key === "Escape" && !document.querySelector(".ctx-menu")) setFullscreen(false);
    };
    // A browser leaves fullscreen by itself on Esc/F11.
    const change = () => {
      if (!isTauri && !document.fullscreenElement) setFullscreen(false);
    };
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    window.addEventListener("keydown", key);
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    document.addEventListener("fullscreenchange", change);
    return () => {
      clearTimeout(timer);
      setIdle(false);
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      document.removeEventListener("fullscreenchange", change);
    };
  }, [full, setFullscreen]);

  const pick = (t: StageTile) => {
    // An unwatched stream is tuned in (and enlarged) by the same click.
    if (t.kind === "screen" && !t.p.isLocal && !watching.includes(t.p.identity)) calls.watchStream(t.p.identity, true);
    else setCallUi({ focus: t.id });
  };
  const tileProps = (t: StageTile): TileProps => ({
    tile: t,
    live: t.kind === "cam" || t.p.isLocal || watching.includes(t.p.identity),
    full,
    onPick: () => pick(t),
    onUnfocus: () => setCallUi({ focus: null }),
    onFullscreen: (on: boolean) => {
      if (on) pick(t);
      setFullscreen(on);
    },
  });

  // Dragging the bottom edge resizes the call area against the chat below.
  const resizable = !solo && !expanded && !full;
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = panel.current;
    const parent = el?.parentElement;
    if (!el || !parent || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const height = parent.clientHeight;
    setDragSize(clampCallSize((e.clientY - el.getBoundingClientRect().top) / height, height, 180, 200));
  };
  const onResizeEnd = () => {
    if (dragSize !== null) useUi.getState().set({ callSize: dragSize });
    setDragSize(null);
  };
  const size = dragSize ?? callSize ?? (hasVideo || focused ? 0.6 : 0.38);

  const cls = ["call-panel", focused && "focused", solo && "solo", expanded && "expanded", full && "full", idle && "idle"];
  return (
    <div ref={panel} className={cls.filter(Boolean).join(" ")} style={resizable ? { flexBasis: `${size * 100}%` } : undefined}>
      {status !== "connected" && <div className="call-status">{status === "connecting" ? "Conectando…" : "Reconectando…"}</div>}
      {focused ? (
        <>
          <div className="stage-main">
            <Tile key={focused.id} {...tileProps(focused)} big />
          </div>
          {strip && others.length > 0 && (
            <div className="stage-strip">
              {others.map((t) => (
                <Tile key={t.id} {...tileProps(t)} />
              ))}
            </div>
          )}
        </>
      ) : (
        <StageGrid tiles={tiles} tileProps={tileProps} />
      )}
      <div className="stage-bar">
        {full && <CallControls />}
        {focused && (
          <button type="button" className="icon-btn" title="Ver todos em grade" onClick={() => setCallUi({ focus: null })}>
            <Icon name="grid" />
          </button>
        )}
        {focused && others.length > 0 && (
          <button
            type="button"
            className={`icon-btn${strip ? " on" : ""}`}
            title={strip ? "Ocultar miniaturas" : "Mostrar miniaturas"}
            onClick={() => setStrip((v) => !v)}
          >
            <Icon name="users" />
          </button>
        )}
        {!solo && !full && (
          <button
            type="button"
            className={`icon-btn${expanded ? "" : " on"}`}
            title={expanded ? "Mostrar chat" : "Ocultar chat"}
            onClick={() => setCallUi({ stageExpanded: !expanded })}
          >
            <Icon name="message" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title={full ? "Sair da tela cheia (Esc)" : "Tela cheia"}
          onClick={() => setFullscreen(!full)}
        >
          <Icon name={full ? "minimize" : "maximize"} />
        </button>
      </div>
      {(screenNotice || screenQuality) && (
        <div className="screen-info">
          {screenQuality && <span>Transmitindo em {screenQuality}</span>}
          {screenNotice && <span className="warn">{screenNotice}</span>}
        </div>
      )}
      {resizable && (
        <div
          className={`call-resize${dragSize !== null ? " dragging" : ""}`}
          title="Arraste para redimensionar · clique duplo para o tamanho automático"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => useUi.getState().set({ callSize: null })}
        />
      )}
    </div>
  );
}

/** Everyone at once, in the largest 16:9 tiles that fit. */
function StageGrid({ tiles, tileProps }: { tiles: StageTile[]; tileProps: (t: StageTile) => TileProps }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = Math.max(120, gridLayout(tiles.length, box.w, box.h, GRID_GAP).tileWidth);
  return (
    <div ref={ref} className="call-grid">
      {box.w > 0 && tiles.map((t) => <Tile key={t.id} {...tileProps(t)} style={{ width }} />)}
    </div>
  );
}

/** Mic, sound, camera and hang up: in fullscreen the sidebar controls are covered. */
function CallControls() {
  const muted = useCall((s) => s.muted);
  const deafened = useCall((s) => s.deafened);
  const cameraOn = useCall((s) => s.cameraOn);
  return (
    <>
      <button
        type="button"
        className={`icon-btn${muted ? " danger" : ""}`}
        title={muted ? "Ativar microfone" : "Silenciar microfone"}
        onClick={() => void calls.toggleMute()}
      >
        <Icon name={muted ? "micOff" : "mic"} />
      </button>
      <button
        type="button"
        className={`icon-btn${deafened ? " danger" : ""}`}
        title={deafened ? "Ativar som" : "Desativar som"}
        onClick={() => void calls.toggleDeafen()}
      >
        <Icon name={deafened ? "headphonesOff" : "headphones"} />
      </button>
      <button
        type="button"
        className={`icon-btn${cameraOn ? " on" : ""}`}
        title={cameraOn ? "Desligar câmera" : "Ligar câmera"}
        onClick={() => void calls.setCamera(!cameraOn)}
      >
        <Icon name={cameraOn ? "video" : "videoOff"} />
      </button>
      <button type="button" className="icon-btn danger" title="Sair da chamada" onClick={() => void calls.leave()}>
        <Icon name="phoneOff" />
      </button>
      <span className="stage-bar-sep" />
    </>
  );
}

function useAttachedVideo(identity: string, source: "camera" | "screen_share", enabled: boolean) {
  const ref = useRef<HTMLVideoElement>(null);
  const version = useCall((s) => s.trackVersion);
  useEffect(() => {
    const el = ref.current;
    const track = enabled ? calls.videoTrack(identity, source) : undefined;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [identity, source, enabled, version]);
  return ref;
}

/**
 * One camera/avatar or screen share. Small: a click enlarges it. Enlarged
 * (`big`): a double click toggles fullscreen.
 */
function Tile({
  tile,
  live,
  full,
  big = false,
  style,
  onPick,
  onUnfocus,
  onFullscreen,
}: TileProps & { big?: boolean; style?: CSSProperties }) {
  const { p, kind } = tile;
  const screen = kind === "screen";
  const user = useNexus((s) => s.users[p.identity]);
  const deafenedRemote = useNexus((s) => {
    const call = Object.values(s.calls).find((c) => c.participants.some((x) => x.user_id === p.identity));
    return call?.participants.find((x) => x.user_id === p.identity)?.deafened ?? false;
  });
  const showVideo = screen ? live : p.hasCamera;
  const ref = useAttachedVideo(p.identity, screen ? "screen_share" : "camera", showVideo);
  const name = user?.display_name ?? p.name;
  const avatar = user ?? { id: p.identity, display_name: p.name, avatar_url: null };
  const speaking = p.speaking && !p.micMuted;
  const inFull = big && full;

  const onContextMenu = (e: React.MouseEvent) => {
    const at = { x: e.clientX, y: e.clientY };
    const layout: MenuEntry[] = [
      big ? { label: "Voltar para a grade", icon: "grid", run: onUnfocus } : { label: "Ampliar", icon: "maximize", run: onPick },
      { label: inFull ? "Sair da tela cheia" : "Tela cheia", icon: inFull ? "minimize" : "maximize", run: () => onFullscreen(!inFull) },
    ];
    if (screen) {
      // Stream audio volume, apart from the person's voice. You never hear your own stream.
      openContextMenu(e, () => [
        !p.isLocal &&
          (p.hasScreenAudio
            ? streamVolumeEntry(p.identity)
            : { label: "Esta transmissão está sem áudio", icon: "volume", disabled: true }),
        { separator: true },
        ...layout,
        !p.isLocal && live && { label: "Parar de assistir", icon: "x", run: () => calls.watchStream(p.identity, false) },
      ]);
      return;
    }
    // Volume first (the most used action in a call), then the usual person menu.
    const conv = useCall.getState().conversationId;
    const serverId = (conv && client().store.getState().conversations[conv]?.server_id) || null;
    openContextMenu(e, () => [
      !p.isLocal && volumeEntry(p.identity),
      !p.isLocal && p.hasScreenAudio && streamVolumeEntry(p.identity),
      { separator: true },
      ...layout,
      { separator: true },
      ...userMenu(p.identity, at, serverId),
    ]);
  };

  const cls = ["tile", screen && "screen", big && "big", !screen && speaking && "speaking", !showVideo && "empty"];
  return (
    <div
      className={cls.filter(Boolean).join(" ")}
      style={style}
      onClick={big ? undefined : onPick}
      onDoubleClick={big ? () => onFullscreen(!full) : undefined}
      onContextMenu={onContextMenu}
    >
      {showVideo ? (
        <video ref={ref} autoPlay playsInline muted className={!screen && p.isLocal ? "mirror" : ""} />
      ) : screen ? (
        <div className="tile-watch">
          <Avatar user={avatar} size={big ? 96 : 40} />
          <span className="tile-watch-btn">Assistir</span>
        </div>
      ) : (
        <Avatar user={avatar} size={big ? 128 : 64} speaking={speaking} />
      )}
      {screen && <span className="tile-live">Ao vivo</span>}
      <div className="tile-label">
        {screen ? (
          <>
            <Icon name="screen" size={14} />
            <span>{p.isLocal ? "Sua tela" : name}</span>
            {p.hasScreenAudio && <Icon name="volume" size={14} />}
          </>
        ) : (
          <>
            {p.micMuted && <Icon name="micOff" size={14} className="danger-text" />}
            {deafenedRemote && <Icon name="headphonesOff" size={14} className="danger-text" />}
            <span>{name}</span>
            {p.quality === "poor" && <small className="warn"> conexão ruim</small>}
          </>
        )}
      </div>
      <div className="tile-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {screen && live && !p.isLocal && (
          <button type="button" title="Parar de assistir" onClick={() => calls.watchStream(p.identity, false)}>
            <Icon name="x" size={16} />
          </button>
        )}
        <button type="button" title={inFull ? "Sair da tela cheia" : "Tela cheia"} onClick={() => onFullscreen(!inFull)}>
          <Icon name={inFull ? "minimize" : "maximize"} size={16} />
        </button>
      </div>
    </div>
  );
}
