package com.google.android.gms.nearby.connection
class Task(val failed:Boolean = false) {
    private var failureListener:((Exception)->Unit)? = null
    fun addOnFailureListener(listener:(Exception)->Unit):Task { failureListener=listener; if(failed) fail(); return this }
    fun fail() { failureListener?.invoke(Exception("simulated request failure")) }
}
class Strategy { companion object { val P2P_STAR = Strategy() } }
class DiscoveryOptions { class Builder { fun setStrategy(s:Strategy)=this; fun build()=DiscoveryOptions() } }
class ConnectionType { companion object { val NON_DISRUPTIVE=ConnectionType() } }
class ConnectionOptions { class Builder { fun setConnectionType(t:ConnectionType)=this; fun build()=ConnectionOptions() } }
class ConnectionInfo
class Status(val isSuccess:Boolean) { val statusCode = if(isSuccess) 0 else 1 }
class ConnectionResolution(val status:Status)
class DiscoveredEndpointInfo(val serviceId:String, val endpointName:String)
abstract class ConnectionLifecycleCallback {
    abstract fun onConnectionInitiated(endpointId:String, info:ConnectionInfo)
    abstract fun onConnectionResult(endpointId:String, resolution:ConnectionResolution)
    abstract fun onDisconnected(endpointId:String)
}
abstract class EndpointDiscoveryCallback {
    abstract fun onEndpointFound(endpointId:String, info:DiscoveredEndpointInfo)
    abstract fun onEndpointLost(endpointId:String)
}
class Payload {
    val type = Type.STREAM
    object Type { const val STREAM = 1 }
    class Stream { fun asInputStream() = java.io.ByteArrayInputStream(byteArrayOf()) }
    fun asStream():Stream? = Stream()
    companion object { fun fromStream(pfd:android.os.ParcelFileDescriptor) = Payload() }
}
class PayloadTransferUpdate(val status:Int=0, val bytesTransferred:Long=0, val totalBytes:Long=0) {
    object Status { const val FAILURE=1 }
}
abstract class PayloadCallback {
    abstract fun onPayloadReceived(endpointId:String, payload:Payload)
    abstract fun onPayloadTransferUpdate(endpointId:String, update:PayloadTransferUpdate)
}
class ConnectionsClient {
    lateinit var lifecycle:ConnectionLifecycleCallback
    lateinit var discovery:EndpointDiscoveryCallback
    var requestMode = "pending"
    var requestCount = 0
    var sent = 0
    val callbacks = mutableListOf<ConnectionLifecycleCallback>()
    val requests = mutableListOf<Task>()
    val disconnected = mutableListOf<String>()
    fun startDiscovery(id:String, callback:EndpointDiscoveryCallback, options:DiscoveryOptions):Task { discovery=callback; return Task() }
    fun stopDiscovery() {}
    fun requestConnection(name:String, endpointId:String, callback:ConnectionLifecycleCallback, options:ConnectionOptions):Task {
        lifecycle=callback; requestCount++; callbacks.add(callback)
        if(requestMode == "success") callback.onConnectionResult(endpointId, ConnectionResolution(Status(true)))
        return Task(requestMode == "fail").also { requests.add(it) }
    }
    fun acceptConnection(endpointId:String, callback:PayloadCallback) {}
    fun sendPayload(endpointId:String, payload:Payload) { sent++ }
    fun disconnectFromEndpoint(endpointId:String) {
        disconnected.add(endpointId)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(Runnable { lifecycle.onDisconnected(endpointId) }, 0)
    }
}
