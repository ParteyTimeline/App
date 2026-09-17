package com.parteytimeline.nearby

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ImageView
import android.widget.ListView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.os.LocaleListCompat
import com.parteytimeline.nearby.host.HOST_PORT
import com.parteytimeline.nearby.host.HostForegroundService
import com.parteytimeline.nearby.host.HostIpcContract
import com.parteytimeline.nearby.host.LanShareInfo
import com.parteytimeline.nearby.nearby.NearbyHostCandidate
import com.parteytimeline.nearby.nearby.NearbyPeer
import com.parteytimeline.nearby.nearby.NearbyPermissions

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var lanCard: android.view.View
    private lateinit var tvLanUrl: TextView
    private lateinit var ivQr: ImageView
    private lateinit var listHosts: ListView

    private var pendingAction: (() -> Unit)? = null
    private var nearbyPeer: NearbyPeer? = null
    private val discoveredHosts = mutableListOf<NearbyHostCandidate>()
    private lateinit var hostsAdapter: ArrayAdapter<String>

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            if (results.values.all { it }) {
                pendingAction?.invoke()
            } else {
                tvStatus.text = getString(R.string.status_permissions_required)
            }
            pendingAction = null
        }

    // HostForegroundService now runs in a separate :host process (see
    // AndroidManifest.xml) — it can no longer hand this activity a same-
    // process callback closure, so these events cross as real broadcasts
    // instead (see HostIpcContract.kt). Registered up front in onCreate(),
    // so unlike the old singleton-polling approach there's no dependency on
    // how quickly the other process finishes starting.
    private val hostEventsReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                HostIpcContract.ACTION_PEER_CONNECTED -> {
                    val name = intent.getStringExtra(HostIpcContract.EXTRA_ENDPOINT_NAME) ?: return
                    tvStatus.text = "${getString(R.string.status_hosting)}\n${getString(R.string.status_connected_to, name)}"
                }
                HostIpcContract.ACTION_HOST_STOPPED -> {
                    // The notification's "Stop hosting" action ended a session
                    // this screen (or GameWebViewActivity, on top of it) didn't
                    // initiate itself — reset back to the idle state startJoining()
                    // and startHosting() themselves show their own next state
                    // for the stop THEY trigger, so this only ever needs to
                    // undo "Hosting…"'s UI, never overwrite theirs.
                    tvStatus.text = ""
                    lanCard.visibility = android.view.View.GONE
                    findViewById<Button>(R.id.btnContinueToGame).visibility = android.view.View.GONE
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tvStatus)
        lanCard = findViewById(R.id.lanCard)
        tvLanUrl = findViewById(R.id.tvLanUrl)
        ivQr = findViewById(R.id.ivQr)
        listHosts = findViewById(R.id.listHosts)

        ContextCompat.registerReceiver(this, hostEventsReceiver, HostIpcContract.allActions(), ContextCompat.RECEIVER_NOT_EXPORTED)

        hostsAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1)
        listHosts.adapter = hostsAdapter
        listHosts.setOnItemClickListener { _, _, position, _ ->
            val candidate = discoveredHosts[position]
            tvStatus.text = getString(R.string.status_connecting)
            nearbyPeer?.connectTo(candidate.endpointId)
        }

        findViewById<Button>(R.id.btnHost).setOnClickListener { withPermissions { startHosting() } }
        findViewById<Button>(R.id.btnJoin).setOnClickListener { withPermissions { startJoining() } }
        findViewById<Button>(R.id.btnContinueToGame).setOnClickListener {
            startActivity(GameWebViewActivity.putPort(Intent(this, GameWebViewActivity::class.java), HOST_PORT, role = "host"))
        }

        findViewById<Button>(R.id.btnLangDe).setOnClickListener { setAppLanguage("de") }
        findViewById<Button>(R.id.btnLangEn).setOnClickListener { setAppLanguage("en") }
        updateLangButtons()
    }

    // AppCompatDelegate persists the chosen per-app locale itself (automatic
    // storage, no manifest/SharedPreferences work needed since appcompat
    // 1.6.0) and recreates every AppCompatActivity in the task to apply it —
    // mirrors the DE/EN toggle in the web UI (public/i18n.js) so both surfaces
    // behave the same way regardless of the device's system language.
    private fun setAppLanguage(tag: String) {
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
    }

    // Reads resources.configuration rather than AppCompatDelegate.getApplicationLocales()
    // so this reflects whichever language is ACTUALLY in effect right now —
    // an explicit override, or (before one is ever chosen) whatever the
    // system locale resolved to via values-de/ vs. the values/ (English) default.
    private fun updateLangButtons() {
        val isGerman = resources.configuration.locales[0].language == "de"
        findViewById<Button>(R.id.btnLangDe).isEnabled = !isGerman
        findViewById<Button>(R.id.btnLangEn).isEnabled = isGerman
    }

    private fun withPermissions(action: () -> Unit) {
        if (NearbyPermissions.hasAll(this)) {
            action()
        } else {
            pendingAction = action
            permissionLauncher.launch(NearbyPermissions.required())
        }
    }

    private fun startHosting() {
        // Mutually exclusive with joining — a device can't be looking for a
        // host and being one at the same time. Tear down any active
        // discovery/connection first in case the user was just in the join
        // screen.
        nearbyPeer?.stopDiscovery()
        nearbyPeer?.disconnect()
        nearbyPeer = null

        val intent = Intent(this, HostForegroundService::class.java)
        ContextCompat.startForegroundService(this, intent)

        listHosts.visibility = android.view.View.GONE
        tvStatus.text = getString(R.string.status_hosting)

        // Hosting itself needs no Wi-Fi at all (only the browser/QR join
        // path below does) — advertising keeps running in the background
        // via HostForegroundService regardless of which screen is in
        // front, so the host can go straight into their own game and let
        // Nearby peers join while the lobby sits open.
        findViewById<Button>(R.id.btnContinueToGame).visibility = android.view.View.VISIBLE

        val lanIp = LanShareInfo.currentLanIp(this)
        if (lanIp != null) {
            // Same no-account, no-code local flow as the Nearby tunnel path
            // below (see GameWebViewActivity) — this URL is meant for
            // someone else's phone/laptop browser on the same Wi-Fi (e.g.
            // an iPhone that can't use Nearby/Bluetooth pairing), not a
            // return to normal self-hosted/online use.
            val url = "http://$lanIp:$HOST_PORT/?local=1&role=guest"
            tvLanUrl.text = url
            ivQr.setImageBitmap(LanShareInfo.qrCodeBitmap(url))
            lanCard.visibility = android.view.View.VISIBLE
        } else {
            tvStatus.text = "${getString(R.string.status_hosting)}\n${getString(R.string.status_no_lan)}"
            lanCard.visibility = android.view.View.GONE
        }
    }

    private fun startJoining() {
        // Mutually exclusive with hosting — stop being a host first
        // (HostForegroundService.onDestroy() tears everything down,
        // including killing the whole :host process — see its own comment).
        // stoppedViaNotification stays false for this self-initiated stop, so
        // hostEventsReceiver above won't fire ACTION_HOST_STOPPED and flash
        // the idle-reset UI over the "discovering" UI set right below.
        stopService(Intent(this, HostForegroundService::class.java))
        findViewById<Button>(R.id.btnContinueToGame).visibility = android.view.View.GONE
        lanCard.visibility = android.view.View.GONE
        listHosts.visibility = android.view.View.VISIBLE
        tvStatus.text = getString(R.string.status_discovering)
        discoveredHosts.clear()
        hostsAdapter.clear()

        val peer = NearbyPeer(applicationContext, localDisplayName = Build.MODEL ?: getString(R.string.player_fallback_name))
        nearbyPeer = peer
        peer.onHostFound = { candidate ->
            runOnUiThread {
                if (discoveredHosts.none { it.endpointId == candidate.endpointId }) {
                    discoveredHosts.add(candidate)
                    hostsAdapter.add(candidate.name)
                }
            }
        }
        peer.onHostLost = { endpointId ->
            runOnUiThread {
                val idx = discoveredHosts.indexOfFirst { it.endpointId == endpointId }
                if (idx >= 0) {
                    discoveredHosts.removeAt(idx)
                    hostsAdapter.remove(hostsAdapter.getItem(idx))
                }
            }
        }
        peer.onConnectionFailed = {
            runOnUiThread { tvStatus.text = getString(R.string.status_connection_failed) }
        }
        peer.onTunnelReady = { localPort ->
            runOnUiThread {
                startActivity(GameWebViewActivity.putPort(Intent(this, GameWebViewActivity::class.java), localPort, role = "guest"))
            }
        }
        peer.startDiscovery()
    }

    override fun onDestroy() {
        nearbyPeer?.stopDiscovery()
        nearbyPeer?.disconnect()
        unregisterReceiver(hostEventsReceiver)
        super.onDestroy()
    }
}
