plugins {
    id("com.android.application")
}

fun buildConfigString(value: String): String = "\"" + value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"") + "\""

val fixedServerUrl = providers.environmentVariable("FUNNET_ANDROID_SERVER_URL").orElse("").get()
val fixedRegionId = providers.environmentVariable("FUNNET_ANDROID_REGION_ID").orElse("").get()
val fixedRegionName = providers.environmentVariable("FUNNET_ANDROID_REGION_NAME").orElse("").get()
val fixedEnrollmentKey = providers.environmentVariable("FUNNET_ANDROID_ENROLLMENT_KEY").orElse("").get()
val fixedTvModel = providers.environmentVariable("FUNNET_ANDROID_TV_MODEL").orElse("LH65QET").get()
val fixedDisplayId = providers.environmentVariable("FUNNET_ANDROID_DISPLAY_ID").orElse("0").get().toIntOrNull() ?: 0
val preconfigured = fixedServerUrl.isNotBlank() && fixedRegionId.isNotBlank() && fixedEnrollmentKey.isNotBlank()

android {
    namespace = "kr.funnet.tvcontroller"
    compileSdk = 35

    defaultConfig {
        applicationId = "kr.funnet.tvcontroller"
        // Android TV Box field-test baseline: Android 9 (API 28) or newer.
        minSdk = 28
        targetSdk = 35
        versionCode = 23
        versionName = "1.4.0"

        buildConfigField("boolean", "PRECONFIGURED", preconfigured.toString())
        buildConfigField("String", "DEFAULT_SERVER_URL", buildConfigString(fixedServerUrl))
        buildConfigField("String", "DEFAULT_REGION_ID", buildConfigString(fixedRegionId))
        buildConfigField("String", "DEFAULT_REGION_NAME", buildConfigString(fixedRegionName))
        buildConfigField("String", "DEFAULT_ENROLLMENT_KEY", buildConfigString(fixedEnrollmentKey))
        buildConfigField("String", "DEFAULT_TV_MODEL", buildConfigString(fixedTvModel))
        buildConfigField("int", "DEFAULT_DISPLAY_ID", fixedDisplayId.toString())

        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("com.github.mik3y:usb-serial-for-android:3.9.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.3")
    testImplementation("junit:junit:4.13.2")
}
