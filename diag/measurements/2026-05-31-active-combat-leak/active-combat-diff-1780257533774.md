# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 503
- Total growing bytes: 1.52 MB
- Total shrinking bytes: -0.02 MB
- Net delta: 1.50 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +549.81 | +265 | code |  |
| 2 | +188.83 | +793 | code | system / TrustedByteArray |
| 3 | +122.06 | +4291 | object | Object |
| 4 | +118.96 | +10151 | number | heap number |
| 5 | +79.13 | +265 | code | system / ProtectedFixedArray |
| 6 | +37.67 | +651 | hidden | system / WeakArrayList |
| 7 | +24.15 | +753 | array | (object elements) |
| 8 | +22.09 | +202 | native | PerformanceScriptTiming |
| 9 | +20.34 | +84 | object | _Graphics |
| 10 | +18.92 | +184 | array | (object properties) |
| 11 | +18.39 | +1177 | object | Array |
| 12 | +15.53 | +265 | code | (code) |
| 13 | +13.09 | +265 | code | system / TrustedWeakFixedArray |
| 14 | +12.16 | +66 | code | system / FeedbackVector |
| 15 | +11.95 | +306 | object | _Matrix |
| 16 | +11.25 | +1 | code | (instruction stream for Alert2) |
| 17 | +10.98 | +50 | code | system / BytecodeArray |
| 18 | +9.38 | +80 | native | PerformanceLongAnimationFrameTiming |
| 19 | +9.38 | +80 | native | TaskAttributionTiming |
| 20 | +9.11 | +53 | native | CSSStyleSheet |
| 21 | +8.70 | +53 | native | <style data-emotion="css" data-s=""> |
| 22 | +8.14 | +96 | native | Text |
| 23 | +8.13 | +80 | native | PerformanceLongTaskTiming |
| 24 | +7.58 | +349 | hidden | system / PropertyArray |
| 25 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 26 | +7.44 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 27 | +7.22 | +84 | object | _GraphicsContext2 |
| 28 | +6.68 | +235 | code | system / WeakArrayList |
| 29 | +6.63 | +212 | object | _Bounds |
| 30 | +6.08 | +3 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 31 | +5.72 | +244 | object | EE |
| 32 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 33 | +5.05 | +2 | string | label:MuiButtonBase-root;display:inline-flex;align-items:... |
| 34 | +4.92 | +70 | object | BatchableGraphics |
| 35 | +4.69 | +173 | closure |  |
| 36 | +4.48 | +191 | object | _ObservablePoint |
| 37 | +4.46 | +163 | object | _GraphicsPath |
| 38 | +4.38 | +3 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 39 | +4.19 | +1 | code | (instruction stream for DeathOverlayContent) |
| 40 | +3.97 | +140 | object | system / Context |