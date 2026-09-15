package com.parteytimeline.nearby.nearby

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.parteytimeline.nearby.tunnel.PeerTunnelClient
import java.io.IOException

data class NearbyHostCandidate(val endpointId: String, val name: String)

/**
 * Peer/joining side: discovers hosts advertising [NEARBY_SERVICE_ID], and
 * once connected to one, sets up the same two-STREAM-payload full-duplex
 * link as NearbyHost, wired into a PeerTunnelClient — see that class for
 * what "connected" then makes available (a local loopback port to point a
 * WebView at).
 *
 * Also owns reconnect: a Nearby link can drop for reasons that have nothing
 * to do with the game (walking a few meters out of Bluetooth/Wi-Fi Direct
 * range, the OS briefly suspending radios). Since the actual game state
 * lives server-side behind the host's session cookie (see /api/local/join
 * in server.js), a fresh tunnel is functionally indistinguishable from the
 * old one to the web app — so on an unexpected disconnect this retries
 * discovery+connect against the same host with backoff, instead of just
 * dying and forcing a manual rejoin from the start screen.
 */
class NearbyPeer(context: Context, private val localDisplayName: String) {
    private val client: ConnectionsClient = Nearby.getConnectionsClient(context)
    private val handler = Handler(Looper.getMainLooper())
    private var tunnel: PeerTunnelClient? = null
    private var outgoingWriteSide: ParcelFileDescriptor? = null
    private var connectedEndpointId: String? = null

    private var discoveryActive = false
    private var connecting = false
    private var manualDisconnect = false
    private var reconnectAttempt = 0

    // Endpoints currently visible via discovery, so a reconnect attempt can
    // target the same host without waiting for a fresh onHostFound if it's
    // already known — and can fall back to matching by name if the host's
    // endpointId happened to change (e.g. it toggled Bluetooth itself).
    private val visibleEndpoints = mutableMapOf<String, String>()
    private var lastEndpointId: String? = null
    private var lastEndpointName: String? = null

    var onHostFound: ((NearbyHostCandidate) -> Unit)? = null
    var onHostLost: ((endpointId: String) -> Unit)? = null
    var onConnecting: ((endpointId: String) -> Unit)? = null
    var onConnectionFailed: ((endpointId: String) -> Unit)? = null
    /** Fired once the tunnel is up and ready — [localPort] is where a WebView should point. Fires again on every reconnect. */
    var onTunnelReady: ((localPort: Int) -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null
    /** Fired for each automatic reconnect attempt after an unexpected drop, 1-based. */
    var onReconnecting: ((attempt: Int) -> Unit)? = null
    /** Fired once reconnect attempts are exhausted — caller should fall back to a manual rejoin. */
    var onReconnectGaveUp: (() -> Unit)? = null

    fun startDiscovery() {
        if (discoveryActive) return
        val options = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startDiscovery(NEARBY_SERVICE_ID, endpointDiscoveryCallback, options)
        discoveryActive = true
    }

    fun stopDiscovery() {
        if (!discoveryActive) return
        client.stopDiscovery()
        discoveryActive = false
    }

    fun connectTo(endpointId: String) {
        if (connecting) return
        connecting = true
        manualDisconnect = false
        onConnecting?.invoke(endpointId)
        client.requestConnection(localDisplayName, endpointId, connectionLifecycleCallback)
            .addOnFailureListener {
                connecting = false
                onConnectionFailed?.invoke(endpointId)
                if (!manualDisconnect && lastEndpointId != null) scheduleReconnect()
            }
    }

    /** Explicit, deliberate teardown (e.g. the activity is going away) — no automatic reconnect follows this. */
    fun disconnect() {
        manualDisconnect = true
        handler.removeCallbacksAndMessages(null)
        reconnectAttempt = 0
        lastEndpointId = null
        lastEndpointName = null
        connectedEndpointId?.let { client.disconnectFromEndpoint(it) }
        teardownTunnel()
        stopDiscovery()
        if (current === this) current = null
    }

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId != NEARBY_SERVICE_ID) return
            visibleEndpoints[endpointId] = info.endpointName
            onHostFound?.invoke(NearbyHostCandidate(endpointId, info.endpointName))
        }

        override fun onEndpointLost(endpointId: String) {
            visibleEndpoints.remove(endpointId)
            onHostLost?.invoke(endpointId)
        }
    }

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            connecting = false
            if (!resolution.status.isSuccess) {
                onConnectionFailed?.invoke(endpointId)
                if (!manualDisconnect && lastEndpointId != null) scheduleReconnect()
                return
            }
            connectedEndpointId = endpointId
            lastEndpointId = endpointId
            lastEndpointName = visibleEndpoints[endpointId] ?: lastEndpointName
            reconnectAttempt = 0
            sendOutgoingStream(endpointId)
        }

        override fun onDisconnected(endpointId: String) {
            connecting = false
            teardownTunnel()
            onDisconnected?.invoke()
            if (!manualDisconnect) scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            onReconnectGaveUp?.invoke()
            return
        }
        reconnectAttempt++
        onReconnecting?.invoke(reconnectAttempt)
        startDiscovery()
        val delay = minOf(RECONNECT_BASE_DELAY_MS * (1L shl minOf(reconnectAttempt - 1, 3)), RECONNECT_MAX_DELAY_MS)
        handler.postDelayed({ attemptReconnect() }, delay)
    }

    private fun attemptReconnect() {
        if (manualDisconnect || connecting) return
        val targetId = lastEndpointId?.takeIf { visibleEndpoints.containsKey(it) }
            ?: lastEndpointName?.let { name -> visibleEndpoints.entries.firstOrNull { it.value == name }?.key }
        if (targetId != null) {
            connectTo(targetId)
        } else {
            scheduleReconnect()
        }
    }

    private fun sendOutgoingStream(endpointId: String) {
        try {
            val pipe = ParcelFileDescriptor.createPipe()
            client.sendPayload(endpointId, Payload.fromStream(pipe[0]))
            outgoingWriteSide = pipe[1]
        } catch (e: IOException) {
            client.disconnectFromEndpoint(endpointId)
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type != Payload.Type.STREAM) return
            val writeSide = outgoingWriteSide ?: return
            val input = payload.asStream()!!.asInputStream()
            val output = ParcelFileDescriptor.AutoCloseOutputStream(writeSide)
            val client = PeerTunnelClient(input, output)
            tunnel = client
            client.onLinkClosed = { onDisconnected?.invoke() }
            val localPort = client.start()
            onTunnelReady?.invoke(localPort)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

    private fun teardownTunnel() {
        tunnel?.stop()
        tunnel = null
        outgoingWriteSide?.let { runCatching { it.close() } }
        outgoingWriteSide = null
        connectedEndpointId = null
    }

    init {
        current = this
    }

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 20
        private const val RECONNECT_BASE_DELAY_MS = 1000L
        private const val RECONNECT_MAX_DELAY_MS = 8000L

        /** The most recently created peer — lets GameWebViewActivity hook reconnect events without owning the instance itself (see MainActivity, which does the actual creating). */
        @Volatile
        var current: NearbyPeer? = null
            private set
    }
}
