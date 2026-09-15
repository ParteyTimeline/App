package com.parteytimeline.nearby

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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tvStatus)
        lanCard = findViewById(R.id.lanCard)
        tvLanUrl = findViewById(R.id.tvLanUrl)
        ivQr = findViewById(R.id.ivQr)
        listHosts = findViewById(R.id.listHosts)

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
        val intent = Intent(this, HostForegroundService::class.java)
        ContextCompat.startForegroundService(this, intent)

        // The service starts asynchronously; poll briefly for it to exist so
        // we can hook UI callbacks (host itself already works either way —
        // this only affects how quickly the "peer connected" status updates).
        listHosts.visibility = android.view.View.GONE
        tvStatus.text = getString(R.string.status_hosting)
        window.decorView.postDelayed({ hookHostCallbacks() }, 300)

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

    private fun hookHostCallbacks() {
        val service = HostForegroundService.instance ?: return
        service.nearbyHost.onPeerConnected = { _, name ->
            runOnUiThread { tvStatus.text = "${getString(R.string.status_hosting)}\n${getString(R.string.status_connected_to, name)}" }
        }
    }

    private fun startJoining() {
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
        super.onDestroy()
    }
}
