package com.parteytimeline.nearby.node

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.AssetManager
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom

/**
 * Starts the bundled Node.js server (server.js + src/ + public/ + node_modules,
 * synced verbatim from the repo root into assets/nodejs-project by the
 * :app:syncNodeProject Gradle task) inside an embedded nodejs-mobile runtime.
 *
 * JNI bridge is native-lib.cpp / libnode.so, following the pattern from the
 * official nodejs-mobile-samples "native-gradle-node-folder" sample.
 */
class NodeRuntime(private val context: Context) {

    companion object {
        init {
            System.loadLibrary("native-lib")
            System.loadLibrary("node")
        }

        @Volatile
        private var started = false
    }

    private external fun startNodeWithArguments(arguments: Array<String>): Int

    /**
     * Starts the server once per process (idempotent). Runs on a background
     * thread since node::Start blocks until the runtime shuts down.
     */
    fun startIfNeeded(port: Int) {
        if (started) return
        synchronized(NodeRuntime::class.java) {
            if (started) return
            started = true
        }
        Thread({
            val nodeDir = File(context.filesDir, "nodejs-project")
            refreshCodeIfNeeded(nodeDir)
            writeEntryPoint(nodeDir, port)
            startNodeWithArguments(arrayOf("node", File(nodeDir, "android-entry.js").absolutePath))
        }, "node-runtime").start()
    }

    // Node can't run straight out of the APK's asset archive, so the project
    // is copied into internal storage. Re-copying on every launch would be
    // wasteful, so it only happens on first run / after an APK update — BUT
    // `data/` (accounts, playlists, the offline audio cache, the session
    // secret file) must survive that recopy, since it isn't part of the
    // app's code and isn't reproducible. So: preserve `data/` across the
    // wipe-and-recopy instead of excluding it from deletion (deleting first
    // would still lose it if the process dies mid-copy) — the safe order is
    // move-out, wipe+recopy code, move-back.
    private fun refreshCodeIfNeeded(nodeDir: File) {
        if (nodeDir.exists() && !wasApkUpdated()) return
        val preserved = File(context.filesDir, "nodejs-project-data-preserved")
        val dataDir = File(nodeDir, "data")
        // If `preserved` already exists, a previous update was interrupted
        // after moving data out but before restoring it — that's the ONLY
        // remaining copy of the user's data (nodeDir may already be wiped),
        // so it must never be deleted or clobbered by a fresh snapshot
        // before being safely restored. Only take a new snapshot when there
        // isn't already one waiting to be restored.
        if (!preserved.exists() && dataDir.exists()) {
            dataDir.copyRecursively(preserved, overwrite = true)
        }
        nodeDir.deleteRecursively()
        copyAssetFolder(context.assets, "nodejs-project", nodeDir.absolutePath)
        if (preserved.exists()) {
            dataDir.deleteRecursively()
            preserved.copyRecursively(dataDir, overwrite = true)
            preserved.deleteRecursively()
        }
        saveApkUpdateTime()
    }

    // server.js reads config from process.env, but node::Start() runs the
    // runtime in this same process rather than spawning a subprocess, so
    // there's no portable way from Kotlin/JVM to set OS environment
    // variables for it ahead of time. Instead: a tiny generated (not synced
    // from the repo) entry script sets process.env itself before requiring
    // the real server — same effect, no server.js changes needed.
    private fun writeEntryPoint(nodeDir: File, port: Int) {
        val secret = sessionSecret()
        File(nodeDir, "android-entry.js").writeText(
            "process.env.PORT = '$port';\n" +
                "process.env.SESSION_SECRET = ${jsString(secret)};\n" +
                "process.env.COOKIE_SECURE = '0';\n" +
                "require('./server.js');\n"
        )
    }

    private fun jsString(s: String) = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    private fun sessionSecret(): String {
        val prefs = context.getSharedPreferences("node_runtime", Context.MODE_PRIVATE)
        prefs.getString("session_secret", null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("session_secret", secret).apply()
        return secret
    }

    private fun wasApkUpdated(): Boolean {
        val prefs = context.getSharedPreferences("node_runtime", Context.MODE_PRIVATE)
        val previous = prefs.getLong("apk_last_update_time", 0)
        val current = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            1L
        }
        return current != previous
    }

    private fun saveApkUpdateTime() {
        val current = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            1L
        }
        context.getSharedPreferences("node_runtime", Context.MODE_PRIVATE)
            .edit().putLong("apk_last_update_time", current).apply()
    }

    private fun copyAssetFolder(assets: AssetManager, fromAssetPath: String, toPath: String) {
        val files = assets.list(fromAssetPath) ?: emptyArray()
        if (files.isEmpty()) {
            copyAssetFile(assets, fromAssetPath, toPath)
        } else {
            File(toPath).mkdirs()
            for (file in files) {
                copyAssetFolder(assets, "$fromAssetPath/$file", "$toPath/$file")
            }
        }
    }

    private fun copyAssetFile(assets: AssetManager, fromAssetPath: String, toPath: String) {
        assets.open(fromAssetPath).use { input ->
            FileOutputStream(toPath).use { output ->
                input.copyTo(output)
            }
        }
    }
}
