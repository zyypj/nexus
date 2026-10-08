# App Android (React Native + Kotlin)

Android 7.0+ (minSdk 24, targetSdk 36). React Native 0.87 (New Architecture, Hermes) +
TypeScript. Kotlin para o que precisa de acesso profundo ao sistema.

## Estrutura

```
apps/android/
  index.js                     registerGlobals() do LiveKit + AppRegistry
  src/
    App.tsx                    sessão + navegação simples (pilha em estado, botão voltar)
    lib/nexus.ts               NexusClient compartilhado, token no Keystore, ciclo de vida do app
    call/callManager.ts        LiveKit (voz, vídeo, tela, áudio do aparelho)
    screens/                   Login, Home (conversas/amigos), Chat, Call, Settings
    native/NexusNative.ts      ponte para o módulo Kotlin
    ui/                        tema (tokens de packages/ui) e componentes (ícones SVG compartilhados)
  android/app/src/main/java/app/nexus/android/
    MainApplication.kt         LiveKitReactNative.setup (antes do React Native)
    NexusNativeModule.kt       prefs, notificações, seletor de arquivos, serviço de chamada,
                               AudioPlaybackCapture
    PlaybackMixer.kt           mistura o áudio capturado no microfone (pós AEC/NS)
    NexusCallService.kt        serviço em primeiro plano (microfone) durante chamadas
```

A lógica de estado é a mesma do Windows (`packages/shared`: store, gateway com
heartbeat/reconexão/backoff, mensagens otimistas, não lidas). O app tem um projeto npm próprio;
os pacotes `@nexus/*` entram por `file:` e o Metro (`metro.config.js`) observa `../../packages`.

## Build

Pré-requisitos: Node 22+, JDK 17, Android SDK (platform 36/37, build-tools 37, NDK 27.1, CMake 3.22).

```bash
cd apps/android
npm install
npm run typecheck && npx jest
cd android
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # assinatura: NEXUS_KEYSTORE, NEXUS_KEYSTORE_PASSWORD, NEXUS_KEY_ALIAS, NEXUS_KEY_PASSWORD
```

Sem as variáveis de keystore, o release é assinado com a chave de debug (instala, mas não
serve para distribuição séria). ABIs geradas: `arm64-v8a` e `armeabi-v7a`.

Nesta máquina o SDK e o JDK ficam em `D:\nexus-build\android` (ver PROJECT_STATUS.md).

## Chamadas

- `@livekit/react-native` + `@livekit/react-native-webrtc` (WebRTC nativo, Opus, VP8/H.264,
  decodificação/codificação por hardware quando o aparelho oferece).
- `AudioType.CommunicationAudioType`: áudio de chamada (modo comunicação, AEC/NS de hardware em
  Android 10+ além do APM do WebRTC).
- Serviço em primeiro plano tipo `microphone` (`NexusCallService`) enquanto há chamada: a ligação
  continua com a tela desligada ou o app em segundo plano.
- Mute, deafen (volume 0 para todos + mute), volume local por pessoa 0–200% (toque longo no
  participante), câmera (frontal/traseira), indicador de quem fala.

## Compartilhamento de tela

- `setScreenShareEnabled(true)` → `MediaProjection`. O serviço em primeiro plano do tipo
  `mediaProjection` é gerenciado pelo `react-native-webrtc` (permissão
  `FOREGROUND_SERVICE_MEDIA_PROJECTION` declarada no manifest).

### Áudio do aparelho (Android 10+)

1. O módulo Kotlin reaproveita a **mesma** `MediaProjection` criada para o vídeo (via reflexão no
   `react-native-webrtc`): no Android 14+ o token de permissão não pode ser usado duas vezes e
   pedir permissão duas vezes seria confuso.
2. `AudioPlaybackCaptureConfiguration` com usos `MEDIA`, `GAME`, `UNKNOWN` e
   `excludeUid(Process.myUid())` — **o próprio Nexus nunca é capturado** (as vozes da chamada
   usam `VOICE_COMMUNICATION`, que o Android também não deixa capturar).
3. `AudioRecord` float 48 kHz mono → `PlaybackMixer`, instalado como
   `capturePostProcessor` do WebRTC: o áudio do aparelho é somado ao microfone **depois** do
   cancelamento de eco e da supressão de ruído (para música/jogo não serem "limpos").
4. Com áudio compartilhado, "mutar" silencia só a voz (no mixer), mantendo o áudio do aparelho.

**Apps que proíbem captura**: o Android respeita `allowAudioPlaybackCapture=false` (e apps com
targetSdk < 29). O Nexus **não tenta contornar**. Um `AudioPlaybackCallback` observa o que está
tocando e, se algum app tocando tiver política de captura restritiva, a tela da chamada mostra:
"Este aplicativo não permite que seu áudio seja compartilhado." (Apps antigos com targetSdk < 29
são bloqueados pelo sistema sem expor a política; nesse caso o aviso pode não aparecer.)

## Limitações conhecidas

- Sem push (FCM): com o app fechado/em Doze não chegam notificações; com o app aberto ou em
  segundo plano recente, notificações locais são exibidas.
- Supressão de ruído "Avançada" (RNNoise) ainda não existe no Android; usa a do aparelho + WebRTC.
- `usesCleartextTraffic=true` para aceitar servidores `http://IP:porta`; prefira HTTPS.
