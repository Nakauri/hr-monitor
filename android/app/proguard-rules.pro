# BLESSED is the BLE stack (replaced Nordic v2.9 on 2026-04-21). Keep its
# internals — it uses reflection for the shim that makes some Samsung
# Bluetooth stack quirks work.
-keep class com.welie.blessed.** { *; }
-dontwarn com.welie.blessed.**

# Keep Ktor OkHttp engine. Engine is loaded via ServiceLoader.
-keep class io.ktor.client.engine.okhttp.** { *; }
-dontwarn io.ktor.**

# kotlinx.serialization — KSerializer classes are looked up by name.
-keepclasseswithmembers class ** {
    @kotlinx.serialization.Serializable <fields>;
}
-keepclassmembers class * {
    static **$$serializer INSTANCE;
}

# Sentry needs its own classes kept for deobfuscation mapping upload.
-keep class io.sentry.** { *; }
-dontwarn io.sentry.**

# Coroutines
-dontwarn kotlinx.coroutines.**
