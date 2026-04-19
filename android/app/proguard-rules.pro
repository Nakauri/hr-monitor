# Keep Nordic BLE Library internals. It uses reflection for GATT characteristic
# parsing; shrinker strips classes that only reflection references.
-keep class no.nordicsemi.android.ble.** { *; }
-dontwarn no.nordicsemi.android.ble.**

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
