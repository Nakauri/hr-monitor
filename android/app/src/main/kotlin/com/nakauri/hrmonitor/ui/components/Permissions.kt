package com.nakauri.hrmonitor.ui.components

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat

/**
 * Returns the runtime permissions required to pair + scan + keep the
 * foreground notification visible, adjusted for the device's API level.
 * Location on <=30, BLUETOOTH_SCAN/CONNECT on 31+, POST_NOTIFICATIONS on 33+.
 */
fun requiredRuntimePermissions(): Array<String> {
    val perms = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        perms += Manifest.permission.BLUETOOTH_SCAN
        perms += Manifest.permission.BLUETOOTH_CONNECT
    } else {
        perms += Manifest.permission.ACCESS_FINE_LOCATION
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        perms += Manifest.permission.POST_NOTIFICATIONS
    }
    return perms.toTypedArray()
}

fun Context.allPermissionsGranted(perms: Array<String>): Boolean = perms.all {
    ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
}

data class PermissionState(
    val allGranted: Boolean,
    val request: () -> Unit,
)

@Composable
fun rememberPermissionState(context: Context): PermissionState {
    val perms = remember { requiredRuntimePermissions() }
    var granted by remember { mutableStateOf(context.allPermissionsGranted(perms)) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        granted = result.values.all { it } && context.allPermissionsGranted(perms)
    }

    return PermissionState(
        allGranted = granted,
        request = { launcher.launch(perms) },
    )
}
