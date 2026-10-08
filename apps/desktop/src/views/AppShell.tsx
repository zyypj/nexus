import { useEffect, useState } from "react";
import { useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { ContextMenuHost } from "../components/ContextMenu";
import { ChatView } from "./ChatView";
import { FriendsView } from "./FriendsView";
import { GlobalDialogs } from "./GlobalDialogs";
import { IncomingCall } from "./IncomingCall";
import { ServerRail } from "./ServerRail";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const active = useNexus((s) => s.activeConversationId);
  const activeServer = useNexus((s) => (s.activeConversationId ? s.conversations[s.activeConversationId]?.server_id : undefined));
  const connection = useNexus((s) => s.connection);
  const serverId = useUi((s) => s.serverId);
  const serverExists = useNexus((s) => (serverId ? !!s.servers[serverId] : true));
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Left a server (or it was deleted): back to Início.
  useEffect(() => {
    if (connection === "ready" && !serverExists) useUi.getState().set({ serverId: null });
  }, [connection, serverExists]);
  // Our own right-click menus replace the WebView's (Back / Reload / Inspect),
  // except where it is useful: text fields and selected text (copy/paste).
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true]")) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);
  // Opening a channel from elsewhere (invite, notification) selects its server.
  useEffect(() => {
    if (activeServer && activeServer !== useUi.getState().serverId) useUi.getState().set({ serverId: activeServer });
  }, [activeServer]);

  const shownServer = serverExists ? serverId : null;
  return (
    <div className="shell">
      <ServerRail />
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} serverId={shownServer} />
      <main className="main panel">
        {connection !== "ready" && (
          <div className="conn-banner">
            {connection === "reconnecting" ? "Reconectando…" : connection === "stopped" ? "Desconectado" : "Conectando…"}
          </div>
        )}
        {active ? (
          <ChatView key={active} conversationId={active} />
        ) : shownServer ? (
          <div className="empty-main">
            <img src="/logo.png" alt="" />
            <p>Escolha um canal.</p>
          </div>
        ) : (
          <FriendsView />
        )}
      </main>
      <IncomingCall />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <GlobalDialogs />
      <ContextMenuHost />
    </div>
  );
}
