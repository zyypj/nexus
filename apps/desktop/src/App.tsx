import { totalUnread } from "@nexus/shared";
import { useEffect, useState } from "react";
import { calls, useCall } from "./call/callStore";
import { createClient, useNexus, useSession } from "./lib/nexus";
import { invoke, isTauri, setBadge } from "./lib/platform";
import { useSettings } from "./lib/settings";
import { startUpdateChecks, startupUpdate } from "./lib/updater";
import { AppShell } from "./views/AppShell";
import { LoginView } from "./views/LoginView";
import { UpdateGate } from "./views/UpdateGate";

let restoreStarted = false;

export function App() {
  const phase = useSession((s) => s.phase);
  // Mandatory update before anything else is shown (no-op outside Tauri).
  const [gateOpen, setGateOpen] = useState(!isTauri);
  useEffect(() => {
    void startupUpdate().then(() => setGateOpen(true));
  }, []);

  useEffect(() => {
    // Once per page: a second restore (React dev StrictMode re-runs effects)
    // would race the first refresh-token rotation and get the session revoked
    // by the server's reuse detection.
    if (restoreStarted) return;
    restoreStarted = true;
    const url = useSettings.getState().serverUrl;
    if (!url) {
      useSession.getState().setPhase("login");
      return;
    }
    const c = createClient(url);
    c.restore()
      .then((ok) => useSession.getState().setPhase(ok ? "app" : "login"))
      .catch(() => useSession.getState().setPhase("login"));
  }, []);

  // Time-to-interactive for the benchmark tool: first frame after the
  // session was restored (or the login screen is shown).
  const booted = phase !== "boot" && gateOpen;
  useEffect(() => {
    if (!booted || !isTauri) return;
    requestAnimationFrame(() => setTimeout(() => void invoke("app_ready").catch(() => undefined), 0));
  }, [booted]);

  // Keep native-side settings in sync.
  const closeToTray = useSettings((s) => s.closeToTray);
  const hotkeys = useSettings((s) => s.hotkeys);
  useEffect(() => {
    if (isTauri) void invoke("set_close_to_tray", { enabled: closeToTray });
  }, [closeToTray]);
  useEffect(() => {
    if (isTauri)
      void invoke("hotkeys_set", {
        bindings: hotkeys.map(({ action, code, ctrl, alt, shift }) => ({ action, code, ctrl, alt, shift })),
      });
  }, [hotkeys]);

  useEffect(() => {
    if (phase === "app") startUpdateChecks();
  }, [phase]);

  if (!gateOpen) return <UpdateGate />;
  if (phase === "boot") return <div className="splash" />;
  if (phase === "login") return <LoginView />;
  return (
    <>
      <CallLifecycle />
      <UnreadBadge />
      <AppShell />
    </>
  );
}

/** Leaves the LiveKit room when the server ends the call. */
function CallLifecycle() {
  const callId = useCall((s) => s.callId);
  const exists = useNexus((s) => (callId ? !!s.calls[callId] : true));
  const ready = useNexus((s) => s.connection === "ready");
  useEffect(() => {
    if (callId && ready && !exists) void calls.onCallEnded(callId);
  }, [callId, exists, ready]);
  return null;
}

function UnreadBadge() {
  const unread = useNexus(totalUnread);
  useEffect(() => {
    void setBadge(unread);
  }, [unread]);
  return null;
}
