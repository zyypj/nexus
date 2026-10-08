import { type ConversationView, Permissions, hasPermission } from "@nexus/protocol";
import { callForConversation, memberColor, memberName } from "@nexus/shared";
import { calls } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useNexus } from "../lib/nexus";

/** A voice channel you are not in yet: who is there + join. */
export function VoiceLobby({ channel }: { channel: ConversationView }) {
  const call = useNexus((s) => callForConversation(s, channel.id));
  const people = call?.participants ?? [];
  const canConnect = hasPermission(channel.permissions, Permissions.CONNECT);
  const canSpeak = hasPermission(channel.permissions, Permissions.SPEAK);
  return (
    <div className="voice-lobby">
      <div className="voice-lobby-card">
        <span className="voice-lobby-icon">
          <Icon name="volume" size={30} />
        </span>
        <h2>{channel.name}</h2>
        <p className="hint">
          {people.length === 0
            ? "Ninguém por aqui ainda."
            : `${people.length} ${people.length === 1 ? "pessoa conversando" : "pessoas conversando"}`}
        </p>
        {people.length > 0 && (
          <div className="voice-lobby-people">
            {people.map((p) => (
              <LobbyPerson key={p.user_id} serverId={channel.server_id ?? ""} userId={p.user_id} live={p.screen} />
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn primary big glow"
          disabled={!canConnect}
          onClick={() => void calls.start(channel.id)}
        >
          <Icon name="phone" size={18} /> Entrar no canal
        </button>
        {!canConnect && <p className="hint warn">Você não tem permissão para entrar neste canal.</p>}
        {canConnect && !canSpeak && <p className="hint">Neste canal você entra só ouvindo.</p>}
      </div>
    </div>
  );
}

function LobbyPerson({ serverId, userId, live }: { serverId: string; userId: string; live: boolean }) {
  const user = useNexus((s) => s.users[userId]);
  const name = useNexus((s) => memberName(s, s.servers[serverId], userId));
  const color = useNexus((s) => {
    const sv = s.servers[serverId];
    return sv ? memberColor(sv, userId) : undefined;
  });
  return (
    <div className="lobby-person">
      <Avatar user={user} size={56} />
      <span style={color ? { color } : undefined}>{name}</span>
      {live && <span className="live-tag">AO VIVO</span>}
    </div>
  );
}
