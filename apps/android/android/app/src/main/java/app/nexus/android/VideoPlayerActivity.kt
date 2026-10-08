package app.nexus.android

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import android.widget.VideoView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Full-screen player for video attachments. Android's own MediaPlayer
 * (VideoView): no extra library, hardware decoding, progressive HTTP with
 * Range (the server answers ranges, so seeking does not download everything).
 * Tap toggles the controls; they hide by themselves while playing.
 */
class VideoPlayerActivity : Activity() {
    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TYPE = "type"
        private const val HIDE_AFTER_MS = 3000L
    }

    private lateinit var video: VideoView
    private lateinit var spinner: ProgressBar
    private lateinit var topBar: View
    private lateinit var bottomBar: View
    private lateinit var bigPlay: ImageButton
    private lateinit var playButton: ImageButton
    private lateinit var seek: SeekBar
    private lateinit var position: TextView
    private lateinit var duration: TextView
    private lateinit var error: TextView

    private val handler = Handler(Looper.getMainLooper())
    private var prepared = false
    private var dragging = false
    private var resumeAt = 0
    private var playWhenReady = true
    private var controlsShown = true

    private val tick = object : Runnable {
        override fun run() {
            if (prepared && !dragging) {
                seek.progress = video.currentPosition
                position.text = fmt(video.currentPosition)
            }
            handler.postDelayed(this, 250)
        }
    }
    private val autoHide = Runnable { if (video.isPlaying) showControls(false) }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun fmt(ms: Int): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s / 60) % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    private fun iconButton(icon: Int, label: String, size: Int, background: Int = R.drawable.nx_round_button): ImageButton =
        ImageButton(this).apply {
            setImageResource(icon)
            setBackgroundResource(background)
            contentDescription = label
            scaleType = android.widget.ImageView.ScaleType.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
        }

    private fun label(sizeSp: Float, bold: Boolean = false) = TextView(this).apply {
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL) ?: return finish()
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val type = intent.getStringExtra(EXTRA_TYPE) ?: "video/*"
        resumeAt = savedInstanceState?.getInt("position") ?: 0

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        video = VideoView(this)
        root.addView(video, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        spinner = ProgressBar(this).apply { isIndeterminate = true }
        root.addView(spinner, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER))

        error = label(15f).apply {
            visibility = View.GONE
            maxLines = 3
            gravity = Gravity.CENTER
            text = "Não foi possível reproduzir este vídeo aqui.\nToque em ↗ para abrir em outro app."
        }
        root.addView(error, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
            leftMargin = dp(24); rightMargin = dp(24)
        })

        bigPlay = iconButton(R.drawable.nx_play, "Tocar", 72, R.drawable.nx_play_big).apply {
            visibility = View.GONE
            setOnClickListener { togglePlay() }
        }
        root.addView(bigPlay, FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER))

        // Top: close, title, open in another app.
        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.parseColor("#99000000"))
            addView(iconButton(R.drawable.nx_close, "Fechar", 44).apply { setOnClickListener { finish() } })
            addView(label(16f, bold = true).apply { text = title; setPadding(dp(12), 0, dp(12), 0) },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(iconButton(R.drawable.nx_external, "Abrir em outro app", 44).apply {
                setOnClickListener {
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), type))
                    }
                }
            })
        }
        root.addView(topBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        // Bottom: play/pause, time, seek bar, duration.
        playButton = iconButton(R.drawable.nx_pause, "Pausar", 44).apply { setOnClickListener { togglePlay() } }
        position = label(13f).apply { text = fmt(0); setPadding(dp(10), 0, dp(6), 0) }
        duration = label(13f).apply { text = fmt(0); setPadding(dp(6), 0, dp(4), 0) }
        seek = SeekBar(this).apply {
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {
                    if (fromUser) position.text = fmt(value)
                }
                override fun onStartTrackingTouch(bar: SeekBar) {
                    dragging = true
                    handler.removeCallbacks(autoHide)
                }
                override fun onStopTrackingTouch(bar: SeekBar) {
                    dragging = false
                    video.seekTo(bar.progress)
                    scheduleHide()
                }
            })
        }
        bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(18))
            setBackgroundColor(Color.parseColor("#99000000"))
            addView(playButton)
            addView(position)
            addView(seek, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(duration)
        }
        root.addView(bottomBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

        root.setOnClickListener { showControls(!controlsShown) }
        setContentView(root)

        video.setOnPreparedListener { mp ->
            prepared = true
            spinner.visibility = View.GONE
            seek.max = mp.duration
            duration.text = fmt(mp.duration)
            mp.setOnInfoListener { _, what, _ ->
                when (what) {
                    MediaPlayer.MEDIA_INFO_BUFFERING_START -> spinner.visibility = View.VISIBLE
                    MediaPlayer.MEDIA_INFO_BUFFERING_END, MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START -> spinner.visibility = View.GONE
                }
                false
            }
            mp.setOnBufferingUpdateListener { _, percent -> seek.secondaryProgress = mp.duration * percent / 100 }
            if (resumeAt > 0) video.seekTo(resumeAt)
            if (playWhenReady) video.start()
            updatePlayIcons()
            scheduleHide()
        }
        video.setOnCompletionListener {
            updatePlayIcons()
            showControls(true)
        }
        video.setOnErrorListener { _, _, _ ->
            spinner.visibility = View.GONE
            error.visibility = View.VISIBLE
            bigPlay.visibility = View.GONE
            showControls(true)
            true
        }
        video.setVideoURI(Uri.parse(url))
        handler.post(tick)
    }

    private fun togglePlay() {
        if (!prepared) return
        if (video.isPlaying) video.pause() else video.start()
        updatePlayIcons()
        if (video.isPlaying) scheduleHide() else showControls(true)
    }

    private fun updatePlayIcons() {
        val playing = video.isPlaying
        playButton.setImageResource(if (playing) R.drawable.nx_pause else R.drawable.nx_play)
        playButton.contentDescription = if (playing) "Pausar" else "Tocar"
        bigPlay.visibility = if (!playing && prepared && controlsShown && error.visibility != View.VISIBLE) View.VISIBLE else View.GONE
    }

    private fun showControls(show: Boolean) {
        controlsShown = show
        val v = if (show) View.VISIBLE else View.GONE
        topBar.visibility = v
        bottomBar.visibility = v
        updatePlayIcons()
        if (show) scheduleHide()
    }

    private fun scheduleHide() {
        handler.removeCallbacks(autoHide)
        handler.postDelayed(autoHide, HIDE_AFTER_MS)
    }

    override fun onPause() {
        super.onPause()
        if (prepared) {
            resumeAt = video.currentPosition
            playWhenReady = video.isPlaying
            video.pause()
            updatePlayIcons()
        }
    }

    override fun onResume() {
        super.onResume()
        if (prepared && playWhenReady) {
            video.start()
            updatePlayIcons()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt("position", if (prepared) video.currentPosition else resumeAt)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        video.stopPlayback()
        super.onDestroy()
    }
}
