# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3205
- Total growing bytes: 2.60 MB
- Total shrinking bytes: -0.40 MB
- Net delta: 2.20 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +970.38 | +525 | code |  |
| 2 | +336.20 | +1333 | code | system / TrustedByteArray |
| 3 | +213.41 | +18211 | number | heap number |
| 4 | +181.51 | +6114 | object | Object |
| 5 | +149.38 | +525 | code | system / ProtectedFixedArray |
| 6 | +120.14 | +466 | object | Text |
| 7 | +78.73 | +1232 | hidden | system / WeakArrayList |
| 8 | +75.16 | +506 | array | (object properties) |
| 9 | +37.41 | +342 | native | PerformanceScriptTiming |
| 10 | +31.29 | +801 | object | _Matrix |
| 11 | +30.76 | +525 | code | (code) |
| 12 | +30.14 | +1164 | hidden | system / PropertyArray |
| 13 | +26.56 | +1700 | object | Array |
| 14 | +24.12 | +525 | code | system / TrustedWeakFixedArray |
| 15 | +23.74 | +1013 | object | EE |
| 16 | +22.08 | +471 | object | _CanvasTextMetrics2 |
| 17 | +19.66 | +1393 | array | (object elements) |
| 18 | +16.81 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 19 | +15.59 | +133 | native | PerformanceLongAnimationFrameTiming |
| 20 | +15.59 | +133 | native | TaskAttributionTiming |
| 21 | +13.51 | +133 | native | PerformanceLongTaskTiming |
| 22 | +12.25 | +627 | code | system / UncompiledDataWithoutPreparseData |
| 23 | +11.35 | +83 | object | _TextureSource2 |
| 24 | +10.09 | +354 | code | system / WeakArrayList |
| 25 | +9.72 | +68 | code | system / FeedbackVector |
| 26 | +9.03 | +578 | object | Events |
| 27 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 28 | +6.48 | +83 | native | WebGLTexture |
| 29 | +6.48 | +83 | object | Texture |
| 30 | +4.88 | +7 | code | (BASELINE instruction stream) |
| 31 | +4.77 | +610 | code | system / CodeWrapper |
| 32 | +4.10 | +525 | hidden | system / SharedFunctionInfoWrapper |
| 33 | +3.89 | +83 | object | GlTexture |
| 34 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 35 | +3.00 | +2 | code | (instruction stream for postrender) |
| 36 | +2.93 | +183 | code | system / LoadHandler |
| 37 | +2.69 | +1 | code | (instruction stream for poll) |
| 38 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 39 | +2.56 | +3 | code | (instruction stream for applyQuality) |
| 40 | +2.47 | +79 | object | _Rectangle |