Standalone regression tests for the production NearbyPeer callback lifecycle.

The fixtures replace Android, Nearby I/O, clocks, and tunnels. The state machine
itself is the real Tinder StateMachine 0.3.0 source, supplied separately; obtain
`src/main/kotlin/com/tinder/StateMachine.kt` from that upstream tag. This avoids
changing production dependencies or the Android Gradle build. No source copies
of NearbyPeer are used, and no radios, device, network, or application data are
accessed. Reflection only reads state and delivers the incoming stream callback.

Run with PowerShell, a JDK, and the Kotlin 1.9.x compiler libraries (the Gradle
8.10 distribution also contains them):

```powershell
./test/nearby-peer-review/run.ps1 -JavaExe <path-to-java> -KotlinLib <compiler-lib-directory> -StateMachineSource <upstream-0.3.0-StateMachine.kt>
```

The runner compiles production code and test fixtures into a unique temporary
directory. It prints every case, then exits nonzero if any assertion fails.
These tests are intentionally separate from `node --test` and the Android
Gradle test source set so fake platform classes cannot enter app builds.
