package com.parteytimeline.nearby.nearby

import android.content.Context
import android.os.Handler
import android.os.Looper
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
    private val handler = Handler(Looper.getMainLooper())
    private val tunnels = mutableMapOf<String, HostTunnelServer>()
    private val outgoingWriteSides = mutableMapOf<String, ParcelFileDescriptor>()
    private val endpointNames = mutableMapOf<String, String>()
    private var stopped = false
    private var advertisingRetryAttempt = 0

    var onPeerConnected: ((endpointId: String, endpointName: String) -> Unit)? = null
    var onPeerDisconnected: ((endpointId: String) -> Unit)? = null
    var onAdvertisingFailed: ((Exception) -> Unit)? = null

    // Peers that drop (out of range, backgrounded, etc.) don't need any
    // action here to be reconnectable: advertising keeps running until stop()
    // is called, so a peer's own reconnect attempt (see NearbyPeer) just
    // looks like a fresh incoming connection. The one failure mode that
    // *does* need explicit recovery is advertising itself failing/dying
    // (e.g. a transient GMS/Bluetooth error) — retried here with backoff so
    // the host doesn't silently become invisible to new/reconnecting peers.
    fun startAdvertising() {
        stopped = false
        val options = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startAdvertising(displayName, NEARBY_SERVICE_ID, connectionLifecycleCallback, options)
            .addOnSuccessListener { advertisingRetryAttempt = 0 }
            .addOnFailureListener { e ->
                onAdvertisingFailed?.invoke(e)
                retryAdvertising()
            }
    }

    private fun retryAdvertising() {
        if (stopped || advertisingRetryAttempt >= MAX_ADVERTISING_RETRIES) return
        advertisingRetryAttempt++
        val delay = minOf(RETRY_BASE_DELAY_MS * (1L shl minOf(advertisingRetryAttempt - 1, 3)), RETRY_MAX_DELAY_MS)
        handler.postDelayed({ if (!stopped) startAdvertising() }, delay)
    }

    fun stop() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
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

    companion object {
        private const val MAX_ADVERTISING_RETRIES = 10
        private const val RETRY_BASE_DELAY_MS = 1000L
        private const val RETRY_MAX_DELAY_MS = 8000L
    }
}
