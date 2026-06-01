# Heap snapshot diff — 60s survived active combat (feel-test-25, worker=0)

**Window**: t=10s → t=70s — player held-fire + thrust the entire window without dying.
**Worker**: 0 (matches user phone path).

**Stats**:
- Total groups with non-zero delta: 2502
- Total growing bytes: 2.26 MB
- Total shrinking bytes: -0.02 MB
- Net delta: 2.24 MB

## Top-40 growers

| Rank | Δ size (KB) | Δ count | Type | Name |
|---:|---:|---:|---|---|
| 1 | +890.44 | +487 | code |  |
| 2 | +320.25 | +1372 | code | system / TrustedByteArray |
| 3 | +185.46 | +6046 | object | Object |
| 4 | +168.50 | +14379 | number | heap number |
| 5 | +136.60 | +487 | code | system / ProtectedFixedArray |
| 6 | +74.26 | +1072 | hidden | system / WeakArrayList |
| 7 | +38.28 | +350 | native | PerformanceScriptTiming |
| 8 | +28.54 | +487 | code | (code) |
| 9 | +23.19 | +148 | array | (object properties) |
| 10 | +22.99 | +487 | code | system / TrustedWeakFixedArray |
| 11 | +22.92 | +1467 | object | Array |
| 12 | +21.78 | +743 | hidden | system / PropertyArray |
| 13 | +20.02 | +427 | object | _CanvasTextMetrics2 |
| 14 | +16.94 | +0 | hidden | system / Managed<wasm::NativeModule> |
| 15 | +15.70 | +134 | native | PerformanceLongAnimationFrameTiming |
| 16 | +15.70 | +134 | native | TaskAttributionTiming |
| 17 | +14.81 | +632 | object | EE |
| 18 | +14.11 | +93 | code | system / FeedbackVector |
| 19 | +13.61 | +134 | native | PerformanceLongTaskTiming |
| 20 | +11.62 | +85 | object | _TextureSource2 |
| 21 | +9.02 | +318 | code | system / WeakArrayList |
| 22 | +8.46 | +69 | code | system / BytecodeArray |
| 23 | +7.56 | +1 | code | (instruction stream for updateLingeringShips) |
| 24 | +7.02 | +29 | object | _Graphics |
| 25 | +6.64 | +85 | native | WebGLTexture |
| 26 | +6.64 | +85 | object | Texture |
| 27 | +6.44 | +9 | code | (BASELINE instruction stream) |
| 28 | +5.31 | +1 | code | (instruction stream for handleDamage) |
| 29 | +5.06 | +1 | code | (instruction stream for applyCollisionResolved) |
| 30 | +4.70 | +601 | code | system / CodeWrapper |
| 31 | +4.64 | +291 | code | system / LoadHandler |
| 32 | +4.38 | +17 | array |  |
| 33 | +3.98 | +85 | object | GlTexture |
| 34 | +3.80 | +487 | hidden | system / SharedFunctionInfoWrapper |
| 35 | +3.73 | +239 | object | Events |
| 36 | +3.38 | +1 | code | (instruction stream for performFetch) |
| 37 | +3.28 | +84 | object | _Matrix |
| 38 | +3.00 | +2 | code | (instruction stream for postrender) |
| 39 | +2.87 | +147 | concatenated string | (concatenated string) |
| 40 | +2.70 | +69 | code | system / ScopeInfo |