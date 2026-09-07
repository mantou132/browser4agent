# Case Studies

[English](./cases.md) | [中文](./cases.zh-CN.md)

A curated collection of real-world frontend development, animation profiling, and automated QA sessions powered by `browser4agent`.

---

## Case 1: High-Frequency UI Animation Profiling & Frame-by-Frame Refactoring (Card Expansion Tuning)

### 1. Context & Challenges

In a mobile web application built with Web Components (Gem / Shadow DOM), an expandable card component `<tap-card>` transitions from its inline thumbnail layout to full-screen detail over 350ms:

- **Challenge 1 (Performance & Frame Drops)**: Long articles and rich multimedia rendered inside the card caused noticeable frame drops and main-thread hitching.
- **Challenge 2 (Text Reflow / Jank)**: Because the card width increased dynamically throughout the 350ms animation, paragraphs and headings continuously re-calculated line breaks, creating a jarring "shivering / water pouring into a widening glass" visual glitch.
- **Challenge 3 (Complex Gesture & Geometric Constraints)**: The top-right close button needed to stay **strictly stationary relative to the visible card's top-right corner** during expansion, while also **scaling proportionally (`transform: scale(...)`)** when the user pulled down on the card to dismiss it.

---

### 2. The Agent's Diagnostic & Profiling Toolchain

Rather than relying on manual browser inspection or visual guesswork, the AI Agent used `browser4agent` to automate a complete profiling and verification workflow:

#### ① Tab Discovery & Active State Management
Located the active tab running the Rsbuild dev server (`http://localhost:3000/tap-app/cards`) via `list_tabs`, then brought it to the foreground with `execute_script_in_background` to ensure Chrome's compositor rendered at full 120Hz ProMotion speed.

#### ② Chromium Engine Telemetry via CDP
Attached to the Chrome DevTools Protocol using `debugger_send_command` before and after card expansion:
- `Performance.enable`
- `Performance.getMetrics`: Extracted internal Blink metrics including `LayoutCount` (number of reflows), `LayoutDuration` (cumulative CPU layout time in seconds), `RecalcStyleDuration`, and `TaskDuration`.

#### ③ Multi-Level Shadow DOM Piercing & Frame-Level Sampling
Because `<tap-card>` was nested across several Shadow DOM boundaries (`t-root` → `tap-page` → `tap-route` → `t-cards` → `tap-card`), the Agent injected a recursive `TreeWalker` via `execute_script`, pairing two real-time observers:
- **`ResizeObserver`**: Tracked how many times the card's expandable content container (`<tap-content slot="expandable">`) changed layout dimensions during expansion.
- **`requestAnimationFrame`**: Aligned strictly with the 120Hz display refresh cycle, reading `getBoundingClientRect()` on every single frame to measure the relative offset between the clipping viewport `.clip` and the close button `.close`.

---

### 3. Baseline Diagnostic Findings

Baseline profiling data across 3 consecutive rounds:

| Metric | Baseline Value | Diagnosis |
| :--- | :--- | :--- |
| **Content Resize Triggers (ResizeObserver)** | **41.7 times** | In just 350ms, the internal text was re-broken and re-measured more than 40 times (font shaping and line breaking), causing severe layout thrashing and visual jank. |
| **Cumulative Blink Layout Time (LayoutDuration)** | **7.28 ms** | Substantial CPU time spent recalculating child layout trees. |
| **Peak Single-Round Layout Time** | **8.19 ms** | Peak layout time approached the full 120Hz frame budget (8.33ms). |

---

### 4. Architecture Refactoring & Geometric Compensation

#### ① Target-Width Staging (Eliminating Text Reflow)
Locked `.card`'s internal layout width directly to the target full-screen width `${elementTheme.targetW}`, treating the outer `.clip` as a pure viewport window (`overflow: hidden`).
- **Result**: Internal paragraphs formatted once at frame 0, achieving **0 recursive reflows during the animation**, completely eliminating text line-wrap shuddering.

#### ② Geometric Compensation for the Close Button
Because `.card` was now fixed at full-screen width, a static `right: 1rem` inside `.card` would position the button at the edge of the screen instead of the card's visible corner. To keep the button **inside `<tap-pull-container>` so it scales on gesture pull, while simultaneously keeping it locked to the card's top-right corner during expansion**, the Agent derived a dynamic offset compensation formula:

- Current visible clip width: $W_{\text{clip}}(t) = W_{\text{init}} + (W_{\text{target}} - W_{\text{init}}) \times t$
- Total container layout width: $W_{\text{card}} = W_{\text{target}}$
- Target right offset $R(t)$:
  $$R(t) = W_{\text{target}} - W_{\text{clip}}(t) + 1\text{rem} = (W_{\text{target}} - W_{\text{init}}) \times (1 - t) + 1\text{rem}$$

Implemented directly in CSS:
```css
.close {
  position: absolute;
  right: calc((${elementTheme.targetW} - ${elementTheme.width}) * (1 - ${elementTheme.progress}) + 1rem);
  top: 1rem;
}
```

---

### 5. Post-Optimization Empirical Verification

Re-running the automated test harness yielded concrete performance gains:

| Metric | Baseline | Optimized | Improvement |
| :--- | :--- | :--- | :--- |
| **Internal Reflows (ResizeObserver)** | **41.7** | **1** (initial setup only) | **↓ 97.6% (Reflows eliminated)** |
| **Cumulative Layout Time (LayoutDuration)** | **7.28 ms** | **5.61 ms** | **↓ 23.0% (Reduced CPU layout burden)** |
| **Peak Layout Time** | **8.19 ms** | **5.42 ms** | **↓ 33.8% (Flattened worst-case spikes)** |
| **Relative Corner Drift (54 consecutive frames)** | Noticeable drifting | **Constant 16px (0px drift)** | **100% synchronized with card corner** |
| **Pull Gesture Scaling Test (`scale: 0.84`)** | - | **Button shrank to 25.60px** | **Scaled smoothly, restored on release** |
| **Unit Test Suite** | Passed | Passed (35/35) | Zero functional regressions |

---

### 6. Key Takeaway

This session highlights what sets `browser4agent` apart from simple "screenshot-and-click" browser wrappers:
- **Runs multi-step, protocol-level debugging sessions**: Combining Chrome DevTools Protocol telemetry, rAF frame profiling, Shadow DOM traversal, and synthetic gesture events;
- **Provides empirical proof for architectural decisions**: Code improvements are backed by microsecond-level layout metrics and frame-by-frame geometry rather than guesswork;
- **Completely autonomous**: The Agent independently discovered the tab, diagnosed the bottleneck, updated the source code, ran tests, and delivered quantified benchmark data.
