package com.nakauri.hrmonitor

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nakauri.hrmonitor.service.HrSessionService
import com.nakauri.hrmonitor.ui.AppRoute
import com.nakauri.hrmonitor.ui.AppViewModel
import com.nakauri.hrmonitor.ui.components.rememberPermissionState
import com.nakauri.hrmonitor.ui.screens.DiagnosticsScreen
import com.nakauri.hrmonitor.ui.screens.LiveScreen
import com.nakauri.hrmonitor.ui.screens.ScanScreen
import com.nakauri.hrmonitor.ui.theme.HRMonitorTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HRMonitorTheme {
                AppRoot()
            }
        }
    }
}

@Composable
private fun AppRoot() {
    val vm: AppViewModel = viewModel()
    val route by vm.route.collectAsState()
    val prefs by vm.prefsState.collectAsState()
    val sessionActive by vm.sessionActive.collectAsState()
    val liveHr by vm.liveHr.collectAsState()
    val liveRmssd by vm.liveRmssd.collectAsState()

    val context = LocalContext.current
    val permission = rememberPermissionState(context)

    LaunchedEffect(sessionActive) {
        if (sessionActive) startSessionService(context) else stopSessionService(context)
    }

    BackHandler(enabled = route != AppRoute.Scan) {
        when (route) {
            AppRoute.Diagnostics -> vm.navigate(if (sessionActive) AppRoute.Live else AppRoute.Scan)
            AppRoute.Live -> { /* Stop session is the only back action from Live. */ }
            AppRoute.Scan -> Unit
        }
    }

    when (route) {
        AppRoute.Scan -> ScanScreen(
            prefs = prefs,
            permission = permission,
            onOpenDiagnostics = { vm.navigate(AppRoute.Diagnostics) },
            onSelectStrap = { mac, name ->
                vm.rememberStrap(mac, name)
                vm.startSession()
            },
        )
        AppRoute.Live -> LiveScreen(
            hr = liveHr,
            rmssd = liveRmssd,
            strapLabel = prefs.lastStrapName ?: prefs.lastStrapMac,
            onOpenDiagnostics = { vm.navigate(AppRoute.Diagnostics) },
            onStop = { vm.stopSession() },
        )
        AppRoute.Diagnostics -> DiagnosticsScreen(
            prefs = prefs,
            onBack = { vm.navigate(if (sessionActive) AppRoute.Live else AppRoute.Scan) },
            onRegenerateRelayKey = { vm.regenerateRelayKey() },
            onForgetStrap = { vm.forgetStrap() },
            onToggleBootRestart = { vm.setBootRestartEnabled(it) },
        )
    }
}

private fun startSessionService(context: Context) {
    val intent = Intent(context, HrSessionService::class.java)
    ContextCompat.startForegroundService(context, intent)
}

private fun stopSessionService(context: Context) {
    val intent = Intent(context, HrSessionService::class.java)
    context.stopService(intent)
}
