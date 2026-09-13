package com.parteytimeline.nearby.tunnel

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Proves the exact mechanism the app relies on: a HostTunnelServer and a
 * PeerTunnelClient talking over one link (here: a real loopback TCP socket
 * pair, standing in for a Nearby Connections stream — the mux protocol has
 * no idea which it is) correctly relay several concurrent real TCP
 * connections to a real local "server" socket, including a payload larger
 * than a single internal buffer.
 *
 * Deliberately NOT java.io.PipedInputStream/PipedOutputStream here: those
 * are documented as supporting exactly one fixed reader thread and one
 * fixed writer thread for the pipe's lifetime. A mux link needs multiple
 * concurrent streams, each pumped by its own thread, sharing one writer —
 * exactly the unsupported pattern that made Piped streams flake here
 * ("Write end dead" / dropped tail bytes) despite the mux logic itself
 * being correct. A real socket pair has no such restriction.
 */
class TunnelIntegrationTest {

    private lateinit var fakeServer: EchoServer
    private lateinit var hostTunnel: HostTunnelServer
    private lateinit var peerTunnel: PeerTunnelClient
    private var peerLocalPort: Int = -1
    private lateinit var link: LoopbackLink

    @Before
    fun setUp() {
        fakeServer = EchoServer().apply { start() }
        link = LoopbackLink.connect()

        hostTunnel = HostTunnelServer(input = link.hostSide.getInputStream(), output = link.hostSide.getOutputStream(), targetPort = fakeServer.port)
        peerTunnel = PeerTunnelClient(input = link.peerSide.getInputStream(), output = link.peerSide.getOutputStream())

        hostTunnel.start()
        peerLocalPort = peerTunnel.start()
    }

    @After
    fun tearDown() {
        peerTunnel.stop()
        hostTunnel.stop()
        fakeServer.stop()
        link.close()
    }

    /** A connected pair of real loopback sockets — a full-duplex byte-stream link, same shape as a Nearby Connections stream. */
    private class LoopbackLink private constructor(val hostSide: Socket, val peerSide: Socket) {
        fun close() {
            try { hostSide.close() } catch (e: java.io.IOException) {}
            try { peerSide.close() } catch (e: java.io.IOException) {}
        }

        companion object {
            fun connect(): LoopbackLink {
                ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { acceptor ->
                    val peerSide = Socket(InetAddress.getByName("127.0.0.1"), acceptor.localPort)
                    val hostSide = acceptor.accept()
                    return LoopbackLink(hostSide, peerSide)
                }
            }
        }
    }

    @Test(timeout = 10_000)
    fun `single request round-trips through the tunnel`() {
        Socket(InetAddress.getByName("127.0.0.1"), peerLocalPort).use { socket ->
            val message = "hello through the tunnel".toByteArray()
            socket.getOutputStream().write(message)
            socket.getOutputStream().flush()
            socket.shutdownOutput()

            val echoed = socket.getInputStream().readBytes()
            assertArrayEquals(message, echoed)
        }
    }

    @Test(timeout = 10_000)
    fun `payload larger than one internal buffer reassembles correctly`() {
        Socket(InetAddress.getByName("127.0.0.1"), peerLocalPort).use { socket ->
            // Bigger than MuxRelay's 16 KiB pump buffer and MUX_MAX_FRAME_PAYLOAD,
            // so it must span several frames and still reassemble byte-for-byte.
            val message = ByteArray(200_000) { (it % 256).toByte() }
            socket.getOutputStream().write(message)
            socket.getOutputStream().flush()
            socket.shutdownOutput()

            val echoed = socket.getInputStream().readBytes()
            assertArrayEquals(message, echoed)
        }
    }

    @Test(timeout = 15_000)
    fun `several concurrent connections are relayed independently without cross-talk`() {
        val clientCount = 8
        val latch = CountDownLatch(clientCount)
        val failures = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()

        (0 until clientCount).map { i ->
            Thread {
                try {
                    Socket(InetAddress.getByName("127.0.0.1"), peerLocalPort).use { socket ->
                        val message = "client-$i-payload".toByteArray()
                        socket.getOutputStream().write(message)
                        socket.getOutputStream().flush()
                        socket.shutdownOutput()
                        val echoed = socket.getInputStream().readBytes()
                        assertArrayEquals(message, echoed)
                    }
                } catch (t: Throwable) {
                    failures.add(t)
                } finally {
                    latch.countDown()
                }
            }.apply { start() }
        }

        assertEquals(true, latch.await(10, TimeUnit.SECONDS))
        if (failures.isNotEmpty()) throw failures.first()
    }

    /** Stands in for the embedded Node server: echoes back whatever it receives on each connection. */
    private class EchoServer {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val running = AtomicBoolean(false)
        val port get() = server.localPort

        fun start() {
            running.set(true)
            Thread({
                while (running.get()) {
                    val socket = try {
                        server.accept()
                    } catch (e: java.io.IOException) {
                        break
                    }
                    Thread({
                        socket.use {
                            it.getInputStream().copyTo(it.getOutputStream())
                        }
                    }, "echo-conn").start()
                }
            }, "echo-accept").start()
        }

        fun stop() {
            running.set(false)
            try {
                server.close()
            } catch (e: java.io.IOException) {
                // already closed
            }
        }
    }
}
