import type { Id } from "@nexus/protocol";
import { useState } from "react";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { OverwritePermissions } from "../components/PermissionEditor";
import { client, useNexus } from "../lib/nexus";
import { colorHex } from "../lib/ui";

/**
 * Settings of a channel or a category: name/topic, per-role permission
 * overwrites (private channels) and delete.
 */
export function ChannelSettings({ serverId, targetId, onClose }: { serverId: Id; targetId: Id; onClose: () => void }) {
  const server = useNexus((s) => s.servers[serverId]);
  const channel = useNexus((s) => s.conversations[targetId]);
  const category = server?.categories.find((c) => c.id === targetId);
  const [tab, setTab] = useState<"general" | "perms">("general");
  const [name, setName] = useState(channel?.name ?? category?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<Id>(serverId);
  if (!server || (!channel && !category)) return null;
  const api = client().api;
  const isVoice = channel?.kind === "voice";
  const title = category ? `Categoria ${category.name}` : `${isVoice ? "" : "#"}${channel?.name ?? ""}`;
  const overwrites = server.overwrites.filter((o) => o.target_id === targetId);
  const current = overwrites.find((o) => o.role_id === roleId) ?? { allow: 0, deny: 0 };
  const rolesWithOverwrite = new Set(overwrites.map((o) => o.role_id));

  async function save() {
    setError(null);
    try {
      if (category) await api.updateCategory(serverId, targetId, name);
      else await api.updateChannel(serverId, targetId, { name, ...(isVoice ? {} : { topic }) });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    try {
      if (category) await api.deleteCategory(serverId, targetId);
      else await api.deleteChannel(serverId, targetId);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
            Geral
          </button>
          <button type="button" className={tab === "perms" ? "active" : ""} onClick={() => setTab("perms")}>
            Permissões
          </button>
          <div className="settings-nav-sep" />
          <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
            {category ? "Apagar categoria" : "Apagar canal"}
          </button>
        </nav>
        <div className="settings-body">
          {tab === "general" && (
            <form
              className="form-grid"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                Nome
                <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              </label>
              {channel && !isVoice && (
                <label>
                  Tópico
                  <textarea
                    value={topic}
                    maxLength={1024}
                    rows={3}
                    placeholder="Sobre o que se fala aqui"
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </label>
              )}
              {error && <p className="form-error">{error}</p>}
              <div className="modal-actions">
                <button type="submit" className="btn primary" disabled={!name.trim()}>
                  Salvar
                </button>
              </div>
            </form>
          )}
          {tab === "perms" && (
            <div className="overwrite-editor">
              <div className="overwrite-roles">
                <p className="hint">
                  {category
                    ? "Vale para todos os canais da categoria (cada canal ainda pode ajustar)."
                    : "Ajustes só deste canal, por cargo."}
                </p>
                {server.roles.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className={`role-pill${roleId === r.id ? " active" : ""}${rolesWithOverwrite.has(r.id) ? " set" : ""}`}
                    onClick={() => setRoleId(r.id)}
                  >
                    <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : "var(--c-text-faint)" }} />
                    {r.name}
                  </button>
                ))}
              </div>
              <div className="overwrite-perms">
                <div className="overwrite-head">
                  <strong>{server.roles.find((r) => r.id === roleId)?.name}</strong>
                  {rolesWithOverwrite.has(roleId) && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void api.deleteOverwrite(serverId, targetId, roleId).catch((e: Error) => setError(e.message))}
                    >
                      Limpar ajustes
                    </button>
                  )}
                </div>
                {roleId === serverId && (
                  <p className="hint">
                    <Icon name="lock" size={13} /> Para deixar {category ? "a categoria" : "o canal"} privad
                    {category ? "a" : "o"}: negue “Ver canais” aqui e permita no cargo que deve ver.
                  </p>
                )}
                <OverwritePermissions
                  allow={current.allow}
                  deny={current.deny}
                  voice={isVoice}
                  onChange={(allow, deny) =>
                    void (allow === 0 && deny === 0
                      ? api.deleteOverwrite(serverId, targetId, roleId)
                      : api.putOverwrite(serverId, targetId, roleId, allow, deny)
                    ).catch((e: Error) => setError(e.message))
                  }
                />
                {error && <p className="form-error">{error}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
      {confirmDelete && (
        <Modal title="Tem certeza?" onClose={() => setConfirmDelete(false)}>
          <p className="hint">
            {category
              ? "A categoria some; os canais dela continuam, sem categoria."
              : "O canal e todas as mensagens e arquivos dele serão apagados. Não dá para desfazer."}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
            <button type="button" className="btn danger" onClick={() => void remove()}>
              Apagar
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
