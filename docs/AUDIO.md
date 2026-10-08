# Áudio

## Pipeline de voz

```
microfone ─► getUserMedia (WebRTC APM: AEC + AGC [+ NS no modo Padrão])
          ─► [modo Avançado: RNNoise em AudioWorklet (WASM SIMD)]
          ─► Opus (LiveKit AudioPresets.speech, DTX + RED) ─► SFU ─► ouvintes
ouvintes  ─► WebAudio mix (ganho por participante 0–200%) ─► saída escolhida
```

- **Codec**: Opus, preset `speech`, **DTX** (não transmite silêncio) e **RED** (redundância
  contra perda de pacotes).
- **Echo cancellation / AGC**: WebRTC Audio Processing Module do Chromium (WebView2).
- **VAD / indicador de fala**: `ActiveSpeakersChanged` do LiveKit (detecção no servidor SFU).
- **Mute**: a trilha é mutada (para de enviar; o microfone continua aberto para desmutar sem
  atraso). **Deafen**: volume local de todos = 0 **e** mute automático; ao sair do deafen o mute
  volta ao estado anterior.
- **Push-to-talk**: hooks globais do Windows (funciona minimizado/em jogo), atraso de soltura
  configurável (padrão 200 ms) para não cortar a última sílaba.
- **Volume individual**: local, 0–200%, por usuário (WebAudio `GainNode` via `webAudioMix`), e
  "silenciar para mim". Não altera o que os outros ouvem.
- Um único `AudioContext` de 48 kHz para tudo (mix, RNNoise, áudio do sistema); suspenso fora
  de chamadas.

## Supressão de ruído: dois níveis

| Modo | Implementação | Quando usar |
|---|---|---|
| **Padrão** | supressor do WebRTC APM do próprio Chromium (`noiseSuppression: true`) | sempre ligado por padrão, custo praticamente zero |
| **Avançado** | **RNNoise** (rede recorrente pequena, frames de 10 ms) em `AudioWorklet`, WASM com SIMD (`@sapphi-red/web-noise-suppressor`) | ventilador, ar-condicionado, ambiente barulhento |

No modo Avançado o NS do navegador é desligado (para não processar duas vezes); AEC e AGC
continuam.

**Por que RNNoise e não um modelo maior?** O objetivo é qualidade boa com CPU baixa. Medimos
0,49% de um núcleo para RNNoise. Modelos como DeepFilterNet custam dezenas de vezes mais. O
pacote usado também traz GTCRN (rede pequena mais recente); fica como candidato para uma
medição futura no pipeline do WebView (ver "Próximos passos").

## Benchmark (medido)

Ferramenta: `tests/noise-bench` (Rust). Usa **nnnoiseless**, port do RNNoise com os mesmos
pesos do WASM usado no app. Para cada ruído e SNR mistura voz + ruído, processa e mede:

- **SI-SDR** antes/depois (qualidade global contra a voz limpa);
- **redução de ruído nas pausas** (energia do ruído quando ninguém fala);
- **variação do nível da voz** enquanto se fala (0 dB = intacta; negativo = voz atenuada);
- CPU por frame de 10 ms, latência (correlação cruzada) e memória por instância
  (alocador instrumentado).

```bash
cargo run --release -p nexus-noise-bench            # tabela + WAVs em tests/noise-bench/out
NEXUS_BENCH_GATE=1 cargo run --release -p nexus-noise-bench   # variante com gate por VAD
```

Sinais: voz **sintética** (pulsos glotais filtrados por formantes, sílabas e pausas) e ruídos
modelados (ventilador: ruído rosa + tom das pás + zumbido do motor; teclado: cliques com ataque
e ressonância, em rajadas; mouse: cliques duplos e rolagem; ar-condicionado: ronco grave +
zumbido do compressor + chiado; ambiente: fundo rosa, zumbido de rede, batidas). Coloque
gravações reais em `tests/noise-bench/samples/` (`speech.wav`, `fan.wav`, `keyboard.wav`,
`mouse.wav`, `air_conditioner.wav`, `ambient.wav`) e elas substituem os sinais sintéticos.

### Resultados (Windows 11, Rust 1.99, release, 30 s por caso, 7 out 2026)

| ruído | SNR entrada | SI-SDR antes | SI-SDR depois | Δ | redução nas pausas | voz |
|---|---|---|---|---|---|---|
| ventilador | 0 dB | -1,9 | 3,9 | **+5,8 dB** | **19,6 dB** | -2,7 dB |
| ventilador | 5 dB | 3,1 | 7,4 | +4,4 dB | 16,8 dB | -1,1 dB |
| ventilador | 10 dB | 8,1 | 9,8 | +1,7 dB | 12,8 dB | -0,5 dB |
| teclado | 0 dB | -2,0 | 2,2 | +4,2 dB | 4,7 dB | +0,9 dB |
| teclado | 5 dB | 3,0 | 6,7 | +3,6 dB | 5,6 dB | +0,2 dB |
| teclado | 10 dB | 8,0 | 9,8 | +1,7 dB | 6,2 dB | 0,0 dB |
| mouse | 0 dB | -2,0 | 0,4 | +2,4 dB | 4,2 dB | +1,8 dB |
| mouse | 5 dB | 3,0 | 5,7 | +2,7 dB | 5,1 dB | +0,4 dB |
| mouse | 10 dB | 8,0 | 9,3 | +1,3 dB | 5,5 dB | 0,0 dB |
| ar-condicionado | 0 dB | -1,9 | 7,1 | **+9,1 dB** | **20,7 dB** | -0,9 dB |
| ar-condicionado | 5 dB | 3,1 | 9,4 | +6,3 dB | 16,7 dB | -0,4 dB |
| ar-condicionado | 10 dB | 8,1 | 10,8 | +2,8 dB | 12,6 dB | -0,3 dB |
| ambiente | 0 dB | -2,0 | 3,0 | +5,0 dB | 21,3 dB | -2,9 dB |
| ambiente | 5 dB | 3,0 | 7,5 | +4,4 dB | 16,5 dB | -1,1 dB |
| ambiente | 10 dB | 8,0 | 9,8 | +1,7 dB | 12,3 dB | -0,5 dB |

| Custo | Valor medido |
|---|---|
| CPU | **49 µs por frame de 10 ms** (pior caso 60 µs) = **0,49% de um núcleo** |
| Latência adicionada | **10,0 ms** (algoritmo) + até 10 ms de buffer no AudioWorklet |
| Memória | **30,9 KiB** por instância |

### Leitura honesta

- Ruído **estacionário** (ventilador, ar-condicionado, ambiente): 12–21 dB a menos nas pausas,
  com perda de voz ≤ 3 dB no pior caso (0 dB de SNR). É onde o modo Avançado faz diferença.
- Ruído **impulsivo** (teclado, mouse): só 4–6 dB. É a limitação conhecida do RNNoise, que
  prioriza não cortar a voz. **Não** está no nível de supressores comerciais nesse ponto.
- Experimento: gate guiado pelo VAD do próprio RNNoise (fecha −20 dB entre falas, hold 200 ms):
  teclado 7,6–7,7 dB e mouse 6,3–7,6 dB nas pausas (ganho de ~1,5–2 dB). Ganho pequeno para o
  custo de manter um worklet próprio — **não adotado**; dados reproduzíveis com
  `NEXUS_BENCH_GATE=1`.
- O teto de SI-SDR (~10 dB) com SNR alto vem da voz sintética, que o modelo distorce um pouco
  mais que voz real. Repita com `samples/speech.wav` real para números mais representativos.
- O modo **Padrão** (NS do WebRTC no Chromium) só pode ser medido com captura real de microfone;
  ainda não está nesta tabela.

## Áudio do computador (screen share)

Ver [SCREEN_SHARE.md](SCREEN_SHARE.md#áudio-do-computador): WASAPI process loopback excluindo
a árvore de processos do Nexus, sem cabo virtual.

## Próximos passos

- Medir o modo Padrão e o GTCRN no pipeline real do WebView2 (microfone falso do Chromium com
  `--use-file-for-fake-audio-capture`).
- Reavaliar o gate por VAD com gravações reais.

## Sons da interface

Gerados por `scripts/gen-sounds.mjs` (síntese simples, sem assets de terceiros; o script é
determinístico e grava os mesmos `.wav` em `apps/desktop/public/sounds/` e
`apps/android/android/app/src/main/res/raw/`, ~550 KB no total).

| Som | Quando |
|---|---|
| `message` | mensagem de outra pessoa fora da conversa aberta |
| `ring` (loop) | chamada recebida, até atender/recusar |
| `calling` (loop) | você iniciou a chamada e ninguém entrou ainda (máx. 45 s) |
| `join` / `leave` | você ou outra pessoa entra/sai da chamada |
| `mute` / `unmute`, `deafen` / `undeafen` | botões e atalhos (o push-to-talk não toca som) |
| `screen_start` / `screen_stop` | início/fim da sua transmissão |

Windows: `HTMLAudioElement` na saída escolhida nas configurações. Android: `SoundPool`
(`SoundPlayer.kt`, uso "sonification"). Ambos têm liga/desliga e volume nas configurações.
