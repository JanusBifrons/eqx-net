# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 397
- Total growing bytes: 1.47 MB
- Total shrinking bytes: -0.06 MB
- Net delta: 1.41 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +655.81 | +326 | code |  |
| 2 | +237.96 | +917 | code | system / TrustedByteArray |
| 3 | +123.54 | +3976 | object | Object |
| 4 | +100.04 | +326 | code | system / ProtectedFixedArray |
| 5 | +93.84 | +8008 | number | heap number |
| 6 | +50.05 | +805 | hidden | system / WeakArrayList |
| 7 | +26.14 | +239 | native | PerformanceScriptTiming |
| 8 | +19.10 | +326 | code | (code) |
| 9 | +16.38 | +326 | code | system / TrustedWeakFixedArray |
| 10 | +11.79 | +390 | hidden | system / PropertyArray |
| 11 | +10.78 | +92 | native | TaskAttributionTiming |
| 12 | +10.78 | +92 | native | PerformanceLongAnimationFrameTiming |
| 13 | +9.67 | +60 | code | system / FeedbackVector |
| 14 | +9.34 | +92 | native | PerformanceLongTaskTiming |
| 15 | +7.69 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 16 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 17 | +7.20 | +253 | code | system / WeakArrayList |
| 18 | +5.56 | +6 | code | (BASELINE instruction stream) |
| 19 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 20 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 21 | +3.33 | +23 | code | system / BytecodeArray |
| 22 | +3.09 | +396 | code | system / CodeWrapper |
| 23 | +3.00 | +2 | code | (instruction stream for postrender) |
| 24 | +2.70 | +101 | code | system / WeakFixedArray |
| 25 | +2.70 | +138 | concatenated string | (concatenated string) |
| 26 | +2.69 | +1 | code | (instruction stream for sampleHeapIfDue) |
| 27 | +2.69 | +1 | code | (instruction stream for poll) |
| 28 | +2.56 | +3 | code | (instruction stream for applyQuality) |
| 29 | +2.55 | +326 | hidden | system / SharedFunctionInfoWrapper |
| 30 | +2.48 | +109 | code | (object elements) |
| 31 | +2.42 | +150 | code | system / LoadHandler |
| 32 | +2.19 | +1 | code | (instruction stream for spawn) |
| 33 | +2.00 | +128 | object | Array |
| 34 | +2.00 | +2 | code | (instruction stream for destroy) |
| 35 | +1.94 | +1 | code | (instruction stream for runOnHash) |
| 36 | +1.94 | +1 | code | (instruction stream for y.string) |
| 37 | +1.75 | +2 | native | CanvasRenderingContext2D |
| 38 | +1.69 | +1 | code | (instruction stream for attachFilters) |
| 39 | +1.69 | +1 | code | (instruction stream for updateRttAndLookahead) |
| 40 | +1.69 | +1 | code | (instruction stream for applyDroneMountAngles) |