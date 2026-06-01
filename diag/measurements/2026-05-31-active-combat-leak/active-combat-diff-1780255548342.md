# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3283
- Total growing bytes: 2.40 MB
- Total shrinking bytes: -0.45 MB
- Net delta: 1.95 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +879.81 | +445 | code |  |
| 2 | +305.99 | +1122 | code | system / TrustedByteArray |
| 3 | +223.86 | +19103 | number | heap number |
| 4 | +163.94 | +5529 | object | Object |
| 5 | +132.91 | +445 | code | system / ProtectedFixedArray |
| 6 | +132.77 | +515 | object | Text |
| 7 | +75.72 | +548 | array | (object properties) |
| 8 | +67.78 | +1033 | hidden | system / WeakArrayList |
| 9 | +35.77 | +327 | native | PerformanceScriptTiming |
| 10 | +34.26 | +877 | object | _Matrix |
| 11 | +28.02 | +1098 | hidden | system / PropertyArray |
| 12 | +26.07 | +445 | code | (code) |
| 13 | +23.44 | +500 | object | _CanvasTextMetrics2 |
| 14 | +23.11 | +986 | object | EE |
| 15 | +21.95 | +445 | code | system / TrustedWeakFixedArray |
| 16 | +21.45 | +1373 | object | Array |
| 17 | +14.77 | +126 | native | PerformanceLongAnimationFrameTiming |
| 18 | +14.77 | +126 | native | TaskAttributionTiming |
| 19 | +12.80 | +126 | native | PerformanceLongTaskTiming |
| 20 | +12.66 | +648 | code | system / UncompiledDataWithoutPreparseData |
| 21 | +11.62 | +85 | object | _TextureSource2 |
| 22 | +9.75 | +625 | object | Events |
| 23 | +8.78 | +309 | code | system / WeakArrayList |
| 24 | +7.79 | +52 | code | system / FeedbackVector |
| 25 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 26 | +6.64 | +85 | native | WebGLTexture |
| 27 | +6.64 | +85 | object | Texture |
| 28 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 29 | +5.02 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 30 | +3.98 | +85 | object | GlTexture |
| 31 | +3.97 | +508 | code | system / CodeWrapper |
| 32 | +3.48 | +445 | hidden | system / SharedFunctionInfoWrapper |
| 33 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 34 | +2.75 | +4 | code | (BASELINE instruction stream) |
| 35 | +2.69 | +1 | code | (instruction stream for poll) |
| 36 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 37 | +2.56 | +3 | code | (instruction stream for applyQuality) |
| 38 | +2.53 | +81 | object | _Rectangle |
| 39 | +2.31 | +1 | code | (instruction stream for postrender) |
| 40 | +2.17 | +135 | code | system / LoadHandler |