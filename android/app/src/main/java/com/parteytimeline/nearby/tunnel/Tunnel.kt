package com.parteytimeline.nearby.tunnel

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

private const val TAG = "PT-Tunnel"

/**
 * Host side of the tunnel: for every OPEN frame from a peer, connects to the
 * real local server (127.0.0.1:targetPort — the embedded Node server) and
 * relays bytes. One instance per connected peer (each peer gets its own
 * Nearby Connections link, wired up by NearbyHost).
 */
class HostTunnelServer(input: InputStream, output: OutputStream, private val targetPort: Int) {
    private val relay = MuxRelay(input, output, onRemoteOpen = { streamId ->
        try {
            Socket().apply { connect(InetSocketAddress("127.0.0.1", targetPort), 5000) }
        } catch (e: IOException) {
            tunnelLog(TAG, "HostTunnelServer failed to connect to local server on 127.0.0.1:$targetPort for stream $streamId", e)
            null
        }
    })

    var onLinkClosed: (() -> Unit)?
        get() = relay.onLinkClosed
        set(value) { relay.onLinkClosed = value }

    val hasReceivedAnyFrame: Boolean get() = relay.hasReceivedAnyFrame

    fun start() {
        tunnelLog(TAG, "HostTunnelServer starting, targetPort=$targetPort", null)
        relay.start()
    }
    fun stop() {
        tunnelLog(TAG, "HostTunnelServer stopping", null)
        relay.shutdown()
    }
}

/**
 * Peer side of the tunnel: runs a local loopback server that the WebView
 * points at; every accepted local connection becomes one logical stream
 * tunnelled to the host, which forwards it to the real server.
 */
class PeerTunnelClient(input: InputStream, output: OutputStream, private val requestedLocalPort: Int = 0) {
    private val relay = MuxRelay(input, output, onRemoteOpen = null)
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var running = false

    val hasReceivedAnyFrame: Boolean get() = relay.hasReceivedAnyFrame

    var onLinkClosed: (() -> Unit)?
        get() = relay.onLinkClosed
        set(value) { relay.onLinkClosed = value }

    /** Starts relaying and the local accept loop. Returns the bound local port. */
    fun start(): Int {
        relay.start()
        val server = ServerSocket(requestedLocalPort, 50, InetAddress.getByName("127.0.0.1"))
        serverSocket = server
        running = true
        tunnelLog(TAG, "PeerTunnelClient started, local port=${server.localPort}", null)
        Thread({
            while (running) {
                val socket = try {
                    server.accept()
                } catch (e: IOException) {
                    tunnelLog(TAG, "PeerTunnelClient accept loop ending: ${e.message}", null)
                    break
                }
                tunnelLog(TAG, "PeerTunnelClient accepted local connection, opening mux stream", null)
                // openStream() writes an OPEN frame immediately, which can
                // throw if the underlying link has already died (e.g. a
                // WebView request racing a tunnel teardown) — must not let
                // that escape onto this accept thread as an uncaught
                // exception, which would take the whole app down.
                try {
                    relay.openStream(socket)
                } catch (e: IOException) {
                    tunnelLog(TAG, "PeerTunnelClient failed to open mux stream, closing local socket", e)
                    runCatching { socket.close() }
                }
            }
        }, "peer-tunnel-accept").start()
        return server.localPort
    }

    fun stop() {
        tunnelLog(TAG, "PeerTunnelClient stopping", null)
        running = false
        try {
            serverSocket?.close()
        } catch (e: IOException) {
            // already closed
        }
        relay.shutdown()
    }
}
