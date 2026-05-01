
(function () {
    'use strict';

    var STORAGE_API_BASE_KEY = 'openhaldex.fw.apiBase';
    var DEFAULT_TIMEOUT_MS = 2500;

    var state = {
        apiBase: '',
        runtimeCache: null,
        runtimeCacheTs: 0,
        runtimePromise: null,
        chart: null,
        chartMaxPoints: 36,
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function collapseStorageKey() {
        var key = pageKey();
        if (!key) {
            key = String(window.location && window.location.pathname || '/').toLowerCase();
        }
        return 'openhaldex.fw.cardCollapse.' + key;
    }

    function slugToken(value, fallback) {
        var text = String(value || '').trim().toLowerCase();
        text = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return text || fallback;
    }

    function readCollapseState() {
        try {
            var raw = localStorage.getItem(collapseStorageKey());
            if (!raw) {
                return {};
            }
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return {};
            }
            return parsed;
        } catch (_) {
            return {};
        }
    }

    function writeCollapseState(nextState) {
        try {
            localStorage.setItem(collapseStorageKey(), JSON.stringify(nextState || {}));
        } catch (_) {
            // Ignore storage failures.
        }
    }

    function setCardCollapsed(card, collapsed) {
        if (!card) {
            return;
        }
        card.classList.toggle('fw-card-collapsed', Boolean(collapsed));
        var btn = card.querySelector('.fw-card-collapse-toggle');
        if (!btn) {
            return;
        }
        var icon = btn.querySelector('i');
        if (icon) {
            icon.className = collapsed ? 'ri-add-line' : 'ri-subtract-line';
        }
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.setAttribute('title', collapsed ? 'Expand block' : 'Collapse block');
    }

    function initCardCollapsePersistence() {
        var cards = document.querySelectorAll('.content-page .card');
        if (!cards.length) {
            return;
        }

        var collapsedState = readCollapseState();

        cards.forEach(function (card, index) {
            var body = card.querySelector(':scope > .card-body') || card.querySelector('.card-body');
            if (!body) {
                return;
            }
            if (body.querySelector(':scope > .fw-card-collapse-row')) {
                return;
            }

            var headingNode = body.querySelector('.header-title, .card-title, h4, h5');
            var headingText = headingNode ? headingNode.textContent : '';
            var cardId = card.getAttribute('id') || card.getAttribute('data-fw-card-id') || '';
            if (!cardId) {
                cardId = slugToken(headingText, 'card-' + (index + 1)) + '-' + (index + 1);
            }
            card.setAttribute('data-fw-card-id', cardId);

            var row = document.createElement('div');
            row.className = 'fw-card-collapse-row';

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-outline-secondary fw-card-collapse-toggle';
            btn.innerHTML = '<i class="ri-subtract-line"></i><span class="visually-hidden">Toggle block</span>';
            row.appendChild(btn);

            var title = document.createElement('span');
            title.className = 'fw-card-collapse-title header-title mb-0';
            title.textContent = String(headingText || 'Section').trim() || 'Section';
            row.appendChild(title);

            body.insertBefore(row, body.firstChild);

            if (headingNode) {
                headingNode.classList.add('fw-card-collapse-heading-source');
            }

            var startCollapsed = Boolean(collapsedState[cardId]);
            setCardCollapsed(card, startCollapsed);

            btn.addEventListener('click', function () {
                var nextCollapsed = !card.classList.contains('fw-card-collapsed');
                setCardCollapsed(card, nextCollapsed);
                collapsedState[cardId] = nextCollapsed;
                writeCollapseState(collapsedState);
            });
        });
    }

    function pageKey() {
        return String((document.body && document.body.dataset && document.body.dataset.fwPage) || '').trim().toLowerCase();
    }

    function isLikelyApHost() {
        var host = String((window.location && window.location.hostname) || '').trim().toLowerCase();
        if (!host) {
            return false;
        }
        if (host === 'openhaldex.local' || host === 'openhaldex') {
            return true;
        }
        if (host === '192.168.4.1' || /^192\.168\.4\.\d{1,3}$/.test(host)) {
            return true;
        }
        return false;
    }

    function normalizeApiBase(value) {
        var trimmed = String(value || '').trim();
        if (!trimmed) {
            return '';
        }
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed.replace(/\/+$/, '');
        }
        if (!trimmed.startsWith('/')) {
            trimmed = '/' + trimmed;
        }
        return trimmed.replace(/\/+$/, '');
    }

    function buildApiUrl(path) {
        var p = String(path || '');
        if (/^https?:\/\//i.test(p)) {
            return p;
        }
        var base = state.apiBase;
        if (!base) {
            return p;
        }
        if (p.startsWith('/')) {
            return base + p;
        }
        return base + '/' + p;
    }

    function nowStamp() {
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function toNumber(value, fallback) {
        var n = Number(value);
        if (Number.isFinite(n)) {
            return n;
        }
        return fallback;
    }

    function fmtNumber(value, digits, unit) {
        if (value === null || value === undefined || value === '') {
            return '--';
        }
        var n = Number(value);
        if (!Number.isFinite(n)) {
            return String(value);
        }
        var rendered = (digits === null || digits === undefined) ? String(Math.round(n)) : n.toFixed(digits);
        if (unit) {
            return rendered + ' ' + unit;
        }
        return rendered;
    }

    function fmtUptime(ms) {
        var total = Math.max(0, Math.round(toNumber(ms, 0) / 1000));
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        return h + 'h ' + m + 'm ' + s + 's';
    }

    function fmtBool(value) {
        return value ? 'Yes' : 'No';
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setStatus(node, message, isError) {
        if (!node) {
            return;
        }
        node.textContent = String(message || '');
        node.classList.toggle('error', Boolean(isError));
    }

    function setGlobalStatus(message, isError) {
        setStatus(byId('fwGlobalStatus'), message, isError);
    }

    function updateHeader(runtime) {
        if (!runtime) {
            return;
        }
        var can = runtime.can || {};
        var canGood = Boolean(can.ready && can.chassis && can.haldex && !can.busFailure);
        var mode = runtime.disableController ? 'STOCK' : (runtime.mode || '--');

        var canText = byId('fwHeaderCanText');
        var modeText = byId('fwHeaderModeText');
        if (canText) {
            canText.textContent = canGood ? 'CAN Online' : 'CAN Degraded';
        }
        if (modeText) {
            modeText.textContent = 'Mode ' + mode;
        }
    }

    async function request(path, options) {
        var opts = options || {};
        var timeoutMs = toNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
        var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});

        var fetchOptions = Object.assign({}, opts, {
            headers: headers,
        });
        delete fetchOptions.timeoutMs;
        delete fetchOptions.noFallback;

        async function fetchWithTimeout(url) {
            var controller = new AbortController();
            var timer = setTimeout(function () {
                controller.abort();
            }, timeoutMs);

            try {
                return await fetch(url, Object.assign({}, fetchOptions, { signal: controller.signal }));
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    throw new Error('Request timeout');
                }
                throw new Error(error && error.message ? error.message : 'Network request failed');
            } finally {
                clearTimeout(timer);
            }
        }

        var rawPath = String(path || '');
        var requestedUrl = buildApiUrl(rawPath);
        var response;

        try {
            response = await fetchWithTimeout(requestedUrl);
        } catch (error) {
            var allowFallback = Boolean(state.apiBase) && rawPath.startsWith('/') && !opts.noFallback;
            if (!allowFallback) {
                throw error;
            }

            try {
                response = await fetchWithTimeout(rawPath);
                state.apiBase = '';
                localStorage.removeItem(STORAGE_API_BASE_KEY);
                setGlobalStatus('API fallback active: same origin (' + nowStamp() + ')');
            } catch (_) {
                throw error;
            }
        }

        var text = await response.text();
        var contentType = String(response.headers.get('content-type') || '').toLowerCase();
        var isJson = contentType.indexOf('application/json') >= 0;

        if (!response.ok) {
            if (isJson) {
                try {
                    var payloadError = JSON.parse(text);
                    if (payloadError && payloadError.error) {
                        throw new Error(payloadError.error);
                    }
                } catch (_) {
                    // Ignore parse failure and fall back below.
                }
            }
            throw new Error(text || ('HTTP ' + response.status));
        }

        return {
            response: response,
            text: text,
            json: isJson ? JSON.parse(text || '{}') : null,
        };
    }

    async function fetchJson(path, options) {
        var result = await request(path, options);
        if (result.json !== null) {
            if (result.json && result.json.error) {
                throw new Error(result.json.error);
            }
            return result.json;
        }
        try {
            var parsed = JSON.parse(result.text || '{}');
            if (parsed && parsed.error) {
                throw new Error(parsed.error);
            }
            return parsed;
        } catch (error) {
            throw new Error('Invalid JSON response');
        }
    }

    async function fetchText(path, options) {
        var result = await request(path, options);
        return result.text;
    }

    function exposeFirmwareApiBridge() {
        window.openhaldexFirmwareApi = {
            fetchJson: function (path, options) {
                return fetchJson(path, options || {});
            },
            fetchText: function (path, options) {
                return fetchText(path, options || {});
            },
            buildApiUrl: function (path) {
                return buildApiUrl(path);
            },
        };
    }

    function initApiBase() {
        var bodyBase = normalizeApiBase(document.body && document.body.dataset ? document.body.dataset.fwApiBase : '');
        var storedBase = normalizeApiBase(localStorage.getItem(STORAGE_API_BASE_KEY) || '');
        var params = new URLSearchParams(window.location.search);
        var queryBase = params.has('api') ? normalizeApiBase(params.get('api')) : null;

        if (queryBase !== null) {
            state.apiBase = queryBase;
            if (queryBase) {
                localStorage.setItem(STORAGE_API_BASE_KEY, queryBase);
            } else {
                localStorage.removeItem(STORAGE_API_BASE_KEY);
            }
        } else if (bodyBase) {
            state.apiBase = bodyBase;
            localStorage.setItem(STORAGE_API_BASE_KEY, bodyBase);
        } else if (isLikelyApHost()) {
            state.apiBase = '';
            localStorage.removeItem(STORAGE_API_BASE_KEY);
        } else {
            state.apiBase = storedBase;
        }

        var baseLabel = state.apiBase ? state.apiBase : '(same origin)';
        setGlobalStatus('API base: ' + baseLabel);

        var apiBtn = byId('fwApiBaseBtn');
        if (apiBtn) {
            apiBtn.addEventListener('click', function () {
                var next = window.prompt('OpenHaldex API base URL or path. Leave empty for same origin.', state.apiBase || '');
                if (next === null) {
                    return;
                }
                var normalized = normalizeApiBase(next);
                if (normalized) {
                    localStorage.setItem(STORAGE_API_BASE_KEY, normalized);
                } else {
                    localStorage.removeItem(STORAGE_API_BASE_KEY);
                }
                state.apiBase = normalized;
                window.location.reload();
            });
        }
    }

    function initSidebarToggle() {
        var shell = byId('fwUiShell');
        var toggle = byId('fwUiNavToggle');
        var backdrop = byId('fwUiBackdrop');

        if (!shell || !toggle || !backdrop) {
            return;
        }

        toggle.addEventListener('click', function () {
            shell.classList.toggle('nav-open');
        });

        backdrop.addEventListener('click', function () {
            shell.classList.remove('nav-open');
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                shell.classList.remove('nav-open');
            }
        });

        window.addEventListener('resize', function () {
            if (window.innerWidth > 991) {
                shell.classList.remove('nav-open');
            }
        });
    }

    function appendActionLog(message) {
        var list = byId('fwActionLog');
        if (!list) {
            return;
        }

        var item = document.createElement('li');
        item.innerHTML = '<span>' + escapeHtml(message) + '</span><small>' + nowStamp() + '</small>';
        list.prepend(item);

        var rows = list.querySelectorAll('li');
        if (rows.length > 14) {
            rows[rows.length - 1].remove();
        }
    }

    async function getRuntime(force, requireFull) {
        var now = Date.now();
        if (!force && !requireFull && state.runtimeCache && now - state.runtimeCacheTs < 700) {
            return state.runtimeCache;
        }

        if (!force && state.runtimePromise) {
            return state.runtimePromise;
        }

        state.runtimePromise = (async function () {
            var data;
            if (requireFull) {
                data = await fetchJson('/api/status', { timeoutMs: 1800 });
            } else {
                try {
                    data = await fetchJson('/api/runtime', { timeoutMs: 1300 });
                } catch (_) {
                    data = await fetchJson('/api/status', { timeoutMs: 1900 });
                }
            }

            state.runtimeCache = data;
            state.runtimeCacheTs = Date.now();
            updateHeader(data);
            return data;
        })();

        try {
            return await state.runtimePromise;
        } finally {
            state.runtimePromise = null;
        }
    }

    function enableRangeMirrors() {
        var sliders = document.querySelectorAll('input[type="range"][data-fw-unit]');
        sliders.forEach(function (slider) {
            var unit = slider.getAttribute('data-fw-unit') || '';
            var badge = document.querySelector('[data-fw-value-for="' + slider.id + '"]');
            if (!badge) {
                return;
            }
            var sync = function () {
                badge.textContent = slider.value + (unit ? ' ' + unit : '');
            };
            slider.addEventListener('input', sync);
            sync();
        });
    }

    function initHomePage() {
        if (pageKey() !== 'home') {
            return;
        }

        var rangeGroup = document.querySelector('.fw-range-toggle');
        var rangeButtons = rangeGroup ? rangeGroup.querySelectorAll('button[data-fw-range]') : [];
        var chartCanvas = byId('fwTelemetryChart');
        var homeProfileSelect = byId('fwHomeProfileSelect');
        var homeProfileApply = byId('fwHomeProfileApply');
        var homeProfileRuntime = byId('fwHomeProfileRuntime');
        var homeProfileCard = byId('fwHomeProfileCard');
        var modeControlsCol = byId('fwModeControlsCol');

        function setProfileCardVisible(visible) {
            if (homeProfileCard) {
                homeProfileCard.hidden = !visible;
            }
            if (modeControlsCol) {
                modeControlsCol.classList.toggle('col-xl-12', !visible);
                modeControlsCol.classList.toggle('col-xl-8', visible);
            }
        }

        function setActiveRangeButton(button) {
            rangeButtons.forEach(function (item) {
                item.classList.toggle('active', item === button);
            });
        }

        function initChart() {
            if (!chartCanvas || typeof window.Chart === 'undefined') {
                return;
            }

            state.chart = new window.Chart(chartCanvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Target',
                            data: [],
                            borderColor: '#4489e4',
                            backgroundColor: 'rgba(68, 137, 228, 0.15)',
                            borderWidth: 2,
                            tension: 0.25,
                            fill: true,
                            pointRadius: 0,
                        },
                        {
                            label: 'Actual',
                            data: [],
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.0)',
                            borderWidth: 2,
                            tension: 0.25,
                            fill: false,
                            pointRadius: 0,
                        },
                    ],
                },
                options: {
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: { legend: { display: true } },
                    scales: {
                        x: {
                            grid: { color: 'rgba(145, 158, 171, 0.18)' },
                            ticks: { color: '#98a6ad' },
                        },
                        y: {
                            min: 0,
                            max: 100,
                            grid: { color: 'rgba(145, 158, 171, 0.18)' },
                            ticks: {
                                color: '#98a6ad',
                                callback: function (value) {
                                    return value + '%';
                                },
                            },
                        },
                    },
                },
            });
        }

        function pushChartPoint(runtime) {
            if (!state.chart) {
                return;
            }
            var telemetry = runtime.telemetry || {};
            var target = Math.max(0, Math.min(100, toNumber(telemetry.spec, 0)));
            var actual = Math.max(0, Math.min(100, toNumber(telemetry.act, 0)));

            state.chart.data.labels.push(new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }));
            state.chart.data.datasets[0].data.push(target);
            state.chart.data.datasets[1].data.push(actual);

            while (state.chart.data.labels.length > state.chartMaxPoints) {
                state.chart.data.labels.shift();
                state.chart.data.datasets[0].data.shift();
                state.chart.data.datasets[1].data.shift();
            }

            state.chart.update('none');
        }

        async function loadBehaviorProfiles() {
            if (!homeProfileSelect || !homeProfileApply || !homeProfileRuntime) {
                return;
            }

            try {
                var payload = await fetchJson('/api/behavior', { timeoutMs: 1800 });
                var profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
                var defaultId = Number(payload.defaultProfileId);
                var behaviorMeta = profiles.filter(function (item) {
                    if (!item || item.enabled === false) {
                        return false;
                    }
                    var profileId = Number(item.id);
                    var isDefault = Number.isFinite(defaultId) && Number.isFinite(profileId) && profileId === defaultId;
                    return Boolean(item.exclusive) || isDefault;
                });

                if (!payload.enabled) {
                    setProfileCardVisible(false);
                    homeProfileSelect.innerHTML = '<option value="">Behavior disabled</option>';
                    homeProfileSelect.disabled = true;
                    homeProfileApply.disabled = true;
                    homeProfileRuntime.textContent = 'Behavior engine disabled';
                    return;
                }

                setProfileCardVisible(true);

                if (!behaviorMeta.length) {
                    homeProfileSelect.innerHTML = '<option value="">No exclusive profiles</option>';
                    homeProfileSelect.disabled = true;
                    homeProfileApply.disabled = true;
                    homeProfileRuntime.textContent = 'Behavior engine on | no exclusive profiles available';
                    return;
                }

                homeProfileSelect.innerHTML = behaviorMeta.map(function (item) {
                    var id = Number(item.id);
                    var label = item.name ? item.name : ('Profile ' + id);
                    return '<option value="' + id + '">' + escapeHtml(label) + '</option>';
                }).join('');

                var hasDefaultExclusive = behaviorMeta.some(function (item) {
                    return Number(item.id) === defaultId;
                });
                if (Number.isFinite(defaultId) && hasDefaultExclusive) {
                    homeProfileSelect.value = String(defaultId);
                } else if (behaviorMeta[0] && Number.isFinite(Number(behaviorMeta[0].id))) {
                    homeProfileSelect.value = String(Number(behaviorMeta[0].id));
                }

                homeProfileSelect.disabled = false;
                homeProfileApply.disabled = false;
            } catch (error) {
                homeProfileSelect.innerHTML = '<option value="">Profile load failed</option>';
                homeProfileSelect.disabled = true;
                homeProfileApply.disabled = true;
                homeProfileRuntime.textContent = 'Behavior profile error: ' + error.message;
            }
        }

        async function applyHomeProfile() {
            if (!homeProfileSelect || homeProfileSelect.disabled) {
                return;
            }

            var selectedId = Number(homeProfileSelect.value);
            if (!Number.isFinite(selectedId)) {
                return;
            }

            try {
                homeProfileApply.disabled = true;
                await fetchJson('/api/behavior', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ defaultProfileId: selectedId }),
                    timeoutMs: 2200,
                });
                appendActionLog('Default profile set to #' + selectedId);
                await loadBehaviorProfiles();
            } catch (error) {
                appendActionLog('Profile apply failed: ' + error.message);
            } finally {
                if (homeProfileSelect && !homeProfileSelect.disabled) {
                    homeProfileApply.disabled = false;
                }
            }
        }

        async function applyMode(mode) {
            try {
                await fetchJson('/api/mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: mode }),
                    timeoutMs: 1800,
                });
                appendActionLog('Mode set to ' + mode);
            } catch (error) {
                appendActionLog('Mode set failed (' + mode + '): ' + error.message);
            }
        }

        async function pollHome() {
            try {
                var runtime = await getRuntime(true, false);
                var telemetry = runtime.telemetry || {};
                var can = runtime.can || {};

                var targetNode = document.querySelector('[data-fw-metric="target"]');
                var actualNode = document.querySelector('[data-fw-metric="actual"]');
                var speedNode = document.querySelector('[data-fw-metric="speed"]');
                var canNode = document.querySelector('[data-fw-metric="can"]');

                if (targetNode) {
                    targetNode.textContent = fmtNumber(telemetry.spec, 0, '%');
                }
                if (actualNode) {
                    actualNode.textContent = fmtNumber(telemetry.act, 0, '%');
                }
                if (speedNode) {
                    speedNode.textContent = fmtNumber(telemetry.speed, 1, 'km/h');
                }
                if (canNode) {
                    var online = Boolean(can.ready && can.chassis && can.haldex && !can.busFailure);
                    canNode.textContent = online ? 'Connected' : 'Degraded';
                }

                if (homeProfileRuntime) {
                    var be = runtime.behaviorEngine || {};
                    var activeProfileId = Number(be.activeProfileId);
                    var matchedRuleIndex = Number(be.matchedRuleIndex);
                    var activeLabel = Number.isFinite(activeProfileId) ? ('#' + activeProfileId) : '--';
                    var ruleLabel = Number.isFinite(matchedRuleIndex) && matchedRuleIndex >= 0 ? ('#' + (matchedRuleIndex + 1)) : '--';
                    homeProfileRuntime.textContent = 'Behavior ' + (be.enabled ? 'ON' : 'OFF') + ' | Active ' + activeLabel + ' | Rule ' + ruleLabel;
                }

                pushChartPoint(runtime);
                setGlobalStatus('Last update: ' + nowStamp());
            } catch (error) {
                setGlobalStatus('Runtime poll failed: ' + error.message, true);
            }
        }

        document.querySelectorAll('[data-fw-set-mode]').forEach(function (button) {
            button.addEventListener('click', function () {
                var mode = String(button.getAttribute('data-fw-set-mode') || '').trim();
                if (!mode) {
                    return;
                }
                applyMode(mode);
            });
        });

        if (rangeGroup) {
            rangeGroup.addEventListener('click', function (event) {
                var button = event.target.closest('button[data-fw-range]');
                if (!button) {
                    return;
                }
                var sec = Math.max(10, Math.min(900, toNumber(button.getAttribute('data-fw-range'), 30)));
                state.chartMaxPoints = Math.max(20, Math.min(200, Math.round(sec / 2)));
                setActiveRangeButton(button);
            });
        }

        if (homeProfileApply) {
            homeProfileApply.addEventListener('click', applyHomeProfile);
        }

        initChart();
        loadBehaviorProfiles();
        pollHome();
        setInterval(pollHome, 1500);
    }

    function initMapPage() {
        if (pageKey() !== 'map') {
            return;
        }

        var rowsNode = byId('fwMapRows');
        var statusNode = byId('fwMapStatus');
        var summaryNode = byId('fwMapSummary');
        var refreshBtn = byId('fwMapRefreshBtn');
        var saveNameInput = byId('fwMapSaveName');
        var saveBtn = byId('fwMapSaveBtn');
        var reloadActiveBtn = byId('fwMapReloadActiveBtn');

        var currentPath = '';

        function renderMaps(payload) {
            var maps = Array.isArray(payload.maps) ? payload.maps : [];
            currentPath = String(payload.current || '');

            if (!maps.length) {
                rowsNode.innerHTML = '<tr><td colspan="5" class="text-muted">No maps found.</td></tr>';
                return;
            }

            rowsNode.innerHTML = maps.map(function (item) {
                var path = String(item.path || '');
                var readOnly = Boolean(item.readOnly);
                var isCurrent = path === currentPath;
                var status = isCurrent
                    ? '<span class="badge bg-success-subtle text-success-emphasis">Active</span>'
                    : '<span class="badge bg-secondary-subtle text-secondary-emphasis">Stored</span>';

                return '<tr>' +
                    '<td>' + escapeHtml(item.name || '-') + '</td>' +
                    '<td>' + escapeHtml(item.format || '-') + '</td>' +
                    '<td><code class="fw-map-path" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</code></td>' +
                    '<td>' + status + '</td>' +
                    '<td class="text-end">' +
                        '<button type="button" class="btn btn-sm btn-outline-primary me-1" data-fw-map-action="load" data-fw-path="' + escapeHtml(path) + '">Load</button>' +
                        '<button type="button" class="btn btn-sm btn-outline-danger" data-fw-map-action="delete" data-fw-path="' + escapeHtml(path) + '" ' + (readOnly ? 'disabled' : '') + '>Delete</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
        }

        async function loadMapCatalog() {
            setStatus(statusNode, 'Loading map catalog...');
            try {
                var payload = await fetchJson('/api/maps', { timeoutMs: 2200 });
                renderMaps(payload);
                setStatus(statusNode, 'Loaded ' + ((payload.maps && payload.maps.length) || 0) + ' map(s). Current: ' + (payload.current || '--'));
            } catch (error) {
                rowsNode.innerHTML = '<tr><td colspan="5" class="text-muted">Map load failed.</td></tr>';
                setStatus(statusNode, 'Map load failed: ' + error.message, true);
            }
        }

        async function loadActiveMapSummary() {
            setStatus(statusNode, 'Loading active map payload...');
            try {
                var payload = await fetchJson('/api/map', { timeoutMs: 2500 });
                var speedBins = Array.isArray(payload.speedBins) ? payload.speedBins : [];
                var throttleBins = Array.isArray(payload.throttleBins) ? payload.throttleBins : [];
                var lockTable = Array.isArray(payload.lockTable) ? payload.lockTable : [];

                var summary = {
                    speedBins: speedBins,
                    throttleBins: throttleBins,
                    lockTableRows: lockTable.length,
                    lockTableCols: lockTable.length ? (Array.isArray(lockTable[0]) ? lockTable[0].length : 0) : 0,
                    currentMapPath: currentPath || '--',
                };
                summaryNode.textContent = JSON.stringify(summary, null, 2);
                setStatus(statusNode, 'Active map payload loaded.');
            } catch (error) {
                summaryNode.textContent = 'Map payload read failed: ' + error.message;
                setStatus(statusNode, 'Map payload read failed: ' + error.message, true);
            }
        }

        async function mapActionLoad(path) {
            setStatus(statusNode, 'Loading map ' + path + ' ...');
            try {
                await fetchJson('/api/maps/load', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path }),
                    timeoutMs: 2600,
                });
                appendActionLog('Map loaded: ' + path);
                await loadMapCatalog();
                await loadActiveMapSummary();
            } catch (error) {
                setStatus(statusNode, 'Map load failed: ' + error.message, true);
            }
        }

        async function mapActionDelete(path) {
            if (!window.confirm('Delete map ' + path + '?')) {
                return;
            }
            setStatus(statusNode, 'Deleting map ' + path + ' ...');
            try {
                await fetchJson('/api/maps/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path }),
                    timeoutMs: 2600,
                });
                appendActionLog('Map deleted: ' + path);
                await loadMapCatalog();
                await loadActiveMapSummary();
            } catch (error) {
                setStatus(statusNode, 'Map delete failed: ' + error.message, true);
            }
        }

        async function saveMap() {
            var name = String(saveNameInput.value || '').trim();
            if (!name) {
                setStatus(statusNode, 'Map name is required.', true);
                return;
            }

            setStatus(statusNode, 'Saving map ' + name + ' ...');
            try {
                var payload = await fetchJson('/api/maps/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name }),
                    timeoutMs: 2600,
                });
                appendActionLog('Map saved: ' + (payload.path || name));
                await loadMapCatalog();
                await loadActiveMapSummary();
            } catch (error) {
                setStatus(statusNode, 'Map save failed: ' + error.message, true);
            }
        }

        rowsNode.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-fw-map-action]');
            if (!button) {
                return;
            }
            var action = button.getAttribute('data-fw-map-action');
            var path = button.getAttribute('data-fw-path');
            if (!path) {
                return;
            }
            if (action === 'load') {
                mapActionLoad(path);
            } else if (action === 'delete') {
                mapActionDelete(path);
            }
        });

        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                loadMapCatalog();
                loadActiveMapSummary();
            });
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', saveMap);
        }

        if (reloadActiveBtn) {
            reloadActiveBtn.addEventListener('click', loadActiveMapSummary);
        }

        loadMapCatalog();
        loadActiveMapSummary();
    }

    function initCurvePage() {
        var key = pageKey();
        if (key !== 'speed' && key !== 'throttle' && key !== 'rpm') {
            return;
        }

        var configMap = {
            speed: {
                endpoint: '/api/curve/speed',
                xLabel: 'Speed (km/h)',
                xMin: 0,
                xMax: 300,
                xStep: 1,
                disengageKey: 'speed',
                livePrimary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.speed, 1, 'km/h');
                },
                liveSecondary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.spec, 0, '%');
                },
            },
            throttle: {
                endpoint: '/api/curve/throttle',
                xLabel: 'Throttle (%)',
                xMin: 0,
                xMax: 100,
                xStep: 1,
                disengageKey: 'throttle',
                livePrimary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.throttle, 1, '%');
                },
                liveSecondary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.boost, 1, 'kPa');
                },
            },
            rpm: {
                endpoint: '/api/curve/rpm',
                xLabel: 'RPM',
                xMin: 0,
                xMax: 10000,
                xStep: 50,
                disengageKey: 'rpm',
                livePrimary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.rpm, 0, 'rpm');
                },
                liveSecondary: function (runtime) {
                    return fmtNumber(runtime.telemetry && runtime.telemetry.act, 0, '%');
                },
            },
        };

        var cfg = configMap[key];

        var rowsNode = byId('fwCurveRows');
        var statusNode = byId('fwCurveStatus');
        var xLabelNode = byId('fwCurveXLabel');
        var loadBtn = byId('fwCurveLoadBtn');
        var addBtn = byId('fwCurveAddBtn');
        var resetBtn = byId('fwCurveResetBtn');
        var saveBtn = byId('fwCurveSaveBtn');
        var livePrimaryNode = byId('fwCurveLivePrimary');
        var liveSecondaryNode = byId('fwCurveLiveSecondary');
        var liveModeNode = byId('fwCurveLiveMode');

        var disengageInput = byId('fwCurveDisengage');
        var disableThrottleInput = byId('fwCurveDisableThrottle');
        var disableSpeedInput = byId('fwCurveDisableSpeed');
        var releaseRateInput = byId('fwCurveReleaseRate');
        var broadcastInput = byId('fwCurveBroadcast');
        var controllerDisabledInput = byId('fwCurveControllerDisabled');
        var saveSettingsBtn = byId('fwCurveSettingsSaveBtn');

        var points = [];

        if (xLabelNode) {
            xLabelNode.textContent = cfg.xLabel;
        }

        function renderRows() {
            if (!points.length) {
                rowsNode.innerHTML = '<tr><td colspan="3" class="text-muted">No points loaded.</td></tr>';
                return;
            }

            rowsNode.innerHTML = points.map(function (point, index) {
                return '<tr data-fw-curve-index="' + index + '">' +
                    '<td><input class="form-control form-control-sm" data-fw-field="x" type="number" min="' + cfg.xMin + '" max="' + cfg.xMax + '" step="' + cfg.xStep + '" value="' + Number(point.x) + '" /></td>' +
                    '<td>' +
                        '<div class="fw-curve-lock-row">' +
                            '<input class="form-range" data-fw-field="lock-range" type="range" min="0" max="100" step="1" value="' + Number(point.lock) + '" />' +
                            '<input class="form-control form-control-sm" data-fw-field="lock-number" type="number" min="0" max="100" step="1" value="' + Number(point.lock) + '" />' +
                        '</div>' +
                    '</td>' +
                    '<td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger" data-fw-field="remove" ' + (points.length <= 2 ? 'disabled' : '') + '>Remove</button></td>' +
                '</tr>';
            }).join('');
        }

        function sortPoints() {
            points.sort(function (a, b) {
                return a.x - b.x;
            });
        }

        function ensureValidPoints() {
            if (!points.length) {
                throw new Error('No points provided');
            }
            if (points.length > 32) {
                throw new Error('Too many points');
            }

            var previousX = null;
            points.forEach(function (point, idx) {
                var x = toNumber(point.x, NaN);
                var lock = toNumber(point.lock, NaN);

                if (!Number.isFinite(x) || x < cfg.xMin || x > cfg.xMax) {
                    throw new Error('Point #' + (idx + 1) + ' x out of range');
                }
                if (!Number.isFinite(lock) || lock < 0 || lock > 100) {
                    throw new Error('Point #' + (idx + 1) + ' lock out of range');
                }
                if (previousX !== null && x <= previousX) {
                    throw new Error('Points must be strictly ascending by x');
                }
                previousX = x;
            });
        }

        function readRows() {
            var next = [];
            rowsNode.querySelectorAll('tr[data-fw-curve-index]').forEach(function (row) {
                var xInput = row.querySelector('input[data-fw-field="x"]');
                var lockInput = row.querySelector('input[data-fw-field="lock-number"]');
                next.push({
                    x: toNumber(xInput && xInput.value, 0),
                    lock: toNumber(lockInput && lockInput.value, 0),
                });
            });
            points = next;
            sortPoints();
        }

        async function loadCurve() {
            setStatus(statusNode, 'Loading curve...');
            try {
                var payload = await fetchJson(cfg.endpoint, { timeoutMs: 2200 });
                points = Array.isArray(payload.points) ? payload.points.map(function (point) {
                    return {
                        x: toNumber(point.x, 0),
                        lock: toNumber(point.lock, 0),
                    };
                }) : [];

                if (!points.length) {
                    points = [
                        { x: cfg.xMin, lock: 0 },
                        { x: cfg.xMin + cfg.xStep, lock: 10 },
                    ];
                }

                sortPoints();
                renderRows();
                setStatus(statusNode, 'Loaded ' + points.length + ' point(s).');
            } catch (error) {
                setStatus(statusNode, 'Curve load failed: ' + error.message, true);
            }
        }

        async function saveCurve() {
            try {
                readRows();
                ensureValidPoints();
            } catch (error) {
                setStatus(statusNode, error.message, true);
                return;
            }

            setStatus(statusNode, 'Saving curve...');
            try {
                await fetchJson(cfg.endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ points: points }),
                    timeoutMs: 2800,
                });
                setStatus(statusNode, 'Curve saved.');
                appendActionLog(key + ' curve saved (' + points.length + ' points)');
                await loadCurve();
            } catch (error) {
                setStatus(statusNode, 'Curve save failed: ' + error.message, true);
            }
        }

        async function saveModeSettings() {
            var runtime;
            try {
                runtime = await getRuntime(true, false);
            } catch (error) {
                setStatus(statusNode, 'Unable to load runtime before save: ' + error.message, true);
                return;
            }

            var disengage = Object.assign({ map: 0, speed: 0, throttle: 0, rpm: 0 }, runtime.disengageUnderSpeed || {});
            disengage[cfg.disengageKey] = Math.max(0, Math.min(300, toNumber(disengageInput.value, 0)));

            var payload = {
                disableThrottle: Math.max(0, Math.min(100, toNumber(disableThrottleInput.value, 0))),
                disableSpeed: Math.max(0, Math.min(300, toNumber(disableSpeedInput.value, 0))),
                disengageUnderSpeed: disengage,
            };

            setStatus(statusNode, 'Saving mode settings...');
            try {
                await fetchJson('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    timeoutMs: 2400,
                });
                setStatus(statusNode, 'Mode settings saved.');
                appendActionLog(key + ' mode settings saved');
            } catch (error) {
                setStatus(statusNode, 'Mode settings save failed: ' + error.message, true);
            }
        }

        async function refreshRuntimeBindings() {
            try {
                var runtime = await getRuntime(true, false);
                if (livePrimaryNode) {
                    livePrimaryNode.textContent = cfg.livePrimary(runtime);
                }
                if (liveSecondaryNode) {
                    liveSecondaryNode.textContent = cfg.liveSecondary(runtime);
                }
                if (liveModeNode) {
                    liveModeNode.textContent = runtime.disableController ? 'STOCK' : (runtime.mode || '--');
                }

                var disengage = runtime.disengageUnderSpeed || {};
                if (disengageInput && !disengageInput.matches(':focus')) {
                    disengageInput.value = toNumber(disengage[cfg.disengageKey], 0);
                }
                if (disableThrottleInput && !disableThrottleInput.matches(':focus')) {
                    disableThrottleInput.value = toNumber(runtime.disableThrottle, 0);
                }
                if (disableSpeedInput && !disableSpeedInput.matches(':focus')) {
                    disableSpeedInput.value = toNumber(runtime.disableSpeed, 0);
                }
                if (releaseRateInput && !releaseRateInput.matches(':focus')) {
                    releaseRateInput.value = toNumber(runtime.lockReleaseRatePctPerSec, 0);
                }
                if (broadcastInput) {
                }
                if (controllerDisabledInput) {
                }
            } catch (error) {
                setStatus(statusNode, 'Runtime poll failed: ' + error.message, true);
            }
        }

        rowsNode.addEventListener('input', function (event) {
            var row = event.target.closest('tr[data-fw-curve-index]');
            if (!row) {
                return;
            }
            var rangeInput = row.querySelector('input[data-fw-field="lock-range"]');
            var numberInput = row.querySelector('input[data-fw-field="lock-number"]');
            if (event.target.getAttribute('data-fw-field') === 'lock-range' && numberInput) {
                numberInput.value = rangeInput.value;
            }
            if (event.target.getAttribute('data-fw-field') === 'lock-number' && rangeInput) {
                rangeInput.value = numberInput.value;
            }
        });

        rowsNode.addEventListener('click', function (event) {
            var removeBtn = event.target.closest('button[data-fw-field="remove"]');
            if (!removeBtn) {
                return;
            }
            if (points.length <= 2) {
                return;
            }
            var row = removeBtn.closest('tr[data-fw-curve-index]');
            var index = Number(row.getAttribute('data-fw-curve-index'));
            if (!Number.isFinite(index)) {
                return;
            }
            points.splice(index, 1);
            renderRows();
        });

        if (loadBtn) {
            loadBtn.addEventListener('click', loadCurve);
        }
        if (addBtn) {
            addBtn.addEventListener('click', function () {
                readRows();
                var last = points.length ? points[points.length - 1] : { x: cfg.xMin, lock: 0 };
                var nextX = Math.min(cfg.xMax, toNumber(last.x, cfg.xMin) + cfg.xStep);
                points.push({ x: nextX, lock: toNumber(last.lock, 0) });
                sortPoints();
                renderRows();
            });
        }
        if (resetBtn) {
            resetBtn.addEventListener('click', function () {
                points = [
                    { x: cfg.xMin, lock: 0 },
                    { x: Math.min(cfg.xMax, cfg.xMin + (cfg.xStep * 5)), lock: 25 },
                    { x: Math.min(cfg.xMax, cfg.xMin + (cfg.xStep * 10)), lock: 50 },
                ];
                sortPoints();
                renderRows();
                setStatus(statusNode, 'Curve reset locally. Save to apply.');
            });
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', saveCurve);
        }
        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', saveModeSettings);
        }

        loadCurve();
        refreshRuntimeBindings();
        setInterval(refreshRuntimeBindings, 1500);
    }

    function initCanviewPage() {
        if (pageKey() !== 'canview') {
            return;
        }

        var busSelect = byId('fwCanBusSelect');
        var filterInput = byId('fwCanFilterInput');
        var pauseBtn = byId('fwCanPauseBtn');
        var dumpBtn = byId('fwCanDumpBtn');
        var statusNode = byId('fwCanStatus');
        var rowsNode = byId('fwCanRows');

        var paused = false;

        function toHex(id) {
            var n = Number(id);
            if (!Number.isFinite(n)) {
                return '--';
            }
            return '0x' + n.toString(16).toUpperCase();
        }

        function renderRows(decoded, raw) {
            var filter = String(filterInput && filterInput.value || '').trim().toLowerCase();
            var items = [];

            (Array.isArray(decoded) ? decoded : []).forEach(function (item) {
                items.push({
                    type: 'decoded',
                    bus: item.bus || '-',
                    dir: item.dir || '-',
                    id: toHex(item.id),
                    left: item.name || '-',
                    right: String(item.value || '-') + (item.unit ? ' ' + item.unit : ''),
                    ts: toNumber(item.ts, 0),
                });
            });

            (Array.isArray(raw) ? raw : []).forEach(function (item) {
                items.push({
                    type: 'raw',
                    bus: item.bus || '-',
                    dir: item.dir || '-',
                    id: toHex(item.id),
                    left: item.data || '-',
                    right: 'dlc ' + (item.dlc || '-'),
                    ts: toNumber(item.ts, 0),
                });
            });

            items.sort(function (a, b) {
                return b.ts - a.ts;
            });

            if (filter) {
                items = items.filter(function (item) {
                    return (
                        String(item.id).toLowerCase().includes(filter) ||
                        String(item.left).toLowerCase().includes(filter) ||
                        String(item.right).toLowerCase().includes(filter) ||
                        String(item.bus).toLowerCase().includes(filter)
                    );
                });
            }

            if (!items.length) {
                rowsNode.innerHTML = '<tr><td colspan="7" class="text-muted">No frames match current filter.</td></tr>';
                return;
            }

            rowsNode.innerHTML = items.slice(0, 220).map(function (item) {
                return '<tr>' +
                    '<td>' + escapeHtml(item.type) + '</td>' +
                    '<td>' + escapeHtml(item.bus) + '</td>' +
                    '<td>' + escapeHtml(item.dir) + '</td>' +
                    '<td><code>' + escapeHtml(item.id) + '</code></td>' +
                    '<td>' + escapeHtml(item.left) + '</td>' +
                    '<td>' + escapeHtml(item.right) + '</td>' +
                    '<td>' + escapeHtml(String(item.ts)) + ' ms</td>' +
                '</tr>';
            }).join('');
        }

        async function pollCanview() {
            if (paused) {
                return;
            }

            var bus = String(busSelect && busSelect.value || 'all');
            try {
                var payload = await fetchJson('/api/canview?decoded=160&raw=60&bus=' + encodeURIComponent(bus), { timeoutMs: 2200 });
                renderRows(payload.decoded, payload.raw);
                var decodedCount = Array.isArray(payload.decoded) ? payload.decoded.length : 0;
                var rawCount = Array.isArray(payload.raw) ? payload.raw.length : 0;
                setStatus(statusNode, 'Decoded: ' + decodedCount + ' | Raw: ' + rawCount + ' | ' + nowStamp());
            } catch (error) {
                setStatus(statusNode, 'CAN poll failed: ' + error.message, true);
            }
        }

        if (pauseBtn) {
            pauseBtn.addEventListener('click', function () {
                paused = !paused;
                pauseBtn.textContent = paused ? 'Resume' : 'Pause';
                setStatus(statusNode, paused ? 'Paused' : 'Resumed');
                if (!paused) {
                    pollCanview();
                }
            });
        }

        if (busSelect) {
            busSelect.addEventListener('change', pollCanview);
        }

        if (filterInput) {
            filterInput.addEventListener('input', pollCanview);
        }

        if (dumpBtn) {
            dumpBtn.addEventListener('click', function () {
                var bus = String(busSelect && busSelect.value || 'all');
                var url = buildApiUrl('/api/canview/dump?seconds=30&bus=' + encodeURIComponent(bus));
                window.open(url, '_blank');
            });
        }

        pollCanview();
        setInterval(pollCanview, 1300);
    }

    function initDiagnosticsPage() {
        if (pageKey() !== 'diagnostics') {
            return;
        }

        var statusNode = byId('fwDiagStatus');
        var rowsNode = byId('fwDiagRows');
        var frameRowsNode = byId('fwDiagFrameRows');
        var refreshBtn = byId('fwDiagRefreshBtn');
        var captureStatusNode = byId('fwCaptureStatus');
        var captureToggleBtn = byId('fwCaptureToggleBtn');
        var captureDumpBtn = byId('fwCaptureDumpBtn');
        var captureActive = false;

        function renderKeyValues(runtime, network) {
            var telemetry = runtime.telemetry || {};
            var can = runtime.can || {};
            var behavior = runtime.behaviorEngine || {};
            var inputMappings = runtime.inputMappings || {};
            var net = network || {};
            var alerts = Array.isArray(behavior.alertsActive) ? behavior.alertsActive : [];
            var netAp = Boolean(net.ap);
            var netSta = Boolean(net.staConnected);
            var netMode = String(net.mode || (netAp && netSta ? 'AP+STA' : (netAp ? 'AP' : (netSta ? 'STA' : 'OFF'))));
            var values = [
                ['Control: Mode', runtime.disableController ? 'STOCK' : (runtime.mode || '--')],
                ['Control: Haldex generation', runtime.haldexGeneration],
                ['Control: Controller enabled', fmtBool(!runtime.disableController)],
                ['Control: Broadcast enabled', fmtBool(Boolean(runtime.broadcastOpenHaldexOverCAN))],
                ['Control: Interpolation enabled', fmtBool(Boolean(runtime.lockInterpolationEnabled))],
                ['Control: Disable below throttle', fmtNumber(runtime.disableThrottle, 0, '%')],
                ['Control: Disable above speed', fmtNumber(runtime.disableSpeed, 0, 'km/h')],
                ['Control: Release rate', fmtNumber(runtime.lockReleaseRatePctPerSec, 0, '%/s')],

                ['Mapping: Inputs mapped', fmtBool(Boolean(telemetry.inputsMapped))],
                ['Mapping: Speed signal', inputMappings.speed || '--'],
                ['Mapping: Throttle signal', inputMappings.throttle || '--'],
                ['Mapping: RPM signal', inputMappings.rpm || '--'],

                ['Network: Mode', netMode],
                ['Network: STA connected', fmtBool(netSta)],
                ['Network: STA status', (net.staStatusText || '--') + ' (' + fmtNumber(net.staStatus, 0, '') + ')'],
                ['Network: STA SSID', net.staSsid || '--'],
                ['Network: STA IP', net.staIp || '--'],
                ['Network: STA RSSI', netSta ? fmtNumber(net.staRssi, 0, 'dBm') : '--'],
                ['Network: AP enabled', fmtBool(netAp)],
                ['Network: AP IP', net.apIp || '--'],
                ['Network: AP clients', fmtNumber(net.apClients, 0, '')],
                ['Network: Channel', fmtNumber(net.channel, 0, '')],
                ['Network: Hostname', net.hostname || '--'],
                ['Network: Internet', fmtBool(Boolean(net.internet))],

                ['CAN: Ready', fmtBool(Boolean(can.ready))],
                ['CAN: Chassis active', fmtBool(Boolean(can.chassis))],
                ['CAN: Haldex active', fmtBool(Boolean(can.haldex))],
                ['CAN: Bus failure', fmtBool(Boolean(can.busFailure))],
                ['CAN: Last chassis frame age', fmtNumber(can.lastChassisMs, 0, 'ms')],
                ['CAN: Last haldex frame age', fmtNumber(can.lastHaldexMs, 0, 'ms')],

                ['Telemetry: Target lock', fmtNumber(telemetry.spec, 0, '%')],
                ['Telemetry: Actual lock', fmtNumber(telemetry.act, 0, '%')],
                ['Telemetry: Vehicle speed', fmtNumber(telemetry.speed, 1, 'km/h')],
                ['Telemetry: Engine RPM', fmtNumber(telemetry.rpm, 0, 'rpm')],
                ['Telemetry: Throttle', fmtNumber(telemetry.throttle, 1, '%')],
                ['Telemetry: Haldex engagement', fmtNumber(telemetry.haldexEngagement, 0, '%')],

                ['Behavior: Enabled', fmtBool(Boolean(behavior.enabled))],
                ['Behavior: Ready', fmtBool(Boolean(behavior.ready))],
                ['Behavior: Active profile', behavior.activeProfileName || '--'],
                ['Behavior: Matched rule index', behavior.matchedRuleIndex],
                ['Behavior: Exclusive lock', fmtBool(Boolean(behavior.exclusiveLock))],
                ['Behavior: Revision', behavior.revision],
                ['Behavior: Profile count', behavior.profileCount],
                ['Behavior: Rule count', behavior.ruleCount],
                ['Behavior: Alert 1 active', fmtBool(Boolean(alerts[0]))],
                ['Behavior: Alert 2 active', fmtBool(Boolean(alerts[1]))],
                ['Behavior: Alert 3 active', fmtBool(Boolean(alerts[2]))],

                ['System: Firmware', runtime.version || '--'],
                ['System: Uptime', fmtUptime(runtime.uptimeMs)],
            ];

            rowsNode.innerHTML = values.map(function (row) {
                return '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(String(row[1])) + '</td></tr>';
            }).join('');
        }

        function renderFrameDiag(runtime) {
            var frameDiag = runtime.frameDiag || {};
            var entries = [
                ['motor1', frameDiag.motor1],
                ['motor3', frameDiag.motor3],
                ['brakes1', frameDiag.brakes1],
                ['brakes2', frameDiag.brakes2],
                ['brakes3', frameDiag.brakes3],
            ];

            frameRowsNode.innerHTML = entries.map(function (entry) {
                var name = entry[0];
                var frame = entry[1] || {};
                var ok = Boolean(frame.ok);
                var stateText = ok ? (frame.generated ? 'Generated' : 'Bridged') : 'Missing';
                var dataText = ok ? String(frame.data || '-') + ' | age ' + String(frame.ageMs || 0) + ' ms' : '-';
                return '<tr>' +
                    '<td>' + escapeHtml(name) + '</td>' +
                    '<td>' + escapeHtml(stateText) + '</td>' +
                    '<td><code>' + escapeHtml(dataText) + '</code></td>' +
                '</tr>';
            }).join('');
        }

        async function loadCaptureState() {
            try {
                var payload = await fetchJson('/api/canview/capture', { timeoutMs: 1800 });
                captureActive = Boolean(payload.active);
                if (captureToggleBtn) {
                    captureToggleBtn.textContent = captureActive ? 'Disable Capture' : 'Enable Capture';
                }
                setStatus(captureStatusNode, captureActive ? 'Capture mode active' : 'Capture mode inactive');
            } catch (error) {
                setStatus(captureStatusNode, 'Capture state failed: ' + error.message, true);
            }
        }

        async function toggleCaptureState() {
            try {
                var payload = await fetchJson('/api/canview/capture', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active: !captureActive }),
                    timeoutMs: 2200,
                });
                captureActive = Boolean(payload.active);
                setStatus(captureStatusNode, captureActive ? 'Capture mode active' : 'Capture mode inactive');
                if (captureToggleBtn) {
                    captureToggleBtn.textContent = captureActive ? 'Disable Capture' : 'Enable Capture';
                }
                appendActionLog('Capture mode ' + (captureActive ? 'enabled' : 'disabled'));
            } catch (error) {
                setStatus(captureStatusNode, 'Capture toggle failed: ' + error.message, true);
            }
        }

        async function refreshDiagnostics() {
            setStatus(statusNode, 'Loading diagnostics...');
            try {
                var payload = await getRuntime(true, true);
                var network = null;
                try {
                    network = await fetchJson('/api/network', { timeoutMs: 1800, noFallback: true });
                } catch (_) {
                    network = null;
                }
                renderKeyValues(payload, network);
                renderFrameDiag(payload);
                setStatus(statusNode, 'Diagnostics updated: ' + nowStamp());
            } catch (error) {
                setStatus(statusNode, 'Diagnostics load failed: ' + error.message, true);
            }
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', refreshDiagnostics);
        }
        if (captureToggleBtn) {
            captureToggleBtn.addEventListener('click', toggleCaptureState);
        }
        if (captureDumpBtn) {
            captureDumpBtn.addEventListener('click', function () {
                window.open(buildApiUrl('/api/canview/dump?seconds=30&bus=all'), '_blank');
            });
        }

        refreshDiagnostics();
        loadCaptureState();
        setInterval(refreshDiagnostics, 2000);
        setInterval(loadCaptureState, 3500);
    }

    function initLogsPage() {
        if (pageKey() !== 'logs') {
            return;
        }

        var statusNode = byId('fwLogsStatus');
        var filesNode = byId('fwLogsFiles');
        var contentNode = byId('fwLogsContent');
        var refreshBtn = byId('fwLogsRefreshBtn');
        var readBtn = byId('fwLogsReadBtn');
        var downloadBtn = byId('fwLogsDownloadBtn');
        var deleteBtn = byId('fwLogsDeleteBtn');
        var clearBtn = byId('fwLogsClearBtn');
        var scopeSelect = byId('fwLogsScope');

        var selectedPath = '';
        var selectedContent = '';
        var fileCache = [];

        function humanSize(bytes) {
            var b = toNumber(bytes, 0);
            if (b > 1024 * 1024) {
                return (b / (1024 * 1024)).toFixed(2) + ' MB';
            }
            if (b > 1024) {
                return (b / 1024).toFixed(1) + ' KB';
            }
            return Math.round(b) + ' B';
        }

        function renderFileList() {
            if (!fileCache.length) {
                filesNode.innerHTML = '<span class="list-group-item text-muted">No log files found.</span>';
                selectedPath = '';
                return;
            }

            filesNode.innerHTML = fileCache.map(function (item) {
                var path = String(item.path || '');
                var active = path === selectedPath ? ' active fw-log-file-item' : ' fw-log-file-item';
                return '<button type="button" class="list-group-item list-group-item-action' + active + '" data-fw-log-path="' + escapeHtml(path) + '">' +
                    '<div class="d-flex justify-content-between"><span>' + escapeHtml(path) + '</span><small>' + escapeHtml(item.scope || '-') + '</small></div>' +
                    '<small class="text-muted">' + humanSize(item.size) + '</small>' +
                '</button>';
            }).join('');
        }

        async function loadFiles() {
            setStatus(statusNode, 'Loading log files...');
            try {
                var payload = await fetchJson('/api/logs', { timeoutMs: 2000 });
                fileCache = Array.isArray(payload.files) ? payload.files.slice() : [];
                fileCache.sort(function (a, b) {
                    return String(a.path || '').localeCompare(String(b.path || ''));
                });

                if (!selectedPath && fileCache.length) {
                    selectedPath = String(fileCache[0].path || '');
                }

                renderFileList();
                setStatus(statusNode, 'Loaded ' + fileCache.length + ' log file(s).');
            } catch (error) {
                filesNode.innerHTML = '<span class="list-group-item text-muted">Log list failed.</span>';
                setStatus(statusNode, 'Log list failed: ' + error.message, true);
            }
        }

        async function readSelected() {
            if (!selectedPath) {
                setStatus(statusNode, 'Select a log file first.', true);
                return;
            }
            setStatus(statusNode, 'Reading ' + selectedPath + ' ...');
            try {
                selectedContent = await fetchText('/api/logs/read?path=' + encodeURIComponent(selectedPath) + '&max=131072', { timeoutMs: 2800 });
                contentNode.textContent = selectedContent || '(empty)';
                setStatus(statusNode, 'Read complete: ' + selectedPath);
            } catch (error) {
                contentNode.textContent = 'Read failed: ' + error.message;
                setStatus(statusNode, 'Read failed: ' + error.message, true);
            }
        }

        function downloadSelected() {
            if (!selectedPath || !selectedContent) {
                setStatus(statusNode, 'No loaded log content to download.', true);
                return;
            }

            var blob = new Blob([selectedContent], { type: 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = selectedPath.replace(/\//g, '_').replace(/^_+/, '');
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }

        async function deleteSelected() {
            if (!selectedPath) {
                setStatus(statusNode, 'Select a log file first.', true);
                return;
            }
            if (!window.confirm('Delete log file ' + selectedPath + '?')) {
                return;
            }

            setStatus(statusNode, 'Deleting ' + selectedPath + ' ...');
            try {
                await fetchJson('/api/logs/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: selectedPath }),
                    timeoutMs: 2400,
                });
                appendActionLog('Deleted log ' + selectedPath);
                selectedPath = '';
                selectedContent = '';
                contentNode.textContent = 'Select a log file to view content.';
                await loadFiles();
            } catch (error) {
                setStatus(statusNode, 'Delete failed: ' + error.message, true);
            }
        }

        async function clearScope() {
            var scope = String(scopeSelect && scopeSelect.value || 'all');
            if (!window.confirm('Clear log scope "' + scope + '"?')) {
                return;
            }

            setStatus(statusNode, 'Clearing ' + scope + ' logs...');
            try {
                await fetchJson('/api/logs/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: scope }),
                    timeoutMs: 2800,
                });
                appendActionLog('Cleared log scope ' + scope);
                selectedPath = '';
                selectedContent = '';
                contentNode.textContent = 'Select a log file to view content.';
                await loadFiles();
            } catch (error) {
                setStatus(statusNode, 'Clear failed: ' + error.message, true);
            }
        }

        filesNode.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-fw-log-path]');
            if (!button) {
                return;
            }
            selectedPath = String(button.getAttribute('data-fw-log-path') || '');
            renderFileList();
            readSelected();
        });

        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadFiles);
        }
        if (readBtn) {
            readBtn.addEventListener('click', readSelected);
        }
        if (downloadBtn) {
            downloadBtn.addEventListener('click', downloadSelected);
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', deleteSelected);
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', clearScope);
        }

        loadFiles().then(readSelected);
    }

    function initSetupPage() {
        if (pageKey() !== 'setup') {
            return;
        }

        var setupStatusNode = byId('fwSetupStatus');
        var setupSaveBtn = byId('fwSetupSaveBtn');

        var speedInput = byId('fwSetupMapSignalSpeed');
        var throttleInput = byId('fwSetupMapSignalThrottle');
        var rpmInput = byId('fwSetupMapSignalRpm');
        var generationSelect = byId('fwSetupHaldexGeneration');
        var logToFileInput = byId('fwSetupLogToFile');
        var logCanInput = byId('fwSetupLogCan');
        var logErrorInput = byId('fwSetupLogError');
        var logSerialInput = byId('fwSetupLogSerial');
        var behaviorSelectedSignalInput = byId('behavior-selected-signal');

        var signalSearchInput = byId('fwSetupSignalSearch');
        var signalSelect = byId('fwSetupSignalSelect');
        var signalRefreshBtn = byId('fwSetupSignalRefreshBtn');
        var signalSummaryNode = byId('fwSetupSignalSummary');
        var assignSpeedBtn = byId('fwSetupAssignSpeedBtn');
        var assignThrottleBtn = byId('fwSetupAssignThrottleBtn');
        var assignRpmBtn = byId('fwSetupAssignRpmBtn');
        var assignBehaviorBtn = byId('fwSetupAssignBehaviorBtn');
        var signalDatalist = byId('fwSetupSignalDatalist');

        var signalSnapshot = [];
        var signalSnapshotMap = new Map();
        var selectedSignalKey = '';

        function normalizeSignalKey(value) {
            return String(value || '').trim().toLowerCase();
        }

        function normalizeSignalDisplayValue(value, unit, signalName) {
            var n = Number(value);
            if (!Number.isFinite(n)) {
                return value;
            }

            var normalizedUnit = String(unit || '').trim().toLowerCase();
            var normalizedName = String(signalName || '').trim().toLowerCase();

            if (normalizedUnit === 'rpm' || normalizedName.indexOf('rpm') >= 0) {
                var abs = Math.abs(n);
                if (abs > 0 && abs < 20) {
                    var scaled = n * 100;
                    if (Math.abs(scaled) >= 100 && Math.abs(scaled) <= 12000) {
                        return scaled;
                    }
                }
            }
            return n;
        }

        function formatDecodedValue(value, unit, signalName) {
            if (value === null || value === undefined || value === '') {
                return '--';
            }

            var n = Number(normalizeSignalDisplayValue(value, unit, signalName));
            if (!Number.isFinite(n)) {
                return String(value);
            }

            var normalizedUnit = String(unit || '').trim().toLowerCase();
            if (normalizedUnit === 'rpm') {
                return Math.abs(n) >= 20 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, '');
            }
            if (Math.abs(n) >= 1000) {
                return String(Math.round(n));
            }
            if (Math.abs(n) >= 100) {
                return n.toFixed(1).replace(/\.?0+$/, '');
            }
            return n.toFixed(2).replace(/\.?0+$/, '');
        }

        function formatDecodedSignalRecord(item) {
            var bus = String(item && item.bus || 'all').toLowerCase();
            var id = Number(item && item.id);
            var frame = Number.isFinite(id)
                ? ('0x' + id.toString(16).toUpperCase())
                : String(item && item.id || '');
            var signal = String(item && item.name || 'Signal').replace(/\s+/g, ' ').trim();
            var unit = String(item && item.unit || '').trim();
            var key = normalizeSignalKey(bus + '|' + frame + '|' + signal + '|' + unit);
            return {
                key: key,
                bus: bus,
                frame: frame,
                signal: signal,
                unit: unit,
                value: item && item.value,
            };
        }

        function readSignalSummary(signalKey) {
            var key = normalizeSignalKey(signalKey);
            if (!key) {
                return { name: 'Not Assigned', value: '--' };
            }

            var signal = signalSnapshotMap.get(key);
            if (!signal) {
                return { name: key, value: '--' };
            }

            var valueText = formatDecodedValue(signal.value, signal.unit, signal.signal);
            return {
                name: signal.frame + ' ' + signal.signal,
                value: valueText + (signal.unit ? (' ' + signal.unit) : ''),
            };
        }

        function refreshSetupSignalBridge() {
            window.openhaldexSetupSignals = {
                getSelectedSignalId: function () {
                    if (selectedSignalKey) {
                        return selectedSignalKey;
                    }
                    return normalizeSignalKey(behaviorSelectedSignalInput && behaviorSelectedSignalInput.value);
                },
                getSignalSummary: function (signalId) {
                    return readSignalSummary(signalId);
                },
            };
        }

        function renderSignalSummary() {
            if (!signalSummaryNode) {
                return;
            }
            if (!selectedSignalKey) {
                signalSummaryNode.textContent = 'No signal selected.';
                return;
            }
            var summary = readSignalSummary(selectedSignalKey);
            signalSummaryNode.textContent = summary.name + ' | ' + summary.value;
        }

        function setSelectedSignalKey(signalKey) {
            selectedSignalKey = normalizeSignalKey(signalKey);
            if (behaviorSelectedSignalInput) {
                behaviorSelectedSignalInput.value = selectedSignalKey;
            }
            renderSignalSummary();
            refreshSetupSignalBridge();
        }

        function renderSignalSelect() {
            if (!signalSelect) {
                return;
            }

            var search = String(signalSearchInput && signalSearchInput.value || '').trim().toLowerCase();
            var filtered = signalSnapshot.filter(function (item) {
                if (!search) {
                    return true;
                }
                return (
                    item.signal.toLowerCase().indexOf(search) >= 0 ||
                    item.frame.toLowerCase().indexOf(search) >= 0 ||
                    item.bus.toLowerCase().indexOf(search) >= 0 ||
                    item.unit.toLowerCase().indexOf(search) >= 0
                );
            });

            if (!filtered.length) {
                signalSelect.innerHTML = '<option value="">No decoded signals in snapshot</option>';
                signalSelect.value = '';
                return;
            }

            signalSelect.innerHTML = filtered.map(function (item) {
                var valueText = formatDecodedValue(item.value, item.unit, item.signal);
                var label = item.signal + ' | ' + item.frame + ' | ' + valueText + (item.unit ? (' ' + item.unit) : '');
                var selected = item.key === selectedSignalKey ? ' selected' : '';
                return '<option value="' + escapeHtml(item.key) + '"' + selected + '>' + escapeHtml(label) + '</option>';
            }).join('');

            if (selectedSignalKey) {
                signalSelect.value = selectedSignalKey;
            }
        }

        function renderSignalDatalist() {
            if (!signalDatalist) {
                return;
            }
            signalDatalist.innerHTML = signalSnapshot.slice(0, 1000).map(function (item) {
                var valueText = formatDecodedValue(item.value, item.unit, item.signal);
                var label = item.signal + ' | ' + item.frame + ' | ' + valueText + (item.unit ? (' ' + item.unit) : '');
                return '<option value="' + escapeHtml(item.key) + '" label="' + escapeHtml(label) + '"></option>';
            }).join('');
        }

        async function refreshSignalSnapshot() {
            if (!signalSelect) {
                refreshSetupSignalBridge();
                return;
            }

            setStatus(setupStatusNode, 'Refreshing signal snapshot...');
            try {
                var payload = await fetchJson('/api/canview?decoded=500&raw=0&bus=all', { timeoutMs: 3200 });
                var decoded = Array.isArray(payload && payload.decoded) ? payload.decoded : [];
                var dedup = new Map();

                decoded.map(formatDecodedSignalRecord).forEach(function (item) {
                    if (!item.key) {
                        return;
                    }
                    dedup.set(item.key, item);
                });

                signalSnapshot = Array.from(dedup.values()).sort(function (left, right) {
                    var frameSort = left.frame.localeCompare(right.frame);
                    if (frameSort !== 0) {
                        return frameSort;
                    }
                    return left.signal.localeCompare(right.signal);
                });

                signalSnapshotMap = new Map(signalSnapshot.map(function (item) {
                    return [item.key, item];
                }));

                renderSignalSelect();
                renderSignalDatalist();
                renderSignalSummary();
                refreshSetupSignalBridge();
                setStatus(setupStatusNode, 'Signal snapshot loaded: ' + signalSnapshot.length + ' decoded signals.');
            } catch (error) {
                setStatus(setupStatusNode, 'Signal snapshot failed: ' + error.message, true);
            }
        }

        function assignSelectedSignal(target) {
            if (!selectedSignalKey) {
                setStatus(setupStatusNode, 'Select a signal from snapshot first.', true);
                return;
            }

            if (target === 'speed' && speedInput) {
                speedInput.value = selectedSignalKey;
                setStatus(setupStatusNode, 'Assigned snapshot signal to Speed.');
                return;
            }
            if (target === 'throttle' && throttleInput) {
                throttleInput.value = selectedSignalKey;
                setStatus(setupStatusNode, 'Assigned snapshot signal to Throttle.');
                return;
            }
            if (target === 'rpm' && rpmInput) {
                rpmInput.value = selectedSignalKey;
                setStatus(setupStatusNode, 'Assigned snapshot signal to RPM.');
                return;
            }
            if (target === 'behavior') {
                setSelectedSignalKey(selectedSignalKey);
                setStatus(setupStatusNode, 'Selected signal set for alerts/rules.');
            }
        }

        async function loadRuntimeSettings() {
            setStatus(setupStatusNode, 'Loading settings...');
            try {
                var runtime = await getRuntime(true, false);
                var mappings = runtime.inputMappings || {};
                var logging = runtime.logging || {};

                speedInput.value = mappings.speed || '';
                throttleInput.value = mappings.throttle || '';
                rpmInput.value = mappings.rpm || '';
                var loadedGen = toNumber(runtime.haldexGeneration, 4);
                generationSelect.value = String((loadedGen === 1 || loadedGen === 2 || loadedGen === 4) ? loadedGen : 4);

                logToFileInput.checked = Boolean(logging.enabled);
                logCanInput.checked = Boolean(logging.canEnabled);
                logErrorInput.checked = Boolean(logging.errorEnabled);
                logSerialInput.checked = Boolean(logging.serialEnabled);

                if (!selectedSignalKey) {
                    setSelectedSignalKey(behaviorSelectedSignalInput && behaviorSelectedSignalInput.value);
                } else {
                    renderSignalSummary();
                    refreshSetupSignalBridge();
                }

                setStatus(setupStatusNode, 'Settings loaded.');
            } catch (error) {
                setStatus(setupStatusNode, 'Settings load failed: ' + error.message, true);
            }
        }

        async function saveRuntimeSettings() {
            var payload = {
                inputMappings: {
                    speed: String(speedInput.value || '').trim(),
                    throttle: String(throttleInput.value || '').trim(),
                    rpm: String(rpmInput.value || '').trim(),
                },
                haldexGeneration: (function(){ var g = toNumber(generationSelect.value, 4); return (g === 1 || g === 2 || g === 4) ? g : 4; })(),
                logToFileEnabled: Boolean(logToFileInput.checked),
                logCanToFileEnabled: Boolean(logCanInput.checked),
                logErrorToFileEnabled: Boolean(logErrorInput.checked),
                logSerialEnabled: Boolean(logSerialInput.checked),
            };

            setStatus(setupStatusNode, 'Saving settings...');
            try {
                await fetchJson('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    timeoutMs: 2600,
                });
                appendActionLog('Controller settings saved');
                setStatus(setupStatusNode, 'Controller settings saved.');
                await loadRuntimeSettings();
            } catch (error) {
                setStatus(setupStatusNode, 'Settings save failed: ' + error.message, true);
            }
        }

        if (setupSaveBtn) {
            setupSaveBtn.addEventListener('click', saveRuntimeSettings);
        }

        if (signalSearchInput) {
            signalSearchInput.addEventListener('input', renderSignalSelect);
        }
        if (signalSelect) {
            signalSelect.addEventListener('change', function () {
                setSelectedSignalKey(signalSelect.value);
            });
        }
        if (signalRefreshBtn) {
            signalRefreshBtn.addEventListener('click', function () {
                refreshSignalSnapshot();
            });
        }
        if (assignSpeedBtn) {
            assignSpeedBtn.addEventListener('click', function () {
                assignSelectedSignal('speed');
            });
        }
        if (assignThrottleBtn) {
            assignThrottleBtn.addEventListener('click', function () {
                assignSelectedSignal('throttle');
            });
        }
        if (assignRpmBtn) {
            assignRpmBtn.addEventListener('click', function () {
                assignSelectedSignal('rpm');
            });
        }
        if (assignBehaviorBtn) {
            assignBehaviorBtn.addEventListener('click', function () {
                assignSelectedSignal('behavior');
            });
        }
        if (behaviorSelectedSignalInput) {
            behaviorSelectedSignalInput.addEventListener('change', function () {
                setSelectedSignalKey(behaviorSelectedSignalInput.value);
            });
        }

        refreshSetupSignalBridge();
        renderSignalSummary();
        renderSignalSelect();
        loadRuntimeSettings();
        refreshSignalSnapshot();

        if (typeof window.openhaldexBehaviorBuilderInit === 'function') {
            window.openhaldexBehaviorBuilderInit();
        }
    }

    function initOtaPage() {
        if (pageKey() !== 'ota') {
            return;
        }

        var uploadForm = byId('fwOtaUploadForm');
        var fileInput = byId('fwOtaFile');
        var uploadStatusNode = byId('fwOtaUploadStatus');

        var updateStatusNode = byId('fwOtaUpdateStatus');
        var currentNode = byId('fwOtaCurrent');
        var latestNode = byId('fwOtaLatest');
        var stageNode = byId('fwOtaStage');
        var progressBar = byId('fwOtaProgressBar');
        var networkNode = byId('fwOtaNetworkSummary');
        var wifiStatusNode = byId('fwWifiStatus');
        var wifiSsidInput = byId('fwWifiSsid');
        var wifiPasswordInput = byId('fwWifiPassword');
        var wifiStaEnabledInput = byId('fwWifiStaEnabled');
        var wifiApPasswordInput = byId('fwWifiApPassword');
        var wifiSaveStaBtn = byId('fwWifiSaveStaBtn');
        var wifiClearStaBtn = byId('fwWifiClearStaBtn');
        var wifiSaveApBtn = byId('fwWifiSaveApBtn');
        var wifiClearApBtn = byId('fwWifiClearApBtn');

        var checkBtn = byId('fwOtaCheckBtn');
        var installBtn = byId('fwOtaInstallBtn');

        function renderProgress(done, total) {
            var pct = 0;
            if (total > 0) {
                pct = Math.max(0, Math.min(100, (done / total) * 100));
            }
            progressBar.style.width = pct.toFixed(1) + '%';
            progressBar.textContent = pct.toFixed(1) + '%';
        }

        async function uploadFirmware(event) {
            event.preventDefault();
            var file = fileInput && fileInput.files && fileInput.files[0];
            if (!file) {
                setStatus(uploadStatusNode, 'Select a firmware file first.', true);
                return;
            }

            setStatus(uploadStatusNode, 'Uploading ' + file.name + ' ...');
            var formData = new FormData();
            formData.append('update', file, file.name);

            try {
                var response = await fetch(buildApiUrl('/ota/update'), {
                    method: 'POST',
                    body: formData,
                });
                var text = await response.text();
                if (!response.ok) {
                    throw new Error(text || ('HTTP ' + response.status));
                }
                setStatus(uploadStatusNode, 'Upload complete. Device should reboot now.');
                appendActionLog('OTA upload complete for ' + file.name);
            } catch (error) {
                setStatus(uploadStatusNode, 'Upload failed: ' + error.message, true);
            }
        }

        async function refreshUpdate() {
            try {
                var data = await fetchJson('/api/update', { timeoutMs: 2000 });
                currentNode.textContent = data.current || '--';
                latestNode.textContent = data.latest || '--';
                stageNode.textContent = data.stage || '--';

                if (Boolean(data.installing)) {
                    setStatus(updateStatusNode, 'Installing update...');
                } else if (data.installError) {
                    setStatus(updateStatusNode, 'Install failed: ' + data.installError, true);
                } else if (data.available) {
                    setStatus(updateStatusNode, 'Update available.');
                } else {
                    setStatus(updateStatusNode, 'Up to date. Last check: ' + fmtNumber(data.lastCheckMs, 0, 'ms'));
                }

                renderProgress(toNumber(data.bytesDone, 0), toNumber(data.bytesTotal, 0));
            } catch (error) {
                setStatus(updateStatusNode, 'Update poll failed: ' + error.message, true);
            }
        }

        async function refreshNetwork() {
            try {
                var net = await fetchJson('/api/network', { timeoutMs: 1800 });
                networkNode.textContent = JSON.stringify(net, null, 2);
            } catch (error) {
                networkNode.textContent = 'Network fetch failed: ' + error.message;
            }
        }

        async function loadWifiSettings() {
            if (!wifiStatusNode) {
                return;
            }

            setStatus(wifiStatusNode, 'Loading Wi-Fi settings...');
            try {
                var payload = await fetchJson('/api/wifi', { timeoutMs: 2200 });
                if (wifiSsidInput) {
                    wifiSsidInput.value = payload.ssid || '';
                }
                if (wifiPasswordInput) {
                    wifiPasswordInput.value = '';
                }
                if (wifiApPasswordInput) {
                    wifiApPasswordInput.value = '';
                }
                if (wifiStaEnabledInput) {
                    wifiStaEnabledInput.checked = Boolean(payload.staEnabled);
                }
                setStatus(wifiStatusNode, payload.ssid
                    ? ('Saved SSID: ' + payload.ssid + ' | AP password set: ' + (payload.apPasswordSet ? 'yes' : 'no'))
                    : ('No saved STA SSID | AP password set: ' + (payload.apPasswordSet ? 'yes' : 'no')));
            } catch (error) {
                setStatus(wifiStatusNode, 'Wi-Fi load failed: ' + error.message, true);
            }
        }

        async function saveStaSettings() {
            if (!wifiSsidInput || !wifiStaEnabledInput || !wifiPasswordInput) {
                return;
            }

            var payload = {
                ssid: String(wifiSsidInput.value || '').trim(),
                staEnabled: Boolean(wifiStaEnabledInput.checked),
            };
            var pass = String(wifiPasswordInput.value || '').trim();
            if (pass) {
                payload.password = pass;
            }

            setStatus(wifiStatusNode, 'Saving STA settings...');
            try {
                await fetchJson('/api/wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    timeoutMs: 2200,
                });
                wifiPasswordInput.value = '';
                setStatus(wifiStatusNode, 'STA settings saved.');
                await loadWifiSettings();
            } catch (error) {
                setStatus(wifiStatusNode, 'STA save failed: ' + error.message, true);
            }
        }

        async function clearStaSettings() {
            if (!wifiSsidInput || !wifiStaEnabledInput || !wifiPasswordInput) {
                return;
            }

            setStatus(wifiStatusNode, 'Clearing STA settings...');
            try {
                await fetchJson('/api/wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ssid: '', password: '', staEnabled: false }),
                    timeoutMs: 2200,
                });
                wifiSsidInput.value = '';
                wifiPasswordInput.value = '';
                wifiStaEnabledInput.checked = false;
                setStatus(wifiStatusNode, 'STA settings cleared.');
                await loadWifiSettings();
            } catch (error) {
                setStatus(wifiStatusNode, 'STA clear failed: ' + error.message, true);
            }
        }

        async function saveApPassword() {
            if (!wifiApPasswordInput) {
                return;
            }

            var pass = String(wifiApPasswordInput.value || '');
            if (!pass || pass.length < 8 || pass.length > 63) {
                setStatus(wifiStatusNode, 'AP password must be 8..63 characters.', true);
                return;
            }

            setStatus(wifiStatusNode, 'Saving AP password...');
            try {
                await fetchJson('/api/wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apPassword: pass }),
                    timeoutMs: 2200,
                });
                wifiApPasswordInput.value = '';
                setStatus(wifiStatusNode, 'AP password saved.');
                await loadWifiSettings();
            } catch (error) {
                setStatus(wifiStatusNode, 'AP save failed: ' + error.message, true);
            }
        }

        async function clearApPassword() {
            if (!wifiApPasswordInput) {
                return;
            }

            setStatus(wifiStatusNode, 'Clearing AP password...');
            try {
                await fetchJson('/api/wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apPassword: '' }),
                    timeoutMs: 2200,
                });
                wifiApPasswordInput.value = '';
                setStatus(wifiStatusNode, 'AP password cleared.');
                await loadWifiSettings();
            } catch (error) {
                setStatus(wifiStatusNode, 'AP clear failed: ' + error.message, true);
            }
        }

        async function checkUpdates() {
            setStatus(updateStatusNode, 'Checking for updates...');
            try {
                await fetchJson('/api/update/check', { method: 'POST', timeoutMs: 3000 });
                await refreshUpdate();
                appendActionLog('Update check triggered');
            } catch (error) {
                setStatus(updateStatusNode, 'Update check failed: ' + error.message, true);
            }
        }

        async function installUpdate() {
            setStatus(updateStatusNode, 'Starting install...');
            try {
                await fetchJson('/api/update/install', { method: 'POST', timeoutMs: 3000 });
                appendActionLog('Update install requested');
                await refreshUpdate();
            } catch (error) {
                setStatus(updateStatusNode, 'Install request failed: ' + error.message, true);
            }
        }

        if (uploadForm) {
            uploadForm.addEventListener('submit', uploadFirmware);
        }
        if (checkBtn) {
            checkBtn.addEventListener('click', checkUpdates);
        }
        if (installBtn) {
            installBtn.addEventListener('click', installUpdate);
        }
        if (wifiSaveStaBtn) {
            wifiSaveStaBtn.addEventListener('click', saveStaSettings);
        }
        if (wifiClearStaBtn) {
            wifiClearStaBtn.addEventListener('click', clearStaSettings);
        }
        if (wifiSaveApBtn) {
            wifiSaveApBtn.addEventListener('click', saveApPassword);
        }
        if (wifiClearApBtn) {
            wifiClearApBtn.addEventListener('click', clearApPassword);
        }

        refreshUpdate();
        refreshNetwork();
        loadWifiSettings();
        setInterval(refreshUpdate, 2000);
        setInterval(refreshNetwork, 6000);
    }

    function initAboutPage() {
        if (pageKey() !== 'about') {
            return;
        }

        var firmwareNode = byId('fwAboutFirmware');
        var modeNode = byId('fwAboutMode');
        var uptimeNode = byId('fwAboutUptime');
        var mapNode = byId('fwAboutMap');
        var runtimeDumpNode = byId('fwAboutRuntimeDump');
        var networkDumpNode = byId('fwAboutNetworkDump');

        async function loadAbout() {
            try {
                var runtime = await getRuntime(true, true);
                var maps = await fetchJson('/api/maps', { timeoutMs: 2200 });
                var network = await fetchJson('/api/network', { timeoutMs: 1800 });

                firmwareNode.textContent = runtime.version || '--';
                modeNode.textContent = runtime.disableController ? 'STOCK' : (runtime.mode || '--');
                uptimeNode.textContent = fmtUptime(runtime.uptimeMs);
                mapNode.textContent = maps.current || '--';

                runtimeDumpNode.textContent = JSON.stringify(runtime, null, 2);
                networkDumpNode.textContent = JSON.stringify(network, null, 2);
            } catch (error) {
                runtimeDumpNode.textContent = 'About load failed: ' + error.message;
            }
        }

        loadAbout();
        setInterval(loadAbout, 3500);
    }

    function initHelpPage() {
        if (pageKey() !== 'help') {
            return;
        }

        var supportBtn = byId('fwHelpSupportBundleBtn');
        if (!supportBtn) {
            return;
        }

        supportBtn.addEventListener('click', function () {
            window.open(buildApiUrl('/api/canview/dump?seconds=30&bus=all'), '_blank');
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        initApiBase();
        exposeFirmwareApiBridge();
        initSidebarToggle();
        initCardCollapsePersistence();
        enableRangeMirrors();

        initHomePage();
        initMapPage();
        initCurvePage();
        initCanviewPage();
        initDiagnosticsPage();
        initLogsPage();
        initSetupPage();
        initOtaPage();
        initAboutPage();
        initHelpPage();
    });
})();






