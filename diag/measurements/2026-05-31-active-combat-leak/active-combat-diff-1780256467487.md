# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 463
- Total growing bytes: 2.06 MB
- Total shrinking bytes: -0.01 MB
- Net delta: 2.05 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +740.81 | +390 | code |  |
| 2 | +267.80 | +1083 | code | system / TrustedByteArray |
| 3 | +231.50 | +19755 | number | heap number |
| 4 | +177.09 | +6068 | object | Object |
| 5 | +114.38 | +390 | code | system / ProtectedFixedArray |
| 6 | +59.70 | +905 | hidden | system / WeakArrayList |
| 7 | +51.34 | +212 | object | _Graphics |
| 8 | +35.20 | +450 | array | (object properties) |
| 9 | +32.11 | +822 | object | _Matrix |
| 10 | +29.30 | +1875 | object | Array |
| 11 | +26.03 | +238 | native | PerformanceScriptTiming |
| 12 | +22.85 | +390 | code | (code) |
| 13 | +18.26 | +390 | code | system / TrustedWeakFixedArray |
| 14 | +18.22 | +212 | object | _GraphicsContext2 |
| 15 | +16.59 | +624 | hidden | system / PropertyArray |
| 16 | +13.29 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 17 | +11.89 | +72 | code | system / FeedbackVector |
| 18 | +11.88 | +507 | object | EE |
| 19 | +11.44 | +366 | object | _Bounds |
| 20 | +10.71 | +457 | object | _ObservablePoint |
| 21 | +10.64 | +71 | code | system / BytecodeArray |
| 22 | +10.45 | +89 | native | PerformanceLongAnimationFrameTiming |
| 23 | +10.45 | +89 | native | TaskAttributionTiming |
| 24 | +10.23 | +374 | object | _GraphicsPath |
| 25 | +9.05 | +89 | native | PerformanceLongTaskTiming |
| 26 | +7.64 | +272 | code | system / WeakArrayList |
| 27 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 28 | +7.36 | +472 | object | Events |
| 29 | +5.69 | +7 | code | (BASELINE instruction stream) |
| 30 | +5.31 | +1 | code | (instruction stream for handleDamage) |
| 31 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 32 | +4.77 | +298 | code | system / LoadHandler |
| 33 | +3.79 | +194 | concatenated string | (concatenated string) |
| 34 | +3.68 | +471 | code | system / CodeWrapper |
| 35 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 36 | +3.05 | +390 | hidden | system / SharedFunctionInfoWrapper |
| 37 | +3.00 | +2 | code | (instruction stream for postrender) |
| 38 | +2.84 | +11 | object | Text |
| 39 | +2.78 | +71 | code | system / ScopeInfo |
| 40 | +2.73 | +70 | object shape | system / Map |