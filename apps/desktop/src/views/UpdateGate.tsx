import { retryStartupUpdate, useUpdater } from "../lib/updater";

/**
 * Launch screen while the mandatory update check runs. When a new version
 * exists it is downloaded and installed here; the app never opens on an old
 * version (except offline, when the check itself is impossible).
 */
export function UpdateGate() {
  const { status, version, progress, error } = useUpdater();
  const pct = Math.round(progress * 100);
  let title = "Procurando atualizações…";
  let detail: string | null = null;
  if (status === "available" || status === "downloading" || status === "ready") {
    title = `Atualizando para o Nexus ${version}`;
    detail = status === "downloading" ? `Baixando… ${pct}%` : "Preparando…";
  } else if (status === "installing") {
    title = `Instalando o Nexus ${version}`;
    detail = "O Nexus vai reabrir sozinho.";
  } else if (status === "error") {
    title = `Não foi possível atualizar para o Nexus ${version ?? ""}`.trim();
    detail = "Esta atualização é obrigatória. Verifique a conexão e tente de novo.";
  }
  return (
    <div className="update-gate" role="status" aria-live="polite">
      <img src="/logo.png" alt="" className="update-gate-logo" />
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
      {status === "downloading" && (
        <div className="upload-progress-bar update-gate-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {(status === "checking" || status === "idle" || status === "installing") && <div className="update-gate-spinner" />}
      {status === "error" && (
        <>
          {error && <small className="update-gate-error">{error}</small>}
          <button type="button" className="btn primary" onClick={() => void retryStartupUpdate()}>
            Tentar de novo
          </button>
        </>
      )}
    </div>
  );
}
