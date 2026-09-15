package com.parteytimeline.nearby.host

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.net.Inet4Address

/**
 * "If the host is on Wi-Fi, let clients join with a plain browser" (path b
 * from the plan) — no Nearby Connections involved at all, just the LAN IP
 * of whatever network this device happens to be on, since the embedded
 * Node server already binds all interfaces.
 */
object LanShareInfo {

    /**
     * This device's Wi-Fi LAN IPv4 address, or null if it isn't on Wi-Fi
     * (cellular-only — a normal state, not an error).
     *
     * Must come specifically from the Wi-Fi network, not just "any
     * non-loopback interface": a phone almost always has mobile data active
     * alongside Wi-Fi, and that interface's address is a carrier-NAT IP
     * (something like 10.x.x.x, easily mistaken for a real LAN address) —
     * showing it in the QR code/URL would point joiners at an address only
     * reachable from the carrier's own network, not the shared Wi-Fi. Ask
     * ConnectivityManager for the network that's actually Wi-Fi rather than
     * enumerating raw NetworkInterfaces and hoping the right one comes first.
     */
    fun currentLanIp(context: Context): String? {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.allNetworks
                .filter { network ->
                    cm.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
                }
                .flatMap { network -> cm.getLinkProperties(network)?.linkAddresses.orEmpty() }
                .map { it.address }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { !it.isLoopbackAddress }
                ?.hostAddress
        } catch (e: Exception) {
            null
        }
    }

    fun qrCodeBitmap(text: String, sizePx: Int = 512): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx)
        val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.RGB_565)
        for (x in 0 until sizePx) {
            for (y in 0 until sizePx) {
                bitmap.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        return bitmap
    }
}
