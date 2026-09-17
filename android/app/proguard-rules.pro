# WebView JS bridge (GameWebViewActivity's AndroidLocalBridge) — R8 renaming
# or stripping these breaks app.js's calls silently at runtime, not compile
# time, since the bridge is invoked by name from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# NodeRuntime.startNodeWithArguments is `external` — resolved by the native
# lib via JNI naming convention. A renamed/stripped signature here breaks
# node startup with no Kotlin-visible error.
-keepclasseswithmembernames class * {
    native <methods>;
}
