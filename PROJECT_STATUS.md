# PROJECT_STATUS

Última atualização: 2026-10-08 (sessão 1, versão 0.1.1).

## Fase atual

Todas as fases têm código. Windows (1–9) testado na prática; **Android (10–12) implementado e
compilando (APK debug e release gerados), mas ainda não executado num aparelho/emulador**.
Pterodactyl (13): eggs/Dockerfiles prontos, não testados num painel real. Benchmarks (14):
Windows medido.

Artefatos desta sessão: `D:\nexus-build\dist\Nexus_0.1.0_x64-setup.exe` (2 MB) e
`D:\nexus-build\dist\Nexus-0.1.0-android.apk` (52 MB, arm64 + armv7, assinado com a chave de
debug).

| Fase | Estado |
|---|---|
| 1 Monorepo, backend, SQLite, auth, convites | ✅ pronto, 66 testes de integração |
| 2 App Windows: login, perfil, amigos | ✅ pronto, testado na UI real |
| 3 DM, grupos, WebSocket | ✅ pronto, testado na UI real |
| 4 LiveKit, call 1:1 | ✅ testado com LiveKit real (Windows ↔ participante via `lk`) |
| 5 Call em grupo, calls simultâneas | ✅ testes de servidor (2/5/10, isolamento); 10 participantes medidos com LiveKit real |
| 6 Câmera | ✅ implementado; vídeo **recebido** validado; câmera local não testada (sem webcam nos testes) |
| 7 Screen share Windows | ⚠️ implementado (getDisplayMedia/WGC + governador de qualidade com testes); **não testado ponta a ponta com o seletor** |
| 8 Áudio do PC sem o áudio da call | ✅ captura nativa verificada em hardware (`loopback_probe` 3/3); ⚠️ publicação via LiveKit dentro do app ainda não exercitada ponta a ponta |
| 9 Supressão de ruído | ✅ Padrão (WebRTC) + Avançado (RNNoise) implementados; RNNoise medido (tabela em docs/AUDIO.md) |
| 10 Android app | ✅ compila (RN 0.87 + Kotlin): login, conversas, amigos, chat (anexos, reações, respostas, edição), notificações locais, token no Keystore; typecheck + jest ok; ⚠️ não executado em aparelho |
| 11 Call Android | ✅ compila: LiveKit RN, mute/deafen, volume 0–200%, câmera, serviço em primeiro plano; ⚠️ não executado |
| 12 Screen share Android | ✅ compila: MediaProjection + AudioPlaybackCapture (reusa a projeção do vídeo; `getMediaProjection()` confirmado no AAR do WebRTC), aviso de app que bloqueia captura; ⚠️ não executado |
| 13 Pterodactyl | ⚠️ eggs + Dockerfiles + entrypoints escritos; geração do livekit.yaml testada; imagens Docker **não construídas** (Docker Desktop parado / pouco espaço no C:) |
| 14 Benchmarks/otimizações | ✅ Windows medido; otimizações aplicadas com antes/depois |

## Releases e atualizações automáticas (sessão 1, parte 2)

- Repositório público: https://github.com/zyypj/nexus. Releases geradas por
  `.github/workflows/release.yml` ao enviar uma tag `vX.Y.Z` (`node scripts/release.mjs X.Y.Z`).
- Eggs do Pterodactyl agora usam `ghcr.io/parkervcp/yolks:debian` + `nexus-start.sh` /
  `livekit-start.sh`: baixam e atualizam sozinhos a partir das releases (SHA-256 conferido).
  Testados localmente (instalação, já atualizado, checksum adulterado, GitHub fora do ar,
  download real do LiveKit).
- Windows: `tauri-plugin-updater` + `latest.json` assinado (minisign). Android: checa a API de
  releases e instala o APK pelo instalador do sistema.
- Secrets já configurados no GitHub: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` e
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`. **Originais (com backup obrigatório!) em `D:\nexus-build\keys`** —
  perder a chave do updater ou a keystore impede atualizar os apps já instalados.
- Detalhes: docs/UPDATES.md.
- **v0.1.0 publicada e marcada como latest** (workflow Release verde). Conferido: todos os
  assets presentes; `releases/latest/download/latest.json` e `VERSION` resolvem; assinatura
  minisign do instalador válida para a chave pública do `tauri.conf.json`; APK assinado com a
  keystore de release (SHA-256 do certificado `f903b344…2123`, versionCode 100);
  `nexus-start.sh` baixou e conferiu o binário real da release (ELF estático x86_64).
- Correções que só entram na próxima release: `nexus-start.sh` checava `-x` antes de iniciar
  (inofensivo no Linux, só falhava em teste no Windows) e o Dockerfile do servidor não incluía
  o membro `tests/noise-bench` do workspace (workflow opcional "Docker images" falhava;
  correção ainda não validada num build real).

## 0.1.1 (sessão 1, parte 3) — correções do primeiro uso real

Problemas encontrados no primeiro uso com o servidor do usuário (painel.tadeu.space) e corrigidos:

- **Ninguém se ouvia nas calls (Windows)**: as trilhas de áudio remotas nunca eram anexadas
  (`track.attach()`); com `webAudioMix` o áudio só toca depois disso. Corrigido em
  `callManager.ts`; verificado com LiveKit local + bot `lk` publicando voz (elemento anexado,
  trilha viva, pico 0,58, AudioContext rodando). O Android não tinha o problema (WebRTC nativo).
- **LiveKit sem porta de sinalização** (`portHttp: 0`): o livekit-server lê `LIVEKIT_<CAMPO>` do
  ambiente por cima do `livekit.yaml`, e a variável vazia `LIVEKIT_PORT` do egg zerava a porta.
  `livekit-start.sh` agora remove todas as `LIVEKIT_*` (menos `LIVEKIT_KEYS`) e se autoatualiza a
  partir das releases (SHA-256). Reproduzido e testado localmente.
- **API key errada no painel** (segredo colado no campo da key): corrigida para `nexus`.
- **Restart do servidor travava** em "shutting down" (WebSockets abertos + leitura bloqueante do
  stdin do console): desligamento limitado a 10 s + `shutdown_timeout`.
- **Áudio do computador falhava** (worklet virava `data:` URL, bloqueado pelo CSP): Vite não
  embute mais `.js` pequenos.
- **Transmissão de tela estilo Discord**: seletor próprio com miniaturas (Aplicativos/Telas),
  resolução, FPS e áudio; captura nativa WGC → memória compartilhada do WebView2 →
  `MediaStreamTrackGenerator`; sem segundo seletor e sem a barra "tauri.localhost está
  compartilhando". Testado ponta a ponta numa cópia do app (identificador separado) com LiveKit
  local: tela e janela, H.264 1920×1200 recebido por um assinante `lk` sem perda, parar/retomar.
  Detalhes e números em docs/SCREEN_SHARE.md.
- **Sons** (mensagem, chamada recebida/chamando, entrar/sair, mute, ensurdecer, transmissão) no
  Windows e no Android, com liga/desliga e volume; banner de chamada recebida no Android.

Produção (painel.tadeu.space, 2026-10-08): **Nexus Server atualizou sozinho 0.1.0 → 0.1.1** no
restart (log do `nexus-start.sh`), `/health` ok; Schedule diário às 05:00 (restart = pega novas
versões). Depois o usuário fez Reinstall do LiveKit e do Nexus Server: ambos sobem com os launchers novos
(LiveKit `portHttp: 7880`, Nexus 0.1.1), banco `data/nexus.db` preservado. A partir daqui os dois
launchers e o servidor se atualizam sozinhos pelas releases.

Não verificado ainda: CPU da captura nativa vs. o caminho antigo; sons e banner no Android em
aparelho real; borda amarela do WGC (o app pede captura sem borda, depende do Windows).

## 0.1.5 — logo nova

- Logo enviada pelo usuário: símbolo "N" recortado com fundo transparente (alpha pela distância
  ao fundo + des-pré-multiplicação, sem halo). Ícones do Windows (exe, bandeja, instalador; .ico
  16–256 px via `tauri icon`), ícones do Android (quadrado e redondo sobre o azul-escuro da logo,
  mdpi–xxxhdpi) e a logo no login / telas de atualização dos dois apps. A cor de destaque da
  interface continua a anterior (não alterada).

## 0.1.3 / 0.1.4 — atualização obrigatória, vídeo/áudio no chat, mensagens de voz

- 0.1.3: atualização **obrigatória ao abrir** (Windows: tela "Atualizando para o Nexus X",
  instala e reabre; Android: tela "Atualização obrigatória"); offline abre normalmente. No
  Windows o app na bandeja checa a cada 1 h e instala escondido ou ao reabrir (nunca em call).
  O número 0.1.2.1 pedido não é possível (Cargo/Tauri/updater exigem X.Y.Z) → 0.1.3.
- Servidor: vídeo (mp4/webm/mov/mkv) e áudio (mp3/ogg/wav/flac/m4a) servidos **inline** com
  Range (teste `videos_play_inline_with_range_requests`); demais tipos continuam download.
- Windows: player de vídeo no chat (fallback para download se o codec não tocar, ex. HEVC),
  player compacto de áudio, **mensagens de voz** (botão de microfone quando o campo está vazio,
  WebM/Opus 48 kbps, mesmo microfone/AEC/NS das calls, máx. 10 min). Testado: vídeo e voz
  gerados no navegador embutido (tocam, seek via 206, duração corrigida); fluxo completo de
  gravação na cópia de teste com microfone simulado do WebView2.
- Android: mensagens de voz (MediaRecorder AAC/M4A) e player nativo (MediaPlayer) no chat;
  vídeo abre no player do celular. Compila; **não testado em aparelho**.

## 0.1.2 — anexos sem limite e arrastar arquivos

- `MAX_UPLOAD_SIZE=0` (novo padrão) = sem limite por arquivo; o upload já era em streaming para
  disco. Proteção: recusa (507) se o disco ficaria com menos de `UPLOAD_MIN_FREE_DISK` (1 GB).
  Testes novos: `upload_without_limit`, `upload_refused_when_disk_would_fill`.
- Barra de progresso no envio (XHR com `upload.onprogress`, Windows e Android).
- Windows: arrastar arquivos para qualquer ponto da conversa (overlay "Solte para enviar");
  o handler de drop do Tauri foi desligado e drops fora da área não abrem o arquivo no WebView.
  Testado na cópia de teste com `Input.dispatchDragEvent`: arquivo de 300 MB arrastado, progresso
  7%→97%, enviado. Arquivo vazio/pasta agora é recusado no app (antes falhava a mensagem toda).
- Produção: `MAX_UPLOAD_SIZE=0` no painel; servidor reiniciou limpo (correção do shutdown
  confirmada) e se atualizou 0.1.1 → 0.1.2; `/api/info` mostra `max_upload_size: 0`.

## Funcionalidades prontas (verificadas)

Servidor (`services/server`): cadastro só com convite (`ALLOW_PUBLIC_REGISTRATION=false`),
Argon2id, access JWT 15 min + refresh rotativo com detecção de reuso, logout/revogação imediata,
sessões, perfil/avatar, amizades, bloqueio, DMs, grupos (até 25), mensagens (editar, apagar,
responder, reações, não lidas, paginação), uploads (limite, validação por magic bytes, nome
aleatório, URLs assinadas), presença, digitando, gateway WebSocket (heartbeat, READY re-sync),
calls (room LiveKit por call, token restrito, webhook, expulsão via RoomService, carência de 30 s
após queda), rate limit, CLI admin + comandos admin pelo console (stdin, útil no Pterodactyl), TLS opcional.

Windows (`apps/desktop`): login/cadastro, amigos/pedidos/bloqueados/convites (admin), DMs e
grupos, chat virtualizado com markdown leve/links/anexos/imagens/reações/respostas/edição,
digitando, notificações, bandeja, calls (voz/vídeo/grid/destaque de tela, indicador de fala,
mute/deafen verificados no servidor e no LiveKit, volume 0–200% por pessoa, saída/entrada
selecionáveis), push-to-talk e atalhos globais (hooks de baixo nível), screen share com
qualidade automática, áudio do PC por process loopback, RNNoise, token no Credential Manager.

## Problemas conhecidos / não verificado

- **Android nunca rodou num aparelho/emulador**. Primeiro passo da próxima sessão: instalar o
  APK num celular e testar login → chat → call → tela + áudio.
- Hotkeys globais e screen share no Windows não foram testados interativamente (o usuário estava
  usando o PC; evitei controlar a tela).

- Screen share de vídeo ainda não exercitado com o seletor do WebView2 (precisa interação manual).
- Áudio do PC: módulo nativo verificado; o caminho completo (Channel → AudioWorklet → LiveKit)
  ainda não foi ouvido do outro lado.
- Hotkeys globais: compilam e o app registra as teclas; **não** testado pressionando teclas
  com o app minimizado.
- Modo Padrão de supressão de ruído não medido (só RNNoise).
- Benchmark de screen share 1080p30 não medido.
- Docker images não construídas localmente; eggs não importados num painel real.
- Sem notificações push no Android em segundo plano (sem FCM; planejado: serviço em primeiro
  plano apenas durante calls).
- O instalador NSIS rodado de dentro do Claude foi virtualizado (MSIX); para uso real, execute
  `Nexus_0.1.0_x64-setup.exe` manualmente.

## Ambiente desta máquina (importante)

- **Disco C: quase cheio** (~5 GB livres). Tudo pesado fica em `D:\nexus-build`:
  - `CARGO_TARGET_DIR=D:/nexus-build/target` (workspace) e `D:/nexus-build/target-desktop` (Tauri)
  - `npm_config_cache=D:/nexus-build/npm-cache`
  - Android: `D:\nexus-build\android\jdk17` (JAVA_HOME), `D:\nexus-build\android\sdk`
    (ANDROID_HOME; platform 36/37.0, build-tools 37, NDK 27.1.12297006, CMake 3.22.1).
    Use `GRADLE_USER_HOME=D:/nexus-build/gradle`.
  - As pastas de build do Android (`apps/android/android/app/build`, `app/.cxx` e
    `node_modules/*/android/build`) são **junções** para `D:\nexus-build\android-out` (só nesta
    máquina; o build intermediário passa de 2 GB). Redirecionar via `buildDirectory` não
    funciona: o codegen do React Native quebra com caminhos em outro drive. Se apagar
    `node_modules`, recrie as junções com `mklink /J`.
  - LiveKit local: `D:\nexus-build\tools\livekit\livekit-server.exe`, CLI `D:\nexus-build\tools\lk\lk.exe`.
- Rust 1.99 (rustup), Node 24, VS 18 Build Tools + Windows SDK 26100 instalados nesta sessão.
- Dados de dev: `D:/nexus-build/devdata` (usuários do seed: joao, pedro, lucas, carlos, marcos /
  `senha-teste-123`).

## Comandos

```bash
# servidor
export CARGO_TARGET_DIR=D:/nexus-build/target
cargo fmt --all --check
cargo clippy -p nexus-server --all-targets -- -D warnings
cargo test -p nexus-server
cargo run -p nexus-server -- admin invite create

# dev local
$env:LIVEKIT_BIN="D:\nexus-build\tools\livekit\livekit-server.exe"; powershell -File scripts/dev-livekit.ps1
powershell -File scripts/dev-server.ps1
python scripts/dev-seed.py

# TypeScript
npm run typecheck ; npm test

# android (JAVA_HOME/ANDROID_HOME/GRADLE_USER_HOME no D:)
cd apps/android && npm run typecheck && npx jest
cd apps/android/android && ./gradlew assembleRelease --no-daemon

# desktop
cd apps/desktop && CARGO_TARGET_DIR=D:/nexus-build/target-desktop npx tauri build
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
cargo run --release --example loopback_probe        # verifica captura de áudio do sistema

# benchmarks
cargo build --release -p nexus-bench
nexus-bench startup --exe <nexus-desktop.exe> --runs 5
nexus-bench measure --process nexus-desktop.exe --duration 60 --label idle
bash scripts/bench-calls.sh <room>
cargo run --release -p nexus-noise-bench
```

## Arquivos principais

```
Cargo.toml / package.json        workspaces (Rust: server, perf-bench, noise-bench; npm: packages, desktop)
services/server/                 Rust API + gateway (+ migrations, tests/, Dockerfile)
packages/{protocol,shared,ui}/   TS compartilhado (shared tem testes vitest)
apps/desktop/                    Tauri + React (src-tauri: hotkeys, system_audio, secrets; examples/loopback_probe)
apps/android/                    React Native 0.87 (scaffold; npm próprio, deps @nexus/* via file:)
infrastructure/docker/           entrypoint do servidor
infrastructure/livekit/          Dockerfile + entrypoint (gera livekit.yaml) + livekit.dev.yaml
infrastructure/pterodactyl/      egg-nexus-server.json, egg-nexus-livekit.json
scripts/                         dev-*.ps1, dev-seed.py, bench-calls.sh, perf-bench/
tests/noise-bench/               benchmark de supressão de ruído
docs/                            ARCHITECTURE, WINDOWS, ANDROID, AUDIO, SCREEN_SHARE, LIVEKIT, PTERODACTYL, BENCHMARKS, SECURITY
.github/workflows/               ci.yml, release.yml, docker.yml
```

## Próximas tarefas

1. Rodar o APK num celular real: login, chat, call (voz/vídeo), tela + áudio do aparelho, aviso
   de app bloqueado; corrigir o que aparecer.
2. APKs por ABI (`splits.abi`) para reduzir de 52 MB para ~27 MB cada.
3. Testar screen share de vídeo + áudio do PC ponta a ponta no Windows.
4. Testar hotkeys/PTT com o app minimizado.
5. Construir imagens Docker e validar os eggs num Pterodactyl real.
6. Medir screen share 1080p30, modo Padrão de NS, comparação controlada com o Discord.
