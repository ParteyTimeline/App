package com.parteytimeline.nearby.nearby

import android.content.Context
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
 */
class NearbyPeer(context: Context, private val localDisplayName: String) {
    private val client: ConnectionsClient = Nearby.getConnectionsClient(context)
    private var tunnel: PeerTunnelClient? = null
    private var outgoingWriteSide: ParcelFileDescriptor? = null
    private var connectedEndpointId: String? = null

    var onHostFound: ((NearbyHostCandidate) -> Unit)? = null
    var onHostLost: ((endpointId: String) -> Unit)? = null
    var onConnecting: ((endpointId: String) -> Unit)? = null
    var onConnectionFailed: ((endpointId: String) -> Unit)? = null
    /** Fired once the tunnel is up and ready — [localPort] is where a WebView should point. */
    var onTunnelReady: ((localPort: Int) -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null

    fun startDiscovery() {
        val options = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startDiscovery(NEARBY_SERVICE_ID, endpointDiscoveryCallback, options)
    }

    fun stopDiscovery() {
        client.stopDiscovery()
    }

    fun connectTo(endpointId: String) {
        onConnecting?.invoke(endpointId)
        client.requestConnection(localDisplayName, endpointId, connectionLifecycleCallback)
            .addOnFailureListener { onConnectionFailed?.invoke(endpointId) }
    }

    fun disconnect() {
        connectedEndpointId?.let { client.disconnectFromEndpoint(it) }
        teardownTunnel()
    }

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId == NEARBY_SERVICE_ID) {
                onHostFound?.invoke(NearbyHostCandidate(endpointId, info.endpointName))
            }
        }

        override fun onEndpointLost(endpointId: String) {
            onHostLost?.invoke(endpointId)
        }
    }

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (!resolution.status.isSuccess) {
                onConnectionFailed?.invoke(endpointId)
                return
            }
            connectedEndpointId = endpointId
            sendOutgoingStream(endpointId)
        }

        override fun onDisconnected(endpointId: String) {
            teardownTunnel()
            onDisconnected?.invoke()
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
}
