import { useState } from "react";
import { useNexus } from "../lib/nexus";
import { ChatView } from "./ChatView";
import { FriendsView } from "./FriendsView";
import { IncomingCall } from "./IncomingCall";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const active = useNexus((s) => s.activeConversationId);
  const connection = useNexus((s) => s.connection);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="shell">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="main">
        {connection !== "ready" && (
          <div className="conn-banner">
            {connection === "reconnecting" ? "Reconectando…" : connection === "stopped" ? "Desconectado" : "Conectando…"}
          </div>
        )}
        {active ? <ChatView key={active} conversationId={active} /> : <FriendsView />}
      </main>
      <IncomingCall />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
