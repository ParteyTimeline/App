package com.parteytimeline.nearby.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.parteytimeline.nearby.nearby.NearbyHost
import com.parteytimeline.nearby.node.NodeRuntime
import java.net.HttpURLConnection
import java.net.URL

const val HOST_PORT = 3000
private const val NOTIFICATION_CHANNEL_ID = "partey_host"
private const val NOTIFICATION_ID = 1
private const val ACTION_STOP = "com.parteytimeline.nearby.host.STOP"

/**
 * Keeps the embedded Node server and Nearby Connections advertising alive
 * as a foreground service — without this, Android can suspend/kill the
 * app's background threads (the Node runtime, the Nearby advertising) once
 * the screen locks or the app isn't in the foreground, which would drop
 * every connected peer's game mid-round.
 */
class HostForegroundService : Service() {
    // Not private: GameWebViewActivity reads nodeRuntime.controlToken to hand
    // the host's own WebView the same secret the server checks (see
    // AndroidLocalBridge.getControlToken() below and server.js's admin gate).
    lateinit var nodeRuntime: NodeRuntime
        private set

    lateinit var nearbyHost: NearbyHost
        private set

    // Lets MainActivity keep its "Hosting…" UI in sync when hosting ends via
    // the notification's stop action rather than the in-app join/host toggle
    // it already knows about — see hookHostCallbacks() in MainActivity.kt.
    var onStopped: (() -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        nodeRuntime = NodeRuntime(applicationContext)
        nearbyHost = NearbyHost(
            applicationContext,
            targetPort = HOST_PORT,
            displayName = Build.MODEL ?: getString(com.parteytimeline.nearby.R.string.host_fallback_name),
        )
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        nodeRuntime.startIfNeeded(HOST_PORT)
        nearbyHost.startAdvertising()
        setLocalJoinEnabled(true)
        return START_STICKY
    }

    override fun onDestroy() {
        nearbyHost.stop()
        // The embedded server itself keeps running (see NodeRuntime.kt) even
        // though hosting is "stopped" — this closes the one door still open
        // to it: new devices finding/joining via /api/local/join, and kicks
        // anyone already connected through it (a LAN/QR browser guest;
        // nearbyHost.stop() above already handles Nearby peers via
        // stopAllEndpoints()).
        setLocalJoinEnabled(false)
        if (instance === this) instance = null
        onStopped?.invoke()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // Fire-and-forget: the embedded server is always already up by the time
    // either call happens (it's never actually stopped, only advertising/
    // joining toggles), so there's no startup race to retry around — and
    // nothing here is worth blocking this service's lifecycle callbacks on.
    private fun setLocalJoinEnabled(active: Boolean) {
        val token = nodeRuntime.controlToken
        Thread({
            try {
                (URL("http://127.0.0.1:$HOST_PORT/api/local/host-control").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("X-Local-Control-Token", token)
                    doOutput = true
                    connectTimeout = 3000
                    readTimeout = 3000
                    outputStream.use { it.write("{\"active\":$active}".toByteArray()) }
                    responseCode // forces the request to actually execute
                    disconnect()
                }
            } catch (e: Exception) {
                Log.w("PT-HostForegroundService", "setLocalJoinEnabled($active) failed", e)
            }
        }, "local-join-toggle").start()
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                getString(com.parteytimeline.nearby.R.string.notification_channel_host),
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val stopIntent = Intent(this, HostForegroundService::class.java).setAction(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(getString(com.parteytimeline.nearby.R.string.app_name))
            .setContentText(getString(com.parteytimeline.nearby.R.string.notification_text_hosting))
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, getString(com.parteytimeline.nearby.R.string.notification_action_stop), stopPendingIntent)
            .build()
    }

    companion object {
        var instance: HostForegroundService? = null
            private set
    }
}
