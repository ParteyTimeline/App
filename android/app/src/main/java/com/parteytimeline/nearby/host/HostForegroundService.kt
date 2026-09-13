package com.parteytimeline.nearby.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.parteytimeline.nearby.nearby.NearbyHost
import com.parteytimeline.nearby.node.NodeRuntime

const val HOST_PORT = 3000
private const val NOTIFICATION_CHANNEL_ID = "partey_host"
private const val NOTIFICATION_ID = 1

/**
 * Keeps the embedded Node server and Nearby Connections advertising alive
 * as a foreground service — without this, Android can suspend/kill the
 * app's background threads (the Node runtime, the Nearby advertising) once
 * the screen locks or the app isn't in the foreground, which would drop
 * every connected peer's game mid-round.
 */
class HostForegroundService : Service() {
    private lateinit var nodeRuntime: NodeRuntime

    lateinit var nearbyHost: NearbyHost
        private set

    override fun onCreate() {
        super.onCreate()
        nodeRuntime = NodeRuntime(applicationContext)
        nearbyHost = NearbyHost(
            applicationContext,
            targetPort = HOST_PORT,
            displayName = Build.MODEL ?: "Partey-Host",
        )
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        nodeRuntime.startIfNeeded(HOST_PORT)
        nearbyHost.startAdvertising()
        return START_STICKY
    }

    override fun onDestroy() {
        nearbyHost.stop()
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Partey Timeline Host",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(getString(com.parteytimeline.nearby.R.string.app_name))
            .setContentText("Läuft — andere Geräte können jetzt beitreten")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .build()
    }

    companion object {
        var instance: HostForegroundService? = null
            private set
    }
}
