# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3095
- Total growing bytes: 2.31 MB
- Total shrinking bytes: -0.40 MB
- Net delta: 1.91 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +986.88 | +511 | code |  |
| 2 | +346.01 | +1316 | code | system / TrustedByteArray |
| 3 | +179.83 | +5803 | object | Object |
| 4 | +149.51 | +511 | code | system / ProtectedFixedArray |
| 5 | +136.54 | +11651 | number | heap number |
| 6 | +71.25 | +1086 | hidden | system / WeakArrayList |
| 7 | +41.48 | +75 | array | (object properties) |
| 8 | +38.83 | +355 | native | PerformanceScriptTiming |
| 9 | +29.94 | +511 | code | (code) |
| 10 | +24.61 | +511 | code | system / TrustedWeakFixedArray |
| 11 | +21.48 | +731 | hidden | system / PropertyArray |
| 12 | +19.88 | +424 | object | _CanvasTextMetrics2 |
| 13 | +18.86 | +1207 | object | Array |
| 14 | +16.41 | +140 | native | PerformanceLongAnimationFrameTiming |
| 15 | +16.41 | +140 | native | TaskAttributionTiming |
| 16 | +15.05 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 17 | +14.22 | +140 | native | PerformanceLongTaskTiming |
| 18 | +12.94 | +552 | object | EE |
| 19 | +12.11 | +620 | code | system / UncompiledDataWithoutPreparseData |
| 20 | +11.84 | +82 | code | system / FeedbackVector |
| 21 | +11.62 | +85 | object | _TextureSource2 |
| 22 | +9.16 | +316 | code | system / WeakArrayList |
| 23 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 24 | +6.64 | +85 | native | WebGLTexture |
| 25 | +6.64 | +85 | object | Texture |
| 26 | +6.25 | +8 | code | (BASELINE instruction stream) |
| 27 | +5.31 | +1 | code | (instruction stream for handleDamage) |
| 28 | +4.67 | +598 | code | system / CodeWrapper |
| 29 | +3.99 | +511 | hidden | system / SharedFunctionInfoWrapper |
| 30 | +3.98 | +85 | object | GlTexture |
| 31 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 32 | +3.05 | +190 | code | system / LoadHandler |
| 33 | +3.00 | +2 | code | (instruction stream for postrender) |
| 34 | +2.69 | +1 | code | (instruction stream for poll) |
| 35 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 36 | +2.62 | +168 | object | Events |
| 37 | +2.56 | +3 | code | (instruction stream for applyQuality) |
| 38 | +2.53 | +81 | object | _Rectangle |
| 39 | +2.23 | +77 | code | system / WeakFixedArray |
| 40 | +2.19 | +1 | code | (instruction stream for spawn) |