param(
    [Parameter(Mandatory=$true)][string]$JavaExe,
    [Parameter(Mandatory=$true)][string]$KotlinLib,
    [Parameter(Mandatory=$true)][string]$StateMachineSource
)
$ErrorActionPreference = 'Stop'
# KotlinLib is the lib directory of Kotlin 1.9.x or Gradle 8.10. The dependency
# source must be Tinder/StateMachine's unmodified 0.3.0 StateMachine.kt.
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$outputDir = Join-Path ([System.IO.Path]::GetTempPath()) ('hipster-peer-tests-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $outputDir | Out-Null
$jar = Join-Path $outputDir 'tests.jar'
$stdlib = (Get-ChildItem -LiteralPath $KotlinLib -Filter 'kotlin-stdlib*.jar' | Where-Object { $_.Name -notmatch 'jdk[78]' } | Select-Object -First 1).FullName
if (-not $stdlib) { throw 'Kotlin standard library not found' }
$separator = [System.IO.Path]::PathSeparator
$fixtures = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'fixtures') -Filter '*.kt' | ForEach-Object { $_.FullName })
$sources = $fixtures + @(
    (Join-Path $PSScriptRoot 'NearbyPeerReviewTest.kt'),
    (Join-Path $repo 'android/app/src/main/java/com/parteytimeline/nearby/nearby/NearbyPeer.kt'),
    (Resolve-Path -LiteralPath $StateMachineSource).Path
)
& $JavaExe -cp (Join-Path $KotlinLib '*') org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -nowarn -no-stdlib -no-reflect -classpath $stdlib -d $jar @sources
if ($LASTEXITCODE -ne 0) { throw "Kotlin compilation failed ($LASTEXITCODE)" }
& $JavaExe -cp ($jar + $separator + $stdlib) NearbyPeerReviewTestKt
exit $LASTEXITCODE
