import { CHANNEL_PERMISSIONS, Permissions } from "@nexus/protocol";
import { PERMISSION_INFO } from "../lib/ui";
import { Icon } from "./Icon";

/** Role permissions: a switch per permission, grouped. */
export function RolePermissions({
  value,
  editable,
  onChange,
}: {
  value: number;
  /** Bits the current user may grant (others are shown disabled). */
  editable: number;
  onChange: (v: number) => void;
}) {
  const groups = [...new Set(PERMISSION_INFO.map((p) => p.group))];
  return (
    <div className="perm-list">
      {groups.map((g) => (
        <section key={g}>
          <h4>{g}</h4>
          {PERMISSION_INFO.filter((p) => p.group === g).map((p) => {
            const bit = Permissions[p.key];
            const on = (value & bit) !== 0;
            const allowed = (editable & bit) !== 0;
            return (
              <label key={p.key} className={`perm-row${allowed ? "" : " disabled"}`}>
                <span>
                  <strong>{p.label}</strong>
                  {p.help && <small>{p.help}</small>}
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!allowed}
                  onChange={(e) => onChange(e.target.checked ? value | bit : value & ~bit)}
                />
                <span className="switch" aria-hidden />
              </label>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** Channel/category overwrite: deny / inherit / allow per permission. */
export function OverwritePermissions({
  allow,
  deny,
  voice,
  onChange,
}: {
  allow: number;
  deny: number;
  /** Show voice permissions first (voice channels) or text ones. */
  voice?: boolean;
  onChange: (allow: number, deny: number) => void;
}) {
  const items = PERMISSION_INFO.filter((p) => (Permissions[p.key] & CHANNEL_PERMISSIONS) !== 0).sort((a, b) =>
    voice ? (a.group === "Voz" ? -1 : 1) - (b.group === "Voz" ? -1 : 1) : 0,
  );
  return (
    <div className="perm-list">
      {items.map((p) => {
        const bit = Permissions[p.key];
        const state = allow & bit ? "allow" : deny & bit ? "deny" : "inherit";
        const set = (next: "allow" | "deny" | "inherit") =>
          onChange(next === "allow" ? allow | bit : allow & ~bit, next === "deny" ? deny | bit : deny & ~bit);
        return (
          <div key={p.key} className="perm-row">
            <span>
              <strong>{p.label}</strong>
              {p.help && <small>{p.help}</small>}
            </span>
            <div className="tri" role="radiogroup" aria-label={p.label}>
              <button
                type="button"
                className={`tri-deny${state === "deny" ? " on" : ""}`}
                title="Negar"
                onClick={() => set("deny")}
              >
                <Icon name="x" size={14} />
              </button>
              <button
                type="button"
                className={`tri-inherit${state === "inherit" ? " on" : ""}`}
                title="Herdar do cargo/categoria"
                onClick={() => set("inherit")}
              >
                /
              </button>
              <button
                type="button"
                className={`tri-allow${state === "allow" ? " on" : ""}`}
                title="Permitir"
                onClick={() => set("allow")}
              >
                <Icon name="check" size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
