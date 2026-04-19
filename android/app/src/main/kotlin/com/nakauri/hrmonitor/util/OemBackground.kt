package com.nakauri.hrmonitor.util

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * OEM-specific background-allow-list deep-links. Samsung, Xiaomi, Huawei etc.
 * each layer their own battery killer on top of Doze. Each has a different
 * settings screen where the user adds an app to a "never sleeping" /
 * "protected" / "auto-start" list.
 *
 * Falls back to ACTION_APPLICATION_DETAILS_SETTINGS when the vendor intent
 * is unavailable. Source of per-OEM intents: https://dontkillmyapp.com
 */
object OemBackground {

    data class VendorInfo(
        val manufacturer: String,
        val brand: String,
        val vendor: String,
        val hasKnownBackgroundKiller: Boolean,
    )

    data class OpenResult(
        val opened: Boolean,
        val vendor: String,
        val path: String,
    )

    fun detect(): VendorInfo {
        val mfr = (Build.MANUFACTURER ?: "")
        val brand = (Build.BRAND ?: "")
        val vendor = detectVendor(mfr.lowercase(), brand.lowercase())
        return VendorInfo(
            manufacturer = mfr,
            brand = brand,
            vendor = vendor,
            hasKnownBackgroundKiller = vendor != "other",
        )
    }

    fun openBackgroundSettings(context: Context): OpenResult {
        val info = detect()
        var opened = false
        var path = "none"

        when (info.vendor) {
            "samsung" -> {
                val intent = Intent().apply {
                    setClassName(
                        "com.samsung.android.lool",
                        "com.samsung.android.sm.ui.battery.BatteryActivity"
                    )
                    action = "com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY"
                    putExtra("activity_type", 2) // 2 = never sleeping apps
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                opened = tryStart(context, intent)
                path = if (opened) "samsung:never_sleeping" else "samsung:fallback"
            }
            "xiaomi" -> {
                val intent = Intent().apply {
                    setClassName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.autostart.AutoStartManagementActivity"
                    )
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                opened = tryStart(context, intent)
                path = if (opened) "xiaomi:autostart" else "xiaomi:fallback"
            }
            "huawei", "honor" -> {
                val intent = Intent().apply {
                    setClassName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
                    )
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                opened = tryStart(context, intent)
                path = if (opened) "huawei:startup" else "huawei:fallback"
            }
            "oppo", "realme" -> {
                val intent = Intent().apply {
                    setClassName(
                        "com.coloros.safecenter",
                        "com.coloros.safecenter.permission.startup.StartupAppListActivity"
                    )
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                opened = tryStart(context, intent)
                path = if (opened) "oppo:startup" else "oppo:fallback"
            }
            "vivo" -> {
                val intent = Intent().apply {
                    setClassName(
                        "com.iqoo.secure",
                        "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"
                    )
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                opened = tryStart(context, intent)
                path = if (opened) "vivo:bgstart" else "vivo:fallback"
            }
        }

        if (!opened) {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            opened = tryStart(context, fallback)
            path = if (opened) "${path}+generic" else "failed"
        }

        return OpenResult(opened = opened, vendor = info.vendor, path = path)
    }

    private fun detectVendor(mfr: String, brand: String): String = when {
        mfr.contains("samsung") || brand.contains("samsung") -> "samsung"
        mfr.contains("xiaomi") || brand.contains("xiaomi") ||
            brand.contains("redmi") || brand.contains("poco") -> "xiaomi"
        mfr.contains("huawei") || brand.contains("huawei") -> "huawei"
        mfr.contains("honor") || brand.contains("honor") -> "honor"
        mfr.contains("oppo") || brand.contains("oppo") -> "oppo"
        mfr.contains("realme") || brand.contains("realme") -> "realme"
        mfr.contains("vivo") || brand.contains("vivo") || brand.contains("iqoo") -> "vivo"
        mfr.contains("oneplus") || brand.contains("oneplus") -> "oneplus"
        else -> "other"
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    } catch (_: Exception) {
        false
    }
}
