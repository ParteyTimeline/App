package com.parteytimeline.nearby.nearby

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
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
import com.parteytimeline.nearby.tunnel.MuxFrameType
import com.parteytimeline.nearby.tunnel.MuxWriter
import com.parteytimeline.nearby.tunnel.tunnelLog
import com.tinder.StateMachine
import java.io.IOException
import java.io.OutputStream

const val NEARBY_SERVICE_ID = "com.parteytimeline.nearby.GAME"
private const val TAG = "PT-NearbyHost"

// The original design has no distinct "actively advertising" vs "retrying"
// state to speak of — just one persistent retry-attempt counter (reset on
// success, incremented on failure) and a terminal "stopped" kill switch
// checked before ever scheduling another retry. Modeled as exactly that,
// rather than inventing a state split the original code never branches on.
sealed class HostState {
    data class Active(val retryAttempt: Int) : HostState()
    object Stopped : HostState()
}

sealed class HostEvent {
    object Start : HostEvent()
    object AdvertisingSucceeded : HostEvent()
    object AdvertisingFailed : HostEvent()
    object Stop : HostEvent()
}

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
    private val outgoingOutputs = mutableMapOf<String, OutputStream>()
    private val endpointNames = mutableMapOf<String, String>()

    // Side effects (client.startAdvertising/stop/etc.) stay exactly where
    // they always were — this only replaces `stopped`/`advertisingRetryAttempt`
    // with a single formal record of the same two facts.
    private val machine = StateMachine.create<HostState, HostEvent, Unit> {
        initialState(HostState.Active(0))
        state<HostState.Active> {
            on<HostEvent.AdvertisingSucceeded> { transitionTo(HostState.Active(0)) }
            on<HostEvent.AdvertisingFailed> { transitionTo(HostState.Active(retryAttempt + 1)) }
            on<HostEvent.Stop> { transitionTo(HostState.Stopped) }
        }
        state<HostState.Stopped> {
            on<HostEvent.Start> { transitionTo(HostState.Active(0)) }
        }
    }

    init {
        // Wire the tunnel package's injectable logger to Log now that we're
        // definitely on Android (the tunnel package itself stays pure JVM
        // for plain-JUnit testability — see its own comment on tunnelLog).
        tunnelLog = { tag, message, error -> if (error != null) Log.w(tag, message, error) else Log.d(tag, message) }
    }

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
        // A no-op unless we're currently Stopped (mirrors the original's
        // unconditional `stopped = false` — harmless to "clear" a stop that
        // was never in effect).
        machine.transition(HostEvent.Start)
        val options = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startAdvertising(displayName, NEARBY_SERVICE_ID, connectionLifecycleCallback, options)
            .addOnSuccessListener { machine.transition(HostEvent.AdvertisingSucceeded) }
            .addOnFailureListener { e ->
                onAdvertisingFailed?.invoke(e)
                retryAdvertising()
            }
    }

    private fun retryAdvertising() {
        if (machine.state == HostState.Stopped) return
        val current = (machine.state as? HostState.Active)?.retryAttempt ?: return
        if (current >= MAX_ADVERTISING_RETRIES) return
        machine.transition(HostEvent.AdvertisingFailed)
        val next = current + 1
        val delay = minOf(RETRY_BASE_DELAY_MS * (1L shl minOf(next - 1, 3)), RETRY_MAX_DELAY_MS)
        handler.postDelayed({ if (machine.state != HostState.Stopped) startAdvertising() }, delay)
    }

    fun stop() {
        machine.transition(HostEvent.Stop)
        handler.removeCallbacksAndMessages(null)
        client.stopAdvertising()
        client.stopAllEndpoints()
        tunnels.values.forEach { it.stop() }
        tunnels.clear()
        outgoingOutputs.values.forEach { runCatching { it.close() } }
        outgoingOutputs.clear()
    }

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            endpointNames[endpointId] = info.endpointName
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            Log.d(TAG, "onConnectionResult($endpointId, success=${resolution.status.isSuccess}, statusCode=${resolution.status.statusCode})")
            if (!resolution.status.isSuccess) return
            sendOutgoingStream(endpointId)
            // See NearbyPeer's matching watchdog: Nearby Connections can
            // report success and then never deliver either side's Payload
            // at all, with no error and no onDisconnected. If we're still
            // waiting on the peer's payload (no tunnel yet) after this
            // window, treat the link as dead ourselves.
            handler.postDelayed({
                if (!tunnels.containsKey(endpointId)) {
                    Log.w(TAG, "No payload received from peer within watchdog window for $endpointId — treating link as stalled")
                    client.disconnectFromEndpoint(endpointId)
                }
            }, STALL_WATCHDOG_MS)
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "onDisconnected($endpointId)")
            tunnels.remove(endpointId)?.stop()
            outgoingOutputs.remove(endpointId)?.let { runCatching { it.close() } }
            onPeerDisconnected?.invoke(endpointId)
        }
    }

    private fun sendOutgoingStream(endpointId: String) {
        try {
            val pipe = ParcelFileDescriptor.createPipe()
            // pipe[0] (read side) goes out over Nearby; pipe[1] (write side) is ours to write host->peer bytes into.
            client.sendPayload(endpointId, Payload.fromStream(pipe[0]))
            val output = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
            outgoingOutputs[endpointId] = output
            Log.d(TAG, "sendOutgoingStream($endpointId): payload sent, write side stored")
            // Break a mutual-wait deadlock: see NearbyPeer's matching
            // comment. Both sides normally only produce their first bytes
            // once onPayloadReceived fires and builds a tunnel/MuxRelay —
            // but if neither side's payload is ever delivered because
            // neither ever produces a first byte, the link just stalls with
            // zero bytes transferred (observed on real devices). Write a
            // bare PING directly now, independent of onPayloadReceived.
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
            val output = outgoingOutputs[endpointId]
            if (output == null) {
                Log.w(TAG, "onPayloadReceived($endpointId): no outgoing stream yet, dropping")
                return
            }
            val input = payload.asStream()!!.asInputStream()
            val tunnel = HostTunnelServer(input, output, targetPort)
            tunnels[endpointId] = tunnel
            tunnel.onLinkClosed = {
                Log.d(TAG, "tunnel.onLinkClosed for $endpointId")
                onPeerDisconnected?.invoke(endpointId)
                // See NearbyPeer's matching comment: the mux relay can die
                // without Nearby ever firing its own onDisconnected — force
                // it so a stalled peer doesn't just sit connected-but-dead
                // forever. No-op if Nearby already agrees it's gone.
                client.disconnectFromEndpoint(endpointId)
            }
            tunnel.start()
            onPeerConnected?.invoke(endpointId, endpointNames[endpointId] ?: endpointId)
            handler.postDelayed({
                if (tunnels[endpointId] === tunnel && !tunnel.hasReceivedAnyFrame) {
                    Log.w(TAG, "No frame received within watchdog window for $endpointId — treating link as stalled")
                    client.disconnectFromEndpoint(endpointId)
                }
            }, STALL_WATCHDOG_MS)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            Log.d(TAG, "onPayloadTransferUpdate($endpointId, status=${update.status}, bytes=${update.bytesTransferred}/${update.totalBytes})")
            if (update.status == PayloadTransferUpdate.Status.FAILURE) {
                Log.w(TAG, "Payload transfer failed for $endpointId — forcing disconnect")
                client.disconnectFromEndpoint(endpointId)
            }
        }
    }

    companion object {
        private const val MAX_ADVERTISING_RETRIES = 10
        private const val RETRY_BASE_DELAY_MS = 1000L
        private const val RETRY_MAX_DELAY_MS = 8000L
        // See NearbyPeer's STALL_WATCHDOG_MS — same reasoning, host side.
        private const val STALL_WATCHDOG_MS = 8000L
    }
}
