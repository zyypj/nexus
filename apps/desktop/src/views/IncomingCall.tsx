import type { Call } from "@nexus/protocol";
import { conversationTitle } from "@nexus/shared";
import { useEffect, useState } from "react";
import { calls, useCall } from "../call/callStore";
import { Icon } from "../components/Icon";
import { useNexus } from "../lib/nexus";
import { notify } from "../lib/platform";
import { startLoop, stopLoop } from "../lib/sounds";

/**
 * Shows a ringing banner for calls started by someone else in a DM or group
 * while we are not in any call. Dismissed calls stay dismissed.
 */
export function IncomingCall() {
  const myId = useNexus((s) => s.me?.id);
  const myCallId = useCall((s) => s.callId);
  const ringing = useNexus((s) =>
    Object.values(s.calls).find(
      (c) =>
        c.started_by !== myId &&
        c.participants.length > 0 &&
        !c.participants.some((p) => p.user_id === myId) &&
        Date.now() - c.created_at < 60_000,
    ),
  );
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const title = useNexus((s) => {
    const c = ringing ? s.conversations[ringing.conversation_id] : undefined;
    return c ? conversationTitle(s, c) : "";
  });
  const caller = useNexus((s) => (ringing?.started_by ? s.users[ringing.started_by]?.display_name : undefined));

  const show = ringing && !myCallId && !dismissed.has(ringing.id);
  useEffect(() => {
    if (show) void notify("Chamada recebida", `${caller ?? "Alguém"} está chamando em ${title}`);
  }, [show, caller, title]);
  useEffect(() => {
    if (!show) return;
    startLoop("ring");
    return () => stopLoop("ring");
  }, [show]);
  if (!show) return null;

  const dismiss = (c: Call) => setDismissed((d) => new Set(d).add(c.id));
  return (
    <div className="incoming-call" role="alertdialog">
      <div>
        <strong>{caller ?? "Chamada"}</strong>
        <small>{title}</small>
      </div>
      <button type="button" className="icon-btn on" onClick={() => void calls.join(ringing.id)} title="Atender">
        <Icon name="phone" />
      </button>
      <button type="button" className="icon-btn danger" onClick={() => dismiss(ringing)} title="Recusar">
        <Icon name="phoneOff" />
      </button>
    </div>
  );
}
