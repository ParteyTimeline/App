package android.os
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper:Looper) {
    data class Pending(val owner:Handler, val at:Long, val runnable:Runnable)
    fun postDelayed(runnable:Runnable, delay:Long): Boolean { pending.add(Pending(this, now + delay, runnable)); return true }
    fun removeCallbacksAndMessages(token:Any?) { pending.removeAll { it.owner === this } }
    companion object {
        var now = 0L
        val pending = mutableListOf<Pending>()
        fun reset() { pending.clear(); now = 0 }
        fun next(): Boolean {
            val next = pending.minByOrNull { it.at } ?: return false
            pending.remove(next); now = next.at; next.runnable.run(); return true
        }
    }
}
class ParcelFileDescriptor {
    companion object { fun createPipe() = arrayOf(ParcelFileDescriptor(), ParcelFileDescriptor()) }
    class AutoCloseOutputStream(pfd:ParcelFileDescriptor): java.io.ByteArrayOutputStream()
}
