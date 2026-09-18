package android.util
object Log {
    fun d(tag:String, message:String) = 0
    fun w(tag:String, message:String) = 0
    fun w(tag:String, message:String, error:Throwable) = 0
    fun e(tag:String, message:String, error:Throwable) = 0
}
