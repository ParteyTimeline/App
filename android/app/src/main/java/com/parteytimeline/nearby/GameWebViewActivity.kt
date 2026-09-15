package com.parteytimeline.nearby

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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
 *
 * Also wires up the two things a plain WebView doesn't support out of the
 * box, needed for the playlist export/import feature (public/app.js):
 * DownloadListener (a bare WebView silently drops any download — e.g. the
 * export's Content-Disposition: attachment response — with no listener at
 * all) and WebChromeClient.onShowFileChooser (a bare WebView never shows a
 * file picker for <input type=file>, so the import button's click would
 * otherwise do nothing).
 */
class GameWebViewActivity : AppCompatActivity() {
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retriesLeft = MAX_RETRIES

    private lateinit var webView: WebView
    private lateinit var tvReconnecting: TextView
    private var url: String = ""
    private var role: String = "host"

    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDownload: PendingDownload? = null

    private data class PendingDownload(val url: String, val userAgent: String, val contentDisposition: String, val mimetype: String)

    // Only ever needed on API 26-28: DownloadManager writing to the public
    // Downloads directory is exempt from needing this on 29+ (scoped
    // storage), and requesting it upfront for everyone would be pointless
    // — most people never trigger an export at all.
    private val storagePermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val pending = pendingDownload
        pendingDownload = null
        if (pending != null) startDownload(pending, useAppDirFallback = !granted)
    }

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFileChooserCallback
        pendingFileChooserCallback = null
        val uris = if (result.resultCode == RESULT_OK) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        callback?.onReceiveValue(uris)
    }

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
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                // A second file-chooser click before the first resolved
                // (shouldn't normally happen, but WebView contracts require
                // exactly one response per callback) — fail the stale one
                // rather than leak it silently.
                pendingFileChooserCallback?.onReceiveValue(null)
                pendingFileChooserCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    pendingFileChooserCallback = null
                    false
                }
            }
        }
        webView.setDownloadListener { downloadUrl, userAgent, contentDisposition, mimetype, _ ->
            val pending = PendingDownload(downloadUrl, userAgent, contentDisposition, mimetype)
            if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O..Build.VERSION_CODES.P &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
            ) {
                pendingDownload = pending
                storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            } else {
                startDownload(pending, useAppDirFallback = false)
            }
        }
        // Lets app.js tell native code the host explicitly stopped hosting
        // (see server.js's /api/local/host-control and app.js's 'hostStopped'
        // WS handler) — a plain browser guest falls back to the WebView's
        // own "waiting for host" screen, but the Android app has an actual
        // native start screen to return to instead of sitting on that.
        webView.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun hostStopped() {
                runOnUiThread { if (!isFinishing) finish() }
            }
        }, "AndroidLocalBridge")
        webView.loadUrl(url)

        if (role == "guest") hookPeerReconnectEvents()
    }

    // useAppDirFallback: the app's own external-files Downloads folder
    // needs no permission on any API level, used when WRITE_EXTERNAL_STORAGE
    // was denied on a pre-29 device — not as nice as the real shared
    // Downloads folder, but still reachable via a file manager, and lets
    // the export succeed either way instead of just silently failing.
    private fun startDownload(pending: PendingDownload, useAppDirFallback: Boolean) {
        val filename = URLUtil.guessFileName(pending.url, pending.contentDisposition, pending.mimetype)
        val request = DownloadManager.Request(Uri.parse(pending.url)).apply {
            setMimeType(pending.mimetype)
            // The export endpoint requires a logged-in session (see
            // auth.requireAuth in server.js) — DownloadManager makes its own
            // independent HTTP request, not through the WebView's network
            // stack, so the session cookie has to be attached explicitly or
            // the "download" silently saves a login-redirect page instead
            // of the actual archive.
            addRequestHeader("Cookie", CookieManager.getInstance().getCookie(pending.url))
            addRequestHeader("User-Agent", pending.userAgent)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            if (useAppDirFallback) {
                setDestinationInExternalFilesDir(this@GameWebViewActivity, Environment.DIRECTORY_DOWNLOADS, filename)
            } else {
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            }
        }
        try {
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            val where = if (useAppDirFallback) getString(R.string.download_saved_app_folder) else getString(R.string.download_saved_downloads)
            Toast.makeText(this, "$filename — $where", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_LONG).show()
        }
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
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = null
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
