import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release-signing credentials live outside version control (see .gitignore
// and signing.properties.example) — a debug-signed APK can't receive
// updates once installed from elsewhere under the same signature, and the
// release key itself is irreplaceable once anything real is signed with
// it, so it's never something to bake into a committed Gradle file.
val signingPropsFile = file("signing.properties")
val signingProps = Properties().apply {
    if (signingPropsFile.exists()) load(FileInputStream(signingPropsFile))
}

// Copies the EXISTING Node.js server (server.js/src/public/package.json/
// node_modules) from the repo root into Android assets, so the embedded
// Node runtime on the Host device runs the exact same server code as the
// normal self-hosted web app — no server-side fork/duplication.
// Sync (not Copy): also removes stale files at the destination that no
// longer match — e.g. a previous run's copy of a now-excluded file — a
// plain Copy task only ever adds/overwrites and would leave it behind.
val syncNodeProject by tasks.registering(Sync::class) {
    description = "Sync server.js/src/public/node_modules from the repo root into assets/nodejs-project"
    val repoRoot = rootProject.projectDir.parentFile
    from(repoRoot) {
        include("server.js", "package.json")
        include("src/**")
        include("public/**")
        include("node_modules/**")
        exclude("node_modules/.bin/**")
        // bcryptjs ships a pre-gzipped browser bundle (dist/bcrypt.min.js.gz)
        // alongside the uncompressed one; Android's asset merger treats the
        // pair as "duplicate resources" and fails the build. Node's
        // require() never touches these browser-bundle files anyway.
        exclude("**/*.gz")
    }
    into(layout.projectDirectory.dir("src/main/assets/nodejs-project"))
}

tasks.named("preBuild") {
    dependsOn(syncNodeProject)
}

android {
    namespace = "com.parteytimeline.nearby"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "com.parteytimeline.nearby"
        minSdk = 26 // covers effectively all real devices in use; simplifies the Nearby Connections permission model
        targetSdk = 34
        versionCode = 2
        versionName = "0.1.1"

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
        ndk {
            // libnode.so is only published prebuilt for these three ABIs
            // (see app/libnode/bin/, populated by scripts/fetch-libnode.sh) —
            // note there is no 32-bit x86 build, only x86_64.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
        }
    }

    signingConfigs {
        if (signingPropsFile.exists()) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    packaging {
        // Only one of the prebuilt libnode.so's transitive libc++_shared.so
        // copies should end up in the APK per ABI; let CMake's own resolve it.
        jniLibs.pickFirsts += "**/libc++_shared.so"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (signingPropsFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // Nearby Connections — device-to-device discovery/transport that needs
    // neither a shared Wi-Fi network nor internet access on either side.
    implementation("com.google.android.gms:play-services-nearby:19.3.0")

    // QR-code generation only (no scanning) for the LAN/browser join path —
    // pure Java, no extra native/camera dependency needed.
    implementation("com.google.zxing:core:3.5.3")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
