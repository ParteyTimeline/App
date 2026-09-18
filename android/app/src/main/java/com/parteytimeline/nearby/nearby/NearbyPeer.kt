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
import com.tinder.StateMachine
import java.io.IOException
import java.io.OutputStream

data class NearbyHostCandidate(val endpointId: String, val name: String)

private const val TAG = "PT-NearbyPeer"

// Discovery is an independent, simultaneously-active radio operation — you
// can be Connecting to one host while discovery is still running for
// others — so it's its own small state machine rather than a field folded
// into PeerState (which would force every PeerState to carry it) or a
// plain boolean (which wouldn't be a state machine at all).
sealed class DiscoveryState {
    object NotDiscovering : DiscoveryState()
    object Discovering : DiscoveryState()
}

sealed class DiscoveryEvent {
    object Start : DiscoveryEvent()
    object Stop : DiscoveryEvent()
}

// The connection lifecycle, formalized instead of the scattered booleans
// (connecting/manualDisconnect/connectedEndpointId-as-a-flag) this used to
// be tracked with — see NearbyPeer's class doc for why.
sealed class PeerState {
    object Idle : PeerState()
    // attempt carries the in-progress reconnect count (0 for a fresh,
    // manually-triggered connect) through Nearby's async handshake so a
    // failure partway through resumes counting instead of restarting at 1 —
    // see currentAttempt()/scheduleReconnect().
    data class Connecting(val endpointId: String, val attempt: Int = 0) : PeerState()
    data class Connected(val endpointId: String, val attempt: Int = 0) : PeerState() // Nearby-level connected, tunnel handshake pending
    data class Active(val endpointId: String) : PeerState() // tunnel confirmed live
    data class Reconnecting(val attempt: Int) : PeerState()
    object GaveUp : PeerState()
}

sealed class PeerEvent {
    data class AttemptConnect(val endpointId: String, val attempt: Int = 0) : PeerEvent()
    data class NearbyConnectSucceeded(val endpointId: String) : PeerEvent()
    // A first-ever failed attempt (never connected before) doesn't retry —
    // see scheduleReconnect()'s callers, which decide whether this or
    // EnterReconnecting is the right event for a given failure/drop.
    object BackToIdle : PeerEvent()
    data class EnterReconnecting(val attempt: Int) : PeerEvent()
    object GiveUp : PeerEvent()
    data class TunnelActive(val endpointId: String) : PeerEvent()
    object ManualDisconnect : PeerEvent()
}

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

    private val discoveryMachine = StateMachine.create<DiscoveryState, DiscoveryEvent, Unit> {
        initialState(DiscoveryState.NotDiscovering)
        state<DiscoveryState.NotDiscovering> {
            on<DiscoveryEvent.Start> { transitionTo(DiscoveryState.Discovering) }
        }
        state<DiscoveryState.Discovering> {
            on<DiscoveryEvent.Stop> { transitionTo(DiscoveryState.NotDiscovering) }
        }
    }

    // Side effects (client.startDiscovery/requestConnection/etc.) stay
    // exactly where they always were, right next to the transition that
    // corresponds to them — this machine only replaces the bookkeeping
    // booleans, not the Nearby Connections calls themselves.
    private val machine = StateMachine.create<PeerState, PeerEvent, Unit> {
        initialState(PeerState.Idle)
        state<PeerState.Idle> {
            on<PeerEvent.AttemptConnect> { transitionTo(PeerState.Connecting(it.endpointId, it.attempt)) }
        }
        state<PeerState.Connecting> {
            on<PeerEvent.NearbyConnectSucceeded> { transitionTo(PeerState.Connected(it.endpointId, attempt)) }
            on<PeerEvent.BackToIdle> { transitionTo(PeerState.Idle) }
            on<PeerEvent.EnterReconnecting> { transitionTo(PeerState.Reconnecting(it.attempt)) }
            // scheduleReconnect() computes attempt from whichever state
            // holds it (see currentAttempt()) — since Connecting/Connected
            // now preserve that count instead of resetting it, exhaustion
            // (attempt >= MAX_RECONNECT_ATTEMPTS) can be DETECTED while
            // still in either of these two states, not only Reconnecting.
            // Without a handler here, that GiveUp transition was invalid
            // (a no-op), yet onReconnectGaveUp still fired unconditionally
            // — a give-up notification with the peer silently still stuck
            // Connecting/Connected instead of actually reaching GaveUp.
            on<PeerEvent.GiveUp> { transitionTo(PeerState.GaveUp) }
            on<PeerEvent.ManualDisconnect> { transitionTo(PeerState.Idle) }
        }
        state<PeerState.Connected> {
            on<PeerEvent.TunnelActive> { transitionTo(PeerState.Active(it.endpointId)) }
            on<PeerEvent.EnterReconnecting> { transitionTo(PeerState.Reconnecting(it.attempt)) }
            on<PeerEvent.GiveUp> { transitionTo(PeerState.GaveUp) } // see PeerState.Connecting's identical handler above for why
            on<PeerEvent.ManualDisconnect> { transitionTo(PeerState.Idle) }
        }
        state<PeerState.Active> {
            on<PeerEvent.EnterReconnecting> { transitionTo(PeerState.Reconnecting(it.attempt)) }
            on<PeerEvent.ManualDisconnect> { transitionTo(PeerState.Idle) }
        }
        state<PeerState.Reconnecting> {
            on<PeerEvent.AttemptConnect> { transitionTo(PeerState.Connecting(it.endpointId, it.attempt)) }
            on<PeerEvent.EnterReconnecting> { transitionTo(PeerState.Reconnecting(it.attempt)) }
            on<PeerEvent.GiveUp> { transitionTo(PeerState.GaveUp) }
            on<PeerEvent.ManualDisconnect> { transitionTo(PeerState.Idle) }
        }
        state<PeerState.GaveUp> {
            on<PeerEvent.AttemptConnect> { transitionTo(PeerState.Connecting(it.endpointId, it.attempt)) }
            on<PeerEvent.ManualDisconnect> { transitionTo(PeerState.Idle) }
        }
    }

    // Single source of truth for "how many reconnect attempts so far",
    // read from whichever state currently carries it — Connecting/Connected
    // preserve the count through Nearby's async handshake instead of
    // losing it the moment a retry leaves Reconnecting (the P1 this
    // replaces: scheduleReconnect() used to read the count ONLY from
    // PeerState.Reconnecting, so every attempt after the first reported 1
    // and the 20-attempt cap/give-up never triggered). Active carries none
    // because a live tunnel deliberately resets the count to 0.
    private fun currentAttempt(): Int = when (val s = machine.state) {
        is PeerState.Connecting -> s.attempt
        is PeerState.Connected -> s.attempt
        is PeerState.Reconnecting -> s.attempt
        else -> 0
    }

    // The endpoint (if any) a CURRENT attempt is mid-flight or live on.
    // Lets stale-callback cleanup tell a truly orphaned endpoint (nothing
    // claims it — safe to disconnect) apart from one a REPLACEMENT attempt
    // now owns (disconnecting it would tear down the replacement, not the
    // abandoned attempt, whenever both happen to target the same host).
    private fun currentlyOwnedEndpointId(): String? = when (val s = machine.state) {
        is PeerState.Connecting -> s.endpointId
        is PeerState.Connected -> s.endpointId
        is PeerState.Active -> s.endpointId
        else -> null
    }

    // Lets MainActivity tell a genuinely idle peer (discovery stopped,
    // nothing connecting, no tunnel) apart from one still legitimately
    // mid-flight — see its onResume().
    val isActive: Boolean
        get() = discoveryMachine.state == DiscoveryState.Discovering ||
            (machine.state != PeerState.Idle && machine.state != PeerState.GaveUp)

    // Endpoints currently visible via discovery, so a reconnect attempt can
    // target the same host without waiting for a fresh onHostFound if it's
    // already known — and can fall back to matching by name if the host's
    // endpointId happened to change (e.g. it toggled Bluetooth itself).
    private val visibleEndpoints = mutableMapOf<String, String>()
    private var lastEndpointId: String? = null
    private var lastEndpointName: String? = null

    // Which attempt's ConnectionLifecycleCallback is the one actually in
    // flight right now — see makeConnectionLifecycleCallback()'s comment.
    // A plain endpointId comparison can't tell a cancelled attempt apart
    // from a NEWER attempt to that same endpoint; reference identity can.
    private var currentAttemptCallback: ConnectionLifecycleCallback? = null

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
        if (discoveryMachine.state == DiscoveryState.Discovering) return
        val options = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build()
        client.startDiscovery(NEARBY_SERVICE_ID, endpointDiscoveryCallback, options)
        discoveryMachine.transition(DiscoveryEvent.Start)
    }

    fun stopDiscovery() {
        if (discoveryMachine.state != DiscoveryState.Discovering) return
        client.stopDiscovery()
        discoveryMachine.transition(DiscoveryEvent.Stop)
    }

    fun connectTo(endpointId: String, attempt: Int = 0) {
        // Only Idle/Reconnecting/GaveUp actually handle AttemptConnect (see
        // the transition table above) — mirror that here so a tap while
        // already Connecting/Connected/Active is dropped instead of firing
        // a second, overlapping requestConnection() that the old bare
        // `is PeerState.Connecting` guard let through for those two states.
        when (machine.state) {
            is PeerState.Idle, is PeerState.Reconnecting, is PeerState.GaveUp -> {}
            else -> return
        }
        machine.transition(PeerEvent.AttemptConnect(endpointId, attempt))
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
        // A fresh callback instance per attempt (not a single shared
        // field) — see makeConnectionLifecycleCallback()'s comment for why:
        // reference identity is what lets a callback delivered after ITS
        // attempt was cancelled/replaced be recognized as stale, even when
        // the replacement targets this exact same endpoint.
        val callback = makeConnectionLifecycleCallback()
        currentAttemptCallback = callback
        client.requestConnection(localDisplayName, endpointId, callback, connectionOptions)
            .addOnFailureListener {
                if (currentAttemptCallback !== callback) return@addOnFailureListener
                onConnectionFailed?.invoke(endpointId)
                if (lastEndpointId != null) scheduleReconnect() else machine.transition(PeerEvent.BackToIdle)
            }
    }

    /** Explicit, deliberate teardown (e.g. the activity is going away) — no automatic reconnect follows this. */
    fun disconnect() {
        // Captured before transitioning — includes a merely in-flight
        // Connecting attempt (not just Connected/Active) so a cancel while
        // a requestConnection() is still pending actually tells Nearby to
        // drop it too, instead of leaving it dangling at the SDK level
        // while our own state machine moves on (the late-success side of
        // that gap is closed separately in onConnectionResult/onPayloadReceived below).
        val pendingId = when (val s = machine.state) {
            is PeerState.Connecting -> s.endpointId
            is PeerState.Connected -> s.endpointId
            is PeerState.Active -> s.endpointId
            else -> null
        }
        machine.transition(PeerEvent.ManualDisconnect)
        // Invalidates whatever attempt was just abandoned — see
        // makeConnectionLifecycleCallback()'s comment. A late callback for
        // it must be recognized as stale even if no NEWER attempt has
        // replaced it yet (e.g. a cancel with no immediate retry).
        currentAttemptCallback = null
        handler.removeCallbacksAndMessages(null)
        lastEndpointId = null
        lastEndpointName = null
        pendingId?.let { client.disconnectFromEndpoint(it) }
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

    // A fresh instance per attempt, created by connectTo() — NOT a single
    // shared field like this used to be. Nearby only ever hands a callback
    // back its own endpointId, never anything identifying WHICH attempt it
    // was for, and two different attempts can legitimately target the very
    // same endpoint one after another (cancel, then retry the same host).
    // With one shared callback object, a stale delivery for an abandoned
    // attempt was indistinguishable from a legitimate one for a NEWER
    // attempt to that identical endpoint — an endpointId-only guard (still
    // kept below as belt-and-suspenders) cannot tell those apart, but
    // reference identity against currentAttemptCallback always can.
    private fun makeConnectionLifecycleCallback(): ConnectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            if (currentAttemptCallback !== this) {
                Log.w(TAG, "Ignoring onConnectionInitiated($endpointId) from a superseded attempt")
                return
            }
            // A payload callback tied to THIS attempt, not a shared field —
            // otherwise a stream/transfer-update for an abandoned attempt
            // would be indistinguishable from one for its replacement the
            // moment both target the same endpoint (mirrors why the
            // lifecycle callback itself is per-attempt — see this class's
            // comment above makeConnectionLifecycleCallback).
            client.acceptConnection(endpointId, makePayloadCallback(this))
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (currentAttemptCallback !== this) {
                Log.w(TAG, "Ignoring onConnectionResult($endpointId) from a superseded attempt")
                // Only clean up a truly orphaned endpoint. If a REPLACEMENT
                // attempt now owns this same endpointId, disconnecting here
                // would tear down that replacement, not the stale attempt.
                if (resolution.status.isSuccess && currentlyOwnedEndpointId() != endpointId) {
                    client.disconnectFromEndpoint(endpointId)
                }
                return
            }
            Log.d(TAG, "onConnectionResult($endpointId, success=${resolution.status.isSuccess}, statusCode=${resolution.status.statusCode})")
            if (!resolution.status.isSuccess) {
                onConnectionFailed?.invoke(endpointId)
                if (lastEndpointId != null) scheduleReconnect() else machine.transition(PeerEvent.BackToIdle)
                return
            }
            // Belt-and-suspenders alongside the identity check above: the
            // state machine itself must still agree we're waiting on THIS
            // endpoint (covers a disconnect()/newer connectTo() moving us
            // away from Connecting(endpointId) before this async callback
            // arrives, i.e. cancel-then-late-success).
            val connecting = machine.state as? PeerState.Connecting
            if (connecting == null || connecting.endpointId != endpointId) {
                Log.w(TAG, "Ignoring stale onConnectionResult success for $endpointId (state=${machine.state})")
                client.disconnectFromEndpoint(endpointId)
                return
            }
            machine.transition(PeerEvent.NearbyConnectSucceeded(endpointId))
            lastEndpointId = endpointId
            lastEndpointName = visibleEndpoints[endpointId] ?: lastEndpointName
            sendOutgoingStream(endpointId)
            // Nearby Connections can report a successful connection and then
            // silently never deliver either side's Payload at all — observed
            // on real devices during its own internal bandwidth-medium
            // upgrade, with no error and no onDisconnected. If we're still
            // waiting on the host's payload (no tunnel yet) after this
            // window, treat the link as dead ourselves.
            val self = this
            handler.postDelayed({
                if (currentAttemptCallback !== self) return@postDelayed
                val current = machine.state
                if (current is PeerState.Connected && current.endpointId == endpointId) {
                    Log.w(TAG, "No payload received from host within watchdog window for $endpointId — treating link as stalled")
                    client.disconnectFromEndpoint(endpointId)
                }
            }, STALL_WATCHDOG_MS)
        }

        override fun onDisconnected(endpointId: String) {
            if (currentAttemptCallback !== this) {
                Log.w(TAG, "Ignoring onDisconnected($endpointId) from a superseded attempt")
                return
            }
            // The endpointId this fires for isn't necessarily the one our
            // OWN active/connected state currently cares about — a queued
            // disconnect for an already-abandoned endpoint can still land
            // after a newer endpoint's connection has already taken over.
            // Only Connected/Active carry an endpoint to compare against;
            // any other current state has nothing at stake here yet.
            val currentEndpointId = when (val s = machine.state) {
                is PeerState.Connected -> s.endpointId
                is PeerState.Active -> s.endpointId
                else -> null
            }
            if (currentEndpointId != null && currentEndpointId != endpointId) {
                Log.w(TAG, "Ignoring onDisconnected($endpointId) — current endpoint is $currentEndpointId")
                return
            }
            Log.d(TAG, "onDisconnected($endpointId)")
            teardownTunnel()
            onDisconnected?.invoke()
            // A manual disconnect() already moved this to Idle/GaveUp before
            // calling client.disconnectFromEndpoint() itself, which is what
            // triggers this very callback — without this check, a manual
            // stop would immediately schedule a pointless reconnect.
            if (machine.state != PeerState.Idle && machine.state != PeerState.GaveUp) scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        val current = currentAttempt()
        if (current >= MAX_RECONNECT_ATTEMPTS) {
            machine.transition(PeerEvent.GiveUp)
            onReconnectGaveUp?.invoke()
            return
        }
        val next = current + 1
        machine.transition(PeerEvent.EnterReconnecting(next))
        onReconnecting?.invoke(next)
        startDiscovery()
        val delay = minOf(RECONNECT_BASE_DELAY_MS * (1L shl minOf(next - 1, 3)), RECONNECT_MAX_DELAY_MS)
        handler.postDelayed({ attemptReconnect() }, delay)
    }

    private fun attemptReconnect() {
        val attempt = (machine.state as? PeerState.Reconnecting)?.attempt ?: return
        val targetId = lastEndpointId?.takeIf { visibleEndpoints.containsKey(it) }
            ?: lastEndpointName?.let { name -> visibleEndpoints.entries.firstOrNull { it.value == name }?.key }
        if (targetId != null) {
            connectTo(targetId, attempt)
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

    // One fresh instance per accepted connection (created in
    // onConnectionInitiated above), tied back to the lifecycle callback
    // that accepted it — NOT a single shared field. Two attempts to the
    // same endpoint each register their own PayloadCallback with Nearby;
    // without the [owner] identity check, a stream/transfer-update meant
    // for an abandoned attempt was indistinguishable from one for its
    // replacement.
    private fun makePayloadCallback(owner: ConnectionLifecycleCallback): PayloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            Log.d(TAG, "onPayloadReceived($endpointId, type=${payload.type})")
            if (payload.type != Payload.Type.STREAM) return
            if (currentAttemptCallback !== owner) {
                Log.w(TAG, "Ignoring stream payload from $endpointId (superseded attempt)")
                return
            }
            // Same late-arrival guard as onConnectionResult above: a stream
            // payload for an endpoint we've since disconnected/moved past
            // (state no longer Connected(endpointId)) must not start a
            // tunnel nobody is tracking.
            val connected = machine.state as? PeerState.Connected
            if (connected == null || connected.endpointId != endpointId) {
                Log.w(TAG, "Ignoring stream payload from $endpointId while state=${machine.state}")
                return
            }
            val output = outgoingOutput
            if (output == null) {
                Log.w(TAG, "onPayloadReceived($endpointId): no outgoing stream yet, dropping")
                return
            }
            val input = payload.asStream()!!.asInputStream()
            val tunnelClient = PeerTunnelClient(input, output)
            tunnel = tunnelClient
            tunnelClient.onLinkClosed = {
                // The real relay's reader thread can already have this
                // closure queued/in flight when a newer attempt replaces
                // the tunnel — clearing the `tunnel` field alone doesn't
                // recall an invocation already captured by that thread, so
                // check identity here too, not just when scheduling it.
                if (tunnel !== tunnelClient) {
                    Log.w(TAG, "Ignoring onLinkClosed for a superseded tunnel ($endpointId)")
                } else {
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
            }
            val localPort = tunnelClient.start()
            // reconnectAttempt resets naturally here: Active carries no
            // attempt count, so the NEXT drop's scheduleReconnect() reads
            // `current = 0` again — only now that the tunnel has actually
            // started, not just "Nearby connected" (see onConnectionResult).
            machine.transition(PeerEvent.TunnelActive(endpointId))
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
            if (currentAttemptCallback !== owner) {
                Log.w(TAG, "Ignoring onPayloadTransferUpdate($endpointId) from a superseded attempt")
                return
            }
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
