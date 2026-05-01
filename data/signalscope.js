const dom = {
    frameTable: document.getElementById("frame-table"),
    framePause: document.getElementById("frame-pause"),
    frameFilterInput: document.getElementById("frame-filter-input"),
    frameFilterClear: document.getElementById("frame-filter-clear"),
    frameFilterSummary: document.getElementById("frame-filter-summary"),
    dbcStatus: document.getElementById("dbc-status"),
    mutationCount: document.getElementById("mutation-count"),
    cpuLoad: document.getElementById("cpu-load"),
    busA: document.getElementById("bus-a"),
    busB: document.getElementById("bus-b"),
    rxDepth: document.getElementById("rx-depth"),
    dropped: document.getElementById("dropped"),
    directPathAvg: document.getElementById("direct-path-avg"),
    mutatedPathAvg: document.getElementById("mutated-path-avg"),
    replayStatus: document.getElementById("replay-status"),

    applyBtn: document.getElementById("apply-btn"),
    revertBtn: document.getElementById("revert-btn"),
    clearStagingBtn: document.getElementById("clear-staging-btn"),

    replayPlay: document.getElementById("replay-play"),
    replayStop: document.getElementById("replay-stop"),
    replayLoop: document.getElementById("replay-loop"),
    replayDirection: document.getElementById("replay-direction"),
    replayFile: document.getElementById("replay-file"),

    dbcFile: document.getElementById("dbc-file"),
    dbcUpload: document.getElementById("dbc-upload"),
    dbcUnload: document.getElementById("dbc-unload"),

    activeMutationList: document.getElementById("active-mutation-list"),
    activeMutationsMasterOff: document.getElementById("active-mutations-master-off"),
    activeMutationsMasterOn: document.getElementById("active-mutations-master-on"),
    activeMutationsMasterOnce: document.getElementById("active-mutations-master-once"),

    rawEditor: document.getElementById("raw-editor"),
    rawBitGrid: document.getElementById("raw-bit-grid"),
    rawByteInputs: Array.from(document.querySelectorAll(".raw-byte-input")),
    signalPicker: document.getElementById("mut-signal-picker"),
    mutCanId: document.getElementById("mut-can-id"),
    mutDirection: document.getElementById("mut-direction"),
    mutStartBit: document.getElementById("mut-start-bit"),
    mutLength: document.getElementById("mut-length"),
    mutEndian: document.getElementById("mut-endian"),
    mutSigned: document.getElementById("mut-signed"),
    mutOperation: document.getElementById("mut-operation"),
    mutFactor: document.getElementById("mut-factor"),
    mutOffset: document.getElementById("mut-offset"),
    mutV1: document.getElementById("mut-v1"),
    mutV2: document.getElementById("mut-v2"),
    mutEnabled: document.getElementById("mut-enabled"),

    opParam1Group: document.getElementById("op-param1-group"),
    opParam1Label: document.getElementById("op-param1-label"),
    opParam2Group: document.getElementById("op-param2-group"),
    opParam2Label: document.getElementById("op-param2-label"),
};

let displayedFrames = [];
let latestIncomingFrames = [];
let selectedFrameKey = null;
let selectedSignalIndex = 0;
let framesPaused = false;
let currentFrameData = "";
let rawOverrideModes = new Array(64).fill(-1); // -1 passthrough, 0 force0, 1 force1
let frameFilterText = "";
let lastRenderSourceFrames = [];

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatPeriodMs(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        return "-";
    }
    if (milliseconds >= 1000) {
        return `${(milliseconds / 1000).toFixed(2)} s`;
    }
    return `${milliseconds} ms`;
}

function renderFrameDataBytes(dataString, changedMask) {
    if (!dataString) {
        return "";
    }
    const tokens = String(dataString).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return "";
    }
    const maskNumber = Number(changedMask);
    const mask = Number.isFinite(maskNumber) ? (maskNumber & 0xFF) : 0;
    return tokens
        .map((token, byteIndex) => {
            const isChanged = (mask & (1 << byteIndex)) !== 0;
            const className = isChanged ? "frame-byte frame-byte-changed" : "frame-byte";
            return `<span class="${className}">${escapeHtml(token)}</span>`;
        })
        .join(" ");
}

function frameKey(frame, fallbackIndex = -1) {
    // Each row corresponds to a single (can_id, direction) entry in the device
    // dictionary, so the key is stable across status polls even as the frame
    // bytes update. This keeps row selection sticky between renders.
    const id = frame.id || (frame && frame.can_id !== undefined ? `0x${Number(frame.can_id).toString(16).toUpperCase()}` : "");
    const direction = frame.direction || "";

    if (id || direction) {
        return `${id}|${direction}`;
    }
    if (fallbackIndex >= 0) {
        return `row|${fallbackIndex}`;
    }
    return "row|0";
}

function parseDirectionToken(token) {
    const t = String(token || "").trim().toLowerCase();
    if (t === "a_to_b" || t === "a2b" || t === "atob") {
        return "A_TO_B";
    }
    if (t === "b_to_a" || t === "b2a" || t === "btoa") {
        return "B_TO_A";
    }
    return null;
}

function parseIdToken(token) {
    const raw = String(token || "").trim();
    if (!raw) {
        return null;
    }

    if (/^0x[0-9a-f]+$/i.test(raw)) {
        const n = parseInt(raw, 16);
        return Number.isFinite(n) ? n : null;
    }
    if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function parseFrameFilter(text) {
    const tokens = String(text || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

    const ids = new Set();
    let direction = null;
    const invalid = [];

    tokens.forEach((token) => {
        const dir = parseDirectionToken(token);
        if (dir) {
            direction = dir;
            return;
        }

        const id = parseIdToken(token);
        if (id !== null && id >= 0) {
            ids.add(id);
            return;
        }

        invalid.push(token);
    });

    return { ids, direction, invalid };
}

function frameCanIdNumber(frame) {
    if (Number.isFinite(Number(frame && frame.can_id))) {
        return Number(frame.can_id);
    }
    const idText = String(frame && frame.id || "").trim();
    if (/^0x[0-9a-f]+$/i.test(idText)) {
        return parseInt(idText, 16);
    }
    if (/^\d+$/.test(idText)) {
        return parseInt(idText, 10);
    }
    return null;
}

function applyFrameFilter(frames) {
    const source = Array.isArray(frames) ? frames : [];
    const parsed = parseFrameFilter(frameFilterText);
    const hasIdFilter = parsed.ids.size > 0;
    const hasDirectionFilter = !!parsed.direction;
    const hasFilter = hasIdFilter || hasDirectionFilter;

    const filtered = source.filter((frame) => {
        if (hasDirectionFilter && String(frame.direction || "") !== parsed.direction) {
            return false;
        }
        if (hasIdFilter) {
            const canId = frameCanIdNumber(frame);
            if (canId === null || !parsed.ids.has(canId)) {
                return false;
            }
        }
        return true;
    });

    return { filtered, parsed, hasFilter, total: source.length };
}

function updateFrameFilterSummary(parsed, filteredCount, totalCount, hasFilter) {
    if (!dom.frameFilterSummary) {
        return;
    }

    if (!hasFilter) {
        dom.frameFilterSummary.textContent = `Showing all frames (${totalCount})`;
        return;
    }

    const parts = [];
    if (parsed.ids.size > 0) {
        parts.push(`${parsed.ids.size} id${parsed.ids.size > 1 ? "s" : ""}`);
    }
    if (parsed.direction) {
        parts.push(parsed.direction);
    }

    let text = `Showing ${filteredCount} of ${totalCount}`;
    if (parts.length > 0) {
        text += ` | filter: ${parts.join(", ")}`;
    }
    if (parsed.invalid.length > 0) {
        text += ` | ignored: ${parsed.invalid.join(" ")}`;
    }
    dom.frameFilterSummary.textContent = text;
}

function normalizeSignalRange(startBit, length, littleEndian, isSigned = false) {
    const sb = Number(startBit);
    const len = Number(length);
    if (!Number.isFinite(sb) || !Number.isFinite(len)) {
        return null;
    }

    return {
        start_bit: Math.max(0, Math.min(63, Math.trunc(sb))),
        length: Math.max(1, Math.min(64, Math.trunc(len))),
        little_endian: !!littleEndian,
        is_signed: !!isSigned,
    };
}
function nextMotorolaBit(current) {
    if ((current % 8) === 0) {
        return current + 15;
    }
    return current - 1;
}

function bitInSignal(signal, bitIndex) {
    if (!signal || !Number.isFinite(signal.start_bit) || !Number.isFinite(signal.length)) {
        return false;
    }

    const startBit = Math.trunc(signal.start_bit);
    const length = Math.max(1, Math.trunc(signal.length));

    if (signal.little_endian) {
        return bitIndex >= startBit && bitIndex < (startBit + length);
    }

    let b = startBit;
    for (let i = 0; i < length; i += 1) {
        if (b === bitIndex) {
            return true;
        }
        b = nextMotorolaBit(b);
        if (b < 0 || b > 63) {
            break;
        }
    }

    return false;
}

function signalBitSet(signal) {
    const set = new Set();
    if (!signal) {
        return set;
    }

    for (let bit = 0; bit < 64; bit += 1) {
        if (bitInSignal(signal, bit)) {
            set.add(bit);
        }
    }
    return set;
}

function signalFromForm() {
    const startBit = parseInt(dom.mutStartBit ? dom.mutStartBit.value : "", 10);
    const length = parseInt(dom.mutLength ? dom.mutLength.value : "", 10);
    const littleEndian = dom.mutEndian ? dom.mutEndian.value !== "big" : true;
    const isSigned = dom.mutSigned ? dom.mutSigned.value === "true" : false;
    return normalizeSignalRange(startBit, length, littleEndian, isSigned);
}
function parseCurrentFrameBytes() {
    const parts = String(currentFrameData || "").trim().split(/\s+/).filter(Boolean);
    const bytes = new Array(8).fill(0);
    for (let i = 0; i < Math.min(parts.length, 8); i += 1) {
        const parsed = parseInt(parts[i], 16);
        bytes[i] = Number.isFinite(parsed) ? (parsed & 0xFF) : 0;
    }
    return bytes;
}

function getBitFromBytes(bytes, bitIndex) {
    const safeBit = Math.max(0, Math.min(63, Math.trunc(bitIndex)));
    const byteIndex = Math.floor(safeBit / 8);
    const bitInByte = safeBit % 8;
    return ((bytes[byteIndex] >> bitInByte) & 0x01) === 1 ? 1 : 0;
}

function toggleBitInCurrentFrame(bitIndex) {
    const safeBit = Math.max(0, Math.min(63, Math.trunc(bitIndex)));
    const bytes = parseCurrentFrameBytes();
    const byteIndex = Math.floor(safeBit / 8);
    const bitInByte = safeBit % 8;
    bytes[byteIndex] ^= (1 << bitInByte);
    currentFrameData = bytesToDataString(bytes);
    return bytes;
}

function extractSignalRawBigInt(bytes, signal) {
    const normalized = normalizeSignalRange(
        signal && signal.start_bit,
        signal && signal.length,
        signal && signal.little_endian,
        signal && signal.is_signed,
    );
    if (!normalized) {
        return null;
    }

    let raw = 0n;
    if (normalized.little_endian) {
        for (let i = 0; i < normalized.length; i += 1) {
            const bit = getBitFromBytes(bytes, normalized.start_bit + i);
            raw |= (BigInt(bit) << BigInt(i));
        }
    } else {
        let bitPos = normalized.start_bit;
        for (let i = 0; i < normalized.length; i += 1) {
            if (bitPos < 0 || bitPos > 63) {
                return null;
            }
            const bit = getBitFromBytes(bytes, bitPos);
            raw = (raw << 1n) | BigInt(bit);
            bitPos = nextMotorolaBit(bitPos);
        }
    }

    if (!normalized.is_signed || normalized.length <= 0 || normalized.length >= 64) {
        return raw;
    }

    const signMask = 1n << BigInt(normalized.length - 1);
    if ((raw & signMask) !== 0n) {
        const modulus = 1n << BigInt(normalized.length);
        return raw - modulus;
    }

    return raw;
}

function syncReplaceValueFromBitEditor(bytes) {
    if (!dom.mutV1 || !dom.mutOperation) {
        return;
    }

    if (!dom.mutOperation.disabled && dom.mutOperation.value !== "REPLACE") {
        return;
    }

    const signal = signalFromForm();
    if (!signal) {
        return;
    }

    const raw = extractSignalRawBigInt(bytes, signal);
    if (raw === null) {
        return;
    }

    dom.mutV1.value = raw.toString();
}
function bytesToDataString(bytes) {
    return bytes
        .slice(0, 8)
        .map((value) => (value & 0xFF).toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
}

function sanitizeByteHex(rawValue) {
    return String(rawValue || "")
        .toUpperCase()
        .replace(/[^0-9A-F]/g, "")
        .slice(0, 2);
}

function commitRawByteInput(index, rawValue) {
    const byteIndex = Math.max(0, Math.min(7, Number(index) || 0));
    let normalized = sanitizeByteHex(rawValue);
    if (normalized.length === 0) {
        return false;
    }

    if (normalized.length === 1) {
        normalized = `0${normalized}`;
    }

    const bytes = parseCurrentFrameBytes();
    bytes[byteIndex] = parseInt(normalized, 16);
    currentFrameData = bytesToDataString(bytes);
    return true;
}

function renderRawBitEditor() {
    const bytes = parseCurrentFrameBytes();
    if (dom.rawByteInputs && dom.rawByteInputs.length > 0) {
        dom.rawByteInputs.forEach((input, idx) => {
            input.value = bytes[idx].toString(16).padStart(2, "0").toUpperCase();
        });
    }

    if (!dom.rawBitGrid) {
        return;
    }

    const selectedSignal = signalFromForm();
    const signalBits = signalBitSet(selectedSignal);
    const startBit = parseInt(dom.mutStartBit ? dom.mutStartBit.value : "", 10);
    const selectedByte = Number.isFinite(startBit)
        ? Math.max(0, Math.min(7, Math.floor(startBit / 8)))
        : 0;

    let html = "";
    html += `<div class="raw-bit-row-label">Byte ${selectedByte} (bits ${(selectedByte * 8) + 7}..${selectedByte * 8})</div>`;
    for (let bit = 7; bit >= 0; bit -= 1) {
        const bitIndex = (selectedByte * 8) + bit;
        const bitValue = ((bytes[selectedByte] >> bit) & 0x01) === 1;
        const classes = ["raw-bit-cell", bitValue ? "raw-bit-on" : "raw-bit-off"];
        const overrideMode = rawOverrideModes[bitIndex];
        if (signalBits.has(bitIndex)) {
            classes.push("raw-bit-selected");
        }
        if (Number.isFinite(startBit) && startBit === bitIndex) {
            classes.push("raw-bit-start");
        }
        if (overrideMode === 1) {
            classes.push("raw-bit-force1");
        } else if (overrideMode === 0) {
            classes.push("raw-bit-force0");
        } else {
            classes.push("raw-bit-pass");
        }

        const overrideLabel = overrideMode === 1 ? "F1" : (overrideMode === 0 ? "F0" : "P");

        html += `<button type="button" class="${classes.join(" ")}" data-bit-index="${bitIndex}" title="Bit ${bitIndex}">`
            + `<span class="raw-bit-label">b${bitIndex}</span>`
            + `<span class="raw-bit-value">${bitValue ? "1" : "0"}</span>`
            + `<span class="raw-bit-override">${overrideLabel}</span>`
            + `</button>`;
    }

    dom.rawBitGrid.innerHTML = html;
    syncReplaceValueFromBitEditor(bytes);
}

function cycleRawOverrideMode(bitIndex) {
    const idx = Math.max(0, Math.min(63, Math.trunc(bitIndex)));
    const current = rawOverrideModes[idx];
    if (current === -1) {
        rawOverrideModes[idx] = 1;
    } else if (current === 1) {
        rawOverrideModes[idx] = 0;
    } else {
        rawOverrideModes[idx] = -1;
    }
}

function rawOverrideMaskValueHexForByte(byteIndex) {
    let mask = 0;
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
        const bitIndex = (byteIndex * 8) + bit;
        const mode = rawOverrideModes[bitIndex];
        if (mode === -1) {
            continue;
        }
        mask |= (1 << bit);
        if (mode === 1) {
            value |= (1 << bit);
        }
    }
    return {
        maskHex: mask.toString(16).padStart(2, "0").toUpperCase(),
        valueHex: value.toString(16).padStart(2, "0").toUpperCase(),
        hasAny: mask !== 0,
    };
}

function buildRawOverridePayload() {
    let mask = "";
    let value = "";
    let hasAny = false;
    for (let byteIdx = 0; byteIdx < 8; byteIdx += 1) {
        const item = rawOverrideMaskValueHexForByte(byteIdx);
        mask += item.maskHex;
        value += item.valueHex;
        hasAny = hasAny || item.hasAny;
    }
    return { mask, value, hasAny };
}

function ensureRawOverrideButton() {
    if (!dom.rawEditor || document.getElementById("raw-override-apply")) {
        return;
    }

    const row = document.createElement("div");
    row.className = "mt-2 d-flex gap-2 flex-wrap";
    row.innerHTML = `
        <button type="button" class="btn btn-sm btn-outline-primary" id="raw-override-apply">Apply Raw Override</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="raw-override-clear">Clear Raw Override</button>
    `;
    dom.rawEditor.appendChild(row);

    const applyBtn = document.getElementById("raw-override-apply");
    const clearBtn = document.getElementById("raw-override-clear");

    if (applyBtn) {
        applyBtn.addEventListener("click", async () => {
            const payload = buildRawOverridePayload();
            if (!payload.hasAny) {
                dom.replayStatus.textContent = "No raw override bits set";
                return;
            }

            const params = new URLSearchParams();
            params.set("rule_kind", "RAW_MASK");
            params.set("can_id", dom.mutCanId.value || "0x000");
            params.set("direction", dom.mutDirection.value || "A_TO_B");
            params.set("mask", payload.mask);
            params.set("value", payload.value);
            params.set("enabled", "true");

            const stage = await postForm("/api/rules/stage", params);
            if (!stage.ok) {
                dom.replayStatus.textContent = "Raw override stage failed";
                return;
            }

            const commit = await postJson("/api/rules", { action: "apply_commit" });
            dom.replayStatus.textContent = commit.ok ? "Raw override applied" : "Raw override commit failed";
            refreshStatus();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            rawOverrideModes = new Array(64).fill(-1);
            renderRawBitEditor();
            dom.replayStatus.textContent = "Raw override cleared";
        });
    }
}
function trySelectSignalForBit(bitIndex) {
    const selectedFrame = findSelectedFrame(displayedFrames);
    if (!selectedFrame) {
        return false;
    }

    const decoded = Array.isArray(selectedFrame.decoded_signals) ? selectedFrame.decoded_signals : [];
    if (decoded.length === 0 || !dom.signalPicker || dom.signalPicker.disabled) {
        return false;
    }

    const idx = decoded.findIndex((signal) => bitInSignal(signal, bitIndex));
    if (idx < 0) {
        return false;
    }

    selectedSignalIndex = idx;
    dom.signalPicker.value = String(idx);
    applySignalToMutationForm(decoded[idx]);
    return true;
}

function enforceRawOnlyOperationMode() {
    if (!dom.mutOperation || !dom.signalPicker) {
        return;
    }

    const hasDecodedSignal = !dom.signalPicker.disabled
        && dom.signalPicker.options.length > 0
        && dom.signalPicker.value !== "";

    if (!hasDecodedSignal) {
        dom.mutOperation.value = "REPLACE";
        dom.mutOperation.disabled = true;
    } else {
        dom.mutOperation.disabled = false;
    }

    updateOperationControls();
}

function formatSignalValue(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "-";
    }

    const fixed = value.toFixed(3);
    return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function findSelectedFrame(frames) {
    if (!selectedFrameKey) {
        return null;
    }

    const safeFrames = Array.isArray(frames) ? frames : [];
    for (let i = safeFrames.length - 1; i >= 0; i -= 1) {
        const frame = safeFrames[i];
        if (frameKey(frame, i) === selectedFrameKey) {
            return frame;
        }
    }
    return null;
}

function setSignalPickerDisabled(message, options) {
    if (!dom.signalPicker) {
        return;
    }

    dom.signalPicker.innerHTML = `<option value="">${escapeHtml(message)}</option>`;
    dom.signalPicker.disabled = true;
    selectedSignalIndex = 0;
    enforceRawOnlyOperationMode();
    // Status polls pass { preserveEditor: true } so periodic refreshes do not
    // overwrite values the user is currently editing in the Raw Frame / Bit
    // Editor or in the Mutation Editor's REPLACE value field.
    if (!options || !options.preserveEditor) {
        renderRawBitEditor();
    }
}

function applySignalToMutationForm(signal) {
    if (!signal) {
        return;
    }

    if (Number.isFinite(signal.start_bit) && dom.mutStartBit) {
        dom.mutStartBit.value = String(signal.start_bit);
    }
    if (Number.isFinite(signal.length) && dom.mutLength) {
        dom.mutLength.value = String(signal.length);
    }

    if (dom.mutEndian) {
        dom.mutEndian.value = signal.little_endian ? "little" : "big";
    }

    if (dom.mutSigned) {
        dom.mutSigned.value = signal.is_signed ? "true" : "false";
    }

    if (Number.isFinite(signal.factor) && dom.mutFactor) {
        dom.mutFactor.value = String(signal.factor);
    }

    if (Number.isFinite(signal.offset) && dom.mutOffset) {
        dom.mutOffset.value = String(signal.offset);
    }
}

function refreshSignalPicker(frame, preserveSelection, options) {
    if (!dom.signalPicker) {
        return;
    }

    const decoded = frame && Array.isArray(frame.decoded_signals) ? frame.decoded_signals : [];
    if (decoded.length === 0) {
        setSignalPickerDisabled("No decoded signals for selected frame", options);
        return;
    }

    const previousName = preserveSelection && decoded[selectedSignalIndex]
        ? decoded[selectedSignalIndex].name
        : null;

    dom.signalPicker.disabled = false;
    dom.signalPicker.innerHTML = "";

    decoded.forEach((signal, idx) => {
        const option = document.createElement("option");
        option.value = String(idx);
        option.textContent = `${signal.name} (${formatSignalValue(signal.value)})`;
        dom.signalPicker.appendChild(option);
    });

    if (previousName) {
        const idxByName = decoded.findIndex((sig) => sig.name === previousName);
        selectedSignalIndex = idxByName >= 0 ? idxByName : 0;
    } else if (selectedSignalIndex >= decoded.length) {
        selectedSignalIndex = 0;
    }

    dom.signalPicker.value = String(selectedSignalIndex);
    enforceRawOnlyOperationMode();
    // Status polls pass { preserveEditor: true } so periodic refreshes do not
    // overwrite values the user is currently editing in the Raw Frame / Bit
    // Editor or in the Mutation Editor's REPLACE value field.
    if (!options || !options.preserveEditor) {
        renderRawBitEditor();
    }
}

function loadFrameIntoEditors(frame, preserveSignalSelection = false) {
    if (!frame) {
        return;
    }

    currentFrameData = frame.data || "";
    renderRawBitEditor();

    if (dom.mutCanId) {
        dom.mutCanId.value = frame.id || "0x000";
    }

    if (dom.mutDirection && (frame.direction === "A_TO_B" || frame.direction === "B_TO_A")) {
        dom.mutDirection.value = frame.direction;
    }

    refreshSignalPicker(frame, preserveSignalSelection);

    const decoded = Array.isArray(frame.decoded_signals) ? frame.decoded_signals : [];
    if (decoded.length > 0) {
        const safeIndex = Number(dom.signalPicker ? dom.signalPicker.value : selectedSignalIndex);
        selectedSignalIndex = Number.isFinite(safeIndex) ? Math.max(0, Math.min(decoded.length - 1, safeIndex)) : 0;
        applySignalToMutationForm(decoded[selectedSignalIndex]);
        dom.replayStatus.textContent = `Selected ${frame.id} ${frame.direction} (${decoded[selectedSignalIndex].name})`;
    } else {
        dom.replayStatus.textContent = `Selected ${frame.id} ${frame.direction}`;
    }

    enforceRawOnlyOperationMode();
    renderRawBitEditor();
}

function compareFramesByCanIdAscending(left, right) {
    const leftId = frameCanIdNumber(left);
    const rightId = frameCanIdNumber(right);
    if (leftId === null && rightId === null) {
        return 0;
    }
    if (leftId === null) {
        return 1;
    }
    if (rightId === null) {
        return -1;
    }
    return leftId - rightId;
}

function renderFrames(frames) {
    lastRenderSourceFrames = Array.isArray(frames) ? frames.slice() : [];
    const { filtered, parsed, hasFilter, total } = applyFrameFilter(frames);
    // Stable sort: groups events by CAN ID while preserving the device's
    // newest-first ordering within each group.
    filtered.sort(compareFramesByCanIdAscending);
    displayedFrames = filtered;
    dom.frameTable.innerHTML = "";
    updateFrameFilterSummary(parsed, filtered.length, total, hasFilter);

    if (displayedFrames.length === 0) {
        dom.frameTable.innerHTML = hasFilter
            ? '<tr><td colspan="5" class="text-muted">No frames match current filter</td></tr>'
            : '<tr><td colspan="5" class="text-muted">Waiting for CAN frames...</td></tr>';
        return;
    }

    displayedFrames.forEach((frame, idx) => {
        const row = document.createElement("tr");
        const key = frameKey(frame, idx);
        const decoded = Array.isArray(frame.decoded_signals) ? frame.decoded_signals : [];
        const hasRuleMutation = frame && (frame.mutated === true || frame.mutated === "true");
        const hasMutatedSignal = hasRuleMutation || decoded.some((sig) => sig && sig.mutated === true);

        const decodedPreview = decoded.slice(0, 3).map((sig) => {
            const chipClass = sig.mutated ? "signal-chip signal-chip-mut" : "signal-chip";
            const label = `${escapeHtml(sig.name || "signal") }=${escapeHtml(formatSignalValue(sig.value))}`;
            return `<span class="${chipClass}">${label}</span>`;
        });
        const mutationChip = hasRuleMutation
            ? '<span class="signal-chip signal-chip-mut">mutation active</span>'
            : "";

        let decodedLine = "";
        if ((frame.message_name && frame.message_name.length > 0) || decodedPreview.length > 0 || mutationChip) {
            const messagePrefix = frame.message_name ? `<span class="text-muted me-1">${escapeHtml(frame.message_name)}:</span>` : "";
            const moreSuffix = decoded.length > 3 ? `<span class="text-muted small">+${decoded.length - 3}</span>` : "";
            decodedLine = `<div class="small mt-1">${messagePrefix}${mutationChip}${decodedPreview.join("")}${moreSuffix}</div>`;
        }

        row.innerHTML = `
            <td>${escapeHtml(frame.id || "-")}</td>
            <td>${escapeHtml(frame.dlc ?? "-")}</td>
            <td>${escapeHtml(frame.direction || "-")}</td>
            <td><div class="fw-semibold frame-data">${renderFrameDataBytes(frame.data, frame.byte_changed_mask)}</div>${decodedLine}</td>
            <td>${formatPeriodMs(frame.period_ms)}</td>
        `;

        row.style.cursor = "pointer";
        row.title = "Click to load this frame into editors";

        if (hasMutatedSignal) {
            row.classList.add("frame-has-mutation");
        }

        if (selectedFrameKey && selectedFrameKey === key) {
            row.classList.add("table-active");
        }

        row.addEventListener("click", () => {
            selectedFrameKey = key;
            selectedSignalIndex = 0;
            loadFrameIntoEditors(frame);
            renderFrames(lastRenderSourceFrames);
        });

        dom.frameTable.appendChild(row);
    });
}

function setOffline() {
    dom.cpuLoad.textContent = "offline";
    dom.busA.textContent = "offline";
    dom.busB.textContent = "offline";
    dom.rxDepth.textContent = "offline";
    dom.dropped.textContent = "offline";
    if (dom.directPathAvg) dom.directPathAvg.textContent = "offline";
    if (dom.mutatedPathAvg) dom.mutatedPathAvg.textContent = "offline";
    dom.dbcStatus.textContent = "No backend connection";
    if (dom.dbcUnload) {
        dom.dbcUnload.hidden = true;
    }
}

function updatePauseUi() {
    if (!dom.framePause) {
        return;
    }

    if (framesPaused) {
        dom.framePause.textContent = "Resume";
        dom.framePause.classList.remove("btn-outline-secondary");
        dom.framePause.classList.add("btn-outline-success");
    } else {
        dom.framePause.textContent = "Pause";
        dom.framePause.classList.remove("btn-outline-success");
        dom.framePause.classList.add("btn-outline-secondary");
    }
}

function updateOperationControls() {
    const operation = dom.mutOperation ? dom.mutOperation.value : "PASS_THROUGH";

    if (!dom.opParam1Group || !dom.opParam2Group || !dom.opParam1Label || !dom.opParam2Label) {
        return;
    }

    const hideParam1 = () => { dom.opParam1Group.style.display = "none"; };
    const hideParam2 = () => { dom.opParam2Group.style.display = "none"; };
    const showParam1 = () => { dom.opParam1Group.style.display = ""; };
    const showParam2 = () => { dom.opParam2Group.style.display = ""; };

    // Start from a hidden state so each operation enables only what it needs.
    hideParam1();
    hideParam2();

    switch (operation) {
    case "REPLACE":
        dom.opParam1Label.textContent = "Value";
        showParam1();
        break;
    case "ADD_OFFSET":
        dom.opParam1Label.textContent = "Offset";
        showParam1();
        break;
    case "MULTIPLY":
        dom.opParam1Label.textContent = "Multiplier";
        showParam1();
        break;
    case "CLAMP":
        dom.opParam1Label.textContent = "Min";
        dom.opParam2Label.textContent = "Max";
        showParam1();
        showParam2();
        break;
    case "PASS_THROUGH":
    default:
        break;
    }
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    let body = null;
    try {
        body = await response.json();
    } catch (_error) {
        body = null;
    }

    return { ok: response.ok, status: response.status, body };
}

async function postForm(url, params) {
    const qs = params ? params.toString() : "";
    const requestUrl = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;

    const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: qs,
    });

    let body = null;
    try {
        body = await response.json();
    } catch (_error) {
        body = null;
    }

    return { ok: response.ok, status: response.status, body };
}

async function setObservationMode(mode) {
    const params = new URLSearchParams();
    params.set("mode", mode);
    try {
        await postForm("/api/observe", params);
    } catch (_error) {
        // Best-effort subscription update.
    }
}

function mutationFormParams() {
    const params = new URLSearchParams();
    params.set("can_id", dom.mutCanId.value || "0x000");
    params.set("direction", dom.mutDirection.value || "A_TO_B");
    params.set("start_bit", dom.mutStartBit.value || "0");
    params.set("length", dom.mutLength.value || "8");
    params.set("little_endian", dom.mutEndian && dom.mutEndian.value === "big" ? "false" : "true");
    params.set("is_signed", dom.mutSigned && dom.mutSigned.value === "true" ? "true" : "false");
    params.set("factor", dom.mutFactor.value || "1");
    params.set("offset", dom.mutOffset.value || "0");
    const forcedRawOperation = dom.mutOperation && dom.mutOperation.disabled;
    params.set("operation", forcedRawOperation ? "REPLACE" : (dom.mutOperation.value || "PASS_THROUGH"));
    params.set("op_value1", dom.mutV1.value || "0");
    params.set("op_value2", dom.mutV2.value || "0");
    params.set("enabled", dom.mutEnabled.checked ? "true" : "false");
    return params;
}

function mutationModeLabel(mode) {
    switch (mode) {
    case "enabled":
        return "On";
    case "single_shot":
        return "Once";
    default:
        return "Off";
    }
}

function resolveMutationItemMode(item) {
    if (item.mode === "enabled" || item.mode === "single_shot" || item.mode === "disabled") {
        return item.mode;
    }
    return item.active ? "enabled" : "disabled";
}

async function postRuleMutationMode(item, mode) {
    if (item && item.rule_id !== undefined && item.rule_id !== null) {
        const byId = new URLSearchParams();
        byId.set("mode", mode);
        byId.set("rule_id", String(item.rule_id));
        const direct = await postForm("/api/rules/mode", byId);
        if (direct.ok) {
            dom.replayStatus.textContent = "Mutation mode updated";
            refreshStatus();
            return true;
        }
    }

    const params = new URLSearchParams();
    params.set("mode", mode);
    params.set("can_id", item.can_id);
    params.set("direction", item.direction);
    if (item.kind === "RAW_MASK") {
        params.set("kind", "RAW_MASK");
    } else {
        params.set("start_bit", String(item.start_bit));
        params.set("length", String(item.length));
    }

    const fallback = await postForm("/api/mutations/mode", params);
    if (!fallback.ok) {
        dom.replayStatus.textContent = "Mutation mode update failed";
        return false;
    }

    dom.replayStatus.textContent = "Mutation mode updated";
    refreshStatus();
    return true;
}

async function postAllMutationModes(mode) {
    const params = new URLSearchParams();
    params.set("mode", mode);
    const response = await postForm("/api/rules/mode_all", params);
    if (!response.ok) {
        dom.replayStatus.textContent = "Bulk mutation mode failed";
        return false;
    }
    dom.replayStatus.textContent = "All mutations mode updated";
    refreshStatus();
    return true;
}

const mutationMasterModeButtons = () =>
    [dom.activeMutationsMasterOff, dom.activeMutationsMasterOn, dom.activeMutationsMasterOnce].filter(Boolean);

function renderActiveMutations(items) {
    if (!dom.activeMutationList) {
        return;
    }

    dom.activeMutationList.innerHTML = "";

    if (!Array.isArray(items) || items.length === 0) {
        dom.activeMutationList.innerHTML = '<div class="text-muted small">No active mutations</div>';
        return;
    }

    items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "list-group-item d-flex justify-content-between align-items-center px-0 flex-wrap gap-2";

        const signalName = item.signal_name ? item.signal_name : `${item.start_bit}|${item.length}`;
        const left = document.createElement("div");
        left.innerHTML = `
            <div class="fw-semibold">${escapeHtml(item.can_id)} ${escapeHtml(item.direction)}</div>
            <div class="small text-muted">${escapeHtml(signalName)} ${escapeHtml(item.operation || "")}</div>
        `;

        const currentMode = resolveMutationItemMode(item);
        const modeSwitch = document.createElement("div");
        modeSwitch.className = "btn-group btn-group-sm mutation-row-mode-switch flex-shrink-0";
        modeSwitch.setAttribute("role", "group");
        modeSwitch.setAttribute("aria-label", "Mutation mode");

        ["disabled", "enabled", "single_shot"].forEach((modeValue) => {
            const tabButton = document.createElement("button");
            tabButton.type = "button";
            tabButton.dataset.mutationMode = modeValue;
            tabButton.textContent = mutationModeLabel(modeValue);
            const isSelected = modeValue === currentMode;
            tabButton.className = isSelected ? "btn btn-secondary" : "btn btn-outline-secondary";
            tabButton.setAttribute("aria-pressed", isSelected ? "true" : "false");

            tabButton.addEventListener("click", async () => {
                if (tabButton.disabled || modeValue === currentMode) {
                    return;
                }
                modeSwitch.querySelectorAll("button").forEach((button) => {
                    button.disabled = true;
                });
                const ok = await postRuleMutationMode(item, modeValue);
                modeSwitch.querySelectorAll("button").forEach((button) => {
                    button.disabled = false;
                });
                if (!ok) {
                    modeSwitch.querySelectorAll("button").forEach((button) => {
                        const buttonMode = button.dataset.mutationMode;
                        const selected = buttonMode === currentMode;
                        button.classList.toggle("btn-secondary", selected);
                        button.classList.toggle("btn-outline-secondary", !selected);
                        button.setAttribute("aria-pressed", selected ? "true" : "false");
                    });
                }
            });

            modeSwitch.appendChild(tabButton);
        });

        row.appendChild(left);
        row.appendChild(modeSwitch);
        dom.activeMutationList.appendChild(row);
    });
}

mutationMasterModeButtons().forEach((button) => {
    button.addEventListener("click", async () => {
        const mode = button.dataset.mutationMode;
        if (!mode) {
            return;
        }
        mutationMasterModeButtons().forEach((masterButton) => {
            masterButton.disabled = true;
        });
        await postAllMutationModes(mode);
        mutationMasterModeButtons().forEach((masterButton) => {
            masterButton.disabled = false;
        });
    });
});

async function refreshStatus() {
    try {
        const response = await fetch("/api/status");
        if (!response.ok) {
            throw new Error("status unavailable");
        }

        const status = await response.json();
        dom.cpuLoad.textContent = `${status.cpu_load_pct}%`;
        dom.busA.textContent = status.bus_a_ready
            ? `RX ${status.bus_a_rx_util_pct}% / TX ${status.bus_a_tx_util_pct}% · drops: ${status.bus_a_hw_drops}`
            : "not ready";
        dom.busB.textContent = status.bus_b_ready
            ? `RX ${status.bus_b_rx_util_pct}% / TX ${status.bus_b_tx_util_pct}% · drops: ${status.bus_b_hw_drops}`
            : "not ready";
        dom.rxDepth.textContent = `${status.rx_queue_depth}`;
        dom.dropped.textContent = `${status.dropped_frames}`;
        dom.mutationCount.textContent = `${status.active_mutations} active / ${status.staging_mutations} staging`;
        if (dom.directPathAvg) {
            const framesPerSec = Number(status.direct_path_frames_per_sec || 0);
            const v = Number(status.direct_path_avg_us || 0);
            const showLatency = framesPerSec > 0 || v > 0;
            dom.directPathAvg.textContent = showLatency ? `${v} us · ${framesPerSec} frames/s` : "-";
        }
        if (dom.mutatedPathAvg) {
            const framesPerSec = Number(status.mutated_path_frames_per_sec || 0);
            const v = Number(status.mutated_path_avg_us || 0);
            const showLatency = framesPerSec > 0 || v > 0;
            dom.mutatedPathAvg.textContent = showLatency ? `${v} us · ${framesPerSec} frames/s` : "-";
        }
        dom.dbcStatus.textContent = status.dbc_loaded
            ? `DBC loaded (${status.dbc_message_count} msgs / ${status.dbc_signal_count} signals)`
            : "No DBC loaded";
        if (dom.dbcUnload) {
            dom.dbcUnload.hidden = !status.dbc_loaded;
        }

        renderActiveMutations(status.active_mutation_items || []);

        latestIncomingFrames = status.recent_frames || [];
        if (!framesPaused) {
            renderFrames(latestIncomingFrames);

            // Once a frame has been loaded into the editors, the Mutation
            // Editor and Raw Frame + Bit Editor are user-owned: they reflect
            // the snapshot taken at click time plus whatever the user types.
            // Periodic status polls only refresh the picker option labels
            // (so live signal values stay visible in the dropdown) and must
            // not re-render the editor, which would clobber pending edits in
            // the byte inputs and the REPLACE value field.
            const selectedFrame = findSelectedFrame(displayedFrames);
            if (selectedFrame) {
                refreshSignalPicker(selectedFrame, true, { preserveEditor: true });
            } else if (dom.signalPicker) {
                setSignalPickerDisabled("Select a frame with decoded DBC signals", { preserveEditor: true });
            }
        }
    } catch (_error) {
        setOffline();
    }
}

dom.dbcUploadBusy = false;
dom.dbcUpload.addEventListener("click", async () => {
    if (dom.dbcUploadBusy) {
        return;
    }

    const file = dom.dbcFile.files && dom.dbcFile.files[0];
    if (!file) {
        dom.dbcStatus.textContent = "Select a .dbc file first";
        return;
    }

    dom.dbcUploadBusy = true;
    if (dom.dbcUpload) {
        dom.dbcUpload.disabled = true;
    }
    dom.dbcStatus.textContent = `Uploading ${file.name}...`;
    dom.replayStatus.textContent = `DBC upload started: ${file.name}`;
    let uploadSucceeded = false;

    try {
        const text = await file.text();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
        try {
            response = await fetch("/api/dbc", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: text,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        let body = null;
        let rawText = "";
        try {
            rawText = await response.text();
            body = rawText ? JSON.parse(rawText) : null;
        } catch (_error) {
            body = null;
        }

        if (response.ok && body && body.ok) {
            dom.dbcStatus.textContent = `DBC loaded (${body.messages} msgs / ${body.signals} signals)`;
            dom.replayStatus.textContent = `DBC upload successful: ${file.name}`;
            uploadSucceeded = true;
        } else {
            const reason = (body && (body.error || body.message))
                ? (body.error || body.message)
                : (rawText || `HTTP ${response.status}`);
            dom.dbcStatus.textContent = `DBC upload failed: ${reason}`;
            dom.replayStatus.textContent = "DBC upload failed";
        }
    } catch (error) {
        if (error && error.name === "AbortError") {
            dom.dbcStatus.textContent = "DBC upload timed out";
            dom.replayStatus.textContent = "DBC upload timed out";
        } else {
            dom.dbcStatus.textContent = `DBC upload failed: ${error && error.message ? error.message : "network error"}`;
            dom.replayStatus.textContent = "DBC upload failed";
        }
    } finally {
        dom.dbcUploadBusy = false;
        if (dom.dbcUpload) {
            dom.dbcUpload.disabled = false;
        }
    }

    if (uploadSucceeded) {
        setObservationMode("all");
        refreshStatus();
    }
});

if (dom.dbcUnload) {
    dom.dbcUnload.addEventListener("click", async () => {
        if (dom.dbcUnload.disabled) {
            return;
        }

        dom.dbcUnload.disabled = true;
        const previousStatus = dom.dbcStatus.textContent;
        dom.dbcStatus.textContent = "Unloading DBC...";
        dom.replayStatus.textContent = "DBC unload requested";

        try {
            const response = await fetch("/api/dbc", { method: "DELETE" });
            let body = null;
            try {
                body = await response.json();
            } catch (_error) {
                body = null;
            }

            if (response.ok && body && body.ok) {
                dom.dbcStatus.textContent = "No DBC loaded";
                dom.replayStatus.textContent = "DBC unloaded";
                dom.dbcUnload.hidden = true;
            } else {
                const reason = (body && (body.error || body.message))
                    ? (body.error || body.message)
                    : `HTTP ${response.status}`;
                dom.dbcStatus.textContent = previousStatus;
                dom.replayStatus.textContent = `DBC unload failed: ${reason}`;
            }
        } catch (error) {
            dom.dbcStatus.textContent = previousStatus;
            dom.replayStatus.textContent = `DBC unload failed: ${error && error.message ? error.message : "network error"}`;
        } finally {
            dom.dbcUnload.disabled = false;
        }

        refreshStatus();
    });
}

dom.applyBtn.addEventListener("click", async () => {
    const stage = await postForm("/api/mutations/stage", mutationFormParams());
    if (!stage.ok) {
        dom.replayStatus.textContent = "Mutation stage failed";
        return;
    }

    const apply = await postJson("/api/mutations", { action: "apply_commit" });
    dom.replayStatus.textContent = apply.ok ? "Mutation applied" : "Mutation commit failed";
    refreshStatus();
});

dom.revertBtn.addEventListener("click", async () => {
    const result = await postJson("/api/mutations", { action: "revert" });
    dom.replayStatus.textContent = result.ok ? "Mutation staging reverted" : "Revert failed";
    refreshStatus();
});

dom.clearStagingBtn.addEventListener("click", async () => {
    const clearStage = await postJson("/api/mutations", { action: "clear_staging" });
    if (!clearStage.ok) {
        dom.replayStatus.textContent = "Clear staging failed";
        return;
    }

    const commit = await postJson("/api/mutations", { action: "apply_commit" });
    dom.replayStatus.textContent = commit.ok ? "All mutations cleared" : "Mutation clear commit failed";
    refreshStatus();
});

dom.replayPlay.addEventListener("click", async () => {
    const file = dom.replayFile.files && dom.replayFile.files[0];
    if (file) {
        dom.replayStatus.textContent = `Loading replay ${file.name}...`;
        try {
            const text = await file.text();
            const loadResponse = await fetch(`/api/replay/load?direction=${encodeURIComponent(dom.replayDirection.value)}`, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: text,
            });

            const loadBody = await loadResponse.json();
            if (!loadResponse.ok || !loadBody.ok) {
                dom.replayStatus.textContent = "Replay load failed";
                return;
            }
        } catch (_error) {
            dom.replayStatus.textContent = "Replay load failed";
            return;
        }
    }

    const start = await postJson("/api/replay", {
        action: "start",
        loop_mode: dom.replayLoop ? dom.replayLoop.value : "PLAY_ONCE",
    });

    dom.replayStatus.textContent = start.ok ? "Replay running" : "Replay start failed";
    refreshStatus();
});

dom.replayStop.addEventListener("click", async () => {
    const result = await postJson("/api/replay", { action: "stop" });
    dom.replayStatus.textContent = result.ok ? "Replay stopped" : "Replay stop failed";
    refreshStatus();
});

if (dom.signalPicker) {
    dom.signalPicker.addEventListener("change", () => {
        const selectedFrame = findSelectedFrame(displayedFrames);
        if (!selectedFrame) {
            return;
        }

        const decoded = Array.isArray(selectedFrame.decoded_signals) ? selectedFrame.decoded_signals : [];
        const index = Number(dom.signalPicker.value);
        if (!Number.isFinite(index) || index < 0 || index >= decoded.length) {
            return;
        }

        selectedSignalIndex = index;
        applySignalToMutationForm(decoded[index]);
        enforceRawOnlyOperationMode();
        renderRawBitEditor();
    });
}

if (dom.framePause) {
    dom.framePause.addEventListener("click", () => {
        framesPaused = !framesPaused;
        updatePauseUi();

        if (!framesPaused) {
            renderFrames(latestIncomingFrames);
        }
    });
}

if (dom.frameFilterInput) {
    dom.frameFilterInput.addEventListener("input", () => {
        frameFilterText = String(dom.frameFilterInput.value || "");
        const source = framesPaused ? lastRenderSourceFrames : latestIncomingFrames;
        renderFrames(source);
    });
}

if (dom.frameFilterClear) {
    dom.frameFilterClear.addEventListener("click", () => {
        frameFilterText = "";
        if (dom.frameFilterInput) {
            dom.frameFilterInput.value = "";
        }
        const source = framesPaused ? lastRenderSourceFrames : latestIncomingFrames;
        renderFrames(source);
    });
}

if (dom.rawByteInputs && dom.rawByteInputs.length > 0) {
    dom.rawByteInputs.forEach((input, idx) => {
        input.addEventListener("focus", () => {
            if (dom.mutStartBit) {
                dom.mutStartBit.value = String(idx * 8);
            }
            if (dom.mutLength) {
                dom.mutLength.value = "8";
            }
            renderRawBitEditor();
        });

        input.addEventListener("input", () => {
            input.value = sanitizeByteHex(input.value);
            if (input.value.length === 2) {
                commitRawByteInput(idx, input.value);
                renderRawBitEditor();
            }
        });

        const commitInput = () => {
            commitRawByteInput(idx, input.value);
            renderRawBitEditor();
        };

        input.addEventListener("change", commitInput);
        input.addEventListener("blur", commitInput);
    });
}

if (dom.rawBitGrid) {
    dom.rawBitGrid.addEventListener("click", (event) => {
        const bitCell = event.target && event.target.closest("[data-bit-index]");
        if (!bitCell) {
            return;
        }

        const bitIndex = parseInt(bitCell.getAttribute("data-bit-index") || "", 10);
        if (!Number.isFinite(bitIndex) || bitIndex < 0 || bitIndex > 63) {
            return;
        }

        toggleBitInCurrentFrame(bitIndex);

        const selected = trySelectSignalForBit(bitIndex);
        if (!selected) {
            if (dom.mutStartBit) {
                dom.mutStartBit.value = String(bitIndex);
            }
            if (dom.mutLength) {
                dom.mutLength.value = "1";
            }
            if (dom.mutOperation) {
                dom.mutOperation.value = "REPLACE";
            }
        }

        enforceRawOnlyOperationMode();
        renderRawBitEditor();
    });

    dom.rawBitGrid.addEventListener("contextmenu", (event) => {
        const bitCell = event.target && event.target.closest("[data-bit-index]");
        if (!bitCell) {
            return;
        }
        event.preventDefault();

        const bitIndex = parseInt(bitCell.getAttribute("data-bit-index") || "", 10);
        if (!Number.isFinite(bitIndex) || bitIndex < 0 || bitIndex > 63) {
            return;
        }

        cycleRawOverrideMode(bitIndex);
        renderRawBitEditor();
    });
}

if (dom.mutOperation) {
    dom.mutOperation.addEventListener("change", () => {
        updateOperationControls();
        renderRawBitEditor();
    });
}

[dom.mutStartBit, dom.mutLength, dom.mutEndian, dom.mutSigned, dom.mutFactor, dom.mutOffset]
    .forEach((el) => {
        if (el) {
            el.addEventListener("input", renderRawBitEditor);
            el.addEventListener("change", renderRawBitEditor);
        }
    });

updateOperationControls();
enforceRawOnlyOperationMode();
updatePauseUi();
setSignalPickerDisabled("Select a frame with decoded DBC signals");
ensureRawOverrideButton();
renderRawBitEditor();
setOffline();
setObservationMode("all");
refreshStatus();
setInterval(() => {
    refreshStatus();
    if (!dom.mutOperation || !dom.mutOperation.disabled) {
        updateOperationControls();
    }
}, 1000);

window.addEventListener("beforeunload", () => {
    try {
        const body = new URLSearchParams({ mode: "none" });
        navigator.sendBeacon("/api/observe", body);
    } catch (_error) {
        // Ignore unload failures.
    }
});


