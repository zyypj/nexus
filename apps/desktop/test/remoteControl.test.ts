import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(), invoke: vi.fn(),
  call: { callId: "call", status: "connected", screenOn: true },
}));
vi.mock("../src/lib/nexus", () => ({ client: () => ({ api: { request: mocks.request, baseUrl: "https://nexus.example" }, state: { me: { id: "owner" } } }) }));
vi.mock("../src/lib/platform", () => ({ invoke: mocks.invoke, isTauri: true }));
vi.mock("../src/call/callStore", () => ({ useCall: { getState: () => mocks.call } }));
import { NO_CONTROL, controlTransportAllowed, receiveControlInput, respondControl, sendControlInput, setControlSource, stopRemoteControl, syncRemoteControl, useRemoteControl, videoPoint } from "../src/call/remoteControl";
const share = { owner_id: "owner", controller_id: "controller", request_id: "request", accepted: true, expires_at: 9999999999999, permissions: { ...NO_CONTROL, pointer: true } };
const packet = { call_id: "call", request_id: "request", sequence: 1, epoch: 2, input: { kind: "move" as const, x: 0.5, y: 0.5 } };

beforeEach(() => {
  mocks.invoke.mockResolvedValue({ active: false, epoch: 0, paused_ms: 0 });
  mocks.request.mockResolvedValue({});
  stopRemoteControl();
  mocks.request.mockReset().mockResolvedValue({ shares: [share], can_request: true });
  mocks.invoke.mockReset().mockResolvedValue({ active: true, epoch: 2, paused_ms: 0 });
  mocks.call.status = "connected";
  useRemoteControl.setState({ offered: true, sourceId: "window:1", requestId: "request", shares: [share], error: null });
});
afterEach(() => vi.restoreAllMocks());

describe("native authorization boundary", () => {
  it("does not forward packets for another call, grant, or stopped share", () => {
    receiveControlInput({ ...packet, call_id: "other" });
    receiveControlInput({ ...packet, request_id: "old" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    stopRemoteControl(); mocks.invoke.mockClear();
    receiveControlInput(packet);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("passes only authenticated current packets to the native guard", () => {
    receiveControlInput(packet);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_control_input", { requestId: "request", epoch: 2, sequence: 1, input: packet.input });
  });
  it("cannot restore a grant when capture changes during acceptance", async () => {
    let resolve!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const pending = respondControl({ ...share, accepted: false }, true, share.permissions, { x: 0, y: 0, width: 1, height: 1 });
    setControlSource("window:2"); resolve(); await pending;
    expect(useRemoteControl.getState().requestId).toBeNull();
    expect(mocks.request.mock.calls.some((args) => args[2]?.action === "respond")).toBe(false);
  });
  it("renews the native lease only after an authenticated server heartbeat", async () => {
    await syncRemoteControl();
    const heartbeat = mocks.request.mock.invocationCallOrder[0];
    const renew = mocks.invoke.mock.calls.findIndex((args) => args[0] === "remote_control_status" && args[1]?.renew);
    expect(renew).toBeGreaterThanOrEqual(0);
    expect(heartbeat).toBeDefined();
    expect(mocks.invoke.mock.invocationCallOrder[renew]).toBeGreaterThan(heartbeat ?? 0);
  });
  it("stops on heartbeat failure and does not renew native access", async () => {
    mocks.request.mockRejectedValueOnce(new Error("revoked"));
    await syncRemoteControl();
    expect(useRemoteControl.getState().offered).toBe(false);
    expect(mocks.invoke.mock.calls.some((args) => args[1]?.renew === true)).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_control_stop");
  });
  it("stops when the native emergency button has revoked access", async () => {
    mocks.invoke.mockResolvedValue({ active: false, epoch: 9, paused_ms: 0 });
    await syncRemoteControl();
    expect(useRemoteControl.getState().offered).toBe(false);
  });
  it("does not buffer another input while one is in flight", async () => {
    useRemoteControl.setState({ offered: false, shares: [{ ...share, owner_id: "target", controller_id: "owner" }] });
    let resolve!: () => void;
    mocks.request.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const first = sendControlInput("target", { kind: "click", x: 0.5, y: 0.5, button: 0 });
    await sendControlInput("target", { kind: "click", x: 0.6, y: 0.6, button: 0 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    resolve(); await first;
  });
  it("lets a click overtake a pending move without buffering more actions", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    useRemoteControl.setState({ offered: false, shares: [{ ...share, owner_id: "target", controller_id: "owner" }] });
    let resolve!: () => void;
    mocks.request.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const first = sendControlInput("target", { kind: "move", x: 0.5, y: 0.5 });
    await sendControlInput("target", { kind: "click", x: 0.6, y: 0.6, button: 0 });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    resolve(); await first;
  });
});

describe("traffic", () => {
  it("sends the newest pointer position after the throttle instead of dropping it", async () => {
    vi.useFakeTimers();
    let now = 50_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    useRemoteControl.setState({ offered: false, shares: [{ ...share, owner_id: "target", controller_id: "owner" }] });
    const move = (x: number) => ({ kind: "move" as const, x, y: 0.5 });
    await sendControlInput("target", move(0.1));
    now += 10;
    await sendControlInput("target", move(0.2));
    await sendControlInput("target", move(0.3));
    now += 60;
    await vi.advanceTimersByTimeAsync(60);
    const sent = mocks.request.mock.calls.filter((args) => args[2]?.action === "input").map((args) => args[2].input.x);
    expect(sent).toEqual([0.1, 0.3]);
    vi.useRealTimers();
  });
  it("the owner's heartbeat carries its share, so no status poll is needed", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true, share });
    await syncRemoteControl(false);
    expect(mocks.request.mock.calls.map((args) => args[2]?.action ?? args[0])).toEqual(["heartbeat"]);
    expect(useRemoteControl.getState().offered).toBe(true);
  });
  it("stops when the heartbeat says the share is gone", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true, share: null });
    await syncRemoteControl(false);
    expect(useRemoteControl.getState().offered).toBe(false);
  });
  it("viewers without an offer do nothing on a heartbeat tick", async () => {
    useRemoteControl.setState({ offered: false, requestId: null });
    await syncRemoteControl(false);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("video coordinates", () => {
  it("requires HTTPS outside loopback", () => {
    expect(controlTransportAllowed("http://192.168.1.2:3000")).toBe(false);
    expect(controlTransportAllowed("http://localhost.evil.example")).toBe(false);
    expect(controlTransportAllowed("https://example.com")).toBe(true);
    expect(controlTransportAllowed("http://127.0.0.1:3000")).toBe(true);
  });
  it("rejects letterboxing and correctly maps negative monitor coordinates", () => {
    const r = { left: -100, top: 0, width: 200, height: 200 };
    expect(videoPoint(r, 200, 100, 0, 20)).toBeNull();
    expect(videoPoint(r, 200, 100, 0, 100)).toEqual({ x: 0.5, y: 0.5 });
    expect(videoPoint(r, 0, 100, 0, 100)).toBeNull();
    expect(videoPoint(r, 200, 100, 101, 100)).toBeNull();
  });
});
