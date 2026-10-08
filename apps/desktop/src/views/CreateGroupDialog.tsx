import { MAX_GROUP_MEMBERS } from "@nexus/protocol";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { client, useNexus } from "../lib/nexus";

export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const friends = useNexus(useShallow((s) => Object.values(s.friends)));
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_GROUP_MEMBERS - 1) next.add(id);
      return next;
    });

  async function create() {
    try {
      const c = await client().api.createGroup(name.trim(), [...selected]);
      onClose();
      await client().openConversation(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title="Novo grupo" onClose={onClose}>
      <label>
        Nome do grupo
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Opcional" />
      </label>
      <p className="hint">Escolha amigos ({selected.size} selecionados)</p>
      <div className="pick-list">
        {friends.map((f) => (
          <label key={f.user.id} className="pick-item">
            <input type="checkbox" checked={selected.has(f.user.id)} onChange={() => toggle(f.user.id)} />
            <Avatar user={f.user} size={28} />
            <span>{f.user.display_name}</span>
          </label>
        ))}
        {friends.length === 0 && <p className="empty-hint">Adicione amigos primeiro.</p>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn primary" onClick={() => void create()}>
          Criar grupo
        </button>
      </div>
    </Modal>
  );
}
