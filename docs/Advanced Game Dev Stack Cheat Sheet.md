# **Cheat Sheet and Edge-Case Reference Document: Multiplayer WebGL/WASM Architecture**

## **1\. Rapier (WASM) & JS Interop Optimization**

### **Minimizing JS/WASM Boundary Overhead in the Hot Loop**

The integration of WebAssembly (WASM) into modern JavaScript engines introduces a complex polyglot environment with disparate memory models and type systems.1 When executing a hot loop at 60-144Hz, standard JavaScript bindings for Rapier generate unacceptable execution overhead. There is no link-time optimization (LTO) or inlining across the JS-WASM boundary.2 Consequently, every invocation of a getter like rigidBody.translation() forces the engine to construct a stack frame, execute the boundary transition, allocate a JavaScript object (e.g., Vector3), and return it, completely disrupting the CPU pipeline and generating garbage.

To achieve optimal performance, the JS API must be bypassed. Read transformations directly from the WASM linear memory. The WASM memory buffer is exposed via wasmInstance.exports.memory.buffer.4 By mapping a Float32Array view directly over the memory segment where Rapier stores its internal vectors, transforms can be extracted with zero-copy overhead.6

TypeScript

// WASM Memory View Implementation  
let wasmMemory: ArrayBuffer \= wasmInstance.exports.memory.buffer; \[4\]  
let physicsTransforms \= new Float32Array(wasmMemory);

// Required due to WASM dynamic memory growth  
function updateMemoryView() {  
    if (wasmMemory.byteLength \=== 0) {  
        // Memory has detached due to a \`memory.grow\` instruction  
        wasmMemory \= wasmInstance.exports.memory.buffer;  
        physicsTransforms \= new Float32Array(wasmMemory);  
    }  
}

// Bypassing Rapier API in the hot loop  
function extractTransforms(bodyHandles: number, transformBuffer: Float32Array) {  
    updateMemoryView();  
    const len \= bodyHandles.length;  
    for (let i \= 0; i \< len; i++) {  
        const handle \= bodyHandles\[i\];  
        // Calculate the raw pointer address based on Rapier's internal layout  
        // Note: Offset logic requires inspecting the specific Rapier version's ABI  
        const ptr \= getBodyTransformPointer(handle) \>\> 2; // Right shift for Float32 offset  
          
        // Zero-copy, zero-allocation memory reads  
        transformBuffer\[i \* 7 \+ 0\] \= physicsTransforms\[ptr\];     // x  
        transformBuffer\[i \* 7 \+ 1\] \= physicsTransforms\[ptr \+ 1\]; // y  
        transformBuffer\[i \* 7 \+ 2\] \= physicsTransforms\[ptr \+ 2\]; // z  
        transformBuffer\[i \* 7 \+ 3\] \= physicsTransforms\[ptr \+ 3\]; // qx  
        transformBuffer\[i \* 7 \+ 4\] \= physicsTransforms\[ptr \+ 4\]; // qy  
        transformBuffer\[i \* 7 \+ 5\] \= physicsTransforms\[ptr \+ 5\]; // qz  
        transformBuffer\[i \* 7 \+ 6\] \= physicsTransforms\[ptr \+ 6\]; // qw  
    }  
}

### **Advanced Deterministic Rollback Evasion**

Server reconciliation typically demands deterministic rollbacks. world.takeSnapshot() serializes the active physics state into a newly allocated Uint8Array.7 Invoking this method continuously at 60Hz floods V8's Young Generation memory space, forcing the Scavenger to execute stop-the-world pauses.

Furthermore, invoking world.restoreSnapshot() presents severe memory constraints. Restoring a snapshot rebuilds the internal WASM state but does not sever JavaScript-side references to older physics objects, leading to massive memory leaks if references to discarded RigidBody objects are retained.8 Additionally, dynamically spawning and despawning objects while utilizing the QueryPipeline induces a linear memory leak in Rapier 0.17.2, harming memory bandwidth.9

**Rollback Optimization Protocol:**

1. **Memory Pre-allocation:** Execute RAPIER.reserveMemory() post-initialization to forcefully pre-allocate internal limits, preventing mid-simulation memory.grow calls that detach buffers.10  
2. **Ring Buffer State Injection:** Do not use takeSnapshot() in the 60Hz loop. Instead, maintain a pre-allocated JS-side Float32Array ring buffer containing minimal kinematic data (Position, Rotation, Linear Velocity, Angular Velocity).  
3. **Targeted Snapshotting:** Reserve world.takeSnapshot() exclusively for authoritative desync events that exceed a predefined error threshold.  
4. **Determinism Edge-Case:** Never invoke collider.setRotationWrtParent or rigidBody.setRotation when operating a rollback architecture. Applying these methods after World.restoreSnapshot destroys the internal determinism state, causing the simulation to permanently diverge.11

### **Floating-Point Drift: Node.js vs. Browser**

Rapier guarantees cross-platform determinism provided the host hardware strictly complies with IEEE 754-2008 standards.12 To achieve this, Rapier compiles a software-based libm implementation to process mathematical functions deterministically, bypassing inconsistent hardware FPUs.12

Despite this, floating-point drift will contaminate the simulation if the JavaScript input layer passes non-deterministic data across the boundary.14

| Floating-Point Issue | Origin Mechanism | Mitigation Strategy |
| :---- | :---- | :---- |
| **Transcendental Functions** | Math.sin(), Math.cos(), Math.exp() rely on underlying C/C++ runtime implementations which differ between OS and CPU architectures (e.g., ARM vs x86).14 | Implement a strict, pre-computed Lookup Table (LUT) or compile a deterministic fixed-point math WASM module exclusively for calculating input forces. |
| **Fused Multiply-Add (FMA)** | JIT compilers (V8 Turbofan) optimize (a \* b) \+ c into single FMA hardware instructions, skipping intermediate 64-bit IEEE truncation. | Enforce strict intermediate variable assignment or execute all input vector calculations within the deterministic Rust/WASM context. |
| **Instruction Reordering** | V8 is permitted to alter the execution order of commutative floating-point operations.15 | Avoid complex chained mathematics in JS. Isolate logic into discrete, un-optimizable steps or rely entirely on Rapier's internal force integration. |

### **Physics Memory Management and Graph Recycling**

The dynamic BVH (Bounding Volume Hierarchy) utilized by Rapier 16 suffers extreme performance degradation when rigid bodies and colliders are frequently instantiated and destroyed. Operations like world.removeRigidBody() force internal graph restructuring and memory fragmentation.

Implement a strict Object Pooling paradigm specifically for physics instances:

* **Initialization:** Allocate the maximum theoretical number of entities as RigidBody and Collider pairs at boot.  
* **Deactivation:** When an entity is destroyed logically, do not execute removeRigidBody. Instead, translate the body to an isolated, off-screen coordinate sector (e.g., \-99999.0). Set rigidBody.setLinvel(zero) and rigidBody.setAngvel(zero) 8, disable Continuous Collision Detection (CCD) via configuration 10, modify the collision groups to ignore all layers 17, and invoke rigidBody.sleep().  
* **Reactivation:** Extract a body from the pool, wake() it, set its new active translation, re-apply the correct collision\_groups 17, and restore CCD.

## **2\. V8 Engine & Garbage Collection Evasion**

### **The Zero-Allocation Hot Loop**

Achieving a steady 144Hz physics and rendering cadence requires evading the V8 garbage collector entirely. V8 utilizes a generational GC: newly allocated objects are pushed to the Young Generation, managed by a Scavenger algorithm. When the Young Generation fills, the Scavenger stops the main thread, traces live objects, and copies them to the Old Generation, causing severe micro-stutters.18

To execute a zero-allocation game loop, implement these rigorous patterns:

1. **Ban the new keyword:** Object creation must occur strictly during application initialization. Banish new RAPIER.Vector3(), new PIXI.Point(), and new Object() from the tick logic.8 Utilize static, pre-allocated temporary variables for vector math.  
2. **Ban Array Mutations:** Methods like Array.prototype.push() force V8 to reallocate the array's backing store once its capacity is exceeded, copying all elements to a new memory segment.21 Pre-allocate arrays to their exact maximum length using new Array(MAX\_ENTITIES) or prefer TypedArrays.21  
3. **Ban High-Order Functions:** Do not utilize .map(), .filter(), or .reduce() in the tick. These create internal closure environments and intermediate arrays. Use traditional for loops and cache the length (const len \= arr.length; for(let i \= 0; i \< len; i++)).22  
4. **Ban Spread syntax and Destructuring:** Operations like const { x, y } \= body.translation() frequently bypass escape analysis and generate temporary allocation records. Access properties directly.

### **Hidden Classes and Turbofan Deoptimization**

V8 relies on Hidden Classes (Shapes) and Inline Caches (ICs) to optimize property access. If V8 encounters objects with differing shapes (e.g., an entity object where property health was added dynamically after instantiation), the IC becomes polymorphic or megamorphic. Turbofan will subsequently deoptimize the function, abandoning fast machine-code execution for slow dictionary lookups.19

* Initialize all properties within the constructor in the exact same order.  
* Never use the delete keyword. To invalidate a property, set it to 0 or null.19

### **TypedArray over DataView for State Manipulation**

When manipulating raw binary data for Colyseus state mapping or WASM extraction, TypedArray (Float32Array, Int32Array) vastly outperforms DataView.

V8 implements DataView with mandatory, un-optimizable bounds checking and dynamic endianness verification on every invocation. TypedArray accesses are mapped directly to native CPU memory-fetch instructions by Turbofan.24

| Memory Access Pattern | V8 Optimization Level | GC Pressure | Endianness |
| :---- | :---- | :---- | :---- |
| DataView.getFloat32() | Low (Checks invoked per call) 25 | None | Explicit (True/False) |
| Float32Array\[index\] | High (JIT optimized to native) 26 | None | Platform Native |
| new Float32Array(...) | Moderate (Object allocation) 26 | High | Platform Native |

### **Object Pooling Paradigms (SoA vs. AoS)**

The standard Object-Oriented approach maps state as an Array of Structures (AoS). This fragments memory and destroys CPU cache locality. To map Colyseus state updates to PixiJS sprites and Rapier bodies efficiently, implement a Structure of Arrays (SoA) architecture powered by dense TypedArrays.25

Assign every entity a strict Integer ID (0 to MAX\_ENTITIES \- 1). Use this integer as the exact memory offset pointer for all subsystems.

TypeScript

// Dense Structure of Arrays (SoA) Architecture  
class UnifiedSimulationState {  
    // 1 byte per entity (0 \= dead, 1 \= alive)  
    public readonly activeFlags \= new Uint8Array(MAX\_ENTITIES);  
      
    // 32-bit floats for physical parameters  
    public readonly positionsX \= new Float32Array(MAX\_ENTITIES);  
    public readonly positionsY \= new Float32Array(MAX\_ENTITIES);  
    public readonly rotations \= new Float32Array(MAX\_ENTITIES);  
      
    // Pre-allocated object pools  
    public readonly sprites: PIXI.Sprite \= new Array(MAX\_ENTITIES);  
    public readonly bodies: RAPIER.RigidBody \= new Array(MAX\_ENTITIES);

    public tick(dt: number) {  
        const len \= MAX\_ENTITIES;  
        for (let id \= 0; id \< len; id++) {  
            if (this.activeFlags\[id\] \=== 0) continue;  
              
            // Sequential memory access maximizes L1/L2 Cache hit rates  
            const px \= this.positionsX\[id\];  
            const py \= this.positionsY\[id\];  
            const rot \= this.rotations\[id\];  
              
            const sprite \= this.sprites\[id\];  
            sprite.x \= px;  
            sprite.y \= py;  
            sprite.rotation \= rot;  
        }  
    }  
}

## **3\. Advanced Colyseus Networking Tricks**

### **Schema Optimization at Scale**

The standard @colyseus/schema implementation utilizes reflection and incremental delta-encoding. While highly ergonomic, it is inappropriate for high-frequency (e.g., 20-60Hz) continuous physics state. Iterating over MapSchema or ArraySchema to serialize and deserialize 1000+ rigid body transforms introduces extreme CPU overhead, and instances are artificially limited to 64 fields.27

**When to Abandon @schema:** Maintain @schema definitions exclusively for discrete, low-frequency data: inventory, player names, chat, and room meta-data. For the physical hot loop (transforms, velocities), abandon schemas and drop down to custom binary serialization utilizing Colyseus' room.sendBytes() 30 and custom serializers registered via registerSerializer.32

### **Custom Bit-Packing / Binary Serialization Protocol**

A custom protocol bypasses schema overhead entirely and allows for aggressive bit-packing.33 For a 2D physics game, 64-bit IEEE floats are unnecessary. By scaling and truncating physics values into 16-bit integers, payload sizes are drastically reduced, preventing WebSocket buffer bloating.

TypeScript

// Server-Side: Packing transforms into a flat buffer \[34, 35\]  
// Format per entity: \= 8 Bytes  
const BYTES\_PER\_ENTITY \= 8;  
const buffer \= new ArrayBuffer(activeEntityCount \* BYTES\_PER\_ENTITY);  
const view \= new DataView(buffer); // Use DataView only for building the packet if endianness is mixed

let offset \= 0;  
for (let id \= 0; id \< MAX\_ENTITIES; id++) {  
    if (activeFlags\[id\] \=== 0) continue;  
      
    const body \= bodies\[id\];  
    const pos \= body.translation();  
      
    // Fixed-point scaling (e.g., 2 decimal places of precision)  
    const xInt \= Math.round(pos.x \* 100);  
    const yInt \= Math.round(pos.y \* 100);  
    // Radians normalized to Int16  
    const rotInt \= Math.round((body.rotation() / Math.PI) \* 32767);  
      
    view.setUint16(offset, id, true);  
    view.setInt16(offset \+ 2, xInt, true);  
    view.setInt16(offset \+ 4, yInt, true);  
    view.setInt16(offset \+ 6, rotInt, true);  
    offset \+= BYTES\_PER\_ENTITY;  
}

// Broadcast binary payload \[30, 36\]  
room.broadcastBytes(new Uint8Array(buffer)); 

**Client-Side Unpacking Edge Case:**

When decoding on the client via room.onMessage, avoid DataView if endianness is guaranteed (or handle endianness explicitly via bitwise shifts). Note that V8 bitwise operators (\<\<, |, &) natively cast values to 32-bit signed integers.

JavaScript

// High-performance binary decoding \[34\]  
const data \= new Uint8Array(messageBytes);  
for (let i \= 0; i \< data.length; i \+= 8) {  
    const id \= data\[i\] | (data\[i+1\] \<\< 8);  
    // Int16 requires sign extension in JS  
    const x \= (data\[i+2\] | (data\[i+3\] \<\< 8)) \<\< 16 \>\> 16;   
    const y \= (data\[i+4\] | (data\[i+5\] \<\< 8)) \<\< 16 \>\> 16;  
      
    positionsX\[id\] \= x / 100.0;  
    positionsY\[id\] \= y / 100.0;  
}

### **Jitter and TCP/WebSocket Packet Batching**

WebSockets run over TCP. To conserve bandwidth, OS network stacks and browsers invoke Nagle's Algorithm, batching small packets into single TCP frames.37 Consequently, the client does not receive a perfectly spaced 20Hz cadence. Instead, it receives silence, followed by a dense burst of state packets.

Applying these state packets immediately upon the Colyseus onMessage event forces the physics bodies and PixiJS sprites to snap erratically, causing visual jitter.

**The Jitter Buffer Algorithm:**

Decouple packet reception from state interpolation.

1. **Ingestion:** When Colyseus fires onMessage, append the decoded state to a circular JitterBuffer alongside its absolute server-side generation timestamp.  
2. **Delayed Playback:** The client rendering loop operates in the past. Calculate the playback time: render\_time \= current\_local\_server\_time \- INTERPOLATION\_DELAY (typically 50-100ms).  
3. **Interpolation:** The client searches the Jitter Buffer for the two state snapshots that bracket the render\_time (![][image1] and ![][image2]) and calculates the lerp factor ![][image3]. Transforms are interpolated, ensuring smooth PixiJS rendering despite erratic WebSocket packet delivery.

### **Reconciling Discrete Predicted Events**

In server-authoritative architectures, clients run local prediction for immediate responsiveness. Continuous state (movement) is easily corrected via interpolation, but discrete events (e.g., a bullet hitting a player) are problematic. If the client predicts a hit, but the server rejects it (due to latency discrepancies), rolling back the simulation requires invoking world.restoreSnapshot(), triggering severe GC spikes and breaking determinism.

**Decoupled Ghost Strategy:**

Instead of mutating the authoritative WASM physics state upon a predicted collision, implement a deferred reconciliation visual layer.

1. **Collision Masking:** When a predicted bullet hits an entity, do *not* call world.removeRigidBody(). Instead, flag the entity as PendingVerification.  
2. **Sensory Disconnect:** Instantly hide the PixiJS sprite and modify the entity's Rapier collision\_groups 17 to an isolated bitmask, rendering it physical intangible to other predicted entities. It becomes a "ghost".  
3. **Server Resolution:**  
   * *Acknowledge (Hit Valid):* The server confirms the kill. Purge the entity from the Object Pool permanently.  
   * *Reject (Hit Invalid):* The server denies the kill. Clear the PendingVerification flag, un-hide the PixiJS sprite, and restore the original collision\_groups mask.  
     This entirely circumvents the need to trigger catastrophic WASM snapshot rollbacks for single-event mispredictions.

## **4\. Multi-Threading & Extreme Rendering (PixiJS)**

### **Web Worker Architecture**

The JavaScript main thread is shared between DOM rendering, garbage collection, and WebGL execution. Attempting to execute Colyseus networking, Rapier WASM physics integration, and PixiJS matrix calculations on a single thread will inevitably breach the 16.67ms frame budget, resulting in dropped frames.38

To circumvent this, the architecture must completely segregate concerns:

* **Worker Thread (Logic/Physics):** Imports Colyseus, establishes the WebSocket connection, deserializes bit-packed binary payloads, manages the Rapier World, and executes the fixed 60Hz accumulator loop.40  
* **Main Thread (Render):** Initializes PixiJS. Hooks into requestAnimationFrame (rAF). Reads transform data, updates the Scene Graph, and issues WebGL draw calls.

### **Passing Interpolated Buffers via SharedArrayBuffer**

The standard worker.postMessage() API relies on the Structured Clone algorithm or Transferable Objects. Structured Cloning duplicates data, causing high GC pressure. Transferable Objects (postMessage(buffer, \[buffer\])) zero-copy the data, but destroy the reference in the originating thread, necessitating a constant, expensive ping-pong of array buffers.41

SharedArrayBuffer (SAB) is the ultimate primitive for this stack. It allocates a continuous block of raw binary memory that both the Main Thread and Worker Thread map simultaneously, eliminating serialization completely.41

**Security Context Headers:** To mitigate Spectre/Meltdown timing attacks, browsers disable SAB unless the server provides strict cross-origin isolation headers 41:

* Cross-Origin-Opener-Policy: same-origin  
* Cross-Origin-Embedder-Policy: require-corp

**Lock-Free SAB Synchronization:** Standard multi-threaded SAB programming dictates using Atomics.wait() and Atomics.notify() to enforce mutex locks during read/write cycles to prevent data tearing.47 However, Atomics.wait() is blocking and is explicitly prohibited on the browser's Main Thread.49

Fortunately, PixiJS only requires the latest available transform state for drawing. Because the CPU guarantees atomic writes for aligned 32-bit values (like Float32), we can forgo strict mutexes. The Worker Thread overwrites the SAB continuously, and the Main Thread reads whatever floats are currently present during the requestAnimationFrame callback.

JavaScript

// WORKER THREAD: Initialization & Writing  
const sab \= new SharedArrayBuffer(MAX\_ENTITIES \* 3 \* 4); // x, y, rot (Float32)  
const transformView \= new Float32Array(sab);  
self.postMessage({ type: 'SAB\_INIT', sab });

function physicsTick() {  
    world.step();  
    for (let id \= 0; id \< MAX\_ENTITIES; id++) {  
        // Write directly to shared memory  
        transformView\[id \* 3 \+ 0\] \= positionsX\[id\];   
        transformView\[id \* 3 \+ 1\] \= positionsY\[id\];  
        transformView\[id \* 3 \+ 2\] \= rotations\[id\];  
    }  
}

// MAIN THREAD: PixiJS Reading  
let sharedTransforms;  
worker.onmessage \= (e) \=\> {  
    if (e.data.type \=== 'SAB\_INIT') {  
        sharedTransforms \= new Float32Array(e.data.sab);  
    }  
};

app.ticker.add(() \=\> {  
    if (\!sharedTransforms) return;  
    for (let id \= 0; id \< MAX\_ENTITIES; id++) {  
        const sprite \= spritePool\[id\];  
        // Zero-copy, lock-free read directly from Worker memory  
        sprite.x \= sharedTransforms\[id \* 3 \+ 0\];  
        sprite.y \= sharedTransforms\[id \* 3 \+ 1\];  
        sprite.rotation \= sharedTransforms\[id \* 3 \+ 2\];  
    }  
});

### **Leveraging Rapier's Broad-Phase for PixiJS Culling**

If MAX\_ENTITIES scales to 10,000, updating every PixiJS sprite in the scene graph—even via SAB—will bottleneck the CPU's iteration limits and flood the WebGL command buffer.50 Render updates must be culled to off-screen entities.

Traditional distance checks (![][image4] iteration) are too slow. Instead, leverage Rapier's heavily optimized internal Dynamic BVH (Bounding Volume Hierarchy), which is automatically updated during world.step().16

Utilize the QueryPipeline.51 Create an AABB (Axis-Aligned Bounding Box) representing the exact dimensions of the PixiJS camera viewport. Invoke queryPipeline.collidersWithAabbIntersecting(). This executes an extremely fast logarithmic search through the broad-phase tree, returning only the handles of objects physically located on-screen.51

TypeScript

// Render Culling via Broad-Phase \[52, 53\]  
const camAABB \= new RAPIER.Aabb(  
    { x: camera.x \- screenW / 2, y: camera.y \- screenH / 2 },  
    { x: camera.x \+ screenW / 2, y: camera.y \+ screenH / 2 }  
);

// Array to track which entities were rendered this frame  
const renderedThisFrame \= new Uint8Array(MAX\_ENTITIES);

// intersect\_aabb\_conservative performs zero narrow-phase collision math \[52\]  
world.queryPipeline.collidersWithAabbIntersecting(camAABB, (handle) \=\> {  
    const entityId \= getEntityIdFromCollider(handle);  
    const sprite \= spritePool\[entityId\];  
      
    // Update transforms only for visible entities  
    sprite.x \= sharedTransforms\[entityId \* 3 \+ 0\];  
    sprite.y \= sharedTransforms\[entityId \* 3 \+ 1\];  
    sprite.visible \= true;  
    renderedThisFrame\[entityId\] \= 1;  
      
    return true; // Continue traversal  
});

// Post-process: Hide entities that fell outside the AABB  
// (Optimize this loop via bitsets in production)  
for(let id \= 0; id \< MAX\_ENTITIES; id++) {  
    if (renderedThisFrame\[id\] \=== 0) spritePool\[id\].visible \= false;  
}

## **5\. Clock Synchronization & Time Manipulation**

### **Advanced NTP-Style Logical Clocks**

In deterministic setups, the client must execute logic at the precise logical time dictated by the authoritative server. JavaScript's Date.now() is inherently flawed: it relies on the OS system clock, which can be altered by the user or NTP daemon syncing, causing time to jump forwards or backwards non-monotonically.

Strictly enforce performance.timeOrigin \+ performance.now() across all calculations to ensure monotonic, high-precision microsecond resolution.54

To sync the client to the Colyseus server, implement the WST (WebSocket Time) protocol—a lightweight derivative of the Network Time Protocol (NTP).56

1. The Client transmits a packet containing its local dispatch timestamp (![][image1]).  
2. The Server receives the packet, logging arrival time (![][image2]). It processes the payload, logs dispatch time (![][image5]), and transmits the packet back.  
3. The Client receives the packet at timestamp (![][image6]).

The exact network latency and clock offset are derived mathematically:

* **Round Trip Delay:** ![][image7]  
* **One-way Latency:** ![][image8]  
* **Server Clock Offset:** ![][image9]

The absolute server time on the client becomes performance.now() \+ offset.

**Smooth Drift Correction:** Over extended sessions, hardware oscillator discrepancies will cause the client and server clocks to drift. Snapping the client clock to a new offset instantly causes the physics simulation to skip or duplicate frames. Implement a smooth time correction algorithm 55: If the newly calculated offset differs from the current offset by less than a threshold (e.g., 50ms), interpolate the difference gradually over 10 seconds. Only force a hard-snap if the discrepancy exceeds 500ms.55

### **Browser Tab Throttling and The Spiral of Death**

Modern browsers aggressively throttle resource usage in inactive tabs. On iOS Safari, Low Power Mode explicitly caps requestAnimationFrame (rAF) to 30Hz.57 Furthermore, if a user minimizes the browser or switches tabs, Chrome and Firefox will suspend rAF and throttle setTimeout entirely.58

When the user returns to the tab, the requestAnimationFrame loop resumes. If the timing algorithm calculates delta-time directly (dt \= now \- lastTime), the resulting dt may be an accumulation of 30 seconds.60

If this massive dt is fed into a while loop that attempts to catch the simulation up via 1,800 consecutive world.step() calls, the main thread will lock up completely, causing a browser "Unresponsive Script" crash—a phenomenon known as the "Spiral of Death."

### **The Decoupled Catch-Up Architecture**

To securely map timing discrepancies, decouple the visual frame rate from the physical timestep using an Accumulator architecture, and enforce strict upper bounds on simulation time.60

TypeScript

const PHYSICS\_HZ \= 60;  
const FIXED\_DT \= 1.0 / PHYSICS\_HZ;  
const MAX\_CATCHUP\_TIME \= 0.25; // Maximum time allowed to simulate per frame (250ms)

let accumulator \= 0.0;  
let lastTime \= performance.now();

function executeGameLoop() {  
    requestAnimationFrame(executeGameLoop);  
      
    const now \= performance.now();  
    let frameTime \= (now \- lastTime) / 1000.0;  
    lastTime \= now;

    // Evasion of the Spiral of Death  
    if (frameTime \> MAX\_CATCHUP\_TIME) {  
        // The tab was throttled or minimized for a significant period.  
        // It is mathematically unsafe to simulate the missed physics steps.  
        console.warn(\`Massive frame drop detected: ${frameTime}s. Aborting simulation catch-up.\`);  
          
        // 1\. Cap the accumulator to prevent infinite while-loops  
        frameTime \= FIXED\_DT;   
          
        // 2\. Halt prediction and request an authoritative state dump from Colyseus  
        colyseusRoom.send("REQUEST\_FULL\_STATE"); \[30, 31\]  
          
        // 3\. Upon receiving the dump, snap the physics state:  
        // world.restoreSnapshot(binaryState);   
    }

    accumulator \+= frameTime;

    // Step physics at strictly deterministic increments  
    while (accumulator \>= FIXED\_DT) {  
        world.step();  
        accumulator \-= FIXED\_DT;  
    }  
      
    // Calculate fractional remainder for PixiJS visual interpolation  
    const alpha \= accumulator / FIXED\_DT;  
    renderPixiScene(alpha);  
}

By enforcing MAX\_CATCHUP\_TIME, the engine acknowledges that physical determinism has been irrevocably broken by the browser's aggressive throttling. Rather than burning CPU cycles simulating historical frames the user never saw, the client abandons prediction, pauses rendering, and synchronizes securely with the authoritative Colyseus state buffer.

#### **Works cited**

1. Weaver: Fuzzing JavaScript Engines at the JavaScript-WebAssembly Boundary \- arXiv, accessed on April 26, 2026, [https://arxiv.org/html/2603.18789v1](https://arxiv.org/html/2603.18789v1)  
2. Devsh-Graphics-Programming/JS-WASM-interop-benchmark \- GitHub, accessed on April 26, 2026, [https://github.com/Devsh-Graphics-Programming/JS-WASM-interop-benchmark](https://github.com/Devsh-Graphics-Programming/JS-WASM-interop-benchmark)  
3. I was understanding WASM all wrong\! | by Yuji Isobe \- Medium, accessed on April 26, 2026, [https://medium.com/@yujiisobe/i-was-understanding-wasm-all-wrong-e4bcab8d077c](https://medium.com/@yujiisobe/i-was-understanding-wasm-all-wrong-e4bcab8d077c)  
4. WebAssembly.Memory.prototype.buffer \- MDN Web Docs, accessed on April 26, 2026, [https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript\_interface/Memory/buffer](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/buffer)  
5. How to pass a buffer pointer to a WebAssembly function \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/73232586/how-to-pass-a-buffer-pointer-to-a-webassembly-function](https://stackoverflow.com/questions/73232586/how-to-pass-a-buffer-pointer-to-a-webassembly-function)  
6. Most performant way to pass data JS/WASM context · Issue \#1231 · WebAssembly/design, accessed on April 26, 2026, [https://github.com/WebAssembly/design/issues/1231](https://github.com/WebAssembly/design/issues/1231)  
7. Serialization \- Rapier physics engine, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/javascript/serialization/](https://rapier.rs/docs/user_guides/javascript/serialization/)  
8. Unstable core features · Issue \#283 · dimforge/rapier.js \- GitHub, accessed on April 26, 2026, [https://github.com/dimforge/rapier.js/issues/283](https://github.com/dimforge/rapier.js/issues/283)  
9. Bug: Incrementally-updated \`QueryPipeline\` memory usage linearly grows over time. · Issue \#617 · dimforge/rapier \- GitHub, accessed on April 26, 2026, [https://github.com/dimforge/rapier/issues/617](https://github.com/dimforge/rapier/issues/617)  
10. CHANGELOG.md \- rapier.js \- GitHub, accessed on April 26, 2026, [https://github.com/dimforge/rapier.js/blob/master/CHANGELOG.md](https://github.com/dimforge/rapier.js/blob/master/CHANGELOG.md)  
11. Loss of determinism when using collider.setRotationWrtParent or rigidBody.setRotation · Issue \#797 · dimforge/rapier \- GitHub, accessed on April 26, 2026, [https://github.com/dimforge/rapier/issues/797](https://github.com/dimforge/rapier/issues/797)  
12. Cross-platform deterministic physics with Unity DOTS physics and soft floats \- Reddit, accessed on April 26, 2026, [https://www.reddit.com/r/Unity3D/comments/lkxb9d/crossplatform\_deterministic\_physics\_with\_unity/](https://www.reddit.com/r/Unity3D/comments/lkxb9d/crossplatform_deterministic_physics_with_unity/)  
13. I think some people have gotten the mistaken idea that floating point arithmetic... | Hacker News, accessed on April 26, 2026, [https://news.ycombinator.com/item?id=33056043](https://news.ycombinator.com/item?id=33056043)  
14. Determinism \- Rapier physics engine, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/javascript/determinism/](https://rapier.rs/docs/user_guides/javascript/determinism/)  
15. JavaScript and Dealing with Floating Point Determinism \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/11493279/javascript-and-dealing-with-floating-point-determinism](https://stackoverflow.com/questions/11493279/javascript-and-dealing-with-floating-point-determinism)  
16. The Rapier physics engine 2025 review and 2026 goals \- Dimforge, accessed on April 26, 2026, [https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/](https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/)  
17. Colliders \- Rapier physics engine, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/rust/colliders/](https://rapier.rs/docs/user_guides/rust/colliders/)  
18. Garbage collection in V8, an illustrated guide | by Irina Shestak \- Medium, accessed on April 26, 2026, [https://medium.com/@\_lrlna/garbage-collection-in-v8-an-illustrated-guide-d24a952ee3b8](https://medium.com/@_lrlna/garbage-collection-in-v8-an-illustrated-guide-d24a952ee3b8)  
19. Understanding the V8 Engine: Optimizing JavaScript for Peak Performance, accessed on April 26, 2026, [https://dev.to/parthchovatiya/understanding-the-v8-engine-optimizing-javascript-for-peak-performance-1c9b](https://dev.to/parthchovatiya/understanding-the-v8-engine-optimizing-javascript-for-peak-performance-1c9b)  
20. memory management \- Pattern for no-allocation loops in JavaScript? \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/18421845/pattern-for-no-allocation-loops-in-javascript](https://stackoverflow.com/questions/18421845/pattern-for-no-allocation-loops-in-javascript)  
21. How does V8 optimise the creation of very large arrays? \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/54481918/how-does-v8-optimise-the-creation-of-very-large-arrays](https://stackoverflow.com/questions/54481918/how-does-v8-optimise-the-creation-of-very-large-arrays)  
22. Writing Faster JavaScript: V8 Compiler Fundamentals | by Manish Prasad | Node Depths, accessed on April 26, 2026, [https://medium.com/node-depths/writing-faster-javascript-v8-compiler-fundamentals-1fa40941b749](https://medium.com/node-depths/writing-faster-javascript-v8-compiler-fundamentals-1fa40941b749)  
23. Performance tips for JavaScript in V8 | Articles \- web.dev, accessed on April 26, 2026, [https://web.dev/articles/speed-v8](https://web.dev/articles/speed-v8)  
24. Improving DataView performance in V8 \- V8.dev, accessed on April 26, 2026, [https://v8.dev/blog/dataview](https://v8.dev/blog/dataview)  
25. V8 Engine Secrets Slashed Memory Usage by 66% with TypedArrays \- DEV Community, accessed on April 26, 2026, [https://dev.to/asadk/v8-engine-secrets-how-we-slashed-memory-usage-by-66-with-typedarrays-g95](https://dev.to/asadk/v8-engine-secrets-how-we-slashed-memory-usage-by-66-with-typedarrays-g95)  
26. Array vs TypedArray performance question · Issue \#2926 · nodejs/help \- GitHub, accessed on April 26, 2026, [https://github.com/nodejs/help/issues/2926](https://github.com/nodejs/help/issues/2926)  
27. Schema \- Colyseus 0.13, accessed on April 26, 2026, [https://0-13-x.docs.colyseus.io/state/schema/](https://0-13-x.docs.colyseus.io/state/schema/)  
28. Colyseus 0.10: Introducing the New State Serialization Algorithm | by Endel Dreyer | Medium, accessed on April 26, 2026, [https://endel.medium.com/colyseus-0-10-introducing-the-new-state-serialization-algorithm-88409ce5a660](https://endel.medium.com/colyseus-0-10-introducing-the-new-state-serialization-algorithm-88409ce5a660)  
29. colyseus/schema: An incremental binary state serializer with delta encoding for games. \- GitHub, accessed on April 26, 2026, [https://github.com/colyseus/schema](https://github.com/colyseus/schema)  
30. Room \- Colyseus Multiplayer Framework, accessed on April 26, 2026, [https://0-15-x.docs.colyseus.io/server/room/](https://0-15-x.docs.colyseus.io/server/room/)  
31. Room API (Client-side) \- Colyseus 0.13, accessed on April 26, 2026, [https://0-13-x.docs.colyseus.io/client/room/](https://0-13-x.docs.colyseus.io/client/room/)  
32. State Serialization \- Colyseus 0.10.x, accessed on April 26, 2026, [https://0-10-x.docs.colyseus.io/server/state-serialization/](https://0-10-x.docs.colyseus.io/server/state-serialization/)  
33. Advanced Schema Usage \- Colyseus docs, accessed on April 26, 2026, [https://docs.colyseus.io/state/advanced-usage](https://docs.colyseus.io/state/advanced-usage)  
34. How to parse/encode binary message formats? \- java \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/6862855/how-to-parse-encode-binary-message-formats](https://stackoverflow.com/questions/6862855/how-to-parse-encode-binary-message-formats)  
35. Two Timestamps, One Message: Why WebSocket Systems Need Both \- DEV Community, accessed on April 26, 2026, [https://dev.to/koistya/two-timestamps-one-message-why-websocket-systems-need-both-44ff](https://dev.to/koistya/two-timestamps-one-message-why-websocket-systems-need-both-44ff)  
36. Web Workers \+ SharedArrayBuffer: Parallel Computing for Heavy Algorithms in Frontend | by Maxim Andriushin | Medium, accessed on April 26, 2026, [https://medium.com/@maximdevtool/web-workers-sharedarraybuffer-parallel-computing-for-heavy-algorithms-in-frontend-662391ae0558](https://medium.com/@maximdevtool/web-workers-sharedarraybuffer-parallel-computing-for-heavy-algorithms-in-frontend-662391ae0558)  
37. Running JS physics in a webworker \- proof of concept \- DEV Community, accessed on April 26, 2026, [https://dev.to/jerzakm/running-js-physics-in-a-webworker-part-1-proof-of-concept-ibj](https://dev.to/jerzakm/running-js-physics-in-a-webworker-part-1-proof-of-concept-ibj)  
38. rapier-physics-worker | Skills Marke... \- LobeHub, accessed on April 26, 2026, [https://lobehub.com/skills/shyamsridhar123-chadpowers-superbowl-rapier-physics-worker](https://lobehub.com/skills/shyamsridhar123-chadpowers-superbowl-rapier-physics-worker)  
39. SharedArrayBuffer \- JavaScript \- MDN Web Docs, accessed on April 26, 2026, [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global\_Objects/SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)  
40. Using transferable objects from a Web Worker \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/16071211/using-transferable-objects-from-a-web-worker](https://stackoverflow.com/questions/16071211/using-transferable-objects-from-a-web-worker)  
41. Transferable objects \- Lightning fast | Blog \- Chrome for Developers, accessed on April 26, 2026, [https://developer.chrome.com/blog/transferable-objects-lightning-fast](https://developer.chrome.com/blog/transferable-objects-lightning-fast)  
42. High-Performance Node.js APIs with SharedArrayBuffer and Worker Threads \- Medium, accessed on April 26, 2026, [https://medium.com/@bhagyarana80/high-performance-node-js-apis-with-sharedarraybuffer-and-worker-threads-dfe46172030f](https://medium.com/@bhagyarana80/high-performance-node-js-apis-with-sharedarraybuffer-and-worker-threads-dfe46172030f)  
43. SharedArrayBuffer and Memory Management in JavaScript | by Artem Khrienov \- Medium, accessed on April 26, 2026, [https://medium.com/@artemkhrenov/sharedarraybuffer-and-memory-management-in-javascript-06738cda8f51](https://medium.com/@artemkhrenov/sharedarraybuffer-and-memory-management-in-javascript-06738cda8f51)  
44. SharedArrayBuffer: The Hidden Super-Primitive That's Reshaping the Future of WebAssembly, .NET & Parallel Runtime Architecture | by Jacob Mellor | Medium, accessed on April 26, 2026, [https://medium.com/@jacobscottmellor/sharedarraybuffer-the-hidden-super-primitive-thats-reshaping-the-future-of-webassembly-net-e369e667f6e9](https://medium.com/@jacobscottmellor/sharedarraybuffer-the-hidden-super-primitive-thats-reshaping-the-future-of-webassembly-net-e369e667f6e9)  
45. A Deep Dive into SharedArrayBuffer and Atomics in JavaScript | by Hamza kareem | Medium, accessed on April 26, 2026, [https://medium.com/@hamzakareem61/a-deep-dive-into-sharedarraybuffer-and-atomics-in-javascript-4d3e902be11a](https://medium.com/@hamzakareem61/a-deep-dive-into-sharedarraybuffer-and-atomics-in-javascript-4d3e902be11a)  
46. Using JavaScript SharedArrayBuffers and Atomics \- Blog Title, accessed on April 26, 2026, [https://blogtitle.github.io/using-javascript-sharedarraybuffers-and-atomics/](https://blogtitle.github.io/using-javascript-sharedarraybuffers-and-atomics/)  
47. About SharedArrayBuffer & Atomics | by Andrea Giammarchi \- Medium, accessed on April 26, 2026, [https://webreflection.medium.com/about-sharedarraybuffer-atomics-87f97ddfc098](https://webreflection.medium.com/about-sharedarraybuffer-atomics-87f97ddfc098)  
48. Advanced collision-detection \- Rapier physics engine, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/javascript/advanced\_collision\_detection\_js/](https://rapier.rs/docs/user_guides/javascript/advanced_collision_detection_js/)  
49. Scene queries \- Rapier physics engine, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/rust/scene\_queries/](https://rapier.rs/docs/user_guides/rust/scene_queries/)  
50. scene\_queries\_intersection\_test | Rapier, accessed on April 26, 2026, [https://rapier.rs/docs/user\_guides/templates\_injected/scene\_queries\_intersection\_test/](https://rapier.rs/docs/user_guides/templates_injected/scene_queries_intersection_test/)  
51. High precision timing \- Web APIs | MDN, accessed on April 26, 2026, [https://developer.mozilla.org/en-US/docs/Web/API/Performance\_API/High\_precision\_timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing)  
52. TheHuman00/precise-time-ntp: Simple NTP time sync for Node.js \- Auto-drift, WebSocket & HTML clocks · GitHub, accessed on April 26, 2026, [https://github.com/TheHuman00/precise-time-ntp](https://github.com/TheHuman00/precise-time-ntp)  
53. A light-weight time protocol based on common web standards \- PTB Uhr \- Physikalisch-Technische Bundesanstalt, accessed on April 26, 2026, [https://uhr.ptb.de/wst/paper](https://uhr.ptb.de/wst/paper)  
54. Throttled Request Animation Frame · Issue \#38 · gkjohnson/js-framerate-optimizer \- GitHub, accessed on April 26, 2026, [https://github.com/gkjohnson/js-framerate-optimizer/issues/38](https://github.com/gkjohnson/js-framerate-optimizer/issues/38)  
55. When browsers throttle requestAnimationFrame \- Motion Magazine, accessed on April 26, 2026, [https://motion.dev/magazine/when-browsers-throttle-requestanimationframe](https://motion.dev/magazine/when-browsers-throttle-requestanimationframe)  
56. Keep RequestAnimationFrame running in the background? \- HTML5 Game Devs Forum, accessed on April 26, 2026, [https://www.html5gamedevs.com/topic/21557-keep-requestanimationframe-running-in-the-background/](https://www.html5gamedevs.com/topic/21557-keep-requestanimationframe-running-in-the-background/)  
57. Performance issue with requestAnimationFrame in my physics simulation \- help needed : r/reactjs \- Reddit, accessed on April 26, 2026, [https://www.reddit.com/r/reactjs/comments/1k2uutb/performance\_issue\_with\_requestanimationframe\_in/](https://www.reddit.com/r/reactjs/comments/1k2uutb/performance_issue_with_requestanimationframe_in/)  
58. Controlling fps with requestAnimationFrame? \- Stack Overflow, accessed on April 26, 2026, [https://stackoverflow.com/questions/19764018/controlling-fps-with-requestanimationframe](https://stackoverflow.com/questions/19764018/controlling-fps-with-requestanimationframe)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAYCAYAAAAYl8YPAAABNElEQVR4Xu2UL0sEQRiHX/FsKieCIgqaTIJBRBBREIUrloNLds0GMYvfQAwGwWDyD9jEeGAUrCZB/QAG0SSoz4/Z5WZ22Nu7rfrAE/bdmXd2fju7Zv+UZRWf8LVD19y0mB48wnOcSq7FCX5jLbnuxRV8xvmkFjGKFzji1Ybw3tzEca/ej2c44dUC9Mg7mdosvuMVVry6FjnEAa8W0MDpTG0Tf3AvUx/GLWtF0RHK6wuXsje6JS+vUszhp8V5pQziLh7gshVsOS8vobd5iQvYh8e4Hozw0Cqnlp+XajfmmooNy99BYV7b2LSwmcZrXkRRXtp608JmLziWDtAZe8A3c1mlfuCjuQVSCpt1Q93iZnfW5otoxwzeWisjZajPqxR62zpj+7iI1zgZjChB1dzfRmftr/ELvZs+z4l5kpAAAAAASUVORK5CYII=>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAYCAYAAAAYl8YPAAABAElEQVR4XmNgGAXkAicgvgvEj4jELhBtmIARiKcA8UogVoDyQWAOEP8DYg8onxmI7YH4ARCbQsUwgDgQrwJiMSQxQSA+zQDRKI0kzgPEi4FYBkkMBYCcXIgmpg/En4B4DRCzIImDLJkExLxIYiggFIjV0MSigfg/EJejiQsDcRoDIiiIAqDw+g3ENugSpAJc4UUWMAbirwyY4YUMuIE4CYgF0CXQAa7wAgFQmC0H4s1AfA2IJVGlUQEoYOczEA4vkOsvMBAwjNjwIsowYsILBHAaBkpj54D4HQMkrGD4CxBfZ4BoRAc4DSMHDD7DOIC4FIi3M0BiHBS2nigqRgFJAADNaDigPZC0dwAAAABJRU5ErkJggg==>

[image3]: <data:image/png;base64,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>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAYAAAC8/X7cAAADAklEQVR4Xu2XS8hOQRjH/0IRktxyS2RB7okoLCSxYGWhWGNh5Rqrs7GwkVAK9a0kkWxcNxRZsFOikEiEEDspPL9vZj4zcy5O3peFvl/9O987z5w5zzzzzDPzSf38fww3DckbO6Cj8Uab1pg2mmaZBqbmEgtMPaaRuaEDppou+GcrBphWmu6Zrpo2e90wPTEt/tU1YbLppml2bjDGmG6bfnh9Ms1Jekh7vS3olWmut60wXVKLwAw2HTI9V9lRbCflPr4wszHpI6Yia8/ZYPos52CRmnohCHdNM7N2xj9u2pe1J+DgCdNH05LMFiCNPsgNxqABovnYP5soTNvkovvIND6xSvNNp0yDsnZYJvfOtNwQ2G767p91jDLdNz2US4sAkbms5s02zHRaLsoEgFXYlPRwqbozawuEb9OnxAzTa1VHJSYM8sI0wbfhNM4fCJ1qmC4XXfoTza+ma6ahUR/Sd3n0O4cAnFG6+r0UchE5mLXn4MQbpRPgye/1oVMN60x7/N84jfNMgskAwTmn5gCy0hSDEXEjdfaWXPqsjg0VYKdfPMgi01s1Rw4KpeOTPgQt7Cf2F3uwKv8DBCkOXi8hgmxOBmniqMoVhAm89M86Qv5PitqINCnLhmZjNuV/gAmQAWRCH2ECpZllTJE7B94rrfVtJhDnf0whF5Ad+n3+AxP4Ilet+qCaUFWaJsAS75f72K7M1mYC1H/ezwnFgxS8rrSyVVGZQuTcWdM31UeAc4EDjIOM8yKG6OIEm7SOQtX7KxxQBIbrQlP+A2n2TBUbnZMVB3tUdnCV6Z3psNKSFwgryAFVxVi56M7LDZ5QUuvej6FU1543XB2eyt2Bwv2Hu9ADuUmUaq+HdibOBo8ZJzdWfL85pvKFkKBcVP3qB1gdVqnxOsHgVCJun+TbRNU7HkNJxFlq+d+CSkXVCudGV+Hafce0Njd0kS1yB12e4l2DSnNe1fukUwjQFdVfMrsCqcZVAbVJu7YwViFXvrs5biUs727T0tzQAfxHuFX/wPl+/oSfdmCStdDzDykAAAAASUVORK5CYII=>

[image5]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAYCAYAAAAYl8YPAAABNklEQVR4Xu2UvyuFURyHv0IRBikSyoLRIBMh3cHCZmG3mExiMdklmZTBRFab/0CZlFJK/gCDmOTH8+mce533vF7n3ne+Tz3D+7nnvOe8n3O6Zk3KsoiP+FynFTctTwse4TmO+mdxgl+45J9bcR6fcNpnOQbwAvuDrBdvzE0cCvJuPMPhIMugLW9F2SS+4iW2BbkWOcSeIMuwiuNRto7fuB3lfbhhv1XUhfr6wNn4h0Yp6qsUU/hu+b6qqPx9PMY5S3xyUV9CL9rDThzDB1zLjAjQKqdW3NeyuVPWaQvt8Bq7aiMCUn1p0gy2+2ddkyvsqI0ISPUVMoJ3uBKGumO3+GKuq6pveG9ugRjt7MDcHf33AFLoRbvm/hyEDiL1FX+iXWyaO4hBnMAdnzfMAn5atg7tsklJfgB8uzz9nzcKgAAAAABJRU5ErkJggg==>

[image6]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAYCAYAAAAYl8YPAAABRUlEQVR4Xu3UzysFURjG8VcormshQlHYWCkkO1GysLkLC+VHd8vaho2trMlSSVLIlrW9shOJuvkD7kKsFL5vZ4Z3zphm5m556rOY95zpzLznzIj8p9ZM4wnPGc242+Kpwx5O0R9ca/bxgdnguh5TqGA8qMXShTN0mlobrsXd2GPqRRyh19Qi0Ude82rDeME5GkxdF9lFq6lFMo9Br7aMT2x49XasyE8rMkX79Y4JfyBvkvpVU8bwJvF+hdHmb2Ibk5Lyykn90uiO6yID4vqnb7AQmWGiqxxIcr/68Ig5ccfkClt2gk2efg3hAaP+QJi0fmkK2ME9yuL1TM/YDariehV6xZ24BX5LMy6xLimbkJRuLKEluD7ELTq+Z+TIqrjPTD83fZpjXKDJTsoa3c0TlLAorj0jkRk5o78iPW/6t2n0xv5CvgDQ6D3fceay7gAAAABJRU5ErkJggg==>

[image7]: <data:image/png;base64,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>

[image8]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAYCAYAAAC4CK7hAAABzklEQVR4XtWWzSsGURSHj3xEpHxEIl/ZKEqJFQtlwRYLJVs2FrJAYqNEshAbiYUNKWUrLCxk429QklhIVjbk4/d770wzd8w77zti3rlPPTUz507NvXPPPUfELIrgJByAj7BPD5tDOVyHBd6AaWTBTThtXRtLMVyDL7DbE9PogU/wy+UbPINlrnGZoA4ewnp4AHe0aBI46FPik0w5cB8OW/fjcM8J+1MCr+EtrNZDGaMKXsFG654TWXLC/jTDZ3gkaiXiQCU8FzUhftMWbNdG+DAiKjdmvIEMMwZX4CyckDROrQ34Dru8gRiQL6oopsTOjxtRvzMsC/AuhCewNPHmH5MqP/JgrvdhHLHzY8obELUnF2GLNxAB7rrm1RfWj2T50QR3JbjP4f7lyZKuFTA78eYfElQ/uJ22Rf2xIFrhUAj7JXhhfgXP5Vf5mR9cOU6Cydngeh41/HODor5lTlTfpdELH8TZcx/w3pLX9nP2N34HQFSwmnPLc0Lz8FIy3/+Fhrl3IU6jyFaFi8+taRzMP3bAhGWCE+FuMhq2T6eSZpWPK52iWvp/6Qiiog0uw0JRE2EdMg7mxyqsFVUSRmGHNsIA2PUei96asDzU2AO+AXcxX0JxAissAAAAAElFTkSuQmCC>

[image9]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJQAAAAaCAYAAABRhnV8AAAFhElEQVR4Xu2bW8hmUxjHHzlkHMKMnKVhKIMkhxBCiIQcMmRKkUMaLhipuTFIZMYxOeUwyPl8IcrNJ0WhcMGFQyKRC3e4UA7Pz7PW7LWfd+1372+/52/2r/59e+/17vXutdaznvU8a7+fyOywuepc1S6+YArg2S5S7eYL5sli1YVi9U0b26guVW3rC2aVy1RnhePdVR+qPla9r/pa9blqLlzj787hs224VqxO6qa+71QfhHOuX158dCNLVHepdvAFDVmkulu1VzgfZRu3U70iRX1fBXH8keoz1fLw2ZRlqrWqLd31mWOp6nGxTocLxDzCZqqdVJ+oLgllnK+X9jMJg7hXzFsA9VI/9cLFqjPCsWeF6ip/MeFY1Rb+YoD2XJOcj7KNx6iuF/OEPM+rqttDGefrVLuGc88a1an+4qyxSorOpME3SuEJDld9ozownNPZdFZbjladHY4ZzKdUDxTF/5fxnTn2Vb0g5gFyXC35MiYK38P9MOo2Xik2SWFPMe93Sjjnu6k795xwnOohsb6ZSWjgk6ojk3M6IeI9CIOzT1E8b1i64sz3ngGoO3pKD/e9KMXAe6oMCkN6WbV9OB91G/eWwiAwkG+lbMz7h+MceK63pP1yO3Ho5OeliC1Sch5kmHjP0ASW5jjbPVUGxWR5WPKzftRtvEn1tmprX1BBjL8a9wkNOEB1mrRfo4cJwelc+OvJeRBmL5kSnsLfc4LqsQrhxn0nec8Ah6huFoslTkyuR54WSx6IT4iJ0u8g4MU44vl1Yh6Bz3NfjlwbGVQSg9Vi9cSlkbqo07ctiudODdrHT8D4nyeW0TE5/ETm/jeletkvwWAwU6iITIcO8BWOG1wrM8gbB/TzILdJ/p6mVHmGW1SHitWNEfqZHQ0qR5WHwqPR5zlybeTaa2IT/j6pThLq8PET0B7qxKnk2tLYoEgFsWI6kWMqZiBxiZOEBrwhNogeMirvQSKDGhSG/KX0egY6mXpZijlOsyEf73mqDCo1EE+ujRj7VmLft0Esa2sDhvSDFPFThPE/R3WP9G6D8ByvSwNHQ8r7q+rgcM5DPxeUW9vHyXopzyLSaYz/e9Uvqiekd5a2NSjuYT8II/5b9Y7qTtWOUjao9DhCZ78k1Sl3lUFhvATlaaDbpI14D7Yx5js+cen/VPWH6hnp3VvDqO4XC9pTML5nJW/8GyGzYbOMlBerBxo+F5TrhHFyumqtv1hDW4PqBwP3oBRLHt4o7Vg8BZubVQNcZVB8fp30Dl4/iOVOEnuOnPduC56HsIcJxOr0SLm4Z78sCx/6J/yN8KC4w2nwUMR2rOuku3UwIfBm74kNYNygHBYnq1aKBa7pckgf3ao6LLk2Hw5S3SHFhO7HfmK73D+KxUBHlIsHgldbj4qtVHiuo5IyxgGv1Xe5owF4JtxqupYSB/wpvUHppGDfhRkzDdv+eBlmcArLTzoh20AdPgieBGSoGFaacDBhrlAdn1zLwnrPu6q/xCw+6nfVv1KehZ5lYutwel+dWPPbwvIyDQblobMJ0gf15MOqZxRgZDxbLWQYBGapJ4r7E79JPiUfBxhzp9lQCVwsF1NPtFT1k5SD9I6ORmBQxErp3gmxANfq1su41hLAN1Uuy+lYQJCqsv8Udz6J5N8VSx3rvBMxzZliP7VoqkktoZOEPuUNP3s//OV8wUJQTmCNYREMrhJLuf0OaUc7mJRrxF5lYEgbxF52T2NyMTTOV30hFojzumXQn7J2FMT9vPj7JSbuzzLczcipJLe30jE4eH02B+NrFTZdMahNcenvGDIsf/yqoEl82tFRC69r2O9b0EF5x3jglwI3iAXjbLUM+x1jxyYEMRSZ3h5iQfpqqXnB2tFRBT8NIoNOX1XwP36N3ovNGv8BpyJkdc6yslgAAAAASUVORK5CYII=>