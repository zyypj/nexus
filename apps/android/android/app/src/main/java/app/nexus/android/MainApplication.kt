package app.nexus.android

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.livekit.reactnative.LiveKitReactNative
import com.livekit.reactnative.audio.AudioType

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(NexusNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Must run before React Native: sets up WebRTC's audio device module
    // (voice-communication audio, hardware AEC/NS when available).
    LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())
    loadReactNative(this)
  }
}
