package com.nakauri.hrmonitor.drive

import com.nakauri.hrmonitor.diag.HrmLog
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.random.Random

/**
 * Minimal REST client for Google Drive v3. Hand-rolled against the same
 * endpoints hr_monitor.html uses so the native app and the web app see
 * the same files in "HR Monitor Sessions".
 *
 * Scope: `drive.file`. Per-app isolation — files created by the same
 * OAuth client are visible to both surfaces.
 */
object DriveRestClient {
    private const val TAG = "drive"
    private const val BASE = "https://www.googleapis.com/drive/v3"
    private const val UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
    const val SESSIONS_FOLDER_NAME = "HR Monitor Sessions"
    private const val FOLDER_MIME = "application/vnd.google-apps.folder"

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = false
    }

    private val client = HttpClient(OkHttp) {
        expectSuccess = false
    }

    @Serializable
    private data class FileMeta(
        val id: String? = null,
        val name: String? = null,
        val mimeType: String? = null,
    )

    @Serializable
    private data class FileList(val files: List<FileMeta> = emptyList())

    @Serializable
    private data class CreateFolderBody(
        val name: String,
        val mimeType: String = FOLDER_MIME,
    )

    sealed class Result {
        data class Ok(val fileId: String) : Result()
        data class Unauthorized(val message: String) : Result()
        data class Failure(val message: String, val status: Int? = null) : Result()
    }

    /**
     * Finds or creates the "HR Monitor Sessions" folder owned by this app.
     * Returns the folder id or a Failure / Unauthorized result.
     */
    @OptIn(ExperimentalSerializationApi::class)
    suspend fun ensureSessionsFolder(token: String): Result {
        val query = "name='$SESSIONS_FOLDER_NAME' and mimeType='$FOLDER_MIME' and trashed=false"
        val resp = try {
            client.get("$BASE/files") {
                bearer(token)
                parameter("q", query)
                parameter("fields", "files(id,name)")
                parameter("spaces", "drive")
            }
        } catch (e: Exception) {
            return Result.Failure("Folder query failed: ${e.message}")
        }
        if (resp.status == HttpStatusCode.Unauthorized) {
            return Result.Unauthorized(resp.bodyAsText())
        }
        if (!resp.status.isSuccess()) {
            return Result.Failure("Folder query HTTP ${resp.status.value}", resp.status.value)
        }
        val existing = try {
            json.decodeFromString<FileList>(resp.bodyAsText()).files.firstOrNull()?.id
        } catch (e: Exception) { null }
        if (existing != null) return Result.Ok(existing)

        val createResp = try {
            client.post("$BASE/files") {
                bearer(token)
                contentType(ContentType.Application.Json)
                parameter("fields", "id")
                setBody(json.encodeToString(CreateFolderBody(name = SESSIONS_FOLDER_NAME)))
            }
        } catch (e: Exception) {
            return Result.Failure("Folder create failed: ${e.message}")
        }
        if (createResp.status == HttpStatusCode.Unauthorized) {
            return Result.Unauthorized(createResp.bodyAsText())
        }
        if (!createResp.status.isSuccess()) {
            return Result.Failure("Folder create HTTP ${createResp.status.value}", createResp.status.value)
        }
        val id = try {
            json.decodeFromString<FileMeta>(createResp.bodyAsText()).id
        } catch (e: Exception) { null }
        return if (id != null) Result.Ok(id)
        else Result.Failure("Folder create response lacked id")
    }

    /** Multipart upload. Matches the web app's `driveUploadSession` body layout. */
    suspend fun uploadCsv(
        token: String,
        folderId: String,
        filename: String,
        csvText: String,
    ): Result {
        val boundary = "-------hr-monitor-${Random.nextInt(0, Int.MAX_VALUE).toString(36)}"
        val meta = mapOf(
            "name" to filename,
            "parents" to listOf(folderId),
            "mimeType" to "text/csv",
        )
        val body = buildString {
            append("--").append(boundary).append("\r\n")
            append("Content-Type: application/json; charset=UTF-8\r\n\r\n")
            append(json.encodeToString(kotlinx.serialization.json.JsonObject(mapOf(
                "name" to kotlinx.serialization.json.JsonPrimitive(filename),
                "parents" to kotlinx.serialization.json.JsonArray(listOf(
                    kotlinx.serialization.json.JsonPrimitive(folderId)
                )),
                "mimeType" to kotlinx.serialization.json.JsonPrimitive("text/csv"),
            ))))
            append("\r\n--").append(boundary).append("\r\n")
            append("Content-Type: text/csv\r\n\r\n")
            append(csvText)
            append("\r\n--").append(boundary).append("--\r\n")
        }

        val resp = try {
            client.post("$UPLOAD_BASE/files") {
                bearer(token)
                parameter("uploadType", "multipart")
                parameter("fields", "id")
                header("Content-Type", "multipart/related; boundary=$boundary")
                setBody(body)
            }
        } catch (e: Exception) {
            return Result.Failure("Upload failed: ${e.message}")
        }
        if (resp.status == HttpStatusCode.Unauthorized) {
            return Result.Unauthorized(resp.bodyAsText())
        }
        if (!resp.status.isSuccess()) {
            return Result.Failure(
                "Upload HTTP ${resp.status.value}: ${resp.bodyAsText().take(300)}",
                resp.status.value,
            )
        }
        val id = try {
            json.decodeFromString<FileMeta>(resp.bodyAsText()).id
        } catch (e: Exception) { null }
        return if (id != null) {
            HrmLog.info(TAG, "Uploaded $filename -> $id")
            Result.Ok(id)
        } else {
            Result.Failure("Upload response lacked id")
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.bearer(token: String) {
        header("Authorization", "Bearer $token")
    }
}
