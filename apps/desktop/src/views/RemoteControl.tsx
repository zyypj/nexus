import { useEffect, useRef, useState, type RefObject } from "react";
import type { ControlCapabilities, ControlShare } from "@nexus/protocol";
import { NO_CONTROL, offerControl, receiveControlInput, respondControl, sendControlInput, stopRemoteControl, syncRemoteControl, useRemoteControl, videoPoint } from "../call/remoteControl";
import { useCall } from "../call/callStore";
import { Modal } from "../components/Modal";
import { useNexus, useSession } from "../lib/nexus";
import { notify } from "../lib/platform";
import { playSound } from "../lib/sounds";

const labels: Record<keyof ControlCapabilities, string> = {
  pointer: "Mover o ponteiro livremente", click: "Clicar (botão esquerdo)", scroll: "Rolar a página", text: "Digitar texto (sem atalhos ou Enter)",
};

export function RemoteControlCenter() {
  const callId = useCall((s) => s.callId);
  const callStatus = useCall((s) => s.status);
  const screenOn = useCall((s) => s.screenOn);
  const ready = useNexus((s) => s.connection === "ready");
  const me = useNexus((s) => s.me?.id);
  const users = useNexus((s) => s.users);
  const participants = useCall((s) => s.participants);
  const remote = useRemoteControl();
  const active = remote.shares.find((s) => s.owner_id === me && s.accepted);
  const pending = remote.offered && remote.shares.find((s) => s.owner_id === me && s.request_id && !s.accepted);
  const pendingUser = pending ? users[pending.controller_id ?? ""] : undefined;
  const pendingName = pendingUser ? `${pendingUser.display_name} (@${pendingUser.username})` : "Usuário";
  const controlling = remote.shares.find((s) => s.controller_id === me);
  const nexus = useSession((s) => s.client);

  // Bound to the current client: a new login creates a new gateway.
  useEffect(() => {
    if (!nexus) return;
    const offInput = nexus.gateway.on("REMOTE_CONTROL_INPUT", receiveControlInput);
    const offUpdate = nexus.gateway.on("REMOTE_CONTROL_UPDATE", (d) => {
      if (d.call_id === useCall.getState().callId) void syncRemoteControl(true);
    });
    return () => { offInput(); offUpdate(); };
  }, [nexus]);
  useEffect(() => {
    if (!callId || callStatus !== "connected" || !ready) { stopRemoteControl(); return; }
    // Changes are pushed by the server; only the owner offering control keeps
    // a heartbeat (every 500 ms). The full status is a slow fallback (5 s).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let beats = 0;
    const tick = async () => {
      clearTimeout(timer);
      const offered = useRemoteControl.getState().offered;
      await syncRemoteControl(!offered || beats++ % 10 === 0);
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), useRemoteControl.getState().offered ? 500 : 5000);
    };
    void tick();
    // Offering starts the heartbeat at once: the server drops an offer
    // without one within 4 s.
    const offStart = useRemoteControl.subscribe((s, prev) => {
      if (s.offered && !prev.offered) void tick();
    });
    return () => { cancelled = true; clearTimeout(timer); offStart(); stopRemoteControl(); };
  }, [callId, callStatus, ready]);
  // A request is easy to miss while another window is shared: sound + system notification.
  const pendingId = pending ? pending.request_id : null;
  useEffect(() => {
    if (!pendingId) return;
    playSound("control_request");
    void notify("Pedido de controle remoto", `${pendingName} quer controlar sua janela. Abra o Nexus para aceitar ou recusar.`,
      useCall.getState().conversationId ?? undefined);
  }, [pendingId]);
  useEffect(() => { if (!screenOn && remote.offered) stopRemoteControl(); }, [screenOn, remote.offered]);
  useEffect(() => {
    if (active?.controller_id && !participants.some((p) => p.identity === active.controller_id)) stopRemoteControl();
  }, [active?.controller_id, participants]);

  return <>
    {remote.error && <div className="remote-banner" role="alert">
      <span>{remote.error}</span><button className="btn" onClick={() => useRemoteControl.setState({ error: null })}>Fechar</button>
    </div>}
    {(remote.offered || controlling) && <div className="remote-banner" role="status">
      <span>{active
        ? `${users[active.controller_id ?? ""]?.display_name ?? "Outro usuário"} tem controle da sua janela. ${remote.pausedMs > 0 ? "PAUSADO: você tem prioridade por 3 segundos." : "Esc encerra."}`
        : controlling?.accepted ? "Controle autorizado. Ative o modo de controle na transmissão."
        : controlling ? "Solicitação enviada. Aguardando o dono aceitar." : "Solicitações de controle liberadas. Ninguém tem acesso sem seu aceite."}</span>
      <button className="btn danger" onClick={stopRemoteControl}>Encerrar controle e solicitações</button>
    </div>}
    {remote.dialog && <EnableControlDialog />}
    {pending && <ConsentDialog key={pending.request_id} share={pending} name={pendingName} />}
  </>;
}

function Warning() {
  return <div className="remote-warning" role="note">
    <strong>PERIGO: controle remoto pode causar perda de arquivos, exposição de senhas e golpes.</strong>
    <p>Só permita a alguém que você conhece e confia. Confirme por voz quem está pedindo: nomes e fotos podem ser copiados. Não aceite pedidos de bancos ou de desconhecidos, nem aceite sob pressão.</p>
    <p>A pessoa poderá agir dentro da janela e da área que você liberar, inclusive alterar dados ou enviar mensagens. Os bloqueios reduzem riscos, mas não tornam um aplicativo seguro. Feche documentos, contas e informações sensíveis antes de aceitar.</p>
  </div>;
}

function EnableControlDialog() {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Modal title="Liberar solicitações de controle?" onClose={() => useRemoteControl.setState({ dialog: false })}>
    <div className="remote-dialog">
      <Warning />
      <p>Isso só permite pedir acesso. Você terá que aprovar a pessoa e escolher permissões a cada sessão, por até 5 minutos.</p>
      <p>Somente a janela compartilhada pode receber entrada. Nexus, UAC, aplicativos administrativos, ferramentas do sistema e terminais são bloqueados. Transferência de arquivos, área de transferência e atalhos do sistema não são oferecidos.</p>
      <label><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> Li e entendi os riscos. Vou acompanhar toda a sessão.</label>
      <button className="btn primary" disabled={!understood || busy} onClick={() => { setBusy(true); void offerControl(true).finally(() => setBusy(false)); }}>Liberar somente solicitações</button>
    </div>
  </Modal>;
}

export function ConsentDialog({ share, name }: { share: ControlShare; name: string }) {
  const app = useCall((s) => s.screenSettings?.app?.name);
  const [permissions, setPermissions] = useState<ControlCapabilities>({ ...NO_CONTROL });
  const [area, setArea] = useState({ x: 0, y: 0, width: 100, height: 100 });
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = Object.values(area).every(Number.isFinite) && area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0 && area.x + area.width <= 100 && area.y + area.height <= 100;
  const respond = (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    void respondControl(share, accept, permissions, { x: area.x / 100, y: area.y / 100, width: area.width / 100, height: area.height / 100 }).finally(() => setBusy(false));
  };
  return <Modal title={`${name} quer controlar sua janela`} onClose={() => respond(false)} wide>
    <div className="remote-dialog">
      <Warning />
      <p><strong>Quem:</strong> {name} · ID: <code>{share.controller_id}</code><br /><strong>Onde:</strong> somente a janela compartilhada de {app ?? "aplicativo"}, na área abaixo. Outras janelas e diálogos ficam bloqueados.</p>
      <fieldset><legend>O que esta pessoa pode fazer (tudo começa bloqueado)</legend>
        {(Object.keys(labels) as (keyof ControlCapabilities)[]).map((key) => <label key={key}>
          <input type="checkbox" checked={permissions[key]} onChange={(e) => setPermissions({ ...permissions, [key]: e.target.checked })} /> {labels[key]}
        </label>)}
        <p>Cliques e rolagem posicionam o ponteiro no ponto escolhido, mesmo sem movimento livre. Menus, listas suspensas e janelas que o aplicativo abrir ficam bloqueados para quem controla: só você pode usá-los.</p>
      </fieldset>
      <fieldset><legend>Área permitida, em % da imagem compartilhada</legend>
        <p>0, 0, 100, 100 permite toda a área interna da janela. A barra de título e as bordas ficam sempre bloqueadas. Este recorte limita entrada; quem assiste continua vendo toda a transmissão.</p>
        <div className="remote-presets">
          <button type="button" className="btn" onClick={() => setArea({ x: 0, y: 0, width: 100, height: 100 })}>Toda a janela</button>
          <button type="button" className="btn" onClick={() => setArea({ x: 0, y: 0, width: 50, height: 100 })}>Metade esquerda</button>
          <button type="button" className="btn" onClick={() => setArea({ x: 50, y: 0, width: 50, height: 100 })}>Metade direita</button>
          <button type="button" className="btn" onClick={() => setArea({ x: 25, y: 25, width: 50, height: 50 })}>Somente o centro</button>
        </div>
        <div className="remote-area-preview" role="img" aria-label="O retângulo amarelo representa a área que poderá receber controle">
          {valid && <div style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.width}%`, height: `${area.height}%` }}>Área permitida</div>}
        </div>
        <div className="remote-area">{([ ["x", "Esquerda"], ["y", "Topo"], ["width", "Largura"], ["height", "Altura"] ] as const).map(([key, label]) => <label key={key}>{label} (%)
          <input type="number" min={0} max={100} value={area[key]} onChange={(e) => setArea({ ...area, [key]: e.target.valueAsNumber })} />
        </label>)}</div>
        {!valid && <p role="alert">A área precisa ficar dentro de 0 a 100% e ter largura e altura positivas.</p>}
      </fieldset>
      <p>Qualquer uso local do mouse ou teclado pausa o controlador imediatamente por 3 segundos, renovados a cada ação sua. Esc ou o botão de emergência encerram o acesso. Para mudar limites, encerre e peça uma nova solicitação.</p>
      <label><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> Confio nesta pessoa, entendo os riscos e autorizo somente as opções marcadas por até 5 minutos.</label>
      <div className="remote-actions"><button className="btn" disabled={busy} onClick={() => respond(false)}>Recusar</button>
        <button className="btn danger" disabled={busy || !understood || !valid || !Object.values(permissions).some(Boolean)} onClick={() => respond(true)}>Autorizar esta pessoa</button>
      </div>
    </div>
  </Modal>;
}

/** Explicit controller mode; viewing a stream alone never forwards local input. */
export function RemoteControlSurface({ ownerId, video }: { ownerId: string; video: RefObject<HTMLVideoElement | null> }) {
  const me = useNexus((s) => s.me?.id);
  const share = useRemoteControl((s) => s.shares.find((x) => x.owner_id === ownerId && x.controller_id === me && x.accepted));
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { setEnabled(false); }, [share?.request_id]);
  useEffect(() => {
    const blur = () => setEnabled(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setEnabled(false); };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("keydown", key); };
  }, []);
  // Native wheel listener must be non-passive to prevent scrolling the local stage.
  useEffect(() => {
    const el = surface.current;
    if (!el || !enabled || !share?.permissions.scroll) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      const v = video.current;
      const p = v && videoPoint(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, e.clientX, e.clientY);
      if (p) void sendControlInput(ownerId, { kind: "scroll", ...p, delta: e.deltaY > 0 ? -120 : 120 });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [enabled, ownerId, share?.permissions.scroll, video]);
  if (!share) return null;
  const point = (e: { clientX: number; clientY: number }) => {
    const v = video.current;
    return v && videoPoint(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, e.clientX, e.clientY);
  };
  return <>
    {enabled && <div ref={surface} className="remote-surface" aria-label="Área de controle remoto"
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerMove={(e) => { const p = point(e); if (p && share.permissions.pointer) void sendControlInput(ownerId, { kind: "move", ...p }); }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); const p = point(e); if (p && e.button === 0 && share.permissions.click) void sendControlInput(ownerId, { kind: "click", ...p, button: 0 }); }} />}
    <div className="remote-controller" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className="btn" onClick={() => setEnabled(!enabled)}>{enabled ? "Sair do modo de controle (Esc)" : "Entrar no modo de controle"}</button>
      {enabled && <small>O dono deve deixar a janela em primeiro plano. Aguarde 3 segundos após ele usar mouse/teclado.</small>}
      {enabled && share.permissions.text && <form onSubmit={(e) => { e.preventDefault(); if (text) { void sendControlInput(ownerId, { kind: "text", text }); setText(""); } }}>
        <input aria-label="Texto para digitar na janela autorizada" value={text} maxLength={16} onChange={(e) => setText(e.target.value.replace(/[\x00-\x1f\x7f-\x9f]/g, ""))} placeholder="Texto sem atalhos" />
        <button className="btn" disabled={!text}>Digitar</button>
      </form>}
    </div>
  </>;
}
