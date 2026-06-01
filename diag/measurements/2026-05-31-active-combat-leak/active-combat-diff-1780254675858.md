# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3140
- Total growing bytes: 2.59 MB
- Total shrinking bytes: -1.82 MB
- Net delta: 0.77 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +960.63 | +517 | code |  |
| 2 | +327.53 | +1303 | code | system / TrustedByteArray |
| 3 | +240.18 | +20495 | number | heap number |
| 4 | +196.46 | +6655 | object | Object |
| 5 | +145.09 | +517 | code | system / ProtectedFixedArray |
| 6 | +105.96 | +411 | object | Text |
| 7 | +74.52 | +1086 | hidden | system / WeakArrayList |
| 8 | +55.98 | +566 | array | (object properties) |
| 9 | +39.05 | +357 | native | PerformanceScriptTiming |
| 10 | +34.61 | +886 | object | _Matrix |
| 11 | +31.36 | +1209 | hidden | system / PropertyArray |
| 12 | +30.29 | +517 | code | (code) |
| 13 | +29.64 | +1897 | object | Array |
| 14 | +26.88 | +1147 | object | EE |
| 15 | +24.04 | +517 | code | system / TrustedWeakFixedArray |
| 16 | +19.13 | +408 | object | _CanvasTextMetrics2 |
| 17 | +17.21 | +881 | code | system / UncompiledDataWithoutPreparseData |
| 18 | +16.76 | +143 | native | PerformanceLongAnimationFrameTiming |
| 19 | +16.76 | +143 | native | TaskAttributionTiming |
| 20 | +15.04 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 21 | +14.52 | +143 | native | PerformanceLongTaskTiming |
| 22 | +13.67 | +100 | object | _TextureSource2 |
| 23 | +10.48 | +671 | object | Events |
| 24 | +9.58 | +66 | code | system / FeedbackVector |
| 25 | +9.36 | +1459 | array | (object elements) |
| 26 | +8.58 | +304 | code | system / WeakArrayList |
| 27 | +7.81 | +100 | native | WebGLTexture |
| 28 | +7.81 | +100 | object | Texture |
| 29 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 30 | +6.78 | +28 | object | _Graphics |
| 31 | +4.75 | +6 | code | (BASELINE instruction stream) |
| 32 | +4.70 | +602 | code | system / CodeWrapper |
| 33 | +4.69 | +100 | object | GlTexture |
| 34 | +4.04 | +517 | hidden | system / SharedFunctionInfoWrapper |
| 35 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 36 | +3.13 | +100 | object | _Rectangle |
| 37 | +3.00 | +2 | code | (instruction stream for postrender) |
| 38 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 39 | +2.69 | +1 | code | (instruction stream for poll) |
| 40 | +2.67 | +167 | code | system / LoadHandler |