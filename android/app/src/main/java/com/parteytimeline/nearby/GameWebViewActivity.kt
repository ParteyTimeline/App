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
private const val MAX_RETRIES = 20
private const val RETRY_DELAY_MS = 500L

/**
 * Loads the existing web app's UI from a local loopback port — either the
 * embedded Node server directly (host, see HostForegroundService.HOST_PORT)
 * or the local tunnel entry point (peer, see PeerTunnelClient's bound
 * port). public/app.js already builds its WebSocket URL and fetch() paths
 * relative to location.host/location.pathname (see app.js), so pointing
 * the WebView at the right origin is the entire integration — no app.js
 * changes needed.
 */
class GameWebViewActivity : AppCompatActivity() {
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retriesLeft = MAX_RETRIES

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game)

        val port = intent.getIntExtra(EXTRA_PORT, -1)
        require(port > 0) { "GameWebViewActivity requires EXTRA_PORT" }
        val url = "http://127.0.0.1:$port/"

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
        fun putPort(intent: android.content.Intent, port: Int): android.content.Intent =
            intent.putExtra(EXTRA_PORT, port)
    }
}
