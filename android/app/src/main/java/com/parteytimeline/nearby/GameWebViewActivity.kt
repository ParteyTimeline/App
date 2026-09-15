package com.parteytimeline.nearby

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.parteytimeline.nearby.nearby.NearbyPeer

private const val EXTRA_PORT = "port"
private const val EXTRA_ROLE = "role"
private const val MAX_RETRIES = 20
private const val RETRY_DELAY_MS = 500L
private const val GIVE_UP_DISMISS_DELAY_MS = 2500L

/**
 * Loads the existing web app's UI from a local loopback port — either the
 * embedded Node server directly (host, see HostForegroundService.HOST_PORT)
 * or the local tunnel entry point (peer, see PeerTunnelClient's bound
 * port). public/app.js already builds its WebSocket URL and fetch() paths
 * relative to location.host/location.pathname (see app.js), so pointing
 * the WebView at the right origin is almost the entire integration — the
 * only addition is `?local=1&role=...`, which tells app.js to skip the
 * account system and room codes entirely (there's no one else this
 * embedded server could belong to) and either create or auto-join the
 * one game this device is part of.
 *
 * For the guest/peer role, also hooks NearbyPeer.current's reconnect events:
 * a dropped Nearby link gets its own automatic retry there (see NearbyPeer),
 * and each reconnect hands back a *new* local tunnel port (PeerTunnelClient
 * binds an ephemeral port each time) — so the WebView needs to be pointed
 * at that new port rather than just reloading the old, now-dead one. The
 * host's session cookie already identifies this device/game (see
 * /api/local/join in server.js), so reloading against a fresh port picks
 * the same game back up without the player doing anything.
 */
class GameWebViewActivity : AppCompatActivity() {
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retriesLeft = MAX_RETRIES

    private lateinit var webView: WebView
    private lateinit var tvReconnecting: TextView
    private var url: String = ""
    private var role: String = "host"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game)

        val port = intent.getIntExtra(EXTRA_PORT, -1)
        require(port > 0) { "GameWebViewActivity requires EXTRA_PORT" }
        role = intent.getStringExtra(EXTRA_ROLE) ?: "host"
        url = "http://127.0.0.1:$port/?local=1&role=$role"

        webView = findViewById(R.id.webView)
        tvReconnecting = findViewById(R.id.tvReconnecting)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // The embedded Node server (host) or the tunnel (peer) may
                // still be starting up when the WebView first tries to load
                // — retry a few times instead of showing a dead page.
                if (!request.isForMainFrame || retriesLeft <= 0) return
                retriesLeft--
                retryHandler.postDelayed({ view.loadUrl(url) }, RETRY_DELAY_MS)
            }
        }
        webView.loadUrl(url)

        if (role == "guest") hookPeerReconnectEvents()
    }

    private fun hookPeerReconnectEvents() {
        val peer = NearbyPeer.current ?: return
        peer.onTunnelReady = { newPort ->
            runOnUiThread {
                url = "http://127.0.0.1:$newPort/?local=1&role=guest"
                retriesLeft = MAX_RETRIES
                tvReconnecting.visibility = View.GONE
                webView.loadUrl(url)
            }
        }
        peer.onReconnecting = {
            runOnUiThread {
                tvReconnecting.text = getString(R.string.status_reconnecting)
                tvReconnecting.visibility = View.VISIBLE
            }
        }
        peer.onReconnectGaveUp = {
            runOnUiThread {
                tvReconnecting.text = getString(R.string.status_reconnect_failed)
                tvReconnecting.visibility = View.VISIBLE
                retryHandler.postDelayed({ if (!isFinishing) finish() }, GIVE_UP_DISMISS_DELAY_MS)
            }
        }
    }

    override fun onDestroy() {
        retryHandler.removeCallbacksAndMessages(null)
        // Drop our hooks so a destroyed activity's WebView/views are never
        // touched from a later callback — recreation (e.g. rotation) re-hooks
        // fresh ones in onCreate, and the peer itself keeps running either way.
        if (role == "guest") {
            NearbyPeer.current?.let { peer ->
                peer.onTunnelReady = null
                peer.onReconnecting = null
                peer.onReconnectGaveUp = null
            }
        }
        super.onDestroy()
    }

    companion object {
        fun putPort(intent: android.content.Intent, port: Int, role: String = "host"): android.content.Intent =
            intent.putExtra(EXTRA_PORT, port).putExtra(EXTRA_ROLE, role)
    }
}
