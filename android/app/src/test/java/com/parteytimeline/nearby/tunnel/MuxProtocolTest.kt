package com.parteytimeline.nearby.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException

class MuxProtocolTest {

    @Test
    fun `round-trips a single frame`() {
        val buf = ByteArrayOutputStream()
        MuxWriter(buf).writeFrame(streamId = 7, type = MuxFrameType.DATA, payload = "hello".toByteArray())

        val frame = MuxReader(ByteArrayInputStream(buf.toByteArray())).readFrame()

        assertEquals(7, frame?.streamId)
        assertEquals(MuxFrameType.DATA, frame?.type)
        assertArrayEquals("hello".toByteArray(), frame?.payload)
    }

    @Test
    fun `round-trips a zero-length frame`() {
        val buf = ByteArrayOutputStream()
        MuxWriter(buf).writeFrame(streamId = 3, type = MuxFrameType.CLOSE, payload = ByteArray(0))

        val frame = MuxReader(ByteArrayInputStream(buf.toByteArray())).readFrame()

        assertEquals(3, frame?.streamId)
        assertEquals(MuxFrameType.CLOSE, frame?.type)
        assertEquals(0, frame?.payload?.size)
    }

    @Test
    fun `reads several frames for different streams in order`() {
        val buf = ByteArrayOutputStream()
        val writer = MuxWriter(buf)
        writer.writeFrame(1, MuxFrameType.OPEN, ByteArray(0))
        writer.writeFrame(2, MuxFrameType.OPEN, ByteArray(0))
        writer.writeFrame(1, MuxFrameType.DATA, "a".toByteArray())
        writer.writeFrame(2, MuxFrameType.DATA, "b".toByteArray())
        writer.writeFrame(1, MuxFrameType.CLOSE, ByteArray(0))

        val reader = MuxReader(ByteArrayInputStream(buf.toByteArray()))
        val frames = generateSequence { reader.readFrame() }.toList()

        assertEquals(5, frames.size)
        assertEquals(listOf(1, 2, 1, 2, 1), frames.map { it.streamId })
        assertEquals(listOf("a", "b"), frames.filter { it.type == MuxFrameType.DATA }.map { String(it.payload) })
    }

    @Test
    fun `clean EOF between frames returns null`() {
        val reader = MuxReader(ByteArrayInputStream(ByteArray(0)))
        assertNull(reader.readFrame())
    }

    @Test
    fun `truncated frame mid-header throws EOFException`() {
        // 4 bytes of a 9-byte header, then the stream just ends.
        val reader = MuxReader(ByteArrayInputStream(byteArrayOf(0, 0, 0, 1)))
        assertThrows(EOFException::class.java) { reader.readFrame() }
    }

    @Test
    fun `truncated frame mid-payload throws EOFException`() {
        val buf = ByteArrayOutputStream()
        MuxWriter(buf).writeFrame(1, MuxFrameType.DATA, "hello world".toByteArray())
        val fullBytes = buf.toByteArray()
        // Cut off the last few payload bytes — header claims more than is actually there.
        val truncated = fullBytes.copyOfRange(0, fullBytes.size - 3)

        val reader = MuxReader(ByteArrayInputStream(truncated))
        assertThrows(EOFException::class.java) { reader.readFrame() }
    }

    @Test
    fun `oversized declared length is rejected`() {
        val header = java.nio.ByteBuffer.allocate(9)
            .putInt(1)
            .put(MuxFrameType.DATA)
            .putInt(MUX_MAX_FRAME_PAYLOAD + 1)
            .array()
        val reader = MuxReader(ByteArrayInputStream(header))
        assertThrows(IOException::class.java) { reader.readFrame() }
    }

    @Test
    fun `handles a frame right at the max payload boundary`() {
        val buf = ByteArrayOutputStream()
        val payload = ByteArray(MUX_MAX_FRAME_PAYLOAD) { (it % 251).toByte() }
        MuxWriter(buf).writeFrame(1, MuxFrameType.DATA, payload)

        val frame = MuxReader(ByteArrayInputStream(buf.toByteArray())).readFrame()

        assertArrayEquals(payload, frame?.payload)
    }
}
