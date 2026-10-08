package app.nexus.android

import com.livekit.reactnative.audio.processing.AudioProcessorInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Mixes captured device audio (AudioPlaybackCapture) into the microphone
 * track, after WebRTC's echo cancellation / noise suppression so music and
 * game sound are not "cleaned" away.
 *
 * WebRTC hands us 10 ms of float samples in int16 scale (±32768). The ring
 * buffer is filled by the capture thread at 48 kHz mono float (±1.0).
 */
class PlaybackMixer : AudioProcessorInterface {
    @Volatile var micMuted: Boolean = false
    @Volatile var playbackGain: Float = 0.8f

    private val capacity = 48_000 * 2
    private val ring = FloatArray(capacity)
    private var readPos = 0
    private var writePos = 0
    private var size = 0
    private val lock = Any()
    private var sampleRate = 48_000

    /** Called by the capture thread. */
    fun push(samples: FloatArray, count: Int) {
        synchronized(lock) {
            for (i in 0 until count) {
                ring[writePos] = samples[i]
                writePos = (writePos + 1) % capacity
            }
            size += count
            // Clock drift / stalls: never accumulate more than 200 ms, fall back to 60 ms.
            val max = 48_000 / 5
            if (size > max) {
                val drop = size - 48_000 * 60 / 1000
                readPos = (readPos + drop) % capacity
                size -= drop
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            readPos = 0
            writePos = 0
            size = 0
        }
    }

    override fun isEnabled(): Boolean = true

    override fun getName(): String = "nexus-playback-mix"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        sampleRate = sampleRateHz
    }

    override fun resetAudioProcessing(newRate: Int) {
        sampleRate = newRate
    }

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        val floats = buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
        val n = minOf(numFrames, floats.limit())
        val micGain = if (micMuted) 0f else 1f
        // Our ring is 48 kHz; step through it if WebRTC runs at another rate.
        val step = 48_000f / sampleRate
        synchronized(lock) {
            var consumed = 0f
            for (i in 0 until n) {
                var playback = 0f
                val idx = consumed.toInt()
                if (idx < size) {
                    playback = ring[(readPos + idx) % capacity] * 32768f * playbackGain
                }
                consumed += step
                val mixed = floats.get(i) * micGain + playback
                floats.put(i, mixed.coerceIn(-32767f, 32767f))
            }
            val used = minOf(consumed.toInt(), size)
            readPos = (readPos + used) % capacity
            size -= used
        }
    }
}
