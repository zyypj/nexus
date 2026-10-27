import type { TokenStore } from "@nexus/shared";

/** True inside the Tauri shell; false when the UI runs in a plain browser (vite dev). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type InvokeArgs = Record<string, unknown>;

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Refresh token storage: Windows Credential Manager, or sessionStorage in a browser. */
export function tokenStore(serverUrl: string): TokenStore {
  const key = `refresh:${serverUrl}`;
  if (!isTauri) {
    return {
      load: async () => sessionStorage.getItem(key),
      save: async (v) => sessionStorage.setItem(key, v),
      clear: async () => sessionStorage.removeItem(key),
    };
  }
  return {
    load: () => invoke<string | null>("secret_get", { key }),
    save: (value) => invoke("secret_set", { key, value }),
    clear: () => invoke("secret_delete", { key }),
  };
}

/**
 * System notification. On Windows it goes through our own toast command so a
 * click brings the window back and opens `conversationId` (see
 * src-tauri/src/notifications.rs); elsewhere through the plugin.
 */
export async function notify(title: string, body: string, conversationId?: string): Promise<void> {
  if (!isTauri) {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    return;
  }
  try {
    await invoke("notify_show", { title, body, conversationId: conversationId ?? null });
    return;
  } catch {
    // not Windows: plugin below
  }
  const n = await import("@tauri-apps/plugin-notification");
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === "granted";
  if (granted) n.sendNotification({ title, body });
}

export async function listen<T>(event: string, fn: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => fn(e.payload));
}

/** RGBA pixels of a red circle with the count, for the taskbar overlay. */
function badgePixels(count: number, size = 32): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const label = count > 99 ? "99+" : String(count);
  ctx.fillStyle = "#f23f43";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const px = label.length === 1 ? 22 : label.length === 2 ? 18 : 13;
  ctx.font = `800 ${Math.round((px * size) / 32)}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(label, size / 2, size / 2 + size / 32);
  return ctx.getImageData(0, 0, size, size).data;
}

let lastBadge = -1;

/**
 * Unread count on the app icon, like Discord/WhatsApp: a red circle with the
 * number over the taskbar button (Windows overlay icon), plus "(n) Nexus" in
 * the window title.
 */
export async function setBadge(count: number): Promise<void> {
  if (!isTauri || count === lastBadge) return;
  lastBadge = count;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  try {
    await w.setTitle(count > 0 ? `(${count > 99 ? "99+" : count}) Nexus` : "Nexus");
  } catch {
    // Title update is cosmetic.
  }
  try {
    if (count <= 0) {
      await w.setOverlayIcon(undefined);
      return;
    }
    const pixels = badgePixels(count);
    if (!pixels) return;
    const { Image } = await import("@tauri-apps/api/image");
    const img = await Image.new(new Uint8Array(pixels.buffer), 32, 32);
    await w.setOverlayIcon(img);
    await img.close();
  } catch {
    // Not Windows (overlay icons are Windows-only): the dock badge instead.
    await w.setBadgeCount(count > 0 ? count : undefined).catch(() => undefined);
  }
}

/**
 * Real fullscreen for the window. WebView2 only stretches a fullscreen element
 * over the window it is in, so the shell is asked to cover the monitor; in a
 * browser the page itself goes fullscreen.
 */
export async function setWindowFullscreen(on: boolean): Promise<void> {
  try {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
    } else if (on) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Not allowed (no user gesture): the stage still fills the window.
  }
}

/** Opens http(s) URLs in the default browser, never inside the app WebView. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export const deviceName = (): string => {
  const ua = navigator.userAgent;
  return isTauri ? "Nexus Windows" : ua.includes("Windows") ? "Navegador (Windows)" : "Navegador";
};
