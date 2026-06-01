# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 3178
- Total growing bytes: 2.66 MB
- Total shrinking bytes: -0.39 MB
- Net delta: 2.27 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +1002.38 | +519 | code |  |
| 2 | +344.98 | +1336 | code | system / TrustedByteArray |
| 3 | +217.80 | +18586 | number | heap number |
| 4 | +174.75 | +5929 | object | Object |
| 5 | +149.82 | +519 | code | system / ProtectedFixedArray |
| 6 | +117.82 | +457 | object | Text |
| 7 | +78.19 | +543 | array | (object properties) |
| 8 | +70.08 | +1063 | hidden | system / WeakArrayList |
| 9 | +34.89 | +319 | native | PerformanceScriptTiming |
| 10 | +32.46 | +831 | object | _Matrix |
| 11 | +30.41 | +519 | code | (code) |
| 12 | +29.67 | +1169 | hidden | system / PropertyArray |
| 13 | +28.18 | +1481 | array | (object elements) |
| 14 | +27.91 | +1191 | object | EE |
| 15 | +27.84 | +1782 | object | Array |
| 16 | +24.16 | +519 | code | system / TrustedWeakFixedArray |
| 17 | +21.61 | +461 | object | _CanvasTextMetrics2 |
| 18 | +14.66 | +125 | native | TaskAttributionTiming |
| 19 | +14.66 | +125 | native | PerformanceLongAnimationFrameTiming |
| 20 | +14.08 | +103 | object | _TextureSource2 |
| 21 | +13.88 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 22 | +12.71 | +125 | native | PerformanceLongTaskTiming |
| 23 | +12.17 | +623 | code | system / UncompiledDataWithoutPreparseData |
| 24 | +11.38 | +85 | code | system / FeedbackVector |
| 25 | +10.21 | +654 | object | Events |
| 26 | +8.84 | +313 | code | system / WeakArrayList |
| 27 | +8.05 | +103 | native | WebGLTexture |
| 28 | +8.05 | +103 | object | Texture |
| 29 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 30 | +6.19 | +8 | code | (BASELINE instruction stream) |
| 31 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 32 | +4.83 | +103 | object | GlTexture |
| 33 | +4.77 | +611 | code | system / CodeWrapper |
| 34 | +4.05 | +519 | hidden | system / SharedFunctionInfoWrapper |
| 35 | +3.39 | +212 | code | system / LoadHandler |
| 36 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 37 | +3.09 | +99 | object | _Rectangle |
| 38 | +3.00 | +2 | code | (instruction stream for postrender) |
| 39 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 40 | +2.69 | +1 | code | (instruction stream for poll) |