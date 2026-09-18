import android.content.Context
import android.os.Handler
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import com.parteytimeline.nearby.nearby.*
import com.tinder.StateMachine

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
    client.lifecycle.onConnectionResult(endpoint, ConnectionResolution(Status(true)))
    val field = peer.javaClass.getDeclaredField("payloadCallback").apply { isAccessible = true }
    (field.get(peer) as PayloadCallback).onPayloadReceived(endpoint, Payload())
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
