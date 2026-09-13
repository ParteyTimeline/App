package com.parteytimeline.nearby.nearby

import android.content.Context
import android.os.ParcelFileDescriptor
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.parteytimeline.nearby.tunnel.HostTunnelServer
import java.io.IOException

const val NEARBY_SERVICE_ID = "com.parteytimeline.nearby.GAME"

/**
 * Host side of "play nearby without a server": advertises this device,
 * accepts any number of peers (STRATEGY_STAR — one advertiser, many
 * discoverers), and for each one sets up a full-duplex byte stream backed
 * by two Nearby Connections STREAM payloads (one per direction — a single
 * payload is one-way, see AudioRecorder/AudioPlayer in Google's own
 * NearbyConnectionsWalkieTalkie sample for the same pattern), then wires
 * that stream into a HostTunnelServer that relays it to the embedded
 * Node server on [targetPort].
 *
 * Connections are auto-accepted: the peer already had to find and pick
 * this specific device by name in the join screen, which is confirmation
 * enough for a private party-game session between people in the same room.
 */
class NearbyHost(context: Context, private val targetPort: Int, private val displayName: String) {
    private val client: ConnectionsClient = Nearby.getConnectionsClient(context)
    private val tunnels = mutableMapOf<String, HostTunnelServer>()
    private val outgoingWriteSides = mutableMapOf<String, ParcelFileDescriptor>()
    private val endpointNames = mutableMapOf<String, String>()

    var onPeerConnected: ((endpointId: String, endpointName: String) -> Unit)? = null
    var onPeerDisconnected: ((endpointId: String) -> Unit)? = null
    var onAdvertisingFailed: ((Exception) -> Unit)? = null

    fun startAdvertising() {
        val options = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startAdvertising(displayName, NEARBY_SERVICE_ID, connectionLifecycleCallback, options)
            .addOnFailureListener { e -> onAdvertisingFailed?.invoke(e) }
    }

    fun stop() {
        client.stopAdvertising()
        client.stopAllEndpoints()
        tunnels.values.forEach { it.stop() }
        tunnels.clear()
        outgoingWriteSides.values.forEach { runCatching { it.close() } }
        outgoingWriteSides.clear()
    }

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            endpointNames[endpointId] = info.endpointName
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (!resolution.status.isSuccess) return
            sendOutgoingStream(endpointId)
        }

        override fun onDisconnected(endpointId: String) {
            tunnels.remove(endpointId)?.stop()
            outgoingWriteSides.remove(endpointId)?.let { runCatching { it.close() } }
            onPeerDisconnected?.invoke(endpointId)
        }
    }

    private fun sendOutgoingStream(endpointId: String) {
        try {
            val pipe = ParcelFileDescriptor.createPipe()
            // pipe[0] (read side) goes out over Nearby; pipe[1] (write side) is ours to write host->peer bytes into.
            client.sendPayload(endpointId, Payload.fromStream(pipe[0]))
            outgoingWriteSides[endpointId] = pipe[1]
        } catch (e: IOException) {
            client.disconnectFromEndpoint(endpointId)
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type != Payload.Type.STREAM) return
            val writeSide = outgoingWriteSides[endpointId] ?: return
            val input = payload.asStream()!!.asInputStream()
            val output = ParcelFileDescriptor.AutoCloseOutputStream(writeSide)
            val tunnel = HostTunnelServer(input, output, targetPort)
            tunnels[endpointId] = tunnel
            tunnel.onLinkClosed = { onPeerDisconnected?.invoke(endpointId) }
            tunnel.start()
            onPeerConnected?.invoke(endpointId, endpointNames[endpointId] ?: endpointId)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }
}
