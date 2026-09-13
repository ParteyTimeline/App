package com.parteytimeline.nearby

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

private const val EXTRA_PORT = "port"
private const val EXTRA_ROLE = "role"
private const val MAX_RETRIES = 20
private const val RETRY_DELAY_MS = 500L

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
 */
class GameWebViewActivity : AppCompatActivity() {
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retriesLeft = MAX_RETRIES

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game)

        val port = intent.getIntExtra(EXTRA_PORT, -1)
        require(port > 0) { "GameWebViewActivity requires EXTRA_PORT" }
        val role = intent.getStringExtra(EXTRA_ROLE) ?: "host"
        val url = "http://127.0.0.1:$port/?local=1&role=$role"

        val webView = findViewById<WebView>(R.id.webView)
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
    }

    override fun onDestroy() {
        retryHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        fun putPort(intent: android.content.Intent, port: Int, role: String = "host"): android.content.Intent =
            intent.putExtra(EXTRA_PORT, port).putExtra(EXTRA_ROLE, role)
    }
}
