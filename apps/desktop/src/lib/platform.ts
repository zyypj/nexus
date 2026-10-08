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

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri) {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    return;
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

export async function setBadge(count: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setTitle(count > 0 ? `(${count > 99 ? "99+" : count}) Nexus` : "Nexus");
  } catch {
    // Title update is cosmetic.
  }
}

export async function flashWindow(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* cosmetic */
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
