import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway";

/** Minimal scripted WebSocket. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
  // test helpers
  open() {
    this.readyState = 1;
  }
  serverSend(t: string, d: unknown = {}) {
    this.onmessage?.({ data: JSON.stringify({ t, d }) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function makeClient(overrides: { refresh?: () => Promise<boolean> } = {}) {
  const states: string[] = [];
  const gw = new GatewayClient({
    url: () => "ws://test/gateway",
    getToken: async () => "token-1",
    refreshToken: overrides.refresh ?? (async () => true),
    onStateChange: (s) => states.push(s),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, capMs: 8000 },
  });
  return { gw, states };
}

describe("GatewayClient", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  async function handshake(sock: FakeSocket) {
    sock.open();
    sock.serverSend("HELLO", { heartbeat_interval_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    sock.serverSend("READY", { session_id: "s" });
  }

  it("identifies, becomes ready and dispatches events", async () => {
    const { gw } = makeClient();
    const seen: unknown[] = [];
    gw.on("MESSAGE_CREATE", (m) => seen.push(m));
    gw.start();
    const sock = FakeSocket.instances[0]!;
    await handshake(sock);
    expect(sock.sent[0]).toEqual({ op: "IDENTIFY", d: { token: "token-1" } });
    expect(gw.state).toBe("ready");
    sock.serverSend("MESSAGE_CREATE", { id: "m1" });
    expect(seen).toEqual([{ id: "m1" }]);
  });

  it("sends heartbeats and drops zombie connections", async () => {
    const { gw } = makeClient();
    gw.start();
    const sock = FakeSocket.instances[0]!;
    await handshake(sock);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sock.sent.filter((m) => (m as { op: string }).op === "HEARTBEAT")).toHaveLength(1);
    sock.serverSend("HEARTBEAT_ACK");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sock.sent.filter((m) => (m as { op: string }).op === "HEARTBEAT")).toHaveLength(2);
    // No ACK this time: next tick closes and reconnects.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sock.readyState).toBe(3);
    await flush();
    expect(gw.state).toBe("reconnecting");
  });

  it("reconnects with backoff and resyncs via READY", async () => {
    const { gw } = makeClient();
    let readies = 0;
    gw.on("READY", () => readies++);
    gw.start();
    await handshake(FakeSocket.instances[0]!);
    FakeSocket.instances[0]!.serverClose(1006);
    expect(gw.state).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    // Second failure waits up to 2s.
    FakeSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances).toHaveLength(3);
    await handshake(FakeSocket.instances[2]!);
    expect(readies).toBe(2);
    expect(gw.state).toBe("ready");
  });

  it("refreshes the token after an auth failure and stops when that fails", async () => {
    let refreshes = 0;
    const { gw } = makeClient({
      refresh: async () => {
        refreshes++;
        return refreshes < 2;
      },
    });
    gw.start();
    FakeSocket.instances[0]!.serverClose(4004);
    await flush();
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverClose(4004);
    await flush();
    expect(refreshes).toBe(2);
    expect(gw.state).toBe("stopped");
  });

  it("stop() prevents reconnection", async () => {
    const { gw } = makeClient();
    gw.start();
    await handshake(FakeSocket.instances[0]!);
    gw.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
