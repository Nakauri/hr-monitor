package com.nakauri.hrmonitor.ui.screens

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.common.api.ApiException
import com.nakauri.hrmonitor.drive.GoogleAuth
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.nakauri.hrmonitor.BuildConfig
import com.nakauri.hrmonitor.data.HrPrefsState
import com.nakauri.hrmonitor.diag.HrmLog
import com.nakauri.hrmonitor.util.OemBackground
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsScreen(
    prefs: HrPrefsState,
    onBack: () -> Unit,
    onRegenerateRelayKey: () -> Unit,
    onForgetStrap: () -> Unit,
    onToggleBootRestart: (Boolean) -> Unit,
    onDriveSignInSuccess: (String?) -> Unit,
    onDriveSignOut: () -> Unit,
) {
    val context = LocalContext.current
    val events by HrmLog.events.collectAsState()

    val signInLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        try {
            val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
            val account = task.getResult(ApiException::class.java)
            onDriveSignInSuccess(account?.email)
        } catch (e: ApiException) {
            HrmLog.warn("drive", "Sign-in cancelled or failed: code=${e.statusCode}")
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Diagnostics") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { inner ->
        Column(
            modifier = Modifier
                .padding(inner)
                .padding(horizontal = 16.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SectionCard(title = "Relay") {
                Text("Broadcast key", style = MaterialTheme.typography.labelMedium)
                Text(
                    prefs.relayKey ?: "(generating...)",
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Paste this into the web overlay to receive the live HR stream.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onRegenerateRelayKey) { Text("Regenerate key") }
            }

            SectionCard(title = "Drive backup") {
                if (prefs.driveEmail != null) {
                    Text("Signed in", style = MaterialTheme.typography.labelMedium)
                    Text(prefs.driveEmail, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Session CSVs upload to your Drive in \"HR Monitor Sessions\". Same folder the web app uses.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = onDriveSignOut) { Text("Sign out") }
                } else {
                    Text(
                        "Sign in to back up session recordings to your Google Drive. Optional.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = {
                        signInLauncher.launch(GoogleAuth.signInIntent(context))
                    }) { Text("Sign in with Google") }
                }
            }

            SectionCard(title = "Keep alive on your phone") {
                Text(
                    "Battery optimisation and OEM autostart lists kill background apps without warning. Grant an exemption here.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { openBatteryOptimisationSettings(context) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Battery optimisation settings")
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        val result = OemBackground.openBackgroundSettings(context)
                        HrmLog.info("oem", "openBackgroundSettings -> ${result.path}")
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    val info = OemBackground.detect()
                    Text(
                        if (info.hasKnownBackgroundKiller) "${info.manufacturer.lowercase().replaceFirstChar(Char::titlecase)} autostart settings"
                        else "App info (battery options)"
                    )
                }
                Spacer(Modifier.height(12.dp))
                Row(
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Switch(
                        checked = prefs.bootRestartEnabled,
                        onCheckedChange = onToggleBootRestart,
                    )
                    Text(
                        "Restart session after reboot",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            SectionCard(title = "Paired strap") {
                if (prefs.lastStrapMac != null) {
                    Text(
                        prefs.lastStrapName ?: prefs.lastStrapMac,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        prefs.lastStrapMac,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = onForgetStrap) { Text("Forget strap") }
                } else {
                    Text("No strap paired yet.", style = MaterialTheme.typography.bodyMedium)
                }
            }

            SectionCard(title = "Recent events") {
                if (events.isEmpty()) {
                    Text("Nothing yet.", style = MaterialTheme.typography.bodySmall)
                } else {
                    val fmt = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }
                    LazyColumn(
                        modifier = Modifier.height(200.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        items(events.takeLast(50).asReversed()) { e ->
                            Text(
                                "${fmt.format(Date(e.timestamp))}  ${e.tag}: ${e.message}",
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }

            SectionCard(title = "About") {
                LabelRow("Version", BuildConfig.VERSION_NAME)
                LabelRow("Build", BuildConfig.VERSION_CODE.toString())
                LabelRow("Package", context.packageName)
                LabelRow("Android SDK", android.os.Build.VERSION.SDK_INT.toString())
                LabelRow("Device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun LabelRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth(0.4f))
        Text(value, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
    }
}

/**
 * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS requires the exact-named
 * permission AND a package-scoped URI. Play Store flags this as sensitive;
 * the permission is declared in the manifest.
 */
@SuppressLint("BatteryLife")
private fun openBatteryOptimisationSettings(context: android.content.Context) {
    val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as? PowerManager
    val alreadyExempt = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
    val intent = if (alreadyExempt) {
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    } else {
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
        }
    }.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    try {
        context.startActivity(intent)
        HrmLog.info("battery", if (alreadyExempt) "Opened battery-opt list" else "Requested battery-opt exemption")
    } catch (e: Exception) {
        HrmLog.warn("battery", "No settings activity found: ${e.message}")
    }
}

