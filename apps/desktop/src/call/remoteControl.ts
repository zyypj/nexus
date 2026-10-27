import type { ControlCapabilities, ControlCommand, ControlInput, ControlShare, ControlStatus, RemoteControlPacket } from "@nexus/protocol";
import { create } from "zustand";
import { client } from "../lib/nexus";
import { invoke, isTauri } from "../lib/platform";
import { useCall } from "./callStore";

export const NO_CONTROL: ControlCapabilities = { pointer: false, click: false, scroll: false, text: false };
export interface ControlArea { x: number; y: number; width: number; height: number }
interface NativeStatus { active: boolean; epoch: number; paused_ms: number }
interface RemoteState {
  shares: ControlShare[];
  canRequest: boolean;
  offered: boolean;
  dialog: boolean;
  sourceId: string | null;
  requestId: string | null;
  pausedMs: number;
  error: string | null;
}
export const useRemoteControl = create<RemoteState>()(() => ({
  shares: [], canRequest: false, offered: false, dialog: false, sourceId: null, requestId: null, pausedMs: 0, error: null,
}));
/** Minimum interval between pointer moves sent to the server. */
const MOVE_INTERVAL_MS = 60;
let revision = 0;
let sequence = 0;
let sendingMove = false;
let sendingAction = false;
let lastMove = 0;
/** Latest pointer position not sent yet; only the newest one is ever kept. */
let pendingMove: { ownerId: string; input: ControlInput } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;

export function controlTransportAllowed(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

function command<T = unknown>(body: ControlCommand, callId = useCall.getState().callId): Promise<T> {
  if (!callId) return Promise.reject(new Error("Entre na chamada primeiro."));
  if (body.action !== "stop" && !(body.action === "offer" && !body.enabled) && !controlTransportAllowed(client().api.baseUrl))
    return Promise.reject(new Error("Controle remoto exige uma conexão HTTPS. HTTP só é permitido em localhost para desenvolvimento."));
  return client().api.request<T>("POST", `/api/calls/${callId}/remote-control`, body);
}
function error(e: unknown) { useRemoteControl.setState({ error: e instanceof Error ? e.message : String(e) }); }

function dropPendingMove() {
  pendingMove = null;
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = null;
}

/** Called synchronously at every share replacement, disconnect and call teardown. */
export function stopRemoteControl(): void {
  revision++;
  dropPendingMove();
  const hadControl = useRemoteControl.getState().offered || useRemoteControl.getState().requestId !== null;
  useRemoteControl.setState({ offered: false, dialog: false, requestId: null, shares: [], pausedMs: 0 });
  if (isTauri) void invoke("remote_control_stop").catch(error);
  if (hadControl) void command({ action: "stop" }).catch(() => undefined);
}

export function setControlSource(sourceId: string | null) {
  stopRemoteControl();
  useRemoteControl.setState({ sourceId });
}

export async function offerControl(enabled: boolean) {
  if (!enabled) { stopRemoteControl(); return; }
  if (!isTauri || !useRemoteControl.getState().sourceId?.startsWith("window:")) {
    error("Para liberar controle, compartilhe uma janela pelo seletor do Nexus no Windows."); return;
  }
  const gen = ++revision;
  try {
    await command({ action: "offer", enabled: true });
    if (gen !== revision) { void command({ action: "stop" }).catch(() => undefined); return; }
    useRemoteControl.setState({ offered: true, dialog: false, error: null });
  } catch (e) { error(e); }
}

export async function requestControl(ownerId: string) {
  try {
    await command({ action: "request", owner_id: ownerId });
    await syncRemoteControl();
  } catch (e) { error(e); }
}

export async function respondControl(share: ControlShare, accept: boolean, permissions: ControlCapabilities, area: ControlArea) {
  const { sourceId } = useRemoteControl.getState();
  if (!share.request_id || !sourceId) return;
  const gen = revision;
  try {
    if (accept) {
      await invoke("remote_control_start", { sourceId, requestId: share.request_id, permissions, area });
      if (gen !== revision || sourceId !== useRemoteControl.getState().sourceId) { await invoke("remote_control_stop"); return; }
    }
    await command({ action: "respond", request_id: share.request_id, accept, permissions });
    if (gen !== revision) { if (isTauri) await invoke("remote_control_stop"); return; }
    useRemoteControl.setState({ requestId: accept ? share.request_id : null, error: null });
    await syncRemoteControl();
  } catch (e) {
    stopRemoteControl(); error(e);
  }
}

let syncing: Promise<void> | null = null;
let fullWanted = false;

/**
 * Single-flight: grants never survive a failed check or a reconnect.
 *
 * `full = false` is the owner's heartbeat alone (its answer carries the
 * owner's own share); `full = true` also fetches everybody's status. Status
 * changes are pushed (REMOTE_CONTROL_UPDATE), so a full sync runs on those
 * events and as a slow fallback, not on every tick. A full request made while
 * a sync is running is done right after it.
 */
export function syncRemoteControl(full = true): Promise<void> {
  fullWanted ||= full;
  syncing ??= (async () => {
    try {
      do {
        const wantFull = fullWanted;
        fullWanted = false;
        await syncOnce(wantFull);
      } while (fullWanted);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function syncOnce(full: boolean) {
  const { callId, status } = useCall.getState();
  if (!callId || status !== "connected") return;
  const gen = revision;
  const current = useRemoteControl.getState();
  const me = client().state.me?.id;
  try {
    if (current.offered) {
      const native = isTauri ? await invoke<NativeStatus>("remote_control_status", { renew: false, advance: true }) : null;
      if (gen !== revision) return;
      if (current.requestId && !native?.active) { stopRemoteControl(); return; }
      const beat = await command<{ share?: ControlShare | null }>({ action: "heartbeat", epoch: native?.epoch ?? 0 }, callId);
      if (gen !== revision) return;
      // Renew the native lease only AFTER the server has authenticated this heartbeat.
      if (current.requestId) await invoke("remote_control_status", { renew: true, advance: false });
      useRemoteControl.setState({ pausedMs: native?.paused_ms ?? 0 });
      // Older servers answer without the share: fall back to the full status.
      if (beat?.share !== undefined) {
        const own = beat.share;
        if (!own) { stopRemoteControl(); return; }
        if (current.requestId && (!own.accepted || own.request_id !== current.requestId)) { stopRemoteControl(); return; }
        if (!full) {
          const shares = useRemoteControl.getState().shares.filter((s) => s.owner_id !== me);
          useRemoteControl.setState({ shares: [...shares, own] });
          return;
        }
      }
    } else if (!full) return;
    const state = await client().api.request<ControlStatus>("GET", `/api/calls/${callId}/remote-control`);
    if (gen !== revision || callId !== useCall.getState().callId) return;
    const owner = state.shares.find((s) => s.owner_id === me);
    if (current.offered && !owner) { stopRemoteControl(); return; }
    if (current.offered && current.requestId && (!owner?.accepted || owner.request_id !== current.requestId)) { stopRemoteControl(); return; }
    const controlling = state.shares.find((s) => s.controller_id === me && s.accepted);
    useRemoteControl.setState({ shares: state.shares, canRequest: state.can_request,
      requestId: current.offered ? current.requestId : controlling?.request_id ?? null });
  } catch (e) {
    if (gen !== revision) return;
    if (current.offered || current.requestId) stopRemoteControl();
    useRemoteControl.setState({ shares: [], canRequest: false });
    if (current.offered || current.requestId) error(e);
  }
}

function activeShare(ownerId: string): ControlShare | undefined {
  const me = client().state.me?.id;
  if (useCall.getState().status !== "connected") return undefined;
  return useRemoteControl.getState().shares.find((s) => s.owner_id === ownerId && s.controller_id === me && s.accepted && s.request_id);
}

function post(share: ControlShare, input: ControlInput) {
  return command({ action: "input", request_id: share.request_id as string, sequence: ++sequence, input });
}

/**
 * Pointer moves: at most one in flight and one every MOVE_INTERVAL_MS; the
 * newest position waits and is sent next, so the pointer always ends where
 * the controller left it. Clicks, scroll and text: one at a time, no queue
 * (dropped while another is in flight). Older sequence numbers are discarded
 * by the server, so a click may overtake a pending move.
 */
export async function sendControlInput(ownerId: string, input: ControlInput) {
  if (!activeShare(ownerId)) return;
  if (input.kind === "move") {
    pendingMove = { ownerId, input };
    flushMove();
    return;
  }
  const share = activeShare(ownerId);
  if (!share || sendingAction) return;
  sendingAction = true;
  try { await post(share, input); }
  catch (e) { stopRemoteControl(); error(e); }
  finally { sendingAction = false; }
}

function flushMove() {
  if (!pendingMove || sendingMove || moveTimer) return;
  const wait = MOVE_INTERVAL_MS - (performance.now() - lastMove);
  if (wait > 0) {
    moveTimer = setTimeout(() => { moveTimer = null; flushMove(); }, wait);
    return;
  }
  const { ownerId, input } = pendingMove;
  pendingMove = null;
  const share = activeShare(ownerId);
  if (!share) return;
  sendingMove = true;
  lastMove = performance.now();
  void post(share, input)
    .catch((e) => { stopRemoteControl(); error(e); })
    .finally(() => { sendingMove = false; flushMove(); });
}

export function receiveControlInput(packet: RemoteControlPacket) {
  const state = useRemoteControl.getState();
  if (!isTauri || !state.offered || state.requestId !== packet.request_id || packet.call_id !== useCall.getState().callId
    || useCall.getState().status !== "connected" || !useCall.getState().screenOn) return;
  void invoke("remote_control_input", { requestId: packet.request_id, epoch: packet.epoch, sequence: packet.sequence, input: packet.input })
    .catch((e) => { stopRemoteControl(); error(e); });
}

/** Ignore black bars around object-fit:contain video. */
export function videoPoint(rect: { left: number; top: number; width: number; height: number }, width: number, height: number, x: number, y: number) {
  if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const w = width * scale, h = height * scale;
  const px = (x - rect.left - (rect.width - w) / 2) / w;
  const py = (y - rect.top - (rect.height - h) / 2) / h;
  return px >= 0 && py >= 0 && px < 1 && py < 1 ? { x: px, y: py } : null;
}
