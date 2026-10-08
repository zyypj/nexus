import { NexusClient, type NexusState, conversationTitle } from "@nexus/shared";
import { useStore } from "zustand";
import { create } from "zustand";
import { deviceName, notify, tokenStore } from "./platform";
import { settings } from "./settings";

/** App-level phase: which screen to show. */
interface SessionStore {
  phase: "boot" | "login" | "app";
  client: NexusClient | null;
  setPhase: (phase: SessionStore["phase"]) => void;
}

export const useSession = create<SessionStore>()((set) => ({
  phase: "boot",
  client: null,
  setPhase: (phase) => set({ phase }),
}));

let focused = typeof document !== "undefined" ? document.hasFocus() : true;
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    focused = true;
    const c = useSession.getState().client;
    const active = c?.state.activeConversationId;
    if (c && active) c.markRead(active);
  });
  window.addEventListener("blur", () => {
    focused = false;
  });
  // OS says the network is back: skip the remaining backoff.
  window.addEventListener("online", () => useSession.getState().client?.gateway.reconnectNow());
}

export function createClient(serverUrl: string): NexusClient {
  const old = useSession.getState().client;
  old?.gateway.stop();
  const client = new NexusClient({
    baseUrl: serverUrl,
    tokenStore: tokenStore(serverUrl),
    deviceName: deviceName(),
    isAppVisible: () => focused && document.visibilityState === "visible",
    onLoggedOut: () => useSession.getState().setPhase("login"),
    onNotify: (m, s) => {
      if (!settings().notifications) return;
      const author = s.users[m.author_id]?.display_name ?? "Nova mensagem";
      const conv = s.conversations[m.conversation_id];
      const title = conv && conv.kind === "group" ? `${author} em ${conversationTitle(s, conv)}` : author;
      const body = m.content || (m.attachments.length ? "📎 Anexo" : "");
      void notify(title, body.slice(0, 140));
    },
  });
  useSession.setState({ client });
  return client;
}

export function client(): NexusClient {
  const c = useSession.getState().client;
  if (!c) throw new Error("client not initialised");
  return c;
}

const emptyStore = new NexusClient({
  baseUrl: "http://invalid",
  tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
  deviceName: "",
}).store;

/** Subscribes a component to a slice of the Nexus state. */
export function useNexus<T>(selector: (s: NexusState) => T): T {
  const c = useSession((s) => s.client);
  return useStore(c?.store ?? emptyStore, selector);
}
