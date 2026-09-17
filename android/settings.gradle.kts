pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Tinder/StateMachine isn't published to Maven Central — it's
        // resolved straight from its GitHub repo via JitPack instead.
        maven("https://jitpack.io")
    }
}

rootProject.name = "ParteyTimelineNearby"
include(":app")
