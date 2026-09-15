package com.parteytimeline.nearby.nearby

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Nearby Connections needs different runtime permissions depending on the
 * OS version. This list must match AndroidManifest.xml's <uses-permission>
 * minSdkVersion/maxSdkVersion gates EXACTLY, permission by permission: a
 * permission the manifest doesn't grant on the device's API level can never
 * be obtained no matter how many times the user taps "allow" — the runtime
 * dialog either won't show it at all or silently reports it denied, which
 * makes `hasAll()` return false forever and the whole "tap button ->
 * request permissions -> nothing happens" flow loop indefinitely. (This
 * happened for real: an earlier version requested ACCESS_WIFI_STATE/
 * CHANGE_WIFI_STATE on API 32+, but the manifest — copied from a different,
 * equally official Google source — only declares those up to API 31.)
 */
object NearbyPermissions {

    fun required(): Array<String> = when {
        Build.VERSION.SDK_INT >= 33 -> arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.NEARBY_WIFI_DEVICES,
            // NEARBY_WIFI_DEVICES only covers the Wi-Fi mediums — Nearby
            // Connections' BLE medium still goes through the classic
            // location-gated scan path regardless of Android version (see
            // AndroidManifest.xml's ACCESS_COARSE_LOCATION comment).
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.POST_NOTIFICATIONS, // needed to show the host's foreground-service notification
        )
        Build.VERSION.SDK_INT == 32 -> arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.NEARBY_WIFI_DEVICES,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        Build.VERSION.SDK_INT == 31 -> arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_WIFI_STATE,
            Manifest.permission.CHANGE_WIFI_STATE,
        )
        Build.VERSION.SDK_INT >= 29 -> arrayOf(
            Manifest.permission.BLUETOOTH,
            Manifest.permission.BLUETOOTH_ADMIN,
            Manifest.permission.ACCESS_WIFI_STATE,
            Manifest.permission.CHANGE_WIFI_STATE,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        else -> arrayOf(
            Manifest.permission.BLUETOOTH,
            Manifest.permission.BLUETOOTH_ADMIN,
            Manifest.permission.ACCESS_WIFI_STATE,
            Manifest.permission.CHANGE_WIFI_STATE,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
    }

    fun hasAll(context: Context): Boolean = required().all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
}
