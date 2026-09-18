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
            // NEARBY_WIFI_DEVICES only covers the Wi-Fi mediums' advertising
            // side — BLE (host) needs COARSE, Wi-Fi LAN discovery (peer)
            // needs FINE specifically, regardless of Android version (see
            // AndroidManifest.xml's ACCESS_COARSE_LOCATION/ACCESS_FINE_LOCATION
            // comments). Requesting both covers host and peer roles alike.
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
            // POST_NOTIFICATIONS is deliberately NOT here — see
            // notificationPermissionIfNeeded() below. Nearby transport
            // itself needs none of the permissions above to actually work,
            // so requiring notifications too (and blocking hasAll() on it)
            // made denying just that one permission prevent hosting AND
            // joining outright, even though a foreground service can start
            // fine without it (the notification just won't be visible).
        )
        // NEARBY_WIFI_DEVICES doesn't exist until API 33 (Android 13) — API
        // 32 (Android 12L) is a real, shipped OS version that predates it,
        // so requesting it there is requesting an undefined permission: the
        // OS silently denies it with no dialog, and hasAll() would never
        // return true on a real 12L device. 31 and 32 share the same
        // pre-NEARBY_WIFI_DEVICES requirement set (BLUETOOTH_SCAN/ADVERTISE/
        // CONNECT were both already introduced in API 31).
        Build.VERSION.SDK_INT in 31..32 -> arrayOf(
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

    // Separate from required()/hasAll() on purpose: this is a nice-to-have
    // (the host's foreground-service notification being visible), not
    // something hosting/joining should ever be blocked on. Returns the
    // permission to request only when it's actually still worth asking for
    // (API 33+ and not already granted) — null otherwise, so callers can
    // just do `notificationPermissionIfNeeded(context)?.let { launcher.launch(it) }`
    // with no extra version/grant checks of their own.
    fun notificationPermissionIfNeeded(context: Context): String? {
        if (Build.VERSION.SDK_INT < 33) return null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return null
        return Manifest.permission.POST_NOTIFICATIONS
    }
}
