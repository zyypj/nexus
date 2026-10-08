import { create } from "zustand";
import { isTauri } from "./platform";
import { settings } from "./settings";

/**
 * Auto-update from GitHub Releases (tauri-plugin-updater): the app reads
 * `latest.json` from the newest release, verifies the minisign signature
 * against the public key in tauri.conf.json, and installs the NSIS update.
 *
 * Checks at startup and every 6 hours (one timer, nothing else polls).
 * With "atualizar automaticamente" on, the download happens in the background
 * and the user only confirms the restart.
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

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
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
  useUpdater.setState({ status: "installing" });
  try {
    if (useUpdater.getState().progress < 1) await download();
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: "error", error: `Falha ao instalar: ${String(e)}` });
  }
}

export function startUpdateChecks(): void {
  if (!isTauri || timer) return;
  const loop = () => {
    void checkForUpdates();
    timer = setTimeout(loop, CHECK_EVERY_MS);
  };
  // Give startup some room before touching the network.
  timer = setTimeout(loop, 15_000);
}
