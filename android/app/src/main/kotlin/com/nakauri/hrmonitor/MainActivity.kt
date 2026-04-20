package com.nakauri.hrmonitor

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nakauri.hrmonitor.service.HrSessionService
import com.nakauri.hrmonitor.session.SessionState
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
    val pendingStart by vm.pendingStart.collectAsState()
    val pendingStop by vm.pendingStop.collectAsState()
    val sessionActive by SessionState.active.collectAsState()
    val strap by SessionState.strap.collectAsState()

    val context = LocalContext.current
    val permission = rememberPermissionState(context)

    // Reconcile UI route with service state. Covers two cases: cold start while
    // the service is still running (navigate to Live), and external session
    // stop via the notification's Stop action (navigate away from Live).
    LaunchedEffect(sessionActive) {
        when {
            sessionActive && route == AppRoute.Scan -> vm.navigate(AppRoute.Live)
            !sessionActive && route == AppRoute.Live -> vm.navigate(AppRoute.Scan)
        }
    }

    LaunchedEffect(pendingStart) {
        val p = pendingStart ?: return@LaunchedEffect
        startSessionService(context, p.mac, p.name)
        vm.consumePendingStart()
    }

    LaunchedEffect(pendingStop) {
        if (!pendingStop) return@LaunchedEffect
        stopSessionService(context)
        vm.consumePendingStop()
    }

    BackHandler(enabled = route != AppRoute.Scan) {
        when (route) {
            AppRoute.Diagnostics -> vm.navigate(if (sessionActive) AppRoute.Live else AppRoute.Scan)
            AppRoute.Live -> { /* Stop session is the only exit from Live. */ }
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
                vm.requestStartSession(mac, name)
            },
        )
        AppRoute.Live -> LiveScreen(
            strapLabel = strap?.name ?: strap?.mac ?: prefs.lastStrapName ?: prefs.lastStrapMac,
            onOpenDiagnostics = { vm.navigate(AppRoute.Diagnostics) },
            onStop = { vm.requestStopSession() },
        )
        AppRoute.Diagnostics -> DiagnosticsScreen(
            prefs = prefs,
            onBack = { vm.navigate(if (sessionActive) AppRoute.Live else AppRoute.Scan) },
            onRegenerateRelayKey = { vm.regenerateRelayKey() },
            onForgetStrap = { vm.forgetStrap() },
            onToggleBootRestart = { vm.setBootRestartEnabled(it) },
            onDriveSignInSuccess = { vm.onDriveSignInSuccess(it) },
            onDriveSignOut = { vm.onDriveSignOut() },
        )
    }
}

private fun startSessionService(context: Context, mac: String, name: String?) {
    val intent = Intent(context, HrSessionService::class.java).apply {
        action = HrSessionService.ACTION_START_SESSION
        putExtra(HrSessionService.EXTRA_STRAP_MAC, mac)
        if (name != null) putExtra(HrSessionService.EXTRA_STRAP_NAME, name)
    }
    ContextCompat.startForegroundService(context, intent)
}

private fun stopSessionService(context: Context) {
    val intent = Intent(context, HrSessionService::class.java).apply {
        action = HrSessionService.ACTION_STOP_SESSION
    }
    ContextCompat.startForegroundService(context, intent)
}
