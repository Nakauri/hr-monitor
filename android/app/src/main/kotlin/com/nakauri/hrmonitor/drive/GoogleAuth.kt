package com.nakauri.hrmonitor.drive

import android.accounts.Account
import android.content.Context
import android.content.Intent
import com.google.android.gms.auth.GoogleAuthException
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.UserRecoverableAuthException
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInAccount
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.Scope
import com.google.android.gms.common.api.ApiException
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Wraps the (legacy-but-functional) Google Sign-In flow and Drive-scope
 * token acquisition. Credential Manager + AuthorizationClient is the
 * "modern" path but adds two extra deps and a harder-to-debug surface;
 * legacy GoogleSignIn works on every Android version we target.
 *
 * Callers:
 *   - UI starts sign-in via [signInIntent] + ActivityResultContracts.
 *   - UI handles sign-out via [signOut].
 *   - Workers fetch an access token via [fetchAccessToken] on IO.
 */
object GoogleAuth {
    const val DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
    private const val TAG = "auth"

    fun client(context: Context): GoogleSignInClient {
        val opts = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(Scope(DRIVE_FILE_SCOPE))
            .build()
        return GoogleSignIn.getClient(context, opts)
    }

    fun signInIntent(context: Context): Intent = client(context).signInIntent

    fun lastSignedInAccount(context: Context): GoogleSignInAccount? =
        GoogleSignIn.getLastSignedInAccount(context)

    fun hasDriveScope(account: GoogleSignInAccount): Boolean =
        GoogleSignIn.hasPermissions(account, Scope(DRIVE_FILE_SCOPE))

    suspend fun signOut(context: Context): Unit = kotlinx.coroutines.suspendCancellableCoroutine { cont ->
        client(context).signOut().addOnCompleteListener { task ->
            HrmLog.info(TAG, "Signed out of Google (success=${task.isSuccessful})")
            cont.resumeWith(Result.success(Unit))
        }
    }

    /**
     * Returns an OAuth access token for the Drive.file scope, or null if
     * the user is not signed in, the token cannot be fetched, or user
     * consent is required (recoverable). The UploadWorker reports back a
     * retry on null; the UI is responsible for driving recovery.
     */
    suspend fun fetchAccessToken(context: Context): String? = withContext(Dispatchers.IO) {
        val account = lastSignedInAccount(context)?.account
            ?: run {
                HrmLog.info(TAG, "No signed-in Google account")
                return@withContext null
            }
        fetchTokenFor(context, account)
    }

    private fun fetchTokenFor(context: Context, account: Account): String? {
        return try {
            GoogleAuthUtil.getToken(
                context,
                account,
                "oauth2:$DRIVE_FILE_SCOPE"
            )
        } catch (e: UserRecoverableAuthException) {
            HrmLog.warn(TAG, "Token fetch requires user consent: ${e.message}")
            null
        } catch (e: GoogleAuthException) {
            HrmLog.warn(TAG, "Google auth failed: ${e.message}")
            null
        } catch (e: IOException) {
            HrmLog.warn(TAG, "Token fetch IO error: ${e.message}")
            null
        } catch (e: Exception) {
            HrmLog.error(TAG, "Unexpected token fetch failure", e)
            null
        }
    }

    /** Invalidates the cached token so the next fetch retrieves a fresh one. */
    suspend fun invalidateToken(context: Context, token: String) = withContext(Dispatchers.IO) {
        try {
            GoogleAuthUtil.clearToken(context, token)
        } catch (_: Exception) { /* best-effort */ }
    }
}

