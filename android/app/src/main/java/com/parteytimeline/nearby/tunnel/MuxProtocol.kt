package com.parteytimeline.nearby.tunnel

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal byte-stream multiplexer for tunnelling arbitrary TCP traffic
 * (many short-lived HTTP requests plus one long-lived WebSocket connection)
 * over a single reliable, ordered connection — a Nearby Connections link in
 * production, a plain pair of pipes/sockets in tests. Deliberately dumb: no
 * HTTP/WS parsing, just [streamId, type, payload] frames mirrored 1:1 to/from
 * real java.net.Socket instances. Pure JVM — no Android imports — so it can
 * be exercised with plain JUnit tests, independent of Nearby Connections
 * itself (see src/test/.../MuxProtocolTest.kt and TunnelIntegrationTest.kt).
 */
object MuxFrameType {
    const val OPEN: Byte = 1
    const val DATA: Byte = 2
    const val CLOSE: Byte = 3

    // Half-close: "no more DATA is coming from me for this stream", mirroring
    // one direction of a local socket reaching read-EOF (e.g. a client that
    // wrote its request and called shutdownOutput() while still waiting to
    // read the response) onto the corresponding socket on the other side —
    // via that socket's own shutdownOutput(), not a full close(). Without
    // this, a stream that reaches EOF in only one direction would get torn
    // down entirely and the still-pending response would never arrive.
    const val EOF: Byte = 4
}

data class MuxFrame(val streamId: Int, val type: Byte, val payload: ByteArray)

private const val HEADER_SIZE = 9 // 4 (streamId) + 1 (type) + 4 (payload length)
const val MUX_MAX_FRAME_PAYLOAD = 64 * 1024

class MuxWriter(private val out: OutputStream) {
    private val lock = Any()

    fun writeFrame(streamId: Int, type: Byte, payload: ByteArray, offset: Int = 0, length: Int = payload.size) {
        synchronized(lock) {
            val header = ByteBuffer.allocate(HEADER_SIZE)
            header.putInt(streamId)
            header.put(type)
            header.putInt(length)
            out.write(header.array())
            if (length > 0) out.write(payload, offset, length)
            out.flush()
        }
    }
}

class MuxReader(private val input: InputStream) {
    private val headerBuf = ByteArray(HEADER_SIZE)

    /** Blocks until a full frame is available; returns null on clean EOF between frames. */
    fun readFrame(): MuxFrame? {
        if (!readFully(headerBuf, allowEofAtStart = true)) return null
        val bb = ByteBuffer.wrap(headerBuf)
        val streamId = bb.int
        val type = bb.get()
        val length = bb.int
        if (length < 0 || length > MUX_MAX_FRAME_PAYLOAD) {
            throw IOException("Ungültige Mux-Frame-Länge: $length")
        }
        val payload = if (length == 0) ByteArray(0) else ByteArray(length)
        if (length > 0) readFully(payload, allowEofAtStart = false)
        return MuxFrame(streamId, type, payload)
    }

    private fun readFully(buf: ByteArray, allowEofAtStart: Boolean): Boolean {
        var offset = 0
        while (offset < buf.size) {
            val n = input.read(buf, offset, buf.size - offset)
            if (n == -1) {
                if (offset == 0 && allowEofAtStart) return false
                throw EOFException("Verbindung während eines Frames unterbrochen")
            }
            offset += n
        }
        return true
    }
}

/**
 * Runs the frame read-loop and dispatches to real sockets. Host and peer
 * share this class; they differ only in [onRemoteOpen] (host connects a
 * fresh OPEN request to its local server; peer never receives OPEN, since
 * it's the one holding the real server, not the peer).
 */
class MuxRelay(
    input: InputStream,
    output: OutputStream,
    private val onRemoteOpen: ((streamId: Int) -> Socket?)? = null,
) {
    private class StreamState(val socket: Socket) {
        @Volatile var localEofSent = false
        @Volatile var remoteEofReceived = false
    }

    private val writer = MuxWriter(output)
    private val reader = MuxReader(input)
    private val sockets = ConcurrentHashMap<Int, StreamState>()
    private val nextStreamId = AtomicInteger(1)

    @Volatile
    var onLinkClosed: (() -> Unit)? = null

    fun start() {
        Thread({
            try {
                while (true) {
                    val frame = reader.readFrame() ?: break
                    handleFrame(frame)
                }
            } catch (e: IOException) {
                // link dropped — fall through to cleanup
            } finally {
                shutdown()
                onLinkClosed?.invoke()
            }
        }, "mux-reader").start()
    }

    private fun handleFrame(frame: MuxFrame) {
        when (frame.type) {
            MuxFrameType.OPEN -> {
                val socket = onRemoteOpen?.invoke(frame.streamId)
                if (socket == null) {
                    safeWrite(frame.streamId, MuxFrameType.CLOSE, ByteArray(0))
                    return
                }
                sockets[frame.streamId] = StreamState(socket)
                pumpSocketToMux(frame.streamId, socket)
            }
            MuxFrameType.DATA -> {
                val state = sockets[frame.streamId] ?: return
                try {
                    state.socket.getOutputStream().write(frame.payload)
                    state.socket.getOutputStream().flush()
                } catch (e: IOException) {
                    closeStream(frame.streamId, notifyRemote = true)
                }
            }
            MuxFrameType.EOF -> {
                val state = sockets[frame.streamId] ?: return
                state.remoteEofReceived = true
                try {
                    state.socket.shutdownOutput()
                } catch (e: IOException) {
                    // already shut down / closed
                }
                closeIfFullyDrained(frame.streamId, state)
            }
            MuxFrameType.CLOSE -> closeStream(frame.streamId, notifyRemote = false)
        }
    }

    /** Peer side: registers a new local socket as a fresh outbound stream and tells the host to open it. */
    fun openStream(socket: Socket): Int {
        val id = nextStreamId.getAndIncrement()
        sockets[id] = StreamState(socket)
        writer.writeFrame(id, MuxFrameType.OPEN, ByteArray(0))
        pumpSocketToMux(id, socket)
        return id
    }

    private fun pumpSocketToMux(streamId: Int, socket: Socket) {
        Thread({
            try {
                val buf = ByteArray(16 * 1024)
                val input = socket.getInputStream()
                while (true) {
                    val n = input.read(buf)
                    if (n == -1) break
                    writer.writeFrame(streamId, MuxFrameType.DATA, buf, 0, n)
                }
                val state = sockets[streamId] ?: return@Thread
                state.localEofSent = true
                safeWrite(streamId, MuxFrameType.EOF, ByteArray(0))
                closeIfFullyDrained(streamId, state)
            } catch (e: IOException) {
                closeStream(streamId, notifyRemote = true)
            }
        }, "mux-socket-$streamId").start()
    }

    private fun safeWrite(streamId: Int, type: Byte, payload: ByteArray) {
        try {
            writer.writeFrame(streamId, type, payload)
        } catch (e: IOException) {
            // link already dead; nothing more to do
        }
    }

    /**
     * Once both directions of a stream have hit EOF, the socket has nothing
     * left to say — close it for real. This can be called concurrently from
     * two different threads (the local pump thread and the mux-reader
     * thread), so the removal itself must be the single point of truth for
     * "did I win the race to close this" — only the thread that actually
     * removes the entry proceeds to close it.
     */
    private fun closeIfFullyDrained(streamId: Int, state: StreamState) {
        if (!state.localEofSent || !state.remoteEofReceived) return
        val removed = sockets.remove(streamId) ?: return
        try {
            removed.socket.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    private fun closeStream(streamId: Int, notifyRemote: Boolean) {
        val state = sockets.remove(streamId) ?: return
        try {
            state.socket.close()
        } catch (e: IOException) {
            // already closed
        }
        if (notifyRemote) safeWrite(streamId, MuxFrameType.CLOSE, ByteArray(0))
    }

    fun shutdown() {
        try {
            // A concurrent stream completing/closing on its own can empty the
            // map mid-snapshot; ConcurrentHashMap's iterator is weakly
            // consistent but this is best-effort cleanup, not a correctness
            // path, so just treat "nothing left to clean up" as success.
            sockets.keys.toList().forEach { closeStream(it, notifyRemote = false) }
        } catch (e: NoSuchElementException) {
            // already drained by a concurrent close
        }
    }
}
