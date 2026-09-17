package com.parteytimeline.nearby.host

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import java.security.SecureRandom
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Holds the per-:host-process-lifetime secret that guards
 * /api/local/host-control (see server.js) — a management endpoint that must
 * be unreachable by anyone but this app itself. Runs in the :host process
 * (same as HostForegroundService/NodeRuntime, see AndroidManifest.xml), so
 * same-process code there reads [token] directly; MainActivity/
 * GameWebViewActivity (main process) can't — they go through [readBlocking]
 * instead, an actual cross-process ContentResolver query.
 *
 * A ContentProvider specifically (not a shared file or a bound Service) is
 * what makes that query safe against the cold-start race: Android
 * guarantees a process's ContentProviders finish onCreate() before any other
 * component in that same freshly-spawned process gets a lifecycle callback,
 * so a query from the main process structurally cannot observe this
 * provider before [token] exists — no polling/retry needed.
 */
class ControlTokenProvider : ContentProvider() {

    override fun onCreate(): Boolean {
        token // touch now to force eager generation, before anything else in this process runs
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<String>?,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): Cursor = MatrixCursor(arrayOf(COLUMN_TOKEN)).apply { addRow(arrayOf(token)) }

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri =
        throw UnsupportedOperationException("read-only")

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int =
        throw UnsupportedOperationException("read-only")

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int =
        throw UnsupportedOperationException("read-only")

    companion object {
        private const val COLUMN_TOKEN = "token"
        private val AUTHORITY_URI: Uri = Uri.parse("content://com.parteytimeline.nearby.hostcontrol/token")

        // A fresh random secret for the :host process's lifetime — same
        // reasoning as the pre-0.5.8 per-NodeRuntime-instance token, just
        // relocated: now that HostForegroundService/NodeRuntime genuinely
        // get a brand-new process each hosting session (see
        // HostForegroundService.onDestroy()'s Process.killProcess), a plain
        // per-process value is correct again — no cross-instance singleton
        // workaround needed.
        val token: String by lazy {
            ByteArray(32).let { SecureRandom().nextBytes(it); it.joinToString("") { b -> "%02x".format(b) } }
        }

        // For the main process only (GameWebViewActivity). Bounded so a
        // wedged :host process can't hang this JS-interface call forever;
        // @JavascriptInterface methods already run off the UI thread, so
        // blocking here briefly is safe.
        fun readBlocking(context: Context, timeoutMs: Long = 3000): String? =
            try {
                Executors.newSingleThreadExecutor().let { pool ->
                    try {
                        pool.submit(
                            Callable {
                                context.contentResolver.query(AUTHORITY_URI, null, null, null, null)?.use { cursor ->
                                    if (cursor.moveToFirst()) cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_TOKEN)) else null
                                }
                            },
                        ).get(timeoutMs, TimeUnit.MILLISECONDS)
                    } finally {
                        pool.shutdown()
                    }
                }
            } catch (e: Exception) {
                null
            }
    }
}
