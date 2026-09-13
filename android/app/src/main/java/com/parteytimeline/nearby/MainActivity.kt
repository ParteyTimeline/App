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
import androidx.core.content.ContextCompat
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
            startActivity(GameWebViewActivity.putPort(Intent(this, GameWebViewActivity::class.java), HOST_PORT))
        }
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

        val lanIp = LanShareInfo.currentLanIp()
        if (lanIp != null) {
            val url = "http://$lanIp:$HOST_PORT/"
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
            runOnUiThread { tvStatus.text = "${getString(R.string.status_hosting)}\nVerbunden: $name" }
        }
    }

    private fun startJoining() {
        lanCard.visibility = android.view.View.GONE
        listHosts.visibility = android.view.View.VISIBLE
        tvStatus.text = getString(R.string.status_discovering)
        discoveredHosts.clear()
        hostsAdapter.clear()

        val peer = NearbyPeer(applicationContext, localDisplayName = Build.MODEL ?: "Spieler")
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
                startActivity(GameWebViewActivity.putPort(Intent(this, GameWebViewActivity::class.java), localPort))
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
