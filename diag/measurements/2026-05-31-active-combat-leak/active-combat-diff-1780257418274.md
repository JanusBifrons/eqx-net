# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 508
- Total growing bytes: 2.18 MB
- Total shrinking bytes: -0.02 MB
- Net delta: 2.16 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +629.44 | +342 | code |  |
| 2 | +257.23 | +21950 | number | heap number |
| 3 | +219.79 | +985 | code | system / TrustedByteArray |
| 4 | +172.89 | +6301 | object | Object |
| 5 | +92.74 | +342 | code | system / ProtectedFixedArray |
| 6 | +76.53 | +316 | object | _Graphics |
| 7 | +72.05 | +2037 | array | (object elements) |
| 8 | +55.91 | +652 | array | (object properties) |
| 9 | +49.19 | +3148 | object | Array |
| 10 | +48.40 | +1239 | object | _Matrix |
| 11 | +43.66 | +741 | hidden | system / WeakArrayList |
| 12 | +27.16 | +316 | object | _GraphicsContext2 |
| 13 | +26.03 | +238 | native | PerformanceScriptTiming |
| 14 | +21.25 | +680 | object | _Bounds |
| 15 | +20.04 | +342 | code | (code) |
| 16 | +19.02 | +105 | code | system / BytecodeArray |
| 17 | +17.36 | +635 | object | _GraphicsPath |
| 18 | +16.59 | +708 | object | EE |
| 19 | +16.11 | +342 | code | system / TrustedWeakFixedArray |
| 20 | +15.35 | +655 | object | _ObservablePoint |
| 21 | +14.42 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 22 | +14.26 | +80 | code | system / FeedbackVector |
| 23 | +13.61 | +646 | hidden | system / PropertyArray |
| 24 | +11.25 | +1 | code | (instruction stream for Alert2) |
| 25 | +11.03 | +94 | native | PerformanceLongAnimationFrameTiming |
| 26 | +11.03 | +94 | native | TaskAttributionTiming |
| 27 | +10.35 | +664 | object | Events |
| 28 | +9.56 | +94 | native | PerformanceLongTaskTiming |
| 29 | +9.28 | +54 | native | CSSStyleSheet |
| 30 | +8.86 | +54 | native | <style data-emotion="css" data-s=""> |
| 31 | +8.31 | +98 | native | Text |
| 32 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 33 | +7.40 | +261 | code | system / WeakArrayList |
| 34 | +6.63 | +10 | code | (BASELINE instruction stream) |
| 35 | +6.08 | +3 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 36 | +6.05 | +86 | object | BatchableGraphics |
| 37 | +5.96 | +374 | code | system / LoadHandler |
| 38 | +5.44 | +185 | code | system / WeakFixedArray |
| 39 | +5.31 | +1 | code | (instruction stream for handleDamage) |
| 40 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |