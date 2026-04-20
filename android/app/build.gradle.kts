import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.sentry)
}

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

fun secret(key: String): String? =
    System.getenv(key)?.takeIf { it.isNotBlank() }
        ?: keystoreProps.getProperty(key)?.takeIf { it.isNotBlank() }

android {
    namespace = "com.nakauri.hrmonitor"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nakauri.hrmonitor"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-native"

        vectorDrawables { useSupportLibrary = true }

        buildConfigField(
            "String",
            "SENTRY_DSN",
            "\"${secret("SENTRY_DSN") ?: ""}\""
        )
    }

    signingConfigs {
        create("release") {
            val storePath = secret("ANDROID_KEYSTORE_PATH") ?: "hr-monitor-release.keystore"
            val storeFile = rootProject.file(storePath).takeIf { it.exists() }
                ?: File(storePath).takeIf { it.exists() }
            if (storeFile != null) {
                this.storeFile = storeFile
                this.storePassword = secret("ANDROID_KEYSTORE_PASSWORD")
                this.keyAlias = secret("ANDROID_KEY_ALIAS") ?: "hr-monitor"
                this.keyPassword = secret("ANDROID_KEY_PASSWORD") ?: this.storePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val release = signingConfigs.getByName("release")
            signingConfig = if (release.storeFile != null) release else signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/INDEX.LIST",
            "/META-INF/io.netty.versions.properties"
        )
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
    }
}

sentry {
    includeProguardMapping.set(true)
    autoUploadProguardMapping.set(false)
    tracingInstrumentation { enabled.set(false) }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.work.runtime.ktx)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.nordic.ble)
    implementation(libs.nordic.ble.ktx)

    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.websockets)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.sentry.android)
}
