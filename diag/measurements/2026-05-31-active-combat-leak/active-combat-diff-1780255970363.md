# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3286
- Total growing bytes: 2.23 MB
- Total shrinking bytes: -0.40 MB
- Net delta: 1.84 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +834.56 | +402 | code |  |
| 2 | +284.46 | +1038 | code | system / TrustedByteArray |
| 3 | +208.96 | +17831 | number | heap number |
| 4 | +184.75 | +6148 | object | Object |
| 5 | +123.30 | +402 | code | system / ProtectedFixedArray |
| 6 | +61.77 | +331 | array | (object properties) |
| 7 | +58.23 | +888 | hidden | system / WeakArrayList |
| 8 | +34.03 | +2178 | object | Array |
| 9 | +32.13 | +1864 | array | (object elements) |
| 10 | +30.73 | +281 | native | PerformanceScriptTiming |
| 11 | +28.34 | +117 | object | _Graphics |
| 12 | +23.91 | +510 | object | _CanvasTextMetrics2 |
| 13 | +23.55 | +402 | code | (code) |
| 14 | +19.95 | +851 | object | EE |
| 15 | +19.49 | +700 | hidden | system / PropertyArray |
| 16 | +19.46 | +402 | code | system / TrustedWeakFixedArray |
| 17 | +16.91 | +433 | object | _Matrix |
| 18 | +12.64 | +647 | code | system / UncompiledDataWithoutPreparseData |
| 19 | +12.52 | +107 | native | TaskAttributionTiming |
| 20 | +12.52 | +107 | native | PerformanceLongAnimationFrameTiming |
| 21 | +12.17 | +89 | object | _TextureSource2 |
| 22 | +10.85 | +107 | native | PerformanceLongTaskTiming |
| 23 | +10.05 | +117 | object | _GraphicsContext2 |
| 24 | +9.53 | +70 | code | system / FeedbackVector |
| 25 | +8.25 | +289 | code | system / WeakArrayList |
| 26 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 27 | +6.95 | +89 | native | WebGLTexture |
| 28 | +6.95 | +89 | object | Texture |
| 29 | +6.69 | +429 | object | Events |
| 30 | +5.95 | +254 | object | _ObservablePoint |
| 31 | +4.92 | +180 | object | _GraphicsPath |
| 32 | +4.69 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 33 | +4.63 | +148 | object | _Bounds |
| 34 | +4.17 | +89 | object | GlTexture |
| 35 | +3.73 | +477 | code | system / CodeWrapper |
| 36 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 37 | +3.25 | +5 | code | (BASELINE instruction stream) |
| 38 | +3.14 | +402 | hidden | system / SharedFunctionInfoWrapper |
| 39 | +2.79 | +172 | code | system / LoadHandler |
| 40 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |