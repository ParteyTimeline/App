package com.parteytimeline.nearby.tunnel
var tunnelLog: (String,String,Throwable?) -> Unit = { _,_,_ -> }
object MuxFrameType { const val PING = 1 }
class MuxWriter(out:java.io.OutputStream) { fun writeFrame(id:Int, type:Int, data:ByteArray) {} }
class PeerTunnelClient(input:java.io.InputStream, output:java.io.OutputStream) {
    var onLinkClosed:(()->Unit)? = null
    val hasReceivedAnyFrame = true
    fun start() = 4321
    fun stop() {}
}
