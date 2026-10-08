import { create } from "zustand";
import { useCall } from "../call/callStore";
import { isTauri } from "./platform";
import { settings } from "./settings";

/**
 * Auto-update from GitHub Releases (tauri-plugin-updater): the app reads
 * `latest.json` from the newest release, verifies the minisign signature
 * against the public key in tauri.conf.json, and installs the NSIS update.
 *
 * Mandatory at startup (`startupUpdate`, before the app opens): a newer
 * release is downloaded and installed right away. While running, checks every
 * 6 hours (one timer); with "atualizar automaticamente" on, the download
 * happens in the background and the user only confirms the restart.
 */
type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";
  version: string | null;
  notes: string | null;
  progress: number;
  error: string | null;
}

export const useUpdater = create<UpdaterState>()(() => ({
  status: "idle",
  version: null,
  notes: null,
  progress: 0,
  error: null,
}));

const CHECK_EVERY_MS = 60 * 60 * 1000;
let pending: NonNullable<Update> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export async function checkForUpdates(): Promise<void> {
  if (!isTauri) return;
  const s = useUpdater.getState();
  if (s.status === "downloading" || s.status === "ready" || s.status === "installing") return;
  useUpdater.setState({ status: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      useUpdater.setState({ status: "idle" });
      return;
    }
    pending = update;
    useUpdater.setState({ status: "available", version: update.version, notes: update.body ?? null });
    if (settings().autoUpdate) await download();
    // Never restart under someone who is using the window; tray → now.
    if (document.visibilityState === "hidden") installWhenIdle();
  } catch (e) {
    // Offline or GitHub unreachable: try again at the next scheduled check.
    useUpdater.setState({ status: "idle", error: String(e) });
  }
}

export async function download(): Promise<void> {
  if (!pending) return;
  let total = 0;
  let received = 0;
  useUpdater.setState({ status: "downloading", progress: 0 });
  try {
    await pending.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        useUpdater.setState({ progress: total ? Math.min(1, received / total) : 0 });
      }
    });
    useUpdater.setState({ status: "ready", progress: 1 });
  } catch (e) {
    useUpdater.setState({ status: "error", error: `Falha ao baixar a atualização: ${String(e)}` });
  }
}

/** Installs the downloaded update and restarts the app. */
export async function installAndRestart(): Promise<void> {
  if (!pending) return;
  if (useUpdater.getState().status !== "ready") {
    await download();
    if (useUpdater.getState().status !== "ready") return; // download error is in the state
  }
  useUpdater.setState({ status: "installing" });
  try {
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: "error", error: `Falha ao instalar: ${String(e)}` });
  }
}

/**
 * Mandatory updates also apply to an app that lives in the tray: a downloaded
 * update is installed while the window is hidden, or the moment it is opened
 * again — never in the middle of a call.
 */
function installWhenIdle() {
  if (useUpdater.getState().status !== "ready" || useCall.getState().status !== "idle") return;
  void installAndRestart();
}

function onVisibility() {
  // Hidden (tray) or just reopened: either way nobody is using the old version.
  installWhenIdle();
}

export function startUpdateChecks(): void {
  if (!isTauri || timer) return;
  document.addEventListener("visibilitychange", onVisibility);
  const loop = () => {
    void checkForUpdates();
    timer = setTimeout(loop, CHECK_EVERY_MS);
  };
  // startupUpdate() already checked at launch.
  timer = setTimeout(loop, CHECK_EVERY_MS);
}

/** How long the launch check may take before the app opens anyway (offline). */
const STARTUP_CHECK_TIMEOUT_MS = 8000;

/**
 * Launch gate: resolves "open" when the app is up to date (or the check is
 * impossible, e.g. offline). When a newer version exists it never resolves:
 * the update is downloaded, installed and the app restarts on the new version.
 * Errors after an update was found keep the gate closed (retry only).
 */
export async function startupUpdate(): Promise<"open"> {
  if (!isTauri) return "open";
  useUpdater.setState({ status: "checking", error: null });
  let update: Update = null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await Promise.race([
      check({ timeout: STARTUP_CHECK_TIMEOUT_MS }),
      new Promise<null>((r) => setTimeout(() => r(null), STARTUP_CHECK_TIMEOUT_MS + 500)),
    ]);
  } catch {
    update = null;
  }
  if (!update) {
    useUpdater.setState({ status: "idle" });
    return "open";
  }
  pending = update;
  useUpdater.setState({ status: "available", version: update.version, notes: update.body ?? null });
  await installAndRestart();
  // Only reached if download/install failed: the gate shows the error + retry.
  return new Promise<"open">(() => undefined);
}

/** Retry from the launch gate after a failed mandatory update. */
export async function retryStartupUpdate(): Promise<void> {
  useUpdater.setState({ status: "available", error: null, progress: 0 });
  await installAndRestart();
}
