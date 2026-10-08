# App Windows (Tauri 2)

Windows 10/11, x64. Interface em React + TypeScript (Vite) dentro do **WebView2** do sistema;
partes nativas em Rust. Sem Electron: o instalador NSIS tem **~2 MB** porque o Chromium já vem
com o Windows (WebView2 Evergreen; o instalador baixa o bootstrapper se faltar).

## Estrutura

```
apps/desktop/
  src/                  React
    lib/                cliente Nexus, plataforma (Tauri), configurações
    call/               LiveKit (carregado sob demanda), RNNoise, áudio do sistema, qualidade de tela
    views/              telas
  src-tauri/
    src/lib.rs          janela, bandeja, permissões de mídia, flags do WebView2
    src/hotkeys.rs      hooks globais teclado/mouse (push-to-talk)
    src/system_audio.rs WASAPI process loopback (áudio do PC sem as vozes da call)
    src/secrets.rs      Windows Credential Manager
    tauri.conf.json     CSP, bundle NSIS
```

## Rodando

Pré-requisitos: Node 20+, Rust stable (MSVC), Visual Studio Build Tools com "Desktop development
with C++" e Windows SDK.

```bash
npm install
npm run desktop:dev        # Vite + Tauri em modo dev
npm run desktop:build      # gera src-tauri/target/release/bundle/nsis/Nexus_x.y.z_x64-setup.exe
```

Na primeira tela informe o endereço do servidor (ex. `https://chat.exemplo.com`), usuário e
senha, ou crie a conta com um código de convite.

## Funcionalidades nativas

### Push-to-talk e atalhos globais

`hotkeys.rs` instala `WH_KEYBOARD_LL` e `WH_MOUSE_LL` numa thread própria:

- funciona com o Nexus minimizado, na bandeja ou com um jogo em foco;
- detecta **soltar** a tecla (necessário para PTT) — `RegisterHotKey` não faz isso;
- **não consome** a tecla (a tecla do PTT continua funcionando no jogo);
- aceita botões laterais do mouse (Mouse 4/5) e do meio;
- modificadores exigidos precisam estar pressionados; modificadores extras são aceitos
  (Shift+PTT enquanto corre no jogo).

Ações configuráveis em Configurações → Atalhos: Push-to-talk, Mutar, Ensurdecer, Ligar câmera,
Desligar câmera.

Limitação do Windows: janelas executando como administrador não entregam input para hooks de
processos comuns (UIPI). Se um jogo roda como admin, rode o Nexus como admin também.

### Credenciais

O refresh token fica no **Windows Credential Manager** (`Nexus/refresh:<servidor>`), protegido
por DPAPI. Nada sensível em `localStorage`.

### Bandeja e notificações

Fechar a janela mantém o app na bandeja (configurável). Notificações nativas para mensagens de
conversas que você não está vendo; o título da janela mostra o total de não lidas.

### Permissões de mídia

`on_permission_request` concede microfone, câmera e captura de tela ao conteúdo empacotado do
app, sem o prompt do WebView2.

## Otimizações (medidas, ver [BENCHMARKS.md](BENCHMARKS.md))

| Medida | Efeito medido |
|---|---|
| `livekit-client` carregado só ao entrar numa call | bundle inicial 864 KB → 336 KB |
| `--in-process-gpu` no WebView2 | −20 MB privados, −80 ms de startup |
| `IntensiveWakeUpThrottling` desligado | heartbeat continua com a janela oculta na bandeja |
| lista de mensagens virtualizada | DOM só com as mensagens visíveis |
| `AudioContext` único, suspenso fora de calls | thread de áudio dorme no idle |
| timers só quando necessários (heartbeat encadeado, stats de tela só durante o share) | sem polling |

## Desinstalar

Configurações do Windows → Aplicativos → Nexus. Os dados do WebView ficam em
`%LOCALAPPDATA%\app.nexus.desktop`; o token em Credential Manager (`Nexus/...`).
