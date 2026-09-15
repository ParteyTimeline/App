package com.parteytimeline.nearby.nearby

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionOptions
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.parteytimeline.nearby.tunnel.MuxFrameType
import com.parteytimeline.nearby.tunnel.MuxWriter
import com.parteytimeline.nearby.tunnel.PeerTunnelClient
import com.parteytimeline.nearby.tunnel.tunnelLog
import java.io.IOException
import java.io.OutputStream

data class NearbyHostCandidate(val endpointId: String, val name: String)

private const val TAG = "PT-NearbyPeer"

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
    private var outgoingOutput: OutputStream? = null
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
        // NON_DISRUPTIVE just avoids changing Wi-Fi/Bluetooth state for a
        // bandwidth upgrade we don't need — harmless to keep, but NOT what
        // fixed the "connects but the tunnel never comes up" failure this
        // was originally added to chase: that turned out to be a mutual
        // deadlock in our own startup handshake (see sendOutgoingStream's
        // comment below), unrelated to Nearby's medium/upgrade behavior.
        val connectionOptions = ConnectionOptions.Builder()
            .setConnectionType(ConnectionType.NON_DISRUPTIVE)
            .build()
        client.requestConnection(localDisplayName, endpointId, connectionLifecycleCallback, connectionOptions)
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
            Log.d(TAG, "onConnectionResult($endpointId, success=${resolution.status.isSuccess}, statusCode=${resolution.status.statusCode})")
            connecting = false
            if (!resolution.status.isSuccess) {
                onConnectionFailed?.invoke(endpointId)
                if (!manualDisconnect && lastEndpointId != null) scheduleReconnect()
                return
            }
            connectedEndpointId = endpointId
            lastEndpointId = endpointId
            lastEndpointName = visibleEndpoints[endpointId] ?: lastEndpointName
            // reconnectAttempt is reset once the tunnel actually starts
            // (see onPayloadReceived below), not here — a Nearby-level
            // "success" doesn't mean the tunnel handshake will ever
            // actually complete (see the watchdog just below), and
            // resetting here would restart backoff from attempt 1 on every
            // failed handshake, defeating the growing delay/attempt cap.
            sendOutgoingStream(endpointId)
            // Nearby Connections can report a successful connection and then
            // silently never deliver either side's Payload at all — observed
            // on real devices during its own internal bandwidth-medium
            // upgrade, with no error and no onDisconnected. If we're still
            // waiting on the host's payload (no tunnel yet) after this
            // window, treat the link as dead ourselves.
            handler.postDelayed({
                if (connectedEndpointId == endpointId && tunnel == null) {
                    Log.w(TAG, "No payload received from host within watchdog window for $endpointId — treating link as stalled")
                    client.disconnectFromEndpoint(endpointId)
                }
            }, STALL_WATCHDOG_MS)
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "onDisconnected($endpointId)")
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
            val output = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
            outgoingOutput = output
            Log.d(TAG, "sendOutgoingStream($endpointId): payload sent, write side stored")
            // Break a mutual-wait deadlock: onPayloadReceived doesn't fire
            // on either side until real bytes start flowing on THAT side's
            // incoming payload, but the tunnel/MuxRelay that would normally
            // produce those bytes (via its own startup PING) isn't built
            // until onPayloadReceived fires — if both sides wait on the
            // other's first byte before producing their own, neither ever
            // does, and the whole link times out with zero bytes
            // transferred (observed on real devices). Write a bare PING
            // directly into our own outgoing stream right now, independent
            // of anything else, to guarantee it doesn't depend on receiving
            // first. Reused as-is by the real MuxRelay below once it exists.
            MuxWriter(output).writeFrame(0, MuxFrameType.PING, ByteArray(0))
        } catch (e: IOException) {
            Log.e(TAG, "sendOutgoingStream($endpointId) failed, disconnecting", e)
            client.disconnectFromEndpoint(endpointId)
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            Log.d(TAG, "onPayloadReceived($endpointId, type=${payload.type})")
            if (payload.type != Payload.Type.STREAM) return
            val output = outgoingOutput
            if (output == null) {
                Log.w(TAG, "onPayloadReceived($endpointId): no outgoing stream yet, dropping")
                return
            }
            val input = payload.asStream()!!.asInputStream()
            val tunnelClient = PeerTunnelClient(input, output)
            tunnel = tunnelClient
            tunnelClient.onLinkClosed = {
                Log.d(TAG, "tunnel.onLinkClosed for $endpointId")
                onDisconnected?.invoke()
                // The mux relay can die (IOException on its own reader
                // thread) without Nearby ever noticing/firing its own
                // onDisconnected — e.g. mid-session, well after the startup
                // watchdog above stopped being relevant. Force it so our
                // reconnect-with-backoff (driven by onDisconnected) always
                // gets a chance to run; a no-op if Nearby already agrees
                // the endpoint is gone.
                client.disconnectFromEndpoint(endpointId)
            }
            val localPort = tunnelClient.start()
            reconnectAttempt = 0 // only now that the tunnel has actually started, not just "Nearby connected" (see onConnectionResult)
            Log.d(TAG, "PeerTunnelClient started on localPort=$localPort for $endpointId")
            onTunnelReady?.invoke(localPort)
            handler.postDelayed({
                if (tunnel === tunnelClient && !tunnelClient.hasReceivedAnyFrame) {
                    Log.w(TAG, "No frame received within watchdog window for $endpointId — treating link as stalled")
                    client.disconnectFromEndpoint(endpointId)
                }
            }, STALL_WATCHDOG_MS)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            Log.d(TAG, "onPayloadTransferUpdate($endpointId, status=${update.status}, bytes=${update.bytesTransferred}/${update.totalBytes})")
            if (update.status == PayloadTransferUpdate.Status.FAILURE) {
                Log.w(TAG, "Payload transfer failed for $endpointId — forcing disconnect to trigger reconnect")
                client.disconnectFromEndpoint(endpointId)
            }
        }
    }

    private fun teardownTunnel() {
        tunnel?.stop()
        tunnel = null
        outgoingOutput?.let { runCatching { it.close() } }
        outgoingOutput = null
        connectedEndpointId = null
    }

    init {
        current = this
        // See NearbyHost's matching init block: wires the pure-JVM tunnel
        // package's injectable logger to Log now that we're on Android.
        tunnelLog = { tag, message, error -> if (error != null) Log.w(tag, message, error) else Log.d(tag, message) }
    }

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 20
        private const val RECONNECT_BASE_DELAY_MS = 1000L
        private const val RECONNECT_MAX_DELAY_MS = 8000L
        // Defense in depth: a connection can report success and then never
        // deliver a payload at all, with no error and no onDisconnected —
        // the concrete case we hit was our own startup deadlock (see
        // sendOutgoingStream's comment, now fixed by writing an immediate
        // PING), but Nearby itself can in principle drop a payload too. If
        // nothing arrives within this window, treat the link as stalled and
        // force a disconnect so the reconnect-with-backoff logic above
        // takes over rather than waiting forever.
        private const val STALL_WATCHDOG_MS = 8000L

        /** The most recently created peer — lets GameWebViewActivity hook reconnect events without owning the instance itself (see MainActivity, which does the actual creating). */
        @Volatile
        var current: NearbyPeer? = null
            private set
    }
}
