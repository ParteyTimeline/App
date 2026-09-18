import android.content.Context
import android.os.Handler
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import com.parteytimeline.nearby.nearby.*
import com.tinder.StateMachine
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

// Compile the unmodified production NearbyPeer with deterministic Android/Nearby
// stand-ins and the real Tinder StateMachine 0.3.0 implementation. These tests
// model callback ordering, not radio behavior. No Android SDK/device is needed.
private fun fixture(): Pair<NearbyPeer, ConnectionsClient> {
    Handler.reset()
    val client = ConnectionsClient()
    Nearby.client = client
    val peer = NearbyPeer(Context(), "review")
    peer.startDiscovery()
    client.discovery.onEndpointFound("host", DiscoveredEndpointInfo(NEARBY_SERVICE_ID, "Host"))
    return peer to client
}

@Suppress("UNCHECKED_CAST")
private fun state(peer: NearbyPeer): PeerState {
    val field = peer.javaClass.getDeclaredField("machine").apply { isAccessible = true }
    return (field.get(peer) as StateMachine<PeerState, PeerEvent, Unit>).state
}

private fun activate(peer: NearbyPeer, client: ConnectionsClient, endpoint: String = "host") {
    peer.connectTo(endpoint)
    client.lifecycle.onConnectionInitiated(endpoint, ConnectionInfo())
    client.lifecycle.onConnectionResult(endpoint, ConnectionResolution(Status(true)))
    client.acceptedPayloads.last().second.onPayloadReceived(endpoint, Payload())
    check(state(peer) is PeerState.Active) { "fixture must establish a tunnel" }
}

private fun exhausted(mode: String, absent: Boolean = false) {
    val (peer, client) = fixture()
    try {
        activate(peer, client)
        val attempts = mutableListOf<Int>()
        var gaveUp = 0
        peer.onReconnecting = { attempts.add(it) }
        peer.onReconnectGaveUp = { gaveUp++ }
        if (absent) client.discovery.onEndpointLost("host")
        client.requestMode = mode
        client.lifecycle.onDisconnected("host")
        var steps = 0
        while (gaveUp == 0 && steps++ < 150 && Handler.next()) { }
        check(attempts == (1..20).toList()) { "expected bounded attempts 1..20, got $attempts" }
        check(gaveUp == 1) { "expected one terminal notification, got $gaveUp" }
        check(state(peer) == PeerState.GaveUp) { "notification fired but state remained ${state(peer)}" }
        val before = client.requestCount
        client.requestMode = "pending"
        peer.connectTo("other")
        check(client.requestCount == before + 1) { "manual retry rejected after exhaustion" }
    } finally { peer.disconnect() }
}

private fun staleFailure(requestTask: Boolean) {
    val (peer, client) = fixture()
    try {
        peer.connectTo("old")
        val oldCallback = client.callbacks.last()
        val oldTask = client.requests.last()
        peer.disconnect()
        peer.connectTo("new")
        var failures = 0
        peer.onConnectionFailed = { failures++ }
        if (requestTask) oldTask.fail()
        else oldCallback.onConnectionResult("old", ConnectionResolution(Status(false)))
        val current = state(peer)
        check(current is PeerState.Connecting && current.endpointId == "new" && failures == 0) {
            "stale failure changed new attempt: state=$current, failure callbacks=$failures"
        }
    } finally { peer.disconnect() }
}

private fun staleDisconnect() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("old")
        peer.disconnect() // the fake SDK queues its onDisconnected callback
        activate(peer, client, "new")
        check(Handler.next()) // deliver old endpoint's queued cancellation
        val current = state(peer)
        check(current is PeerState.Active && current.endpointId == "new") {
            "old disconnect tore down new active connection: $current"
        }
    } finally { peer.disconnect() }
}

private fun sameEndpointLateSuccess() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("host")
        val oldCallback = client.callbacks.last()
        peer.disconnect()
        peer.connectTo("host")
        val before = client.sent
        oldCallback.onConnectionResult("host", ConnectionResolution(Status(true)))
        check(client.sent == before && state(peer) is PeerState.Connecting) {
            "old attempt success opened a stream for the replacement attempt: ${state(peer)}"
        }
    } finally { peer.disconnect() }
}

private fun duplicateTap() {
    val (peer, client) = fixture()
    try {
        activate(peer, client)
        peer.connectTo("other")
        peer.connectTo("other")
        check(client.requestCount == 1) { "tap on active connection issued extra request" }
    } finally { peer.disconnect() }
}

private fun cancelledSuccess() {
    val (peer, client) = fixture()
    peer.connectTo("host")
    peer.disconnect()
    client.lifecycle.onConnectionResult("host", ConnectionResolution(Status(true)))
    check(client.sent == 0 && state(peer) == PeerState.Idle) { "cancelled success started stream" }
    check(client.disconnected.contains("host")) { "stale endpoint was not disconnected" }
}

private fun staleSuccessCannotDisconnectReplacement() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("host")
        val oldCallback = client.callbacks.last()
        peer.disconnect()
        activate(peer, client, "host")
        val before = client.disconnected.size
        oldCallback.onConnectionResult("host", ConnectionResolution(Status(true)))
        check(client.disconnected.size == before) {
            "stale success issued endpoint-wide disconnect against the replacement connection"
        }
        check(state(peer) is PeerState.Active) { "replacement must remain active" }
    } finally { peer.disconnect() }
}

private fun staleInitiation() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("host")
        val oldCallback = client.callbacks.last()
        peer.disconnect()
        peer.connectTo("host")
        val before = client.acceptedPayloads.size
        oldCallback.onConnectionInitiated("host", ConnectionInfo())
        check(client.acceptedPayloads.size == before) {
            "cancelled attempt still accepts a connection and registers its payload callback"
        }
    } finally { peer.disconnect() }
}

private fun staleStream() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("host")
        client.lifecycle.onConnectionInitiated("host", ConnectionInfo())
        val oldPayload = client.acceptedPayloads.last().second
        client.lifecycle.onConnectionResult("host", ConnectionResolution(Status(true)))
        peer.disconnect()
        peer.connectTo("host")
        client.lifecycle.onConnectionInitiated("host", ConnectionInfo())
        client.lifecycle.onConnectionResult("host", ConnectionResolution(Status(true)))
        var ready = 0
        peer.onTunnelReady = { ready++ }
        oldPayload.onPayloadReceived("host", Payload())
        check(state(peer) is PeerState.Connected && ready == 0) {
            "cancelled stream activated replacement tunnel: state=${state(peer)}, ready=$ready"
        }
        client.acceptedPayloads.last().second.onPayloadReceived("host", Payload())
        check(state(peer) is PeerState.Active && ready == 1) { "current stream must still activate tunnel" }
    } finally { peer.disconnect() }
}

private fun staleTransferFailure() {
    val (peer, client) = fixture()
    try {
        activate(peer, client)
        val oldPayload = client.acceptedPayloads.last().second
        peer.disconnect()
        activate(peer, client)
        val before = client.disconnected.size
        oldPayload.onPayloadTransferUpdate("host", PayloadTransferUpdate(PayloadTransferUpdate.Status.FAILURE))
        check(client.disconnected.size == before) {
            "old transfer failure disconnected the replacement endpoint"
        }
    } finally { peer.disconnect() }
}

private fun staleTunnelClose() {
    val (peer, client) = fixture()
    try {
        activate(peer, client)
        val field = peer.javaClass.getDeclaredField("tunnel").apply { isAccessible = true }
        val oldTunnel = field.get(peer) as com.parteytimeline.nearby.tunnel.PeerTunnelClient
        // Model a reader-thread callback that was already queued/in flight
        // when the old tunnel was stopped; clearing the stored hook alone
        // cannot recall this captured callback.
        val pendingClose = checkNotNull(oldTunnel.onLinkClosed)
        peer.disconnect()
        activate(peer, client)
        val before = client.disconnected.size
        var notifications = 0
        peer.onDisconnected = { notifications++ }
        pendingClose()
        check(client.disconnected.size == before && notifications == 0) {
            "old tunnel close affected new connection: disconnects=${client.disconnected.size - before}, notifications=$notifications"
        }
    } finally { peer.disconnect() }
}

private fun payloadFailureDuringBackoff() {
    val (peer, client) = fixture()
    try {
        activate(peer, client)
        val abandonedPayload = client.acceptedPayloads.last().second
        val retries = mutableListOf<Int>()
        peer.onReconnecting = { retries.add(it) }
        client.lifecycle.onDisconnected("host")
        check(state(peer) == PeerState.Reconnecting(1))
        val before = client.disconnected.size
        // A transfer failure belonging to the link that just disconnected
        // can arrive before the delayed replacement request is issued.
        abandonedPayload.onPayloadTransferUpdate("host", PayloadTransferUpdate(PayloadTransferUpdate.Status.FAILURE))
        check(client.disconnected.size == before) {
            "completed attempt's payload failure issued another disconnect during backoff"
        }
        check(retries == listOf(1)) { "one lost connection must schedule exactly one retry" }
    } finally { peer.disconnect() }
}

private fun initiationAfterRequestFailure() {
    val (peer, client) = fixture()
    try {
        peer.connectTo("host")
        val abandoned = client.callbacks.last()
        client.requests.last().fail()
        check(state(peer) == PeerState.Idle)
        val before = client.acceptedPayloads.size
        abandoned.onConnectionInitiated("host", ConnectionInfo())
        check(client.acceptedPayloads.size == before) {
            "failed attempt still accepts a connection while peer is Idle"
        }
    } finally { peer.disconnect() }
}

private fun tunnelCloseRacingReplacement() {
    val (peer, client) = fixture()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val error = AtomicReference<Throwable?>()
    var reader: Thread? = null
    try {
        activate(peer, client)
        val field = peer.javaClass.getDeclaredField("tunnel").apply { isAccessible = true }
        val oldTunnel = field.get(peer) as com.parteytimeline.nearby.tunnel.PeerTunnelClient
        val close = checkNotNull(oldTunnel.onLinkClosed)
        // The production mux-reader invokes this hook on its own thread.
        // Pause after the identity guard has passed but before the endpoint
        // disconnect. Latches select a valid ordering without timing sleeps.
        peer.onDisconnected = {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "test did not release reader callback" }
        }
        reader = Thread({
            try { close() } catch (t: Throwable) { error.set(t) }
        }, "review-mux-reader").also { it.start() }
        check(entered.await(5, TimeUnit.SECONDS)) { "reader callback did not reach notification" }
        peer.onDisconnected = null
        peer.disconnect()
        activate(peer, client)
        val before = client.disconnected.size
        release.countDown()
        reader.join(5000)
        check(!reader.isAlive) { "reader callback did not finish" }
        error.get()?.let { throw it }
        check(client.disconnected.size == before) {
            "in-flight old tunnel callback disconnected the replacement after passing its identity guard"
        }
        check(state(peer) is PeerState.Active) { "replacement must remain active" }
    } finally {
        release.countDown()
        reader?.join(5000)
        peer.onDisconnected = null
        peer.disconnect()
    }
}

private fun tunnelCloseRacingAfterFinalCheck() {
    val (peer, client) = fixture()
    val atSdkBoundary = CountDownLatch(1)
    val releaseSdk = CountDownLatch(1)
    val replacementStarted = CountDownLatch(1)
    val replacementDone = CountDownLatch(1)
    val error = AtomicReference<Throwable?>()
    val hitReplacement = java.util.concurrent.atomic.AtomicBoolean(false)
    var reader: Thread? = null
    var replacement: Thread? = null
    try {
        activate(peer, client)
        val oldAttempt = client.lifecycle
        val field = peer.javaClass.getDeclaredField("tunnel").apply { isAccessible = true }
        val oldTunnel = field.get(peer) as com.parteytimeline.nearby.tunnel.PeerTunnelClient
        val close = checkNotNull(oldTunnel.onLinkClosed)
        client.beforeDisconnect = {
            if (Thread.currentThread() === reader) {
                // Both production identity checks have already passed. A
                // real thread may be preempted at this SDK-call boundary.
                atSdkBoundary.countDown()
                check(releaseSdk.await(5, TimeUnit.SECONDS)) { "SDK boundary was not released" }
                hitReplacement.set(client.lifecycle !== oldAttempt)
            }
        }
        reader = Thread({
            try { close() } catch (t: Throwable) { error.set(t) }
        }, "review-close-at-sdk-boundary")
        reader.start()
        check(atSdkBoundary.await(5, TimeUnit.SECONDS)) { "close did not reach SDK boundary" }
        replacement = Thread({
            try {
                replacementStarted.countDown()
                peer.disconnect()
                activate(peer, client)
            } catch (t: Throwable) { error.set(t) }
            finally { replacementDone.countDown() }
        }, "review-replacement-controller").also { it.start() }
        check(replacementStarted.await(5, TimeUnit.SECONDS)) { "replacement thread did not start" }
        // A correct critical section may block replacement until the old
        // SDK operation finishes. Allow that ordering too: release the old
        // call after a bounded window, then join both before asserting.
        replacementDone.await(2, TimeUnit.SECONDS)
        releaseSdk.countDown()
        reader.join(5000)
        replacement.join(5000)
        check(!reader.isAlive && !replacement.isAlive) { "callback/replacement did not finish" }
        error.get()?.let { throw it }
        check(!hitReplacement.get()) {
            "old close reached endpoint-wide disconnect after a replacement took ownership, despite the second identity check"
        }
        check(state(peer) is PeerState.Active) { "replacement must remain active" }
    } finally {
        releaseSdk.countDown()
        reader?.join(5000)
        replacement?.join(5000)
        client.beforeDisconnect = null
        peer.disconnect()
    }
}

fun main() {
    val cases = listOf<Pair<String, () -> Unit>>(
        "retry exhaustion after request failures becomes terminal" to { exhausted("fail") },
        "retry exhaustion after handshake stalls becomes terminal" to { exhausted("success") },
        "host absent still exhausts and permits manual retry" to { exhausted("pending", true) },
        "stale result failure cannot invalidate new endpoint" to { staleFailure(false) },
        "stale request-task failure cannot invalidate new endpoint" to { staleFailure(true) },
        "old endpoint disconnect cannot tear down new tunnel" to ::staleDisconnect,
        "cancelled same-endpoint attempt cannot claim replacement success" to ::sameEndpointLateSuccess,
        "duplicate tap on active peer issues no request" to ::duplicateTap,
        "success after cancellation while idle is rejected" to ::cancelledSuccess,
        "stale success does not disconnect a replacement to the same host" to ::staleSuccessCannotDisconnectReplacement,
        "stale initiation does not accept an abandoned attempt" to ::staleInitiation,
        "stale incoming stream cannot activate a replacement attempt" to ::staleStream,
        "stale payload failure cannot disconnect a replacement attempt" to ::staleTransferFailure,
        "stale tunnel close cannot disconnect a replacement attempt" to ::staleTunnelClose,
        "payload failure from disconnected attempt is ignored during backoff" to ::payloadFailureDuringBackoff,
        "failed request cannot accept a later initiation while idle" to ::initiationAfterRequestFailure,
        "in-flight tunnel close cannot disconnect a replacement after its identity check" to ::tunnelCloseRacingReplacement,
        "tunnel ownership cannot change between final check and SDK disconnect" to ::tunnelCloseRacingAfterFinalCheck,
    )
    var failed = 0
    for ((name, run) in cases) {
        try { run(); println("PASS: $name") }
        catch (e: Throwable) { failed++; println("FAIL: $name -- ${e.message}") }
        finally { Handler.reset() }
    }
    println("${cases.size - failed} passed; $failed failed")
    check(failed == 0) { "$failed NearbyPeer regression tests failed" }
}
