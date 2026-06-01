# Heap snapshot diff — mobile emu (4x CPU, 414x896 DPR 2), 180s hostile combat

**Snapshots**: `diag\measurements\2026-05-30-mobile-emu\snap-t05-1780168431818.heapsnapshot` → `diag\measurements\2026-05-30-mobile-emu\snap-t180-1780168431818.heapsnapshot`

**Stats**:
- Total groups with non-zero delta: 881
- Total growing bytes: 107.0 KB
- Total shrinking bytes: -1030.6 KB
- Net delta: -923.6 KB

## Top-25 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +12.56 | +1 | code | (instruction stream for Dialog2) |
| 2 | +7.71 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 3 | +5.58 | +70 | code | system / BytecodeArray |
| 4 | +5.25 | +36 | code | system / TrustedByteArray |
| 5 | +4.19 | +167 | code | (constant elements) |
| 6 | +3.72 | +34 | code | system / FeedbackVector |
| 7 | +3.52 | +30 | native | PerformanceLongAnimationFrameTiming |
| 8 | +3.50 | +2 | string | label:MuiButtonBase-root;display:inline-flex;align-items:... |
| 9 | +3.45 | +21 | native | <style data-emotion="css" data-s=""> |
| 10 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 11 | +3.25 | +13 | code | (BASELINE instruction stream) |
| 12 | +2.84 | +26 | native | PerformanceScriptTiming |
| 13 | +2.76 | +70 | code | system / ScopeInfo |
| 14 | +2.69 | +1 | code | (instruction stream for poll) |
| 15 | +2.58 | +22 | native | TaskAttributionTiming |
| 16 | +2.51 | +2 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 17 | +2.44 | +13 | native | CSSStyleSheet |
| 18 | +2.23 | +22 | native | PerformanceLongTaskTiming |
| 19 | +2.13 | -24 | hidden | system / WeakArrayList |
| 20 | +1.52 | +70 | code | system / FeedbackMetadata |
| 21 | +1.45 | +69 | code | (constant pool) |
| 22 | +1.41 | +52 | code | system / AllocationSite |
| 23 | +1.21 | +74 | code | system / LoadHandler |
| 24 | +1.13 | +1 | code | (instruction stream for useUtilityClasses) |
| 25 | +1.06 | +1 | code | (instruction stream for styleFromPropValue) |