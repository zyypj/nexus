import { useEffect, useState } from "react";
import { useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { ChatView } from "./ChatView";
import { FriendsView } from "./FriendsView";
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
    </div>
  );
}
