# Heap snapshot diff — mobile emu (4x CPU, 414x896 DPR 2), 180s hostile combat

**Snapshots**: `diag\measurements\2026-05-30-mobile-emu\snap-t05-1780168866170.heapsnapshot` → `diag\measurements\2026-05-30-mobile-emu\snap-t180-1780168866170.heapsnapshot`

**Stats**:
- Total groups with non-zero delta: 906
- Total growing bytes: 108.8 KB
- Total shrinking bytes: -1065.8 KB
- Net delta: -957.0 KB

## Top-25 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +12.56 | +1 | code | (instruction stream for Dialog2) |
| 2 | +7.71 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 3 | +6.59 | +72 | code | system / BytecodeArray |
| 4 | +4.47 | +38 | native | PerformanceLongAnimationFrameTiming |
| 5 | +4.00 | +34 | native | TaskAttributionTiming |
| 6 | +3.83 | +35 | native | PerformanceScriptTiming |
| 7 | +3.77 | +35 | code | system / FeedbackVector |
| 8 | +3.50 | +2 | string | label:MuiButtonBase-root;display:inline-flex;align-items:... |
| 9 | +3.47 | +34 | native | PerformanceLongTaskTiming |
| 10 | +3.45 | +21 | native | <style data-emotion="css" data-s=""> |
| 11 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 12 | +3.25 | +13 | code | (BASELINE instruction stream) |
| 13 | +3.04 | +135 | code | (constant elements) |
| 14 | +2.84 | +72 | code | system / ScopeInfo |
| 15 | +2.69 | +30 | code | system / TrustedByteArray |
| 16 | +2.69 | +1 | code | (instruction stream for poll) |
| 17 | +2.51 | +2 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 18 | +2.44 | +13 | native | CSSStyleSheet |
| 19 | +1.66 | +72 | code | system / FeedbackMetadata |
| 20 | +1.66 | +71 | code | (constant pool) |
| 21 | +1.41 | +52 | code | system / AllocationSite |
| 22 | +1.25 | +76 | code | system / LoadHandler |
| 23 | +1.13 | +1 | code | (instruction stream for useUtilityClasses) |
| 24 | +1.06 | +1 | code | (instruction stream for styleFromPropValue) |
| 25 | +0.88 | +1 | code | (instruction stream for _parse) |