package com.nakauri.hrmonitor.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.security.SecureRandom

private val Context.dataStore by preferencesDataStore(name = "hr_monitor_prefs")

/**
 * Single typed facade over the preferences DataStore. Values are read as
 * cold Flows and written through suspend methods. Relay key auto-generates
 * on first read so the user never sees an empty chip.
 */
class HrPrefs(private val context: Context) {

    private val store = context.dataStore

    val state: Flow<HrPrefsState> = store.data.map { p ->
        HrPrefsState(
            lastStrapMac = p[K.LAST_STRAP_MAC],
            lastStrapName = p[K.LAST_STRAP_NAME],
            relayKey = p[K.RELAY_KEY],
            driveEmail = p[K.DRIVE_EMAIL],
            bootRestartEnabled = p[K.BOOT_RESTART_ENABLED] ?: false,
            sentryEnabled = p[K.SENTRY_ENABLED] ?: true,
        )
    }

    suspend fun setLastStrap(mac: String, name: String?) {
        store.edit { p ->
            p[K.LAST_STRAP_MAC] = mac
            if (name != null) p[K.LAST_STRAP_NAME] = name else p.remove(K.LAST_STRAP_NAME)
        }
    }

    suspend fun clearLastStrap() {
        store.edit { p ->
            p.remove(K.LAST_STRAP_MAC)
            p.remove(K.LAST_STRAP_NAME)
        }
    }

    suspend fun ensureRelayKey(): String {
        val current = store.data.first()[K.RELAY_KEY]
        if (!current.isNullOrBlank()) return current
        val key = generateRelayKey()
        store.edit { it[K.RELAY_KEY] = key }
        return key
    }

    suspend fun regenerateRelayKey(): String {
        val key = generateRelayKey()
        store.edit { it[K.RELAY_KEY] = key }
        return key
    }

    suspend fun setDriveEmail(email: String?) {
        store.edit { p ->
            if (email != null) p[K.DRIVE_EMAIL] = email else p.remove(K.DRIVE_EMAIL)
        }
    }

    suspend fun setBootRestartEnabled(enabled: Boolean) {
        store.edit { it[K.BOOT_RESTART_ENABLED] = enabled }
    }

    suspend fun setSentryEnabled(enabled: Boolean) {
        store.edit { it[K.SENTRY_ENABLED] = enabled }
    }

    private fun generateRelayKey(): String {
        val bytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private object K {
        val LAST_STRAP_MAC: Preferences.Key<String> = stringPreferencesKey("last_strap_mac")
        val LAST_STRAP_NAME: Preferences.Key<String> = stringPreferencesKey("last_strap_name")
        val RELAY_KEY: Preferences.Key<String> = stringPreferencesKey("relay_key")
        val DRIVE_EMAIL: Preferences.Key<String> = stringPreferencesKey("drive_email")
        val BOOT_RESTART_ENABLED: Preferences.Key<Boolean> = booleanPreferencesKey("boot_restart_enabled")
        val SENTRY_ENABLED: Preferences.Key<Boolean> = booleanPreferencesKey("sentry_enabled")
    }
}

data class HrPrefsState(
    val lastStrapMac: String? = null,
    val lastStrapName: String? = null,
    val relayKey: String? = null,
    val driveEmail: String? = null,
    val bootRestartEnabled: Boolean = false,
    val sentryEnabled: Boolean = true,
)
