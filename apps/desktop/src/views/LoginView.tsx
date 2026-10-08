import { ApiError } from "@nexus/shared";
import { type FormEvent, useState } from "react";
import { createClient, useSession } from "../lib/nexus";
import { useSettings } from "../lib/settings";

function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === "invalid_credentials") return "Usuário ou senha incorretos.";
    if (e.code === "rate_limited") return "Muitas tentativas. Aguarde um pouco.";
    return e.message;
  }
  return "Não foi possível conectar ao servidor. Verifique o endereço.";
};

export function LoginView() {
  const savedUrl = useSettings((s) => s.serverUrl);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [server, setServer] = useState(savedUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const url = normalizeUrl(server);
    if (!url) {
      setError("Informe o endereço do servidor.");
      return;
    }
    setBusy(true);
    try {
      const c = createClient(url);
      await c.api.info();
      if (mode === "login") await c.login(username, password);
      else await c.register(username, password, invite, displayName || undefined);
      useSettings.getState().set({ serverUrl: url });
      useSession.getState().setPhase("app");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/logo.svg" alt="" width={48} height={48} />
          <h1>Nexus</h1>
        </div>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Entrar
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            Criar conta
          </button>
        </div>
        <label>
          Servidor
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://nexus.exemplo.com"
            autoComplete="url"
            required
          />
        </label>
        <label>
          Usuário
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={2}
            maxLength={32}
          />
        </label>
        {mode === "register" && (
          <label>
            Nome de exibição
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
          />
        </label>
        {mode === "register" && (
          <label>
            Código de convite
            <input
              value={invite}
              onChange={(e) => setInvite(e.target.value.toUpperCase())}
              placeholder="NEXUS-XXXX-XXXX"
              required
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
        </button>
      </form>
    </div>
  );
}
