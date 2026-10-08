package app.nexus.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioPlaybackConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.livekit.reactnative.LiveKitReactNative
import com.oney.WebRTCModule.WebRTCModule

class NexusNativeModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ActivityEventListener {

    override fun getName() = "NexusNative"

    private val prefs by lazy { ctx.getSharedPreferences("nexus", Context.MODE_PRIVATE) }
    private var pickPromise: Promise? = null
    private val mixer = PlaybackMixer()
    private var record: AudioRecord? = null
    private var captureThread: Thread? = null
    @Volatile private var capturing = false
    private var playbackCallback: AudioManager.AudioPlaybackCallback? = null
    private val installer by lazy { ApkInstaller(ctx) }
    private val sounds by lazy { SoundPlayer(ctx) }
    private val voice by lazy { VoiceRecorder(ctx) }
    private val audio by lazy {
        ChatAudioPlayer { id, state, position, duration ->
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(
                    "NexusAudio",
                    Arguments.createMap().apply {
                        putString("id", id)
                        putString("state", state)
                        putInt("position", position)
                        putInt("duration", duration)
                    },
                )
        }
    }

    init {
        ctx.addActivityEventListener(this)
    }

    // ---- preferences (server URL, etc.; secrets go to the Keystore instead) ----

    @ReactMethod
    fun getPref(key: String, promise: Promise) = promise.resolve(prefs.getString(key, null))

    @ReactMethod
    fun setPref(key: String, value: String?, promise: Promise) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
        promise.resolve(null)
    }

    // ---- self update (GitHub Releases) ----

    @ReactMethod
    fun getAppVersion(promise: Promise) {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        promise.resolve(info.versionName)
    }

    /** Resolves "permission" when the user must first allow installing unknown apps. */
    @ReactMethod
    fun installUpdate(url: String, version: String, promise: Promise) {
        if (!installer.canInstall()) {
            installer.openInstallPermissionSettings()
            promise.resolve("permission")
            return
        }
        installer.downloadAndInstall(url, version) { error ->
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("NexusUpdateError", Arguments.createMap().apply { putString("message", error) })
        }
        promise.resolve("downloading")
    }

    // ---- call foreground service ----

    @ReactMethod
    fun startCallService(title: String, promise: Promise) {
        try {
            val intent = Intent(ctx, NexusCallService::class.java).putExtra(NexusCallService.EXTRA_TITLE, title)
            ContextCompat.startForegroundService(ctx, intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("call_service", e)
        }
    }

    @ReactMethod
    fun stopCallService(promise: Promise) {
        ctx.stopService(Intent(ctx, NexusCallService::class.java))
        promise.resolve(null)
    }

    // ---- notifications ----

    @ReactMethod
    fun notify(title: String, body: String, promise: Promise) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            promise.resolve(null)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(MESSAGES) == null) {
                nm.createNotificationChannel(NotificationChannel(MESSAGES, "Mensagens", NotificationManager.IMPORTANCE_HIGH))
            }
        }
        val open = android.app.PendingIntent.getActivity(
            ctx, 0, ctx.packageManager.getLaunchIntentForPackage(ctx.packageName),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, MESSAGES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        @SuppressLint("MissingPermission")
        NotificationManagerCompat.from(ctx).notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
        promise.resolve(null)
    }

    // ---- file picker (Storage Access Framework, no storage permission needed) ----

    @ReactMethod
    fun pickFiles(promise: Promise) {
        val activity = ctx.currentActivity ?: return promise.reject("no_activity", "no activity")
        pickPromise?.reject("cancelled", "replaced")
        pickPromise = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        activity.startActivityForResult(intent, PICK_REQUEST)
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_REQUEST) return
        val promise = pickPromise ?: return
        pickPromise = null
        val result = Arguments.createArray()
        if (resultCode == Activity.RESULT_OK && data != null) {
            val uris = mutableListOf<Uri>()
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
            for (uri in uris) {
                var name = "arquivo"
                var size = 0L
                ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(OpenableColumns.SIZE)
                        if (ni >= 0) name = c.getString(ni) ?: name
                        if (si >= 0) size = c.getLong(si)
                    }
                }
                result.pushMap(Arguments.createMap().apply {
                    putString("uri", uri.toString())
                    putString("name", name)
                    putDouble("size", size.toDouble())
                    putString("type", ctx.contentResolver.getType(uri) ?: "application/octet-stream")
                })
            }
        }
        promise.resolve(result)
    }

    override fun onNewIntent(intent: Intent) {}

    // ---- device audio while screen sharing (AudioPlaybackCapture, Android 10+) ----

    @ReactMethod
    fun playbackCaptureSupported(promise: Promise) = promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)

    @ReactMethod
    fun setMicMuted(muted: Boolean, promise: Promise) {
        mixer.micMuted = muted
        promise.resolve(null)
    }

    /**
     * Reuses the MediaProjection that react-native-webrtc created for the
     * screen-share video (Android 14+ does not allow reusing the permission
     * token for a second projection, and asking twice would be confusing).
     */
    private fun findScreenProjection(): MediaProjection? {
        val webrtc = ctx.getNativeModule(WebRTCModule::class.java) ?: return null
        val gum = WebRTCModule::class.java.getDeclaredField("getUserMediaImpl")
            .apply { isAccessible = true }.get(webrtc) ?: return null
        val tracks = gum.javaClass.getDeclaredField("tracks").apply { isAccessible = true }.get(gum) as? Map<*, *>
            ?: return null
        for (tp in tracks.values) {
            tp ?: continue
            val controller = tp.javaClass.getDeclaredField("videoCaptureController")
                .apply { isAccessible = true }.get(tp) ?: continue
            if (controller.javaClass.simpleName != "ScreenCaptureController") continue
            val capturer = controller.javaClass.getMethod("getVideoCapturer").invoke(controller) ?: continue
            val projection = runCatching { capturer.javaClass.getMethod("getMediaProjection").invoke(capturer) }
                .getOrNull()
                ?: runCatching {
                    capturer.javaClass.getDeclaredField("mediaProjection").apply { isAccessible = true }.get(capturer)
                }.getOrNull()
            if (projection is MediaProjection) return projection
        }
        return null
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun startPlaybackCapture(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return promise.reject("unsupported", "Requer Android 10 ou superior.")
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return promise.reject("permission", "Permissão de microfone necessária.")
        }
        val projection = try {
            findScreenProjection()
        } catch (e: Exception) {
            null
        } ?: return promise.reject("no_projection", "Inicie o compartilhamento de tela primeiro.")

        stopCaptureInternal()
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            // Never capture Nexus itself (call voices) — they would echo back.
            .excludeUid(Process.myUid())
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(48_000)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val rec = try {
            AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(48_000 * 4 / 5) // 200 ms
                .setAudioPlaybackCaptureConfig(config)
                .build()
        } catch (e: Exception) {
            return promise.reject("audio_record", e)
        }
        record = rec
        mixer.clear()
        capturing = true
        rec.startRecording()
        captureThread = Thread({
            val buf = FloatArray(480)
            while (capturing) {
                val n = rec.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                if (n > 0) mixer.push(buf, n)
            }
        }, "nexus-playback-capture").also { it.start() }
        LiveKitReactNative.audioProcessingController.capturePostProcessor = mixer
        watchCapturePolicies()
        promise.resolve(null)
    }

    @ReactMethod
    fun stopPlaybackCapture(promise: Promise) {
        stopCaptureInternal()
        promise.resolve(null)
    }

    private fun stopCaptureInternal() {
        capturing = false
        captureThread?.join(500)
        captureThread = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
        runCatching { LiveKitReactNative.audioProcessingController.capturePostProcessor = null }
        mixer.micMuted = false
        mixer.clear()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            playbackCallback?.let { ctx.getSystemService(AudioManager::class.java).unregisterAudioPlaybackCallback(it) }
        }
        playbackCallback = null
    }

    /**
     * Apps can forbid capture of their audio. Android enforces that; we only
     * tell the user, from the AudioAttributes of what is currently playing.
     */
    private fun watchCapturePolicies() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val am = ctx.getSystemService(AudioManager::class.java)
        val cb = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) = evaluate(configs)
        }
        playbackCallback = cb
        am.registerAudioPlaybackCallback(cb, Handler(Looper.getMainLooper()))
        evaluate(am.activePlaybackConfigurations)
    }

    private fun evaluate(configs: List<AudioPlaybackConfiguration>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val shareable = setOf(AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_GAME, AudioAttributes.USAGE_UNKNOWN)
        val blocked = configs.any { c ->
            val attrs = c.audioAttributes
            attrs.usage in shareable && attrs.allowedCapturePolicy != AudioAttributes.ALLOW_CAPTURE_BY_ALL
        }
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("NexusCaptureBlocked", Arguments.createMap().apply { putBoolean("blocked", blocked) })
    }

    // ---- UI sounds ----

    @ReactMethod
    fun playSound(name: String, volume: Double) = sounds.play(name, volume.toFloat())

    @ReactMethod
    fun startSoundLoop(name: String, volume: Double) = sounds.startLoop(name, volume.toFloat())

    @ReactMethod
    fun stopSoundLoop(name: String) = sounds.stopLoop(name)

    // ---- voice messages / chat audio ----

    @ReactMethod
    fun voiceStart(promise: Promise) {
        try {
            voice.start()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("voice_start", e.message ?: "Falha ao iniciar a gravação", e)
        }
    }

    @ReactMethod
    fun voiceStop(promise: Promise) {
        val result = voice.stop()
        if (result == null) {
            promise.resolve(null)
            return
        }
        val (file, duration) = result
        promise.resolve(
            Arguments.createMap().apply {
                putString("uri", "file://${file.absolutePath}")
                putString("name", file.name)
                putString("type", "audio/mp4")
                putDouble("size", file.length().toDouble())
                putDouble("durationMs", duration.toDouble())
            },
        )
    }

    @ReactMethod
    fun voiceCancel() = voice.cancel()

    @ReactMethod
    fun audioPlay(id: String, url: String) {
        audio.play(id, url)
    }

    @ReactMethod
    fun audioPause() {
        audio.pause()
    }

    @ReactMethod
    fun audioSeek(positionMs: Double) {
        audio.seek(positionMs.toInt())
    }

    @ReactMethod
    fun audioStop() {
        audio.stop()
    }

    // ---- media viewer / clipboard ----

    /** Full-screen video player (VideoPlayerActivity). Stops chat audio first. */
    @ReactMethod
    fun playVideo(url: String, title: String, type: String) {
        audio.stop()
        val intent = Intent(ctx, VideoPlayerActivity::class.java)
            .putExtra(VideoPlayerActivity.EXTRA_URL, url)
            .putExtra(VideoPlayerActivity.EXTRA_TITLE, title)
            .putExtra(VideoPlayerActivity.EXTRA_TYPE, type)
        val activity = ctx.currentActivity
        if (activity != null) activity.startActivity(intent)
        else ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** React Native has no clipboard API in core anymore. */
    @ReactMethod
    fun copyText(text: String) {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("Nexus", text))
    }

    // Required by NativeEventEmitter on Android.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    override fun invalidate() {
        stopCaptureInternal()
        sounds.release()
        voice.cancel()
        audio.stop()
        super.invalidate()
    }

    companion object {
        private const val PICK_REQUEST = 7311
        private const val MESSAGES = "nexus-messages"
    }
}
