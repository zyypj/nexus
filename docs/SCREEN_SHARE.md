# Compartilhamento de tela

## Windows

### Vídeo

O app chama `getDisplayMedia` dentro do WebView2. No Windows o Chromium captura janelas e
monitores com **Windows Graphics Capture** (DXGI Desktop Duplication como fallback), e o quadro
capturado segue pela GPU até o encoder do WebRTC sem passar por JavaScript. Fazer a captura WGC
em Rust e copiar quadros para o WebView custaria mais CPU e memória (cópias de buffers a 60 FPS),
então a API nativa é usada *através* do Chromium.

- Seletor: monitor inteiro ou janela/aplicativo (`displaySurface`). A permissão é concedida pelo
  handler nativo do Tauri (`PermissionKind::DisplayCapture`), sem prompt extra do WebView2.
- Codec: **H.264** (o que o WebView2 tem mais chance de codificar em hardware via Media
  Foundation), com VP8 como codec reserva.
- `contentHint`: `detail` (texto nítido, mantém resolução) ou `motion` (jogo/vídeo, mantém FPS),
  escolhido no diálogo.

### Qualidade

| Opção | Resolução | FPS | Bitrate máx. |
|---|---|---|---|
| 720p 30 FPS | 1280×720 | 30 | 2,5 Mbps |
| 1080p 30 FPS | 1920×1080 | 30 | 4 Mbps |
| 1080p 60 FPS | 1920×1080 | 60 | 6 Mbps |
| **Automática** (padrão) | começa em 1080p30 (720p30 com < 4 núcleos lógicos) | | |

Um governador (`apps/desktop/src/call/screenQuality.ts`, com testes) lê as estatísticas do
encoder a cada 5 s **só enquanto compartilha**:

- `qualityLimitationReason` = `cpu` ou `bandwidth` em 3 amostras seguidas (~15 s) → desce um
  degrau (1080p60 → 1080p30 → 720p30), inclusive nas opções manuais. **Nunca mantém 1080p60 se a
  máquina ou a internet não sustentam**, e a interface avisa ("Qualidade reduzida para 720p 30
  FPS (limite de CPU)").
- O modo automático sobe um degrau após ~60 s sem limitação e com o encoder atingindo o FPS; só
  chega a 1080p60 para conteúdo em movimento em máquinas com 8+ núcleos lógicos.
- O WebRTC adapta bitrate continuamente e o LiveKit usa adaptive stream + dynacast nos receptores.

### Áudio do computador

Requisito: os outros ouvem jogo/YouTube/Spotify/navegador, **mas não** as vozes da própria call.
Capturar a saída inteira do Windows criaria eco (as vozes recebidas voltariam para a call).

Implementação (`apps/desktop/src-tauri/src/system_audio.rs`):

1. `ActivateAudioInterfaceAsync` no dispositivo virtual `VAD\Process_Loopback` com
   `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`.
2. **"Áudio do computador"**: `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` com o PID do
   Nexus. O áudio da call é tocado pelo WebView2, cujos processos são **filhos** do Nexus.exe —
   a árvore inteira (e portanto as vozes) fica de fora.
3. **"Somente <aplicativo>"**: `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` com o PID
   escolhido (lista das sessões de áudio do Windows via `IAudioSessionManager2`).
4. `IAudioClient` compartilhado + loopback + evento, float 48 kHz estéreo (`AUTOCONVERTPCM`),
   buffer de 20 ms.
5. Blocos de 20 ms vão como bytes crus (sem JSON) por um `Channel` do Tauri; um AudioWorklet
   (`pcmPlayer.worklet.js`: buffer circular de 1 s, alvo de 60 ms, descarta atraso acumulado
   acima de 200 ms) transforma em `MediaStreamTrack`.
6. O LiveKit publica como `screen_share_audio` (música estéreo, sem DTX), separada do microfone;
   cada ouvinte controla o volume dela à parte.

```
Jogo ───────┐
Chrome ─────┼──► WASAPI process loopback (exclui a árvore do Nexus) ──► Tauri Channel ──► AudioWorklet ──► LiveKit "screen_share_audio"
Spotify ────┘
Nexus (WebView2 = vozes da call) ── X (excluído na origem)
```

Não exige VB-Cable, VoiceMeeter nem driver.

**Requisito de sistema**: process loopback existe a partir do **Windows 10 build 20348**
(qualquer Windows 11). No Windows 10 22H2 (build 19045) a opção aparece desabilitada com a
explicação — capturar a saída inteira causaria o eco que o requisito proíbe.

O estado da verificação ponta a ponta (com áudio real tocando) está em
[PROJECT_STATUS.md](../PROJECT_STATUS.md).

## Android

Ver [ANDROID.md](ANDROID.md): MediaProjection + serviço em primeiro plano; áudio via
`AudioPlaybackCapture` (Android 10+), respeitando apps que proíbem captura.
