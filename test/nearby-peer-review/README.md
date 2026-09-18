Standalone regression tests for the production NearbyPeer callback lifecycle.

The fixtures replace Android, Nearby I/O, clocks, and tunnels. The state machine
itself is the real Tinder StateMachine 0.3.0 source, vendored unmodified at
`vendor/StateMachine.kt` (Apache License 2.0) so this harness has no external
fetch step. This avoids changing production dependencies or the Android Gradle
build — production code still resolves the same version via JitPack (see
`android/app/build.gradle.kts`). No source copies of NearbyPeer are used, and no
radios, device, network, or application data are accessed. Reflection reads
state and captures a tunnel's close hook; incoming streams are delivered
through the callback registered with the fake Nearby SDK.

Run with PowerShell, a JDK, and the Kotlin 1.9.x compiler libraries (the Gradle
8.10 distribution also contains them):

```powershell
./test/nearby-peer-review/run.ps1 -JavaExe <path-to-java> -KotlinLib <compiler-lib-directory>
```

Pass `-StateMachineSource <path>` only to compile against a different copy of
the upstream source than the vendored one.

The runner compiles production code and test fixtures into a unique temporary
directory. It prints every case, then exits nonzero if any assertion fails.
These tests are intentionally separate from `node --test` and the Android
Gradle test source set so fake platform classes cannot enter app builds.
