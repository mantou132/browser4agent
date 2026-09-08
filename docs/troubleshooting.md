# Troubleshooting & FAQ

[English](./troubleshooting.md) | [中文](./troubleshooting.zh-CN.md)

This document collects common environment issues, macOS Gatekeeper security interceptions, and corresponding solutions when using `browser4agent`.

---

## Table of Contents

- [1. macOS: "Apple could not verify '.<hash>-0.node'" Security Warning on Image Attachments](#1-macos-apple-could-not-verify-hash-0node-security-warning-on-image-attachments)
  - [Symptoms](#symptoms)
  - [Root Cause Analysis](#root-cause-analysis)
  - [Why This Is Critical for Remote Devices](#why-this-is-critical-for-remote-devices)
  - [Recommended Solution (Best & Complete)](#recommended-solution-best--complete)
  - [Alternative Workarounds](#alternative-workarounds)

---

## 1. macOS: "Apple could not verify '.<hash>-0.node'" Security Warning on Image Attachments

### Symptoms

When sending prompts with image attachments via the DevTools **Agent Panel** or from a **remote device** (e.g. mobile AgentDeck client):

1. macOS displays a modal Gatekeeper security prompt:
   > **“.<hash>-0.node” Not Opened**  
   > Apple could not verify ".\<hash\>-0.node" is free of malware that may harm your Mac or compromise your privacy.  
   > `[Done]` `[Move to Trash]`
2. **If no button is clicked, the turn hangs indefinitely**;
3. Clicking either "Done" or "Move to Trash" allows the session to proceed;
4. **Different images or subsequent attempts show different filenames** (e.g. `.99dec9ff...-0.node`, `.99dfbbe9...-0.node`).

---

### Root Cause Analysis

This occurs when running **Claude Code** (`claude`) as the underlying ACP Agent. The execution trace is as follows:

```text
Chrome / Chrome Canary (Browser Host)
  └─ browser4agent (Native Messaging Host, inherits browser Quarantine/Provenance)
       └─ claude-agent-acp (Node.js Adapter)
            └─ claude (Claude Code CLI, standalone Bun-compiled binary)
                 ├─ Calls require("/$bunfs/root/image-processor.node") upon image attachments
                 ├─ Bun dynamically extracts native addon to TMPDIR/.<hash>-0.node
                 └─ Kernel tags new file with com.apple.quarantine: 0081;...;Chrome Canary;
                      └─ dlopen() loads unnotarized ad-hoc signed dynamic library
                           └─ Triggers macOS Gatekeeper modal dialog interception
```

1. **Claude Code & Bun Native Addon Extraction**:
   Claude Code CLI is bundled with Bun into a single executable. To inspect and scale images locally, it embeds the native AppKit/ImageIO module `image-processor.node`. Because macOS dynamic linking (`dlopen`) requires a physical file path on disk, Bun dynamically unpacks the module to the temporary directory as a hidden dotfile (`.<hash>-0.node`).
2. **Quarantine Inheritance via Native Messaging**:
   `browser4agent` is launched by Chrome via the Native Messaging protocol. Under macOS security policies, files written by processes descended from a browser inherit the browser's quarantine attribute (`com.apple.quarantine`).
3. **Gatekeeper Interception**:
   `image-processor.node` is only ad-hoc signed and not notarized by Apple. When `dlopen()` loads a quarantined, unnotarized dynamic library, macOS Gatekeeper (`syspolicyd`) suspends the calling thread and presents a modal security alert.
4. **Why It Hangs Until Clicked & Continues Either Way**:
   - The suspension happens synchronously inside the `dlopen()` kernel call until user interaction.
   - Clicking "Done" dismisses the modal and unfreezes the thread.
   - Clicking "Move to Trash" deletes the file, causing `dlopen()` to fail; however, Claude Code catches the failure in a fallback block and forwards the raw base64 image data to the cloud API without crashing.
5. **Why the Filename Changes**:
   Bun generates temporary file names using a dynamic hash (`tmpname`). When an existing file is moved to Trash or image context changes, a new random filename is generated, which Gatekeeper treats as a brand new unverified file.

---

### Why This Is Critical for Remote Devices

When using a remote device (such as a smartphone running AgentDeck connected to the Mac via WebSocket Relay):

- The Agent still runs on the host Mac inside `browser4agent`.
- If an image is sent from the phone, the Mac triggers the modal Gatekeeper dialog.
- **The remote phone cannot see or click the dialog**, resulting in the remote turn hanging permanently.
- The Mac must be configured to silently permit execution without blocking prompts.

---

### Recommended Solution (Best & Complete)

#### Option 1: Grant the Host Browser "Developer Tools" Permission (Recommended)

macOS provides a built-in exemption for local development tools that compile or extract unsigned dynamic libraries (**Developer Tools** permission):

1. Open macOS **System Settings**;
2. Navigate to **Privacy & Security**;
3. Scroll down and click **Developer Tools**;
4. Click the **`+`** button at the bottom:
   - Select and add your browser (e.g. **Google Chrome** or **Google Chrome Canary**);
   - Ensure the toggle next to it is turned **ON**;
5. **Quit and restart the browser** (`Cmd + Q` and reopen).

> **Why this works**: With Developer Tools permission, macOS allows the browser and its spawned child processes to `dlopen()` local unnotarized binaries without triggering Gatekeeper prompts, completely eliminating freezes for both local panels and remote devices.

---

### Alternative Workarounds

#### Option 2: Switch Underlying Agent to Codex or Cursor

If modifying system settings is not feasible:
- Switch to **Codex** or **Cursor** in the Agent panel or remote configuration.
- Codex uses a standard JavaScript CLI runtime that does not dynamically unpack unnotarized native addons at runtime.

#### Option 3: Clean Residual Quarantine Attributes

To clear historical quarantine attributes on cached runtimes:

```bash
xattr -dr com.apple.quarantine ~/Library/Application\ Support/browser4agent
```
