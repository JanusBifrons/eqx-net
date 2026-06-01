# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3377
- Total growing bytes: 2.77 MB
- Total shrinking bytes: -0.48 MB
- Net delta: 2.30 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +1041.94 | +550 | code |  |
| 2 | +358.52 | +1387 | code | system / TrustedByteArray |
| 3 | +250.05 | +21338 | number | heap number |
| 4 | +196.67 | +6636 | object | Object |
| 5 | +157.69 | +550 | code | system / ProtectedFixedArray |
| 6 | +128.65 | +499 | object | Text |
| 7 | +78.91 | +554 | array | (object properties) |
| 8 | +78.36 | +1275 | hidden | system / WeakArrayList |
| 9 | +40.80 | +373 | native | PerformanceScriptTiming |
| 10 | +34.88 | +893 | object | _Matrix |
| 11 | +32.23 | +550 | code | (code) |
| 12 | +31.52 | +1214 | hidden | system / PropertyArray |
| 13 | +27.13 | +1736 | object | Array |
| 14 | +26.02 | +550 | code | system / TrustedWeakFixedArray |
| 15 | +23.91 | +1020 | object | EE |
| 16 | +22.83 | +487 | object | _CanvasTextMetrics2 |
| 17 | +17.62 | +902 | code | system / UncompiledDataWithoutPreparseData |
| 18 | +17.11 | +146 | native | PerformanceLongAnimationFrameTiming |
| 19 | +17.11 | +146 | native | TaskAttributionTiming |
| 20 | +15.10 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 21 | +14.83 | +146 | native | PerformanceLongTaskTiming |
| 22 | +11.96 | +81 | code | system / FeedbackVector |
| 23 | +11.48 | +84 | object | _TextureSource2 |
| 24 | +10.22 | +357 | code | system / WeakArrayList |
| 25 | +9.82 | +629 | object | Events |
| 26 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 27 | +6.56 | +84 | native | WebGLTexture |
| 28 | +6.56 | +84 | object | Texture |
| 29 | +5.88 | +8 | code | (BASELINE instruction stream) |
| 30 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 31 | +4.98 | +637 | code | system / CodeWrapper |
| 32 | +4.30 | +550 | hidden | system / SharedFunctionInfoWrapper |
| 33 | +3.94 | +84 | object | GlTexture |
| 34 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 35 | +3.00 | +2 | code | (instruction stream for postrender) |
| 36 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 37 | +2.69 | +1 | code | (instruction stream for poll) |
| 38 | +2.64 | +164 | code | system / LoadHandler |
| 39 | +2.56 | +3 | code | (instruction stream for applyQuality) |
| 40 | +2.50 | +80 | object | _Rectangle |