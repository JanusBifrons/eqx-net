# Heap snapshot diff — mobile emu (4x CPU, 414x896 DPR 2), 180s hostile combat

**Snapshots**: `diag\measurements\2026-05-30-mobile-emu\snap-t05-1780169225617.heapsnapshot` → `diag\measurements\2026-05-30-mobile-emu\snap-t180-1780169225617.heapsnapshot`

**Stats**:
- Total groups with non-zero delta: 915
- Total growing bytes: 5967.4 KB
- Total shrinking bytes: -978.7 KB
- Net delta: 4988.7 KB

## Top-25 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +4688.45 | +9598 | native | system / JSArrayBufferData |
| 2 | +562.62 | +9602 | object | Uint8Array |
| 3 | +487.40 | +9598 | object | ArrayBuffer |
| 4 | +66.00 | -3 | code |  |
| 5 | +36.42 | +90 | code | system / TrustedByteArray |
| 6 | +12.56 | +1 | code | (instruction stream for Dialog2) |
| 7 | +7.75 | -4 | code | system / ProtectedFixedArray |
| 8 | +7.60 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 9 | +6.59 | +72 | code | system / BytecodeArray |
| 10 | +6.57 | +62 | hidden | system / WeakArrayList |
| 11 | +4.81 | +44 | native | PerformanceScriptTiming |
| 12 | +4.59 | +39 | native | PerformanceLongAnimationFrameTiming |
| 13 | +4.38 | +36 | code | system / FeedbackVector |
| 14 | +3.78 | +32 | native | TaskAttributionTiming |
| 15 | +3.50 | +2 | string | label:MuiButtonBase-root;display:inline-flex;align-items:... |
| 16 | +3.45 | +21 | native | <style data-emotion="css" data-s=""> |
| 17 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 18 | +3.28 | +32 | native | PerformanceLongTaskTiming |
| 19 | +3.25 | +13 | code | (BASELINE instruction stream) |
| 20 | +2.84 | +72 | code | system / ScopeInfo |
| 21 | +2.69 | +1 | code | (instruction stream for advanceLerp) |
| 22 | +2.69 | +1 | code | (instruction stream for poll) |
| 23 | +2.51 | +2 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 24 | +2.44 | +13 | native | CSSStyleSheet |
| 25 | +1.85 | +68 | code | (object elements) |