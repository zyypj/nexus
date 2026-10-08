package app.nexus.android

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.File

/**
 * Voice messages: AAC in an MPEG-4 container (.m4a), 64 kbps mono — plays on
 * Windows (WebView2) and Android without conversion. Files live in the app
 * cache until uploaded.
 */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    fun start() {
        cancel()
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd-HH-mm-ss", java.util.Locale.US).format(java.util.Date())
        val out = File(dir, "mensagem-de-voz-$stamp.m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioChannels(1)
        r.setAudioSamplingRate(44_100)
        r.setAudioEncodingBitRate(64_000)
        r.setOutputFile(out.absolutePath)
        r.prepare()
        r.start()
        recorder = r
        file = out
        startedAt = System.currentTimeMillis()
    }

    /** Stops and returns (file, duration ms), or null when nothing usable was recorded. */
    fun stop(): Pair<File, Long>? {
        val r = recorder ?: return null
        val f = file
        val duration = System.currentTimeMillis() - startedAt
        recorder = null
        file = null
        val ok = try {
            r.stop()
            true
        } catch (_: RuntimeException) {
            false // stop() right after start() throws: no audio was captured
        }
        r.release()
        if (!ok || f == null || !f.exists() || f.length() == 0L) {
            f?.delete()
            return null
        }
        return f to duration
    }

    fun cancel() {
        recorder?.let {
            try {
                it.stop()
            } catch (_: RuntimeException) {
            }
            it.release()
        }
        recorder = null
        file?.delete()
        file = null
    }
}

/**
 * One audio at a time for the chat (voice messages and audio files), streamed
 * from the signed URL. Reports progress every 250 ms while playing.
 */
class ChatAudioPlayer(private val emit: (id: String, state: String, position: Int, duration: Int) -> Unit) {
    private var player: MediaPlayer? = null
    private var currentId: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            val p = player ?: return
            val id = currentId ?: return
            if (p.isPlaying) {
                emit(id, "playing", p.currentPosition, p.duration)
                handler.postDelayed(this, 250)
            }
        }
    }

    fun play(id: String, url: String) = handler.post {
        val p = player
        if (p != null && id == currentId) {
            p.start()
            handler.post(tick)
            return@post
        }
        stopInternal()
        currentId = id
        emit(id, "loading", 0, 0)
        val mp = MediaPlayer()
        player = mp
        mp.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        mp.setOnPreparedListener {
            it.start()
            handler.post(tick)
        }
        mp.setOnCompletionListener { emit(id, "ended", 0, it.duration) }
        mp.setOnErrorListener { _, _, _ ->
            emit(id, "error", 0, 0)
            true
        }
        try {
            mp.setDataSource(url)
            mp.prepareAsync()
        } catch (e: Exception) {
            emit(id, "error", 0, 0)
        }
    }

    fun pause() = handler.post {
        val p = player ?: return@post
        val id = currentId ?: return@post
        if (p.isPlaying) p.pause()
        emit(id, "paused", p.currentPosition, p.duration)
    }

    fun seek(positionMs: Int) = handler.post {
        val p = player ?: return@post
        val id = currentId ?: return@post
        p.seekTo(positionMs)
        emit(id, if (p.isPlaying) "playing" else "paused", positionMs, p.duration)
    }

    fun stop() = handler.post { stopInternal() }

    private fun stopInternal() {
        handler.removeCallbacks(tick)
        val id = currentId
        player?.release()
        player = null
        currentId = null
        if (id != null) emit(id, "stopped", 0, 0)
    }
}
