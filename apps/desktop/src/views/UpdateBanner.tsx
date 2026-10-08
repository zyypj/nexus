import { useCall } from "../call/callStore";
import { download, installAndRestart, useUpdater } from "../lib/updater";

/** Small notice above the user bar when a new version exists. */
export function UpdateBanner() {
  const { status, version, progress, error } = useUpdater();
  const inCall = useCall((s) => s.status !== "idle");
  if (status === "error") {
    return (
      <div className="update-banner error" title={error ?? ""}>
        Não foi possível atualizar.{" "}
        <button type="button" className="link" onClick={() => void download()}>
          Tentar de novo
        </button>
      </div>
    );
  }
  if (status !== "available" && status !== "downloading" && status !== "ready" && status !== "installing") return null;
  return (
    <div className="update-banner">
      <span>
        <strong>Nexus {version}</strong> disponível
        {status === "downloading" && ` · baixando ${Math.round(progress * 100)}%`}
        {status === "installing" && " · instalando…"}
      </span>
      {status === "available" && (
        <button type="button" className="btn small" onClick={() => void download()}>
          Baixar
        </button>
      )}
      {status === "ready" && (
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            if (inCall && !confirm("Você está em uma chamada. Reiniciar o Nexus para atualizar agora?")) return;
            void installAndRestart();
          }}
        >
          Reiniciar e atualizar
        </button>
      )}
    </div>
  );
}
