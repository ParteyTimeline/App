package com.parteytimeline.nearby.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.os.bundleOf
import com.parteytimeline.nearby.MainActivity
import com.parteytimeline.nearby.nearby.NearbyHost
import com.parteytimeline.nearby.node.NodeRuntime
import java.net.HttpURLConnection
import java.net.URL

const val HOST_PORT = 3000
private const val NOTIFICATION_CHANNEL_ID = "partey_host"
private const val NOTIFICATION_ID = 1
private const val ACTION_STOP = "com.parteytimeline.nearby.host.STOP"
private const val LOCAL_JOIN_DISABLE_TIMEOUT_MS = 1500L

/**
 * Keeps the embedded Node server and Nearby Connections advertising alive
 * as a foreground service — without this, Android can suspend/kill the
 * app's background threads (the Node runtime, the Nearby advertising) once
 * the screen locks or the app isn't in the foreground, which would drop
 * every connected peer's game mid-round.
 *
 * Runs in its own ":host" process (see AndroidManifest.xml) so onDestroy()
 * can end with Process.killProcess() — a genuinely clean kill of the
 * embedded Node runtime, which nodejs-mobile can't otherwise cleanly
 * restart within one process. That means nothing here (MainActivity,
 * GameWebViewActivity) can hold a direct same-process reference to this
 * service or its NodeRuntime/NearbyHost anymore — see HostIpcContract.kt
 * (event broadcasts) and ControlTokenProvider.kt (the host-control token)
 * for how those now cross the process boundary instead.
 */
class HostForegroundService : Service() {
    private lateinit var nodeRuntime: NodeRuntime
    private lateinit var nearbyHost: NearbyHost

    // Only the notification's stop action should tell MainActivity to reset
    // its "Hosting…" UI (see onDestroy()) — a stop MainActivity itself
    // triggered (e.g. switching to "join" mode) already knows to show its
    // own next UI state and would just have that flash overwritten.
    private var stoppedViaNotification = false

    override fun onCreate() {
        super.onCreate()
        nodeRuntime = NodeRuntime(applicationContext)
        nearbyHost = NearbyHost(
            applicationContext,
            targetPort = HOST_PORT,
            displayName = Build.MODEL ?: getString(com.parteytimeline.nearby.R.string.host_fallback_name),
        )
        nearbyHost.onPeerConnected = { endpointId, endpointName ->
            HostIpcContract.send(
                applicationContext, HostIpcContract.ACTION_PEER_CONNECTED,
                bundleOf(HostIpcContract.EXTRA_ENDPOINT_ID to endpointId, HostIpcContract.EXTRA_ENDPOINT_NAME to endpointName),
            )
        }
        nearbyHost.onPeerDisconnected = { endpointId ->
            HostIpcContract.send(
                applicationContext, HostIpcContract.ACTION_PEER_DISCONNECTED,
                bundleOf(HostIpcContract.EXTRA_ENDPOINT_ID to endpointId),
            )
        }
        nearbyHost.onAdvertisingFailed = {
            HostIpcContract.send(applicationContext, HostIpcContract.ACTION_ADVERTISING_FAILED)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stoppedViaNotification = true
            // Don't rely solely on the WS-based 'hostStopped' kick to get the
            // host back to a sane screen — that only fires if GameWebViewActivity
            // still has a live connection when this runs, which isn't
            // guaranteed (app backgrounded, WebView JS throttled, or the host
            // never left MainActivity to begin with). Explicitly return to
            // the start screen instead, clearing GameWebViewActivity off the
            // stack if it's there.
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            )
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        nodeRuntime.startIfNeeded(HOST_PORT)
        nearbyHost.startAdvertising()
        setLocalJoinEnabled(true, blocking = false)
        return START_STICKY
    }

    override fun onDestroy() {
        nearbyHost.stop()
        // Give already-connected LAN/QR browser guests a chance to hear
        // 'hostStopped' (see server.js) and land on a clean "waiting for
        // host" screen instead of a raw connection error — bounded so a
        // wedged/slow loopback call can't meaningfully delay the kill below
        // (Nearby peers don't depend on this: nearbyHost.stop() already
        // dropped them via stopAllEndpoints()).
        setLocalJoinEnabled(false, blocking = true)
        if (stoppedViaNotification) HostIpcContract.send(applicationContext, HostIpcContract.ACTION_HOST_STOPPED)
        super.onDestroy()
        // The whole point of the :host process: a real kill, not just
        // tearing down this Service object, so the embedded Node runtime
        // (which can't otherwise be cleanly restarted in-process) actually
        // exits. Safe here specifically because both paths that reach
        // onDestroy() already un-stickied this service first (ACTION_STOP
        // above calls stopSelf(); MainActivity's own stop calls
        // stopService()) — killing before that would make START_STICKY
        // respawn this service moments later, silently undoing the stop.
        Process.killProcess(Process.myPid())
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // The embedded server is always already up by the time either call
    // happens (it's never actually stopped while this process is alive,
    // only advertising/joining toggles) — no startup race to retry around.
    // `blocking`: the final active=false call (see onDestroy()) needs a
    // real chance to reach the server before Process.killProcess() below
    // ends this process; every other call stays fire-and-forget.
    private fun setLocalJoinEnabled(active: Boolean, blocking: Boolean) {
        val token = ControlTokenProvider.token
        val thread = Thread({
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
        }, "local-join-toggle")
        thread.start()
        if (blocking) thread.join(LOCAL_JOIN_DISABLE_TIMEOUT_MS)
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
}
