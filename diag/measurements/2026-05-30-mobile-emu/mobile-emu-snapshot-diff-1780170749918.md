# Heap snapshot diff — mobile emu (4x CPU, 414x896 DPR 2), 180s hostile combat

**Snapshots**: `diag\measurements\2026-05-30-mobile-emu\snap-t05-1780170749918.heapsnapshot` → `diag\measurements\2026-05-30-mobile-emu\snap-t180-1780170749918.heapsnapshot`

**Stats**:
- Total groups with non-zero delta: 948
- Total growing bytes: 179.7 KB
- Total shrinking bytes: -1068.3 KB
- Net delta: -888.6 KB

## Top-25 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +33.56 | +15 | code |  |
| 2 | +24.16 | +125 | code | system / TrustedByteArray |
| 3 | +12.56 | +1 | code | (instruction stream for Dialog2) |
| 4 | +7.71 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 5 | +5.58 | +70 | code | system / BytecodeArray |
| 6 | +5.44 | +1 | code | (instruction stream for MetaLandingScreen) |
| 7 | +4.89 | +14 | code | system / ProtectedFixedArray |
| 8 | +4.83 | +27 | hidden | system / WeakArrayList |
| 9 | +4.31 | +1 | code | (instruction stream for captureSnapshot) |
| 10 | +4.15 | +35 | code | system / FeedbackVector |
| 11 | +3.69 | +15 | code | (BASELINE instruction stream) |
| 12 | +3.50 | +2 | string | label:MuiButtonBase-root;display:inline-flex;align-items:... |
| 13 | +3.45 | +21 | native | <style data-emotion="css" data-s=""> |
| 14 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 15 | +3.17 | +29 | native | PerformanceScriptTiming |
| 16 | +2.93 | +25 | native | PerformanceLongAnimationFrameTiming |
| 17 | +2.93 | +25 | native | TaskAttributionTiming |
| 18 | +2.76 | +70 | code | system / ScopeInfo |
| 19 | +2.69 | +1 | code | (instruction stream for poll) |
| 20 | +2.54 | +25 | native | PerformanceLongTaskTiming |
| 21 | +2.51 | +2 | string | label:MuiButton-root;font-family:"Inter", "Roboto Mono", ... |
| 22 | +2.44 | +13 | native | CSSStyleSheet |
| 23 | +1.58 | +58 | code | system / AllocationSite |
| 24 | +1.52 | +70 | code | system / FeedbackMetadata |
| 25 | +1.45 | +69 | code | (constant pool) |