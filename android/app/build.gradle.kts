plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Même numéro de version que l'application de bureau (package.json).
val appVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootProject.file("../package.json").readText())!!.groupValues[1]
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

android {
    namespace = "com.anselmekyere.keaplayer"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anselmekyere.keaplayer"
        minSdk = 24
        targetSdk = 36
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        // libVLC fournit ses bibliothèques natives pour chaque architecture.
        jniLibs.useLegacyPackaging = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // Le moteur de lecture de VLC : démultiplexeurs, décodeurs (dont MediaCodec
    // matériel), libass pour les sous-titres ASS, égaliseur, désentrelacement.
    implementation("org.videolan.android:libvlc-all:3.7.6")
    testImplementation("junit:junit:4.13.2")
}
