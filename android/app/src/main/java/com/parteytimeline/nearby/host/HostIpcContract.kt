package com.parteytimeline.nearby.host

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle

/**
 * Cross-process signals from HostForegroundService (runs in the :host
 * process, see AndroidManifest.xml) to MainActivity (main process) — a
 * same-process closure/callback can't reach across that boundary, so these
 * become real broadcasts instead. All fire-and-forget, one-directional,
 * low-frequency — no response value or ordering guarantee needed, so a
 * bound Service/Messenger would be pure boilerplate for what this actually
 * is. Deliberately NOT LocalBroadcastManager, which only delivers within a
 * single process and would silently do nothing here.
 */
object HostIpcContract {
    const val ACTION_PEER_CONNECTED = "com.parteytimeline.nearby.host.PEER_CONNECTED"
    const val ACTION_PEER_DISCONNECTED = "com.parteytimeline.nearby.host.PEER_DISCONNECTED"
    const val ACTION_ADVERTISING_FAILED = "com.parteytimeline.nearby.host.ADVERTISING_FAILED"
    const val ACTION_HOST_STOPPED = "com.parteytimeline.nearby.host.HOST_STOPPED"

    const val EXTRA_ENDPOINT_ID = "endpointId"
    const val EXTRA_ENDPOINT_NAME = "endpointName"

    // Explicitly scoped to this app (.setPackage) so no other app can
    // receive these — paired with RECEIVER_NOT_EXPORTED on the receiver
    // side (see MainActivity.kt).
    fun send(context: Context, action: String, extras: Bundle? = null) {
        val intent = Intent(action).setPackage(context.packageName)
        extras?.let { intent.putExtras(it) }
        context.sendBroadcast(intent)
    }

    fun allActions(): IntentFilter = IntentFilter().apply {
        addAction(ACTION_PEER_CONNECTED)
        addAction(ACTION_PEER_DISCONNECTED)
        addAction(ACTION_ADVERTISING_FAILED)
        addAction(ACTION_HOST_STOPPED)
    }
}
