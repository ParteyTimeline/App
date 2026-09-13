package com.parteytimeline.nearby.tunnel

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Host side of the tunnel: for every OPEN frame from a peer, connects to the
 * real local server (127.0.0.1:targetPort — the embedded Node server) and
 * relays bytes. One instance per connected peer (each peer gets its own
 * Nearby Connections link, wired up by NearbyHost).
 */
class HostTunnelServer(input: InputStream, output: OutputStream, private val targetPort: Int) {
    private val relay = MuxRelay(input, output, onRemoteOpen = { _ ->
        try {
            Socket().apply { connect(InetSocketAddress("127.0.0.1", targetPort), 5000) }
        } catch (e: IOException) {
            null
        }
    })

    var onLinkClosed: (() -> Unit)?
        get() = relay.onLinkClosed
        set(value) { relay.onLinkClosed = value }

    fun start() = relay.start()
    fun stop() = relay.shutdown()
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

    var onLinkClosed: (() -> Unit)?
        get() = relay.onLinkClosed
        set(value) { relay.onLinkClosed = value }

    /** Starts relaying and the local accept loop. Returns the bound local port. */
    fun start(): Int {
        relay.start()
        val server = ServerSocket(requestedLocalPort, 50, InetAddress.getByName("127.0.0.1"))
        serverSocket = server
        running = true
        Thread({
            while (running) {
                val socket = try {
                    server.accept()
                } catch (e: IOException) {
                    break
                }
                relay.openStream(socket)
            }
        }, "peer-tunnel-accept").start()
        return server.localPort
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (e: IOException) {
            // already closed
        }
        relay.shutdown()
    }
}
