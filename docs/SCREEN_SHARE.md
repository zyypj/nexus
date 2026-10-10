# Compartilhamento de tela

## Windows

### Vídeo (captura nativa, desde 0.1.1)

O seletor "Transmitir" funciona como o do Discord: abas **Aplicativos** e **Telas** com
miniaturas atualizadas a cada 4 s, resolução, FPS e áudio no mesmo lugar, e **um clique** começa
a transmissão. Não aparece o seletor do WebView2 nem a barra "tauri.localhost está compartilhando
sua tela", porque a captura não passa por `getDisplayMedia`:

1. `src-tauri/src/screen_capture.rs` lista monitores (`EnumDisplayMonitors`) e janelas visíveis
   de outros processos (`EnumWindows`, sem janelas ocultas/"cloaked", minimizadas ou do próprio
   Nexus), com miniaturas JPEG (`PrintWindow` com `PW_RENDERFULLCONTENT`, que funciona com
   janelas renderizadas pela GPU). ~200 ms para listar 10 fontes.
2. A fonte escolhida é capturada com **Windows.Graphics.Capture** (`Direct3D11CaptureFramePool`
   free-threaded, sem a borda amarela quando o Windows permite, cursor incluído).
3. Fontes maiores que o alvo são reduzidas **na GPU** (cadeia de mipmaps) até ficarem logo acima
   da resolução escolhida; o quadro é lido uma vez e escrito em memória compartilhada do WebView2
   (`ICoreWebView2SharedBuffer`, 3 slots com cabeçalho de estado), sem pixels passando por IPC.
4. Uma mensagem pequena por quadro avisa a página; `call/nativeScreen.ts` cria um `VideoFrame`
   (BGRX) e alimenta um `MediaStreamTrackGenerator`, que o LiveKit publica como `screen_share`.
   O encoder do WebRTC faz a escala final (`scaleResolutionDownBy`).
5. Tela parada não gera quadros novos no WGC; a página repete o último quadro a cada 1 s para
   quem entra depois. Se o encoder atrasar, quadros são descartados (latência baixa) em vez de
   enfileirados. Janela fechada → a transmissão para sozinha.

Medido (`cargo run --release --example capture_probe`, janela animada): alvo 30 FPS → 27,7 FPS;
alvo 60 FPS → 54 FPS (limitado pela própria animação de teste); redução na GPU 1582×940 → 790×470
para o alvo 360p. Ponta a ponta com LiveKit local: H.264 1920×1200 recebido por um assinante com
0% de perda. Uso de CPU da captura nativa ainda **não medido** contra o caminho anterior.

Fallback: se o WebView2 não tiver `MediaStreamTrackGenerator`/shared buffers ou o Windows não
suportar WGC, o diálogo usa `getDisplayMedia` (seletor do sistema) como antes, e o app esconde a
barra "compartilhando sua tela" do WebView2 (`capture_bar.rs`, equivalente a clicar em "Ocultar").

- Codec: **H.264** (o que o WebView2 tem mais chance de codificar em hardware via Media
  Foundation), com VP8 como codec reserva.
- `contentHint`: `motion` com 60 FPS (jogo/vídeo, mantém FPS), `detail` com 30 FPS (texto nítido).
- Áudio: ao transmitir uma **janela**, o padrão é o som **só daquele aplicativo**; ao transmitir
  uma **tela**, o som do computador sem as vozes da chamada.

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

### Verificação automatizada (hardware real)

`apps/desktop/src-tauri/examples/loopback_probe.rs` toca um tom de 660 Hz em processos reais e
mede, só nessa frequência (Goertzel, imune a outros sons do PC), o que a captura recebe:

```bash
cd apps/desktop/src-tauri
cargo run --release --example loopback_probe
```

Resultado nesta máquina (Windows 11 build 26300, 7 out 2026):

| Caso | Nível do tom capturado | Esperado |
|---|---|---|
| nada nosso tocando | −140 dBFS | referência |
| tom num processo **filho**, modo "só este app" | **−12,9 dBFS** | capturado ✅ |
| tom num processo **filho**, modo "áudio do computador" | **−140 dBFS** | excluído ✅ |
| tom num processo **fora da árvore** (criado via WMI), modo "áudio do computador" | **−12,9 dBFS** | capturado ✅ |

Os processos do WebView2 que tocam as vozes da call são descendentes do `nexus-desktop.exe`
(confirmado listando a árvore de processos), portanto caem no caso "filho → excluído".

Esse teste encontrou um bug real: o `PROPVARIANT` com o blob de ativação apontando para a pilha
era destruído com `PropVariantClear`, causando corrupção de heap. Corrigido (o `PROPVARIANT`
nunca é liberado, pois não é dono da memória).

### Assistindo (palco da chamada)

`apps/desktop/src/views/CallPanel.tsx`, no estilo do Discord:

- Cada câmera/avatar e cada transmissão é um bloco. **Grade** automática (os maiores blocos 16:9
  que cabem) ou **um bloco ampliado** com os outros numa faixa de miniaturas: clique para ampliar,
  botão "Ver todos em grade" para voltar. Vale para câmeras também.
- **Mais de uma transmissão:** a primeira da chamada abre sozinha; as outras aparecem como bloco
  "Ao vivo — Assistir" e só são decodificadas **e ouvidas** depois do clique (o áudio da
  transmissão segue o que se assiste; "Parar de assistir" no bloco ou no botão direito). Blocos
  não assistidos não custam vídeo (adaptive stream pausa trilhas sem elemento visível).
- **Tela cheia** de verdade (janela do Tauri em fullscreen; `Esc` sai): botão no bloco, clique
  duplo no bloco ampliado ou botão direito. Em tela cheia a barra do palco ganha microfone, som,
  câmera e desligar, e some junto com o cursor após 3 s parado.
- **Tamanho da área:** arraste a borda de baixo do palco (fica salvo; clique duplo volta ao
  automático) ou use "Ocultar chat" para o palco ocupar tudo. Em canais de voz ele já ocupa tudo.
- A lógica (o que se assiste, bloco ampliado, grade, limite do tamanho) é pura em
  `call/stageLayout.ts`, com testes.

## Android

Ver [ANDROID.md](ANDROID.md): MediaProjection + serviço em primeiro plano; áudio via
`AudioPlaybackCapture` (Android 10+), respeitando apps que proíbem captura.
