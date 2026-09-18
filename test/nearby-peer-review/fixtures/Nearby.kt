package com.google.android.gms.nearby
import android.content.Context
import com.google.android.gms.nearby.connection.ConnectionsClient
object Nearby {
    var client = ConnectionsClient()
    fun getConnectionsClient(context:Context) = client
}
