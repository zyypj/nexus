# Nexus

Aplicativo privado de comunicação para um grupo pequeno de amigos: mensagens, DMs, grupos,
chamadas de voz e vídeo, compartilhamento de tela com áudio do computador. **Self-hosted**,
leve e feito para **Windows** e **Android**. O nome é configurável (`NEXUS_APP_NAME` no servidor,
`productName` no app).

> Inspirado em funcionalidades de apps de chat de voz, mas com identidade visual, assets e
> código próprios.

## Arquitetura em uma frase

Um servidor Rust (API + WebSocket + SQLite + uploads) e um LiveKit self-hosted (só mídia, SFU).
Cada chamada é uma room LiveKit independente; o servidor decide quem entra e emite tokens.
Detalhes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
apps/desktop        Windows — Tauri 2 + Rust + React + TypeScript + Vite
apps/android        Android — React Native + TypeScript + Kotlin
services/server     Nexus Server — Rust, Axum, Tokio, SQLx (SQLite WAL)
packages/protocol   tipos do protocolo
packages/shared     cliente REST, gateway (heartbeat/reconexão), estado compartilhado
packages/ui         tokens visuais
infrastructure/     Docker, Pterodactyl (eggs), LiveKit
scripts/            dev, seed, benchmark (nexus-bench)
tests/noise-bench   benchmark objetivo de supressão de ruído
docs/               documentação
```

## Início rápido (desenvolvimento, Windows)

```bash
npm install
# 1) LiveKit local (binário oficial: https://github.com/livekit/livekit/releases)
$env:LIVEKIT_BIN = "C:\caminho\livekit-server.exe"; powershell -File scripts/dev-livekit.ps1
# 2) servidor
powershell -File scripts/dev-server.ps1
# 3) usuários de teste (joao, pedro, lucas, carlos, marcos / senha-teste-123)
python scripts/dev-seed.py
# 4) app
npm run desktop:dev
```

Convite manual: `cargo run -p nexus-server -- admin invite create`.

## Produção

- Servidor e LiveKit no **Pterodactyl**: [docs/PTERODACTYL.md](docs/PTERODACTYL.md)
  (3 portas no total, eggs prontos em `infrastructure/pterodactyl/`).
- Docker puro: `docker build -f services/server/Dockerfile -t nexus-server .` e
  `docker run -v nexus-data:/data -p 3000:3000 -e LIVEKIT_URL=... nexus-server`.
- Variáveis do servidor: `NEXUS_HOST`, `NEXUS_PORT`, `NEXUS_PUBLIC_URL`, `NEXUS_DATA_DIR`,
  `JWT_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `ALLOW_PUBLIC_REGISTRATION` (padrão `false`), `MAX_UPLOAD_SIZE`, `LOG_LEVEL`
  (+ opcionais em `services/server/src/config.rs`).

## Testes e qualidade

```bash
cargo fmt --all --check && cargo clippy -p nexus-server --all-targets -- -D warnings
cargo test -p nexus-server          # 66 testes (auth, convites, mensagens, uploads, gateway, calls)
npm run typecheck && npm test       # TypeScript + vitest
cargo run --release -p nexus-noise-bench
```

CI: `.github/workflows/ci.yml` (servidor, TypeScript, app Windows, APK Android) e
`docker.yml` (imagens no GHCR, opcional).

## Documentação

[Arquitetura](docs/ARCHITECTURE.md) · [Windows](docs/WINDOWS.md) · [Android](docs/ANDROID.md) ·
[Áudio](docs/AUDIO.md) · [Compartilhamento de tela](docs/SCREEN_SHARE.md) ·
[LiveKit](docs/LIVEKIT.md) · [Pterodactyl](docs/PTERODACTYL.md) ·
[Benchmarks](docs/BENCHMARKS.md) · [Segurança](docs/SECURITY.md) ·
[Status do projeto](PROJECT_STATUS.md)
