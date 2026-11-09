# Khronos OpenXR loader for Android (arm64-v8a)

`arm64-v8a/libopenxr_loader.so` is the unmodified loader from the Khronos
OpenXR-SDK, version 1.1.54, taken from Maven Central:

- https://repo1.maven.org/maven2/org/khronos/openxr/openxr_loader_for_android/1.1.54/openxr_loader_for_android-1.1.54.aar
  (`jni/arm64-v8a/libopenxr_loader.so`; the .aar's SHA-1 is
  `5ee95cd66f6501d3c969212b349065293da3e26a`, as Maven Central lists it)
- SHA-256 of the .so: `12b10b0d6f3a93c52f9aaf8b0d2452771eeff6e6d0852fe0ecc16412c6b9c311`
- Source: https://github.com/KhronosGroup/OpenXR-SDK-Source
- License: Apache-2.0 (see `LICENSE`, copied from the .aar's `META-INF/LICENSE`)

Frameloader's "Quest compatibility patches" put it in place of the loader that
Meta's mobile SDK bundles into Quest apps. Meta's loader only looks for Meta's
own runtime (`com.oculus.systemdriver`), so on a Steam Frame it logs "Failed to
find default runtime". The Khronos loader also reads
`/vendor/etc/openxr/1/active_runtime.json`, which is where Lepton registers
SteamVR's OpenXR runtime.
