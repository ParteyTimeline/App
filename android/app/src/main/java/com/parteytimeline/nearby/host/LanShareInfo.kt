package com.parteytimeline.nearby.host

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.net.NetworkInterface

/**
 * "If the host is on Wi-Fi, let clients join with a plain browser" (path b
 * from the plan) — no Nearby Connections involved at all, just the LAN IP
 * of whatever network this device happens to be on, since the embedded
 * Node server already binds all interfaces.
 */
object LanShareInfo {

    /** This device's LAN IPv4 address, or null if there isn't one (Wi-Fi off / cellular-only — a normal state, not an error). */
    fun currentLanIp(): String? {
        return try {
            NetworkInterface.getNetworkInterfaces()?.asSequence()
                ?.filter { it.isUp && !it.isLoopback }
                ?.flatMap { it.inetAddresses.asSequence() }
                ?.filterNot { it.isLoopbackAddress }
                ?.map { it.hostAddress }
                ?.firstOrNull { it != null && !it.contains(':') } // skip IPv6 — keeps the QR/URL short
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
