package com.nakauri.hrmonitor.drive

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.nakauri.hrmonitor.data.SessionCsvWriter
import com.nakauri.hrmonitor.diag.HrmLog
import java.util.concurrent.TimeUnit

/**
 * Uploads all pending session CSVs in `filesDir/sessions/` to Drive.
 * Runs as expedited work under the `dataSync` FGS subtype the manifest
 * declares.
 *
 * Retry semantics:
 *   - If Google sign-in is missing or token fetch fails → Result.retry().
 *     WorkManager will back off; user can trigger a fresh attempt by
 *     signing in (the diagnostics screen re-enqueues after sign-in).
 *   - If an HTTP 401 bubbles through, invalidate + one retry inline.
 *   - If an upload succeeds, delete the local CSV.
 *   - Partial progress is OK — remaining files retry next run.
 */
class SessionUploadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val pending = SessionCsvWriter.listPending(applicationContext)
        if (pending.isEmpty()) {
            HrmLog.info(TAG, "No CSVs to upload")
            return Result.success()
        }
        HrmLog.info(TAG, "${pending.size} CSV(s) to upload")

        val account = GoogleAuth.lastSignedInAccount(applicationContext)
        if (account == null || !GoogleAuth.hasDriveScope(account)) {
            HrmLog.info(TAG, "No Drive-scoped account; retry later")
            return Result.retry()
        }

        var token = GoogleAuth.fetchAccessToken(applicationContext)
            ?: run {
                HrmLog.warn(TAG, "Token fetch returned null; retry later")
                return Result.retry()
            }

        val folderResult = DriveRestClient.ensureSessionsFolder(token)
        val folderId = when (folderResult) {
            is DriveRestClient.Result.Ok -> folderResult.fileId
            is DriveRestClient.Result.Unauthorized -> {
                GoogleAuth.invalidateToken(applicationContext, token)
                token = GoogleAuth.fetchAccessToken(applicationContext) ?: return Result.retry()
                val retryResult = DriveRestClient.ensureSessionsFolder(token)
                if (retryResult is DriveRestClient.Result.Ok) retryResult.fileId
                else {
                    HrmLog.warn(TAG, "Folder resolution failed after token refresh")
                    return Result.retry()
                }
            }
            is DriveRestClient.Result.Failure -> {
                HrmLog.warn(TAG, "Folder resolution failed: ${folderResult.message}")
                return Result.retry()
            }
        }

        var anyFailed = false
        for (file in pending) {
            val csvText = try { file.readText() } catch (e: Exception) {
                HrmLog.warn(TAG, "Could not read ${file.name}: ${e.message}")
                continue
            }
            val uploadResult = DriveRestClient.uploadCsv(token, folderId, file.name, csvText)
            when (uploadResult) {
                is DriveRestClient.Result.Ok -> {
                    file.delete()
                    HrmLog.info(TAG, "Uploaded + deleted ${file.name}")
                }
                is DriveRestClient.Result.Unauthorized -> {
                    GoogleAuth.invalidateToken(applicationContext, token)
                    anyFailed = true
                    break
                }
                is DriveRestClient.Result.Failure -> {
                    HrmLog.warn(TAG, "Upload failed for ${file.name}: ${uploadResult.message}")
                    anyFailed = true
                }
            }
        }

        return if (anyFailed) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "upload"
        private const val UNIQUE_WORK = "hr_session_upload"

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SessionUploadWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,
                    30,
                    TimeUnit.SECONDS,
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_WORK,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                request,
            )
            HrmLog.info(TAG, "Upload work enqueued")
        }
    }
}
