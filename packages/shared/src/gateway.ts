import type { ClientOp, GatewayEventName, GatewayEvents, GatewayFrame } from "@nexus/protocol";
import { CloseCodes } from "@nexus/protocol";
import { backoffDelay } from "./backoff";

export type GatewayState = "idle" | "connecting" | "ready" | "reconnecting" | "stopped";

type Listener<K extends GatewayEventName> = (data: GatewayEvents[K]) => void;

export interface GatewayOptions {
  url: () => string;
  /** Fresh access token (refreshing if needed); null = cannot authenticate. */
  getToken: () => Promise<string | null>;
  /** Forces a token refresh after the server rejected IDENTIFY. */
  refreshToken: () => Promise<boolean>;
  onStateChange?: (state: GatewayState) => void;
  WebSocketImpl?: typeof WebSocket;
  backoff?: { baseMs?: number; capMs?: number };
}

/**
 * One WebSocket per client. Heartbeats only run while connected (a single
 * chained timeout, no polling), reconnects use exponential backoff with
 * jitter, and every successful (re)connect yields a fresh READY snapshot
 * which is the re-sync point.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<GatewayEventName, Set<Listener<GatewayEventName>>>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAck = false;
  private attempt = 0;
  private stopped = true;
  private _state: GatewayState = "idle";
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: GatewayOptions) {
    this.WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  }

  get state(): GatewayState {
    return this._state;
  }

  private setState(s: GatewayState) {
    if (s === this._state) return;
    this._state = s;
    this.opts.onStateChange?.(s);
  }

  on<K extends GatewayEventName>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<GatewayEventName>);
    return () => set.delete(fn as Listener<GatewayEventName>);
  }

  /** Receives every dispatch frame (used by the store). */
  onAny(fn: (frame: GatewayFrame) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }
  private anyListeners = new Set<(frame: GatewayFrame) => void>();

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) ws.close(1000, "client stop");
    this.setState("stopped");
  }

  /** Reconnect immediately (e.g. the OS reports the network is back). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this._state === "ready" || this._state === "connecting") return;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  send(op: ClientOp): boolean {
    if (!this.ws || this.ws.readyState !== 1 || this._state !== "ready") return false;
    this.ws.send(JSON.stringify(op));
    return true;
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private connect() {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new this.WS(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as GatewayFrame;
      } catch {
        return;
      }
      this.handleFrame(ws, frame);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      void this.handleClose(ev.code);
    };
    ws.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  private handleFrame(ws: WebSocket, frame: GatewayFrame) {
    switch (frame.t) {
      case "HELLO":
        void this.identify(ws, frame.d.heartbeat_interval_ms);
        return;
      case "HEARTBEAT_ACK":
        this.awaitingAck = false;
        return;
      case "READY":
        this.attempt = 0;
        this.setState("ready");
        break;
      default:
        break;
    }
    for (const fn of this.anyListeners) fn(frame);
    const set = this.listeners.get(frame.t);
    if (set) for (const fn of set) fn(frame.d as never);
  }

  private async identify(ws: WebSocket, intervalMs: number) {
    const token = await this.opts.getToken();
    if (this.ws !== ws) return;
    if (!token) {
      // No credentials (network down while refreshing, or logged out).
      ws.close(4000, "no token");
      return;
    }
    ws.send(JSON.stringify({ op: "IDENTIFY", d: { token } } satisfies ClientOp));
    this.awaitingAck = false;
    // First beat is jittered so many clients do not beat in lockstep.
    this.scheduleHeartbeat(ws, intervalMs, Math.floor(intervalMs * (0.5 + Math.random() * 0.5)));
  }

  private scheduleHeartbeat(ws: WebSocket, intervalMs: number, delay: number) {
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      if (this.awaitingAck) {
        // Zombie connection: no ACK for a whole interval.
        ws.close(4000, "heartbeat ack timeout");
        return;
      }
      this.awaitingAck = true;
      ws.send(JSON.stringify({ op: "HEARTBEAT" } satisfies ClientOp));
      this.scheduleHeartbeat(ws, intervalMs, intervalMs);
    }, delay);
  }

  private async handleClose(code: number) {
    if (this.stopped) return;
    if (code === CloseCodes.AUTH_FAILED) {
      // Access token rejected: refresh once, give up if the session is gone.
      const ok = await this.opts.refreshToken();
      if (!ok) {
        this.stop();
        return;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setState("reconnecting");
    const delay = backoffDelay(this.attempt, this.opts.backoff);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
