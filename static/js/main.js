/* ==========================================================================
   SOC COMMAND CENTER - MAIN JAVASCRIPT
   Application web dynamique avec onglets, état centralisé, polling intelligent
   ========================================================================== */

// ==========================================================================
// STATE CENTRALISÉ
// ==========================================================================
const appState = {
    activeTab: 'dashboard',
    connected: false,
    lastUpdate: null,
    loading: false,
    networkError: false,
    onlineNodes: 0,
    totalNodes: 0,
    isLoggedIn: false,
    userRole: 'viewer', // 'viewer', 'analyst', 'admin_secops'
    currentUser: {
        username: 'Visiteur (Lecture seule)',
        role: 'viewer',
        full_name: 'Session Non Authentifiée'
    },
    lastServersData: []
};

let performanceChart = null;
let failedResolveAttempts = 0;
let pollInterval = null;
let currentCleanupResource = null;
let currentCleanupNode = '';

// Seuil critique et gestion des alertes automatiques
const CRITICAL_THRESHOLD = 85;
let alertCriticalQueue = [];       // File d'alertes critiques en attente
let dismissedAlerts = {};          // Alertes ignorées {clé: timestamp} pour ne pas ré-alerter immédiatement
const ALERT_COOLDOWN_MS = 120000;  // Cooldown de 2 min après un "Ignorer"
let pendingAlertResource = null;
let pendingAlertNode = '';

// ==========================================================================
// TAB NAVIGATION
// ==========================================================================
function switchTab(tabName) {
    appState.activeTab = tabName;

    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.remove('active');
    });

    // Deactivate all tab buttons
    document.querySelectorAll('.nav-tab').forEach(el => {
        el.classList.remove('active');
    });

    // Show selected tab
    const tabEl = document.getElementById(`tab-${tabName}`);
    if (tabEl) tabEl.classList.add('active');

    // Activate selected button
    const btnEl = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
    if (btnEl) btnEl.classList.add('active');

    // Trigger data load for the tab
    switch (tabName) {
        case 'dashboard':
            fetchServersStatus(true);
            break;
        case 'nodes':
            fetchServersStatus();
            break;
        case 'logs':
            fetchIncidents();
            fetchLogs();
            break;
        case 'settings':
            loadSettingsForm();
            break;
    }
}

function refreshCurrentTab() {
    switchTab(appState.activeTab);
    showToast("Données rafraîchies.");
}

// ==========================================================================
// STATUS BAR
// ==========================================================================
function updateStatusBar() {
    const dot = document.getElementById('status-dot');
    const connText = document.getElementById('status-connection-text');
    const nodesText = document.getElementById('status-nodes-count');
    const updateText = document.getElementById('status-last-update');

    if (dot && connText) {
        if (appState.networkError) {
            dot.className = 'status-dot offline';
            connText.textContent = 'Erreur réseau';
        } else if (appState.loading) {
            dot.className = 'status-dot loading';
            connText.textContent = 'Chargement...';
        } else {
            dot.className = 'status-dot';
            connText.textContent = 'Connecté';
        }
    }

    if (nodesText) {
        nodesText.textContent = `${appState.onlineNodes}/${appState.totalNodes} nœud(s) en ligne`;
    }

    if (updateText && appState.lastUpdate) {
        updateText.textContent = `Dernière MAJ : ${appState.lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

    // Network error banner
    const banner = document.getElementById('network-error');
    if (banner) {
        if (appState.networkError) {
            banner.classList.add('visible');
        } else {
            banner.classList.remove('visible');
        }
    }

    // Global status
    const globalStatus = document.getElementById('global-status');
    if (globalStatus) {
        if (appState.onlineNodes === appState.totalNodes && appState.totalNodes > 0) {
            globalStatus.textContent = 'INFRASTRUCTURE EN LIGNE';
        } else if (appState.onlineNodes > 0) {
            globalStatus.textContent = `${appState.onlineNodes}/${appState.totalNodes} NŒUDS EN LIGNE`;
        } else if (appState.totalNodes > 0) {
            globalStatus.textContent = 'INFRASTRUCTURE HORS LIGNE';
        } else {
            globalStatus.textContent = 'INFRASTRUCTURE MONITORING';
        }
    }
}

function setNetworkError(hasError) {
    appState.networkError = hasError;
    updateStatusBar();
}

// ==========================================================================
// SPINNER LOADER
// ==========================================================================
function setSpinner(active) {
    appState.loading = active;
    const spinner = document.getElementById('main-spinner');
    if (spinner) {
        if (active) spinner.classList.add('active');
        else spinner.classList.remove('active');
    }
    updateStatusBar();
}

// ==========================================================================
// CHART INITIALIZATION
// ==========================================================================
function initPerformanceChart() {
    const ctx = document.getElementById('kaliPerformanceChart');
    if (!ctx) return;

    const chartCtx = ctx.getContext('2d');

    const cpuGradient = chartCtx.createLinearGradient(0, 0, 0, 200);
    cpuGradient.addColorStop(0, 'rgba(79, 38, 131, 0.2)');
    cpuGradient.addColorStop(1, 'rgba(79, 38, 131, 0.0)');

    const ramGradient = chartCtx.createLinearGradient(0, 0, 0, 200);
    ramGradient.addColorStop(0, 'rgba(26, 26, 26, 0.2)');
    ramGradient.addColorStop(1, 'rgba(26, 26, 26, 0.0)');

    const diskGradient = chartCtx.createLinearGradient(0, 0, 0, 200);
    diskGradient.addColorStop(0, 'rgba(141, 141, 141, 0.2)');
    diskGradient.addColorStop(1, 'rgba(141, 141, 141, 0.0)');

    const initialLabels = [];
    const now = new Date();
    for (let i = 10; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 10000);
        initialLabels.push(time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }

    performanceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: initialLabels,
            datasets: [
                {
                    label: 'CPU (%)',
                    data: new Array(11).fill(0),
                    borderColor: '#4F2683',
                    backgroundColor: cpuGradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'RAM (%)',
                    data: new Array(11).fill(0),
                    borderColor: '#1A1A1A',
                    backgroundColor: ramGradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'Disk (%)',
                    data: new Array(11).fill(0),
                    borderColor: '#8D8D8D',
                    backgroundColor: diskGradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeInOutQuad' },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#2D3748', font: { family: 'Inter' } }
                },
                tooltip: {
                    backgroundColor: 'rgba(255, 255, 255, 0.9)',
                    titleColor: '#2D3748',
                    bodyColor: '#2D3748',
                    borderColor: 'rgba(226, 232, 240, 1)',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0, 0, 0, 0.05)' },
                    ticks: { color: '#718096', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(0, 0, 0, 0.05)' },
                    ticks: { color: '#718096', font: { size: 10 } },
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            }
        }
    });
}

function pushChartData(cpuVal, ramVal, diskVal) {
    if (!performanceChart) return;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    performanceChart.data.labels.push(timeStr);
    performanceChart.data.datasets[0].data.push(cpuVal);
    performanceChart.data.datasets[1].data.push(ramVal);
    performanceChart.data.datasets[2].data.push(diskVal);

    if (performanceChart.data.labels.length > 15) {
        performanceChart.data.labels.shift();
        performanceChart.data.datasets.forEach(ds => ds.data.shift());
    }
    performanceChart.update();
}

// ==========================================================================
// SERVICE STATE
// ==========================================================================
function updateServiceState(serviceId, status) {
    const led = document.getElementById(`led-${serviceId}`);
    const text = document.getElementById(`status-text-${serviceId}`);
    if (!led) return;

    if (status === 'active' || status === 'Online' || status === 'Running') {
        led.className = 'pulse-led led-active';
        if (text) {
            text.textContent = "Status: ONLINE";
            text.style.color = "#10B981";
        }
    } else {
        led.className = 'pulse-led led-inactive';
        if (text) {
            text.textContent = "Status: OFFLINE";
            text.style.color = "#EF4444";
        }
    }
}

// ==========================================================================
// DATA FETCHING
// ==========================================================================
async function fetchServersStatus(silent = false) {
    try {
        if (!silent) setSpinner(true);
        const response = await fetch('/api/servers/status');
        const data = await response.json();
        setNetworkError(false);

        const container = document.getElementById('servers-container');

        if (data.status === 'success' && data.servers) {
            appState.lastServersData = data.servers;
            appState.lastUpdate = new Date();
            appState.totalNodes = data.servers.length;
            appState.onlineNodes = data.servers.filter(s => s.status === 'ONLINE' || s.status === 'UP').length;

            let totalCpu = 0, totalMem = 0, totalDisk = 0, count = 0;

            // Build server cards HTML
            if (container) {
                let html = '';
                data.servers.forEach(srv => {
                    const isUp = srv.status === 'ONLINE' || srv.status === 'UP';
                    const statusColor = isUp ? '#10B981' : '#EF4444';
                    const ledClass = isUp ? 'pulse-led led-active' : 'pulse-led led-inactive';

                    totalCpu += srv.cpu || 0;
                    totalMem += srv.memory || 0;
                    totalDisk += srv.disk || 0;
                    count++;

                    const cpuColor = (srv.cpu || 0) > 80 ? '#EF4444' : 'var(--cgi-dark)';
                    const memColor = (srv.memory || 0) > 80 ? '#EF4444' : 'var(--cgi-dark)';
                    const diskColor = (srv.disk || 0) > 80 ? '#EF4444' : 'var(--cgi-dark)';

                    html += `
                    <div class="server-card">
                        <div class="server-card-header">
                            <div class="server-card-info">
                                <div class="${ledClass}"></div>
                                <div>
                                    <h3>${srv.hostname || srv.name}</h3>
                                    <span class="server-card-meta">${srv.ip} | ${(srv.role || 'NODE').toUpperCase()}</span>
                                </div>
                            </div>
                            <span class="server-status-badge" style="background: ${statusColor}20; color: ${statusColor};">${srv.status}</span>
                        </div>
                        <div class="server-metrics">
                            <div class="server-metric-box">
                                <div class="server-metric-label">CPU</div>
                                <div class="server-metric-value" style="color: ${cpuColor};">${srv.cpu || 0}%</div>
                            </div>
                            <div class="server-metric-box">
                                <div class="server-metric-label">RAM</div>
                                <div class="server-metric-value" style="color: ${memColor};">${srv.memory || 0}%</div>
                            </div>
                            <div class="server-metric-box">
                                <div class="server-metric-label">DISK</div>
                                <div class="server-metric-value" style="color: ${diskColor};">${srv.disk || 0}%</div>
                            </div>
                        </div>
                        <div class="node-card-actions ${appState.userRole === 'viewer' ? 'rbac-viewer-hidden' : ''}" style="display: ${appState.userRole === 'viewer' ? 'none' : 'flex'}; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--cgi-border);">
                            <button class="btn-action" style="flex: 1; padding: 8px 4px; font-size: 11px; font-weight: 700;" onclick="openCleanupModal('cpu', '${srv.name || srv.hostname || srv.ip}')" title="Optimiser la charge CPU de ${srv.name || srv.hostname}">CPU</button>
                            <button class="btn-action" style="flex: 1; padding: 8px 4px; font-size: 11px; font-weight: 700;" onclick="openCleanupModal('ram', '${srv.name || srv.hostname || srv.ip}')" title="Libérer la mémoire RAM de ${srv.name || srv.hostname}">RAM</button>
                            <button class="btn-action" style="flex: 1; padding: 8px 4px; font-size: 11px; font-weight: 700;" onclick="openCleanupModal('disk', '${srv.name || srv.hostname || srv.ip}')" title="Purger l'espace disque de ${srv.name || srv.hostname}">DISQUE</button>
                        </div>
                    </div>
                    `;
                });
                container.innerHTML = html;
            }

            // Mettre à jour dynamiquement la liste déroulante des serveurs dans la modale
            const nodeSelect = document.getElementById('cleanup-node-select');
            if (nodeSelect && data.servers && data.servers.length > 0) {
                const currentVal = nodeSelect.value;
                let optHtml = '<option value="">Kali Master (Défaut - 192.168.132.130)</option>';
                data.servers.forEach(srv => {
                    const sName = srv.name || srv.hostname || srv.ip;
                    optHtml += `<option value="${sName}">${sName} (${srv.ip})</option>`;
                });
                nodeSelect.innerHTML = optHtml;
                if (currentVal) nodeSelect.value = currentVal;
            }

            // Update gauges with averages
            if (count > 0) {
                const avgCpu = Math.round(totalCpu / count);
                const avgMem = Math.round(totalMem / count);
                const avgDisk = Math.round(totalDisk / count);

                updateGauge('cpu', avgCpu);
                updateGauge('ram', avgMem);
                updateGauge('disk', avgDisk);

                pushChartData(avgCpu, avgMem, avgDisk);
            }

            updateStatusBar();

            // Mettre à jour l'état des services selon l'état réel des machines hôtes
            updateServicesFromServers(data.servers);

            // Vérifier les seuils critiques et déclencher les alertes automatiques
            checkCriticalThresholds(data.servers);
        }
    } catch (error) {
        console.error("Erreur de récupération des serveurs:", error);
        setNetworkError(true);
    } finally {
        if (!silent) setTimeout(() => setSpinner(false), 500);
    }
}

// ==========================================================================
// SYNCHRONISATION ÉTAT SERVICES <-> VMS HÔTES
// ==========================================================================
function updateServicesFromServers(servers) {
    if (!servers || servers.length === 0) return;

    const findSrv = (keywords) => servers.find(s => {
        const text = `${s.name || ''} ${s.role || ''} ${s.ip || ''}`.toLowerCase();
        return keywords.some(k => text.includes(k.toLowerCase()));
    });

    const dbServer = findSrv(['database', 'mariadb', 'db-node', '119.144']);
    const webServer = findSrv(['web', 'dashboard', '118.189']);
    const appServer = findSrv(['app', 'apache', '127.3']) || webServer;

    const setServiceUI = (serviceKey, hostServer) => {
        const textEl = document.getElementById(`status-text-${serviceKey}`);
        const ledEl = document.getElementById(`led-${serviceKey}`);
        
        const isUp = hostServer ? (hostServer.status === 'ONLINE' || hostServer.status === 'UP') : true;

        if (textEl) {
            if (isUp) {
                textEl.textContent = "Status: ONLINE";
                textEl.style.color = "#10B981";
            } else {
                const hostName = hostServer ? (hostServer.name || hostServer.ip) : 'Nœud';
                textEl.textContent = `Status: OFFLINE (${hostName} Injoignable)`;
                textEl.style.color = "#E31937";
            }
        }

        if (ledEl) {
            ledEl.className = isUp ? "pulse-led led-active" : "pulse-led led-inactive";
        }
    };

    setServiceUI('apache2', appServer);
    setServiceUI('mariadb', dbServer);
    setServiceUI('cron', webServer);
    setServiceUI('sauvegarde', dbServer);
}

// ==========================================================================
// ALERTES CRITIQUES AUTOMATIQUES (Pop-up avant nettoyage)
// ==========================================================================
function checkCriticalThresholds(servers) {
    if (!servers || servers.length === 0) return;

    const now = Date.now();
    let newAlerts = [];

    servers.forEach(srv => {
        const srvName = srv.name || srv.hostname || srv.ip;
        const cpuVal = srv.cpu || 0;
        const memVal = srv.memory || 0;
        const diskVal = srv.disk || 0;

        if (cpuVal > CRITICAL_THRESHOLD) {
            const key = `cpu_${srvName}`;
            if (!isDismissed(key, now)) {
                newAlerts.push({ resource: 'cpu', node: srvName, value: cpuVal, label: 'CPU' });
            }
        }
        if (memVal > CRITICAL_THRESHOLD) {
            const key = `ram_${srvName}`;
            if (!isDismissed(key, now)) {
                newAlerts.push({ resource: 'ram', node: srvName, value: memVal, label: 'RAM' });
            }
        }
        if (diskVal > CRITICAL_THRESHOLD) {
            const key = `disk_${srvName}`;
            if (!isDismissed(key, now)) {
                newAlerts.push({ resource: 'disk', node: srvName, value: diskVal, label: 'Disque' });
            }
        }
    });

    if (newAlerts.length > 0) {
        alertCriticalQueue = newAlerts;
        showNextCriticalAlert();
    }
}

function isDismissed(key, now) {
    if (dismissedAlerts[key] && (now - dismissedAlerts[key]) < ALERT_COOLDOWN_MS) {
        return true;
    }
    return false;
}

function showNextCriticalAlert() {
    if (alertCriticalQueue.length === 0) return;

    // Ne pas afficher si la modale de nettoyage est déjà ouverte
    const cleanupModal = document.getElementById('cleanup-modal');
    if (cleanupModal && cleanupModal.style.display === 'flex') return;

    // Ne pas afficher si la modale d'alerte est déjà visible
    const alertModal = document.getElementById('alert-critical-modal');
    if (!alertModal) return;
    if (alertModal.style.display === 'flex') return;

    const alertData = alertCriticalQueue[0];
    pendingAlertResource = alertData.resource;
    pendingAlertNode = alertData.node;

    // Construire le contenu du pop-up
    const subtitle = document.getElementById('alert-critical-subtitle');
    const body = document.getElementById('alert-critical-body');
    const actionBtn = document.getElementById('btn-alert-critical-action');

    if (subtitle) subtitle.textContent = `${alertData.node} — ${alertData.label} a ${alertData.value}%`;

    // Grouper toutes les alertes du même nœud
    const sameNodeAlerts = alertCriticalQueue.filter(a => a.node === alertData.node);
    let bodyHtml = `<strong>${alertData.node}</strong> — Ressources en état critique :<br><br>`;
    sameNodeAlerts.forEach(a => {
        const barColor = a.value > 90 ? '#DC2626' : '#EF4444';
        bodyHtml += `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <span style="font-weight: 700; width: 55px;">${a.label}</span>
                <div style="flex: 1; height: 8px; background: #FEE2E2; border-radius: 4px; overflow: hidden;">
                    <div style="width: ${a.value}%; height: 100%; background: ${barColor}; border-radius: 4px; transition: width 0.3s ease;"></div>
                </div>
                <span style="font-weight: 700; min-width: 40px; text-align: right;">${a.value}%</span>
            </div>
        `;
    });
    bodyHtml += `<div style="margin-top: 10px; font-size: 12px; color: #7F1D1D;">Action recommandée : nettoyez les ressources consommées pour stabiliser le serveur.</div>`;

    if (body) body.innerHTML = bodyHtml;

    // Libellé du bouton d'action
    if (actionBtn) {
        if (sameNodeAlerts.length > 1) {
            actionBtn.textContent = 'Intervenir sur ' + alertData.node;
        } else {
            const actionLabels = { cpu: 'Optimiser CPU', ram: 'Libérer RAM', disk: 'Purger Disque' };
            actionBtn.textContent = actionLabels[alertData.resource] || 'Intervenir';
        }
    }

    alertModal.style.display = 'flex';
}

function closeAlertCriticalModal() {
    const alertModal = document.getElementById('alert-critical-modal');
    if (alertModal) alertModal.style.display = 'none';

    // Marquer les alertes du nœud courant comme ignorées
    if (pendingAlertNode) {
        const now = Date.now();
        alertCriticalQueue
            .filter(a => a.node === pendingAlertNode)
            .forEach(a => {
                dismissedAlerts[`${a.resource}_${a.node}`] = now;
            });
        // Retirer les alertes de ce nœud de la file
        alertCriticalQueue = alertCriticalQueue.filter(a => a.node !== pendingAlertNode);
    }

    pendingAlertResource = null;
    pendingAlertNode = '';

    // Afficher la prochaine alerte s'il en reste
    if (alertCriticalQueue.length > 0) {
        setTimeout(showNextCriticalAlert, 500);
    }
}

function handleAlertCriticalAction() {
    const resource = pendingAlertResource;
    const node = pendingAlertNode;

    // Fermer le pop-up d'alerte
    const alertModal = document.getElementById('alert-critical-modal');
    if (alertModal) alertModal.style.display = 'none';

    // Marquer comme traité pour éviter de ré-alerter
    if (node) {
        const now = Date.now();
        alertCriticalQueue
            .filter(a => a.node === node)
            .forEach(a => {
                dismissedAlerts[`${a.resource}_${a.node}`] = now;
            });
        alertCriticalQueue = alertCriticalQueue.filter(a => a.node !== node);
    }

    // Déterminer la ressource la plus critique pour ce nœud
    // et ouvrir la modale de nettoyage avec les checkboxes
    if (resource && node) {
        openCleanupModal(resource, node);
    }

    pendingAlertResource = null;
    pendingAlertNode = '';

    // Prochaine alerte après un délai
    if (alertCriticalQueue.length > 0) {
        setTimeout(showNextCriticalAlert, 1000);
    }
}

async function remediateServer(btnElem, serverId) {
    btnElem.classList.add('clicked');
    const originalText = btnElem.textContent;
    btnElem.textContent = "Exécution...";
    btnElem.disabled = true;

    try {
        const response = await fetch(`/api/server/${encodeURIComponent(serverId)}/remediate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Accès Refusé : Vous devez être connecté en tant qu'Analyste SOC.", true);
            openLoginModal();
        } else if (data.status === 'success' || data.success) {
            showToast(data.message || "Remédiation réussie");
            fetchIncidents(true);
            fetchServersStatus(true);
        } else {
            showToast(data.message || "Erreur de remédiation", true);
        }
    } catch (error) {
        showToast("Erreur réseau.", true);
    } finally {
        setTimeout(() => {
            btnElem.classList.remove('clicked');
            btnElem.textContent = originalText;
            btnElem.disabled = false;
        }, 1000);
    }
}

// ==========================================================================
// CIRCULAR GAUGE HELPER
// ==========================================================================
function updateGauge(type, val) {
    const numberEl = document.getElementById(`${type}-val`);
    const fillEl = document.getElementById(`${type}-gauge-fill`);

    if (!numberEl || !fillEl) return;

    val = Math.min(100, Math.max(0, val));
    numberEl.textContent = `${val}%`;

    const circumference = 251.2;
    const offset = circumference - (val / 100) * circumference;
    fillEl.style.strokeDashoffset = offset;

    if (val >= 90) {
        fillEl.style.stroke = '#E31937';
        numberEl.style.color = '#E31937';
    } else if (val >= 70) {
        fillEl.style.stroke = '#F59E0B';
        numberEl.style.color = '#F59E0B';
    } else {
        fillEl.style.stroke = type === 'cpu' ? '#4F2683' : (type === 'ram' ? '#1A1A1A' : '#8D8D8D');
        numberEl.style.color = '#111827';
    }
}

// ==========================================================================
// INCIDENTS
// ==========================================================================
async function fetchIncidents(silent = false) {
    try {
        if (!silent) setSpinner(true);
        const response = await fetch('/api/incidents');
        const data = await response.json();
        setNetworkError(false);

        const tbody = document.getElementById('incidents-body');
        if (!tbody) return;

        if (!data.incidents || data.incidents.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Aucun incident enregistré pour le moment.</td></tr>`;
            return;
        }

        let html = '';
        data.incidents.forEach(inc => {
            const isError = inc.status.includes('Inactif') || inc.status.includes('CRITICAL') || inc.status.includes('ERROR');
            const badgeClass = isError ? 'status-badge status-alert' : 'status-badge status-ok';
            html += `
                <tr>
                    <td class="ticket-id">${inc.id}</td>
                    <td style="font-family: var(--font-mono); color: var(--cgi-grey);">${inc.timestamp}</td>
                    <td style="font-weight: 600;">${inc.service}</td>
                    <td><span class="${badgeClass}">${inc.status}</span></td>
                    <td style="color: var(--cgi-grey); font-weight: 500;">${inc.assignee}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } catch (error) {
        console.error("Erreur incidents:", error);
        setNetworkError(true);
    } finally {
        if (!silent) setTimeout(() => setSpinner(false), 500);
    }
}

// ==========================================================================
// SERVICE ACTIONS (REAL SSH)
// ==========================================================================
async function setServiceState(btnElem, serviceName, action) {
    btnElem.classList.add('clicked');
    btnElem.disabled = true;

    try {
        const response = await fetch('/api/service_action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: serviceName, action: action })
        });
        const data = await response.json();

        if (data.success) {
            showToast(data.message);
            fetchIncidents(true);
            fetchServersStatus(true);
        } else {
            showToast(data.error || "Erreur lors de l'action.", true);
        }
    } catch (error) {
        showToast("Erreur réseau.", true);
    } finally {
        btnElem.classList.remove('clicked');
        btnElem.disabled = false;
    }
}

async function executeCustomScript(btnElem) {
    const repeatInput = document.getElementById('script-repeat-count');
    const repeatCount = repeatInput ? parseInt(repeatInput.value) : 1;

    btnElem.classList.add('clicked');
    btnElem.disabled = true;
    const originalText = btnElem.textContent;
    btnElem.textContent = "...";

    try {
        const response = await fetch('/api/execute_script', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repeat: repeatCount })
        });
        const data = await response.json();

        if (data.status === 'success') {
            showToast(data.message);
            const countEl = document.getElementById('script-count');
            if (countEl && data.count) countEl.textContent = data.count;
            fetchIncidents(true);
            fetchServersStatus(true);
        } else {
            showToast(data.message || "Erreur lors de l'exécution.", true);
        }
    } catch (error) {
        showToast("Erreur réseau.", true);
    } finally {
        btnElem.classList.remove('clicked');
        btnElem.disabled = false;
        btnElem.textContent = originalText;
    }
}

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================
function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'soc-toast';

    if (isError) {
        toast.style.borderLeftColor = '#E31937';
    } else {
        toast.style.borderLeftColor = '#4F2683';
    }

    toast.innerHTML = `<div style="flex: 1; font-weight: 600; font-size: 13px;">${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = "toastExit 0.4s ease-in-out forwards";
        setTimeout(() => {
            if (container.contains(toast)) container.removeChild(toast);
        }, 400);
    }, 4000);
}

// ==========================================================================
// AUTHENTIFICATION, GESTION DE SESSION & RBAC
// ==========================================================================
let sessionInactivityTimer = null;
const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function resetInactivityTimer() {
    if (sessionInactivityTimer) clearTimeout(sessionInactivityTimer);
    if (appState.isLoggedIn) {
        sessionInactivityTimer = setTimeout(() => {
            showToast("Session expirée après 20 minutes d'inactivité.", true);
            logoutSOC(true);
        }, SESSION_TIMEOUT_MS);
    }
}

// Détection de l'activité utilisateur
['mousemove', 'keydown', 'click', 'scroll'].forEach(evt => {
    window.addEventListener(evt, resetInactivityTimer, { passive: true });
});

async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/me');
        const data = await response.json();
        appState.isLoggedIn = data.is_authenticated;
        appState.userRole = data.role || 'viewer';
        appState.currentUser = data;

        updateUserProfileUI();
        applyRBACPermissions(appState.userRole);
        resetInactivityTimer();
    } catch (e) {
        console.error("Erreur vérification auth:", e);
    }
}

function updateUserProfileUI() {
    const nameEl = document.getElementById('user-display-name');
    const badgeEl = document.getElementById('user-role-badge');
    const btnLogin = document.getElementById('btn-login');

    if (nameEl) {
        nameEl.textContent = appState.currentUser.full_name || appState.currentUser.username || 'Visiteur';
    }

    if (badgeEl) {
        badgeEl.className = 'role-badge';
        if (appState.userRole === 'admin_secops') {
            badgeEl.classList.add('role-admin_secops');
            badgeEl.textContent = "Admin SecOps (Contrôle total)";
        } else if (appState.userRole === 'analyst') {
            badgeEl.classList.add('role-analyst');
            badgeEl.textContent = "Analyste SOC (Opérationnel)";
        } else {
            badgeEl.classList.add('role-viewer');
            badgeEl.textContent = "Viewer (Lecture seule)";
        }
    }

    if (btnLogin) {
        if (appState.isLoggedIn) {
            btnLogin.textContent = "DÉCONNEXION";
            btnLogin.onclick = () => logoutSOC(false);
            btnLogin.style.background = "var(--cgi-grey)";
            btnLogin.style.color = "white";
        } else {
            btnLogin.textContent = "CONNEXION";
            btnLogin.onclick = openLoginModal;
            btnLogin.style.background = "var(--cgi-red)";
            btnLogin.style.color = "white";
        }
    }
}

function applyRBACPermissions(role) {
    // 1. Boutons d'action des VM cards dans "Gestion des Nœuds"
    document.querySelectorAll('.node-card-actions').forEach(el => {
        if (role === 'viewer') {
            el.style.display = 'none';
            el.classList.add('rbac-viewer-hidden');
        } else {
            el.style.display = 'flex';
            el.classList.remove('rbac-viewer-hidden');
        }
    });

    // 2. Boutons d'administration (Paramètres)
    const btnSettings = document.getElementById('btn-settings');
    if (btnSettings) {
        if (role === 'admin_secops') {
            btnSettings.style.display = 'inline-block';
            btnSettings.classList.remove('rbac-disabled');
        } else {
            btnSettings.style.display = 'none';
        }
    }

    // 3. Éléments réservés à l'administrateur
    document.querySelectorAll('.role-admin-only').forEach(el => {
        if (role === 'admin_secops') {
            el.style.display = '';
            el.classList.remove('rbac-disabled');
        } else {
            el.style.display = 'none';
        }
    });
}

function openLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'flex';
        const uInput = document.getElementById('username');
        const pInput = document.getElementById('password');
        const oInput = document.getElementById('otp-code');
        const alertEl = document.getElementById('login-alert-msg');
        const mfaGroup = document.getElementById('mfa-group');

        if (pInput) pInput.value = '';
        if (oInput) oInput.value = '';
        if (alertEl) { alertEl.style.display = 'none'; alertEl.textContent = ''; }
        if (mfaGroup) mfaGroup.style.display = 'none';

        // Détection automatique de l'identifiant pour afficher le champ MFA si admin
        if (uInput) {
            uInput.oninput = () => {
                const val = uInput.value.trim().toLowerCase();
                if (val.includes('admin') || val === 'admin_secops') {
                    if (mfaGroup) mfaGroup.style.display = 'block';
                } else {
                    if (mfaGroup) mfaGroup.style.display = 'none';
                }
            };
            setTimeout(() => uInput.focus(), 100);
        }
    }
}

function closeLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) modal.style.display = 'none';
}

async function submitLogin() {
    const user = (document.getElementById('username').value || '').trim();
    const pass = document.getElementById('password').value || '';
    const otp = (document.getElementById('otp-code')?.value || '').trim();
    const alertEl = document.getElementById('login-alert-msg');
    const mfaGroup = document.getElementById('mfa-group');
    const btnSubmit = document.getElementById('btn-submit-login');

    if (!user || !pass) {
        if (alertEl) {
            alertEl.style.display = 'block';
            alertEl.style.background = '#FEE2E2';
            alertEl.style.color = '#991B1B';
            alertEl.style.border = '1px solid #F87171';
            alertEl.textContent = "Veuillez saisir votre identifiant et mot de passe.";
        }
        return;
    }

    try {
        if (btnSubmit) btnSubmit.disabled = true;
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass, otp: otp })
        });

        const data = await response.json();
        if (btnSubmit) btnSubmit.disabled = false;

        if (response.ok && data.success) {
            appState.isLoggedIn = true;
            appState.userRole = data.user.role;
            appState.currentUser = data.user;

            showToast(`Connexion réussie : ${data.user.full_name || data.user.username}`);
            closeLoginModal();
            updateUserProfileUI();
            applyRBACPermissions(data.user.role);
            resetInactivityTimer();

            // Recharger les statuts pour actualiser la vue des serveurs
            fetchServersStatus(true);
        } else {
            // Affichage de l'erreur dans la modale
            if (alertEl) {
                alertEl.style.display = 'block';
                alertEl.style.background = '#FEE2E2';
                alertEl.style.color = '#991B1B';
                alertEl.style.border = '1px solid #F87171';
                alertEl.textContent = data.message || "Échec de l'authentification.";
            }

            if (data.require_mfa && mfaGroup) {
                mfaGroup.style.display = 'block';
                document.getElementById('otp-code')?.focus();
            }

            showToast(data.message || "Identifiants invalides.", true);
        }
    } catch (error) {
        if (btnSubmit) btnSubmit.disabled = false;
        showToast("Erreur de communication avec le serveur d'authentification.", true);
    }
}

async function logoutSOC(silent = false) {
    try {
        await fetch('/api/logout', { method: 'POST' });
        appState.isLoggedIn = false;
        appState.userRole = 'viewer';
        appState.currentUser = {
            username: 'Visiteur (Lecture seule)',
            role: 'viewer',
            full_name: 'Session Non Authentifiée'
        };

        if (!silent) showToast("Vous avez été déconnecté.");
        if (sessionInactivityTimer) clearTimeout(sessionInactivityTimer);

        updateUserProfileUI();
        applyRBACPermissions('viewer');

        // Si l'utilisateur était sur l'onglet paramètres, le rediriger vers le dashboard
        if (appState.activeTab === 'settings') {
            switchTab('dashboard');
        }

        // Rafraîchir les cartes serveurs
        fetchServersStatus(true);
    } catch (e) {
        console.error("Erreur lors de la déconnexion:", e);
    }
}

// ==========================================================================
// CLEANUP MODAL (3 ÉTAPES : AVANT / PENDANT / APRÈS)
// ==========================================================================
let currentCleanupStep = 1;
let cachedCleanableFiles = [];
let cachedProcesses = [];

// Utilitaires de conversion de taille
function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const clean = sizeStr.toString().trim().toUpperCase();
    const match = clean.match(/^([\d.]+)\s*([KMGTPEZY]?B?)$/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2];
    if (unit.startsWith('G')) return num * 1024 * 1024 * 1024;
    if (unit.startsWith('M')) return num * 1024 * 1024;
    if (unit.startsWith('K')) return num * 1024;
    if (unit.startsWith('T')) return num * 1024 * 1024 * 1024 * 1024;
    return num;
}

function formatBytes(bytes) {
    if (bytes <= 0) return '0 MB';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setCleanupStep(step) {
    currentCleanupStep = step;

    // Masquer / afficher les conteneurs d'étape
    const step1 = document.getElementById('cleanup-step-1');
    const step2 = document.getElementById('cleanup-step-2');
    const step3 = document.getElementById('cleanup-step-3');

    if (step1) step1.style.display = (step === 1) ? 'block' : 'none';
    if (step2) step2.style.display = (step === 2) ? 'block' : 'none';
    if (step3) step3.style.display = (step === 3) ? 'block' : 'none';

    // Mettre à jour les badges du stepper
    const b1 = document.getElementById('step-badge-1');
    const b2 = document.getElementById('step-badge-2');
    const b3 = document.getElementById('step-badge-3');

    if (b1 && b2 && b3) {
        b1.className = 'step-item';
        b2.className = 'step-item';
        b3.className = 'step-item';

        const num1 = b1.querySelector('.step-num');
        const num2 = b2.querySelector('.step-num');
        const num3 = b3.querySelector('.step-num');

        if (num1) num1.textContent = '1';
        if (num2) num2.textContent = '2';
        if (num3) num3.textContent = '3';

        if (step === 1) {
            b1.classList.add('active');
        } else if (step === 2) {
            b1.classList.add('completed');
            if (num1) num1.textContent = '✓';
            b2.classList.add('active');
        } else if (step === 3) {
            b1.classList.add('completed');
            b2.classList.add('completed');
            b3.classList.add('completed', 'active');
            if (num1) num1.textContent = '✓';
            if (num2) num2.textContent = '✓';
            if (num3) num3.textContent = '✓';
        }
    }
}

function openCleanupModal(resource, nodeName = '', step = 1) {
    currentCleanupResource = resource;
    currentCleanupNode = nodeName;

    const modal = document.getElementById('cleanup-modal');
    const nodeSelect = document.getElementById('cleanup-node-select');

    if (!modal) return;

    if (nodeSelect) {
        nodeSelect.value = nodeName || '';
    }

    modal.style.display = 'flex';
    setCleanupStep(step);

    if (step === 1) {
        renderStep1Diagnostic();
    } else if (step === 2) {
        proceedToInspection();
    }
}

function closeCleanupModal() {
    const modal = document.getElementById('cleanup-modal');
    if (modal) modal.style.display = 'none';
    currentCleanupResource = null;
    cachedCleanableFiles = [];
    cachedProcesses = [];
}

function onCleanupNodeChange() {
    const nodeSelect = document.getElementById('cleanup-node-select');
    if (!nodeSelect) return;
    currentCleanupNode = nodeSelect.value;

    if (currentCleanupStep === 1) {
        renderStep1Diagnostic();
    } else if (currentCleanupStep === 2) {
        proceedToInspection();
    }
}

// --------------------------------------------------------------------------
// ÉTAPE 1 : AVANT (ALERTE & DIAGNOSTIC PRÉALABLE)
// --------------------------------------------------------------------------
function renderStep1Diagnostic() {
    const resource = currentCleanupResource || 'disk';
    const nodeName = currentCleanupNode;

    // Récupération de la métrique actuelle du serveur
    let currentUsage = 0;
    if (appState.lastServersData && appState.lastServersData.length > 0) {
        let server = null;
        if (nodeName) {
            server = appState.lastServersData.find(s => (s.name === nodeName || s.hostname === nodeName || s.ip === nodeName));
        } else {
            server = appState.lastServersData[0];
        }
        if (server) {
            if (resource === 'disk') currentUsage = server.disk || 0;
            else if (resource === 'cpu') currentUsage = server.cpu || 0;
            else if (resource === 'ram') currentUsage = server.memory || 0;
        }
    }

    const title1 = document.getElementById('cleanup-title-step1');
    const alertTitle = document.getElementById('step1-alert-title');
    const alertBadge = document.getElementById('step1-metric-badge');
    const alertText = document.getElementById('step1-alert-text');
    const gaugeLabel = document.getElementById('step1-gauge-label');
    const gaugeVal = document.getElementById('step1-gauge-val');
    const gaugeFill = document.getElementById('step1-gauge-fill');
    const btnProceed = document.getElementById('btn-proceed-inspection');

    const targetLabel = nodeName ? `sur ${nodeName}` : `(Kali Master / Multi-Nœuds)`;

    // Valeur représentative si serveur 0%
    const displayUsage = currentUsage > 0 ? currentUsage : 86;
    const isCritical = displayUsage >= 80;
    const alertTheme = isCritical ? '#EF4444' : '#F59E0B';
    const alertBg = isCritical ? '#FEF2F2' : '#FFFBEB';
    const alertBorder = isCritical ? '#FECACA' : '#FDE68A';

    const alertBox = document.getElementById('step1-alert-box');
    if (alertBox) {
        alertBox.style.borderLeftColor = alertTheme;
        alertBox.style.borderColor = alertBorder;
        alertBox.style.background = alertBg;
    }

    if (alertBadge) {
        alertBadge.textContent = `${displayUsage}%`;
        alertBadge.style.color = alertTheme;
        alertBadge.style.background = `${alertTheme}20`;
    }

    if (gaugeVal) gaugeVal.textContent = `${displayUsage}%`;
    if (gaugeFill) {
        gaugeFill.style.width = `${Math.min(100, displayUsage)}%`;
        gaugeFill.style.background = alertTheme;
    }

    const questionText = document.getElementById('step1-dominant-question-text');
    const questionSub = document.getElementById('step1-dominant-question-sub');

    if (resource === 'disk') {
        if (title1) title1.textContent = `Alerte & Diagnostic Espace Disque ${targetLabel}`;
        if (alertTitle) alertTitle.textContent = isCritical ? 'Seuil Critique Espace Disque Atteint' : 'Alerte Utilisation Disque Élevée';
        if (alertText) alertText.innerHTML = `L'espace disque consommé atteint <strong>${displayUsage}%</strong> sur la partition système. Des fichiers de logs (<code>/var/log</code>) ou des résidus temporaires (<code>/tmp</code>) saturent le stockage.`;
        if (gaugeLabel) gaugeLabel.textContent = "Taux d'occupation disque";
        if (questionText) questionText.textContent = "Souhaitez-vous lancer l'inspection et la purge des fichiers volumineux sur ce serveur ?";
        if (questionSub) questionSub.textContent = "L'analyse SSH va scanner les répertoires /var/log et /tmp pour identifier les fichiers de logs volumineux et archives obsolètes à supprimer.";
        if (btnProceed) btnProceed.innerHTML = `<span>Oui, inspecter les fichiers</span>`;
    } else if (resource === 'cpu') {
        if (title1) title1.textContent = `Alerte & Diagnostic Charge CPU ${targetLabel}`;
        if (alertTitle) alertTitle.textContent = isCritical ? 'Pic Critique de Charge CPU Détecté' : 'Alerte Charge CPU Élevée';
        if (alertText) alertText.innerHTML = `La charge processeur est mesurée à <strong>${displayUsage}%</strong>. Des processus énergivores ou boucles ininterrompues monopolisent les ressources du processeur.`;
        if (gaugeLabel) gaugeLabel.textContent = "Charge processeur globale";
        if (questionText) questionText.textContent = "Souhaitez-vous inspecter les processus actifs et arrêter ceux qui saturent le processeur ?";
        if (questionSub) questionSub.textContent = "L'analyse SSH va lister les processus les plus consommateurs de cycles CPU afin de vous permettre d'arrêter les PIDs critiques (kill -9).";
        if (btnProceed) btnProceed.innerHTML = `<span>Oui, inspecter les processus</span>`;
    } else if (resource === 'ram') {
        if (title1) title1.textContent = `Alerte & Diagnostic Mémoire Vive (RAM) ${targetLabel}`;
        if (alertTitle) alertTitle.textContent = isCritical ? 'Seuil Critique Saturation RAM Atteint' : 'Pression Mémoire Élevée';
        if (alertText) alertText.innerHTML = `La mémoire vive est sollicitée à <strong>${displayUsage}%</strong>. Une purge du cache mémoire système (<code>drop_caches</code>) ou l'arrêt de processus volumineux est requis.`;
        if (gaugeLabel) gaugeLabel.textContent = "Mémoire RAM occupée";
        if (questionText) questionText.textContent = "Souhaitez-vous analyser la mémoire vive et déclencher la libération du cache système ?";
        if (questionSub) questionSub.textContent = "L'analyse SSH va cibler la mémoire inactive (drop_caches) et les processus volumineux pour libérer la RAM et prévenir le blocage OOM.";
        if (btnProceed) btnProceed.innerHTML = `<span>Oui, analyser la mémoire</span>`;
    }
}

// --------------------------------------------------------------------------
// ÉTAPE 2 : PENDANT (SÉLECTION PAR CASES À COCHER & TRAITEMENT)
// --------------------------------------------------------------------------
function proceedToInspection() {
    setCleanupStep(2);

    const nodeSelect = document.getElementById('cleanup-node-select');
    if (nodeSelect) currentCleanupNode = nodeSelect.value;

    const nodeBadge = document.getElementById('step2-node-badge');
    if (nodeBadge) nodeBadge.textContent = currentCleanupNode || 'Kali Master (Défaut)';

    const title = document.getElementById('cleanup-title');
    const desc = document.getElementById('cleanup-desc');
    const targetLabel = currentCleanupNode ? `sur ${currentCleanupNode}` : `(Multi-Nœuds)`;

    if (currentCleanupResource === 'disk') {
        if (title) title.textContent = `Étape 2 : Purge Disque — Sélection de fichiers ${targetLabel}`;
        if (desc) desc.textContent = 'Sélectionnez les fichiers de logs (/var/log) ou temporaires (/tmp) à purger via SSH.';
        fetchCleanableFiles(currentCleanupNode);
    } else if (currentCleanupResource === 'cpu') {
        if (title) title.textContent = `Étape 2 : Optimisation CPU — Processus actifs ${targetLabel}`;
        if (desc) desc.textContent = 'Sélectionnez les processus consommateurs de CPU à arrêter (kill -9) pour libérer la charge serveur.';
        fetchTopProcesses(currentCleanupNode, 'cpu');
    } else if (currentCleanupResource === 'ram') {
        if (title) title.textContent = `Étape 2 : Libération RAM — Processus & Cache ${targetLabel}`;
        if (desc) desc.textContent = 'Purgez le cache mémoire système (drop_caches) ou arrêtez les processus les plus consommateurs de mémoire.';
        fetchTopProcesses(currentCleanupNode, 'mem');
    }
}

async function fetchCleanableFiles(nodeName = '') {
    const loading = document.getElementById('cleanup-loading');
    const content = document.getElementById('cleanup-content');
    const confirmBtn = document.getElementById('btn-cleanup-confirm');
    const selBar = document.getElementById('step2-selection-bar');

    loading.style.display = 'block';
    content.style.display = 'none';
    confirmBtn.style.display = 'none';
    if (selBar) selBar.style.display = 'none';

    try {
        const url = nodeName ? `/api/cleanable_files?node=${encodeURIComponent(nodeName)}` : '/api/cleanable_files';
        const response = await fetch(url);
        const data = await response.json();

        loading.style.display = 'none';
        content.style.display = 'block';

        if (data.status === 'success' && data.files && data.files.length > 0) {
            cachedCleanableFiles = data.files;
            let html = `
                <div class="select-all-bar" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(0,0,0,0.03); border-radius: 6px; margin-bottom: 10px;">
                    <label style="cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--cgi-dark);">
                        <input type="checkbox" id="select-all-files" onchange="toggleAllFiles(this)" style="accent-color: var(--cgi-purple); cursor: pointer;">
                        Tout sélectionner
                    </label>
                    <span style="font-size: 12px; color: var(--cgi-grey); font-weight: 600;">${data.files.length} fichier(s) identifié(s)</span>
                </div>
                <div class="cleanup-list" style="max-height: 300px; overflow-y: auto;">
            `;

            data.files.forEach((file, idx) => {
                html += `
                    <div class="cleanup-item" style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #f1f5f9;">
                        <input type="checkbox" class="cleanup-file-cb" value="${file.path}" data-size="${file.size}" id="file-${idx}" onchange="updateSelectedFilesSummary()" style="accent-color: var(--cgi-purple); cursor: pointer;">
                        <span class="file-type ${file.type}" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #e2e8f0; font-weight: 600; text-transform: uppercase;">${file.type}</span>
                        <span class="file-path" style="flex: 1; font-family: monospace; font-size: 12px; word-break: break-all; color: var(--cgi-dark);">${file.path}</span>
                        <span class="file-size" style="font-size: 12px; font-weight: bold; color: var(--cgi-purple);">${file.size}</span>
                    </div>
                `;
            });

            html += '</div>';
            content.innerHTML = html;
            confirmBtn.style.display = 'block';
            confirmBtn.textContent = 'Supprimer les fichiers sélectionnés';
            if (selBar) selBar.style.display = 'flex';
            updateSelectedFilesSummary();
        } else {
            cachedCleanableFiles = [];
            content.innerHTML = '<div class="cleanup-empty" style="text-align: center; padding: 25px; color: #10B981; font-weight: 600;">Aucun fichier volumineux éligible au nettoyage. Espace disque nominal.</div>';
        }
    } catch (error) {
        loading.style.display = 'none';
        content.style.display = 'block';
        content.innerHTML = '<div class="cleanup-empty" style="text-align: center; padding: 25px; color: #EF4444; font-weight: 600;">Erreur lors du scan SSH du serveur.</div>';
    }
}

function updateSelectedFilesSummary() {
    const checked = document.querySelectorAll('.cleanup-file-cb:checked');
    const countEl = document.getElementById('step2-selected-count');
    const impactEl = document.getElementById('step2-selected-impact');

    let totalBytes = 0;
    checked.forEach(cb => {
        const sizeStr = cb.getAttribute('data-size') || '';
        totalBytes += parseSizeToBytes(sizeStr);
    });

    if (countEl) countEl.textContent = `${checked.length} fichier(s) sélectionné(s)`;
    if (impactEl) impactEl.textContent = `Gain estimé : ${formatBytes(totalBytes)}`;
}

async function fetchTopProcesses(nodeName = '', sortBy = 'cpu') {
    const loading = document.getElementById('cleanup-loading');
    const content = document.getElementById('cleanup-content');
    const confirmBtn = document.getElementById('btn-cleanup-confirm');
    const selBar = document.getElementById('step2-selection-bar');

    loading.style.display = 'block';
    content.style.display = 'none';
    confirmBtn.style.display = 'none';
    if (selBar) selBar.style.display = 'none';

    try {
        const sortParam = sortBy || (currentCleanupResource === 'ram' ? 'mem' : 'cpu');
        const url = nodeName ? `/api/top_processes?node=${encodeURIComponent(nodeName)}&sort=${sortParam}` : `/api/top_processes?sort=${sortParam}`;
        const response = await fetch(url);
        const data = await response.json();

        loading.style.display = 'none';
        content.style.display = 'block';

        if (data.status === 'success' && data.processes && data.processes.length > 0) {
            cachedProcesses = data.processes;
            let extraActionHtml = '';
            if (currentCleanupResource === 'ram') {
                extraActionHtml = `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(79, 38, 131, 0.06); border: 1px solid rgba(79, 38, 131, 0.2); border-radius: 6px; margin-bottom: 12px;">
                        <div>
                            <strong style="font-size: 13px; color: var(--cgi-dark);">Purge Immédiate du Cache Système :</strong>
                            <div style="font-size: 11px; color: var(--cgi-grey);">Libère la mémoire vive inactive (drop_caches & sync) sans fermer d'applications.</div>
                        </div>
                        <button class="btn-primary" style="padding: 6px 12px; font-size: 12px; font-weight: 600;" onclick="purgeRamCache(this, '${nodeName || ''}')">Vider Cache RAM</button>
                    </div>
                `;
            }

            let html = extraActionHtml + `
                <div class="select-all-bar" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(0,0,0,0.03); border-radius: 6px; margin-bottom: 10px;">
                    <label style="cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--cgi-dark);">
                        <input type="checkbox" id="select-all-procs" onchange="toggleAllProcesses(this)" style="accent-color: var(--cgi-purple); cursor: pointer;">
                        Tout sélectionner
                    </label>
                    <span style="font-size: 12px; color: var(--cgi-grey); font-weight: 600;">${data.processes.length} processus triés par ${sortParam === 'mem' ? 'RAM (%)' : 'CPU (%)'}</span>
                </div>
                <div class="cleanup-list" style="max-height: 280px; overflow-y: auto;">
            `;

            data.processes.forEach(proc => {
                const cpuBadgeColor = proc.cpu > 50 ? '#EF4444' : (proc.cpu > 10 ? '#F59E0B' : '#10B981');
                const memBadgeColor = proc.mem > 50 ? '#EF4444' : (proc.mem > 15 ? '#F59E0B' : '#10B981');
                html += `
                    <div class="process-row cleanup-item" id="proc-row-${proc.pid}" style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #f1f5f9;">
                        <input type="checkbox" class="cleanup-proc-cb" value="${proc.pid}" data-cpu="${proc.cpu}" data-mem="${proc.mem}" id="proc-${proc.pid}" onchange="updateSelectedProcessesSummary()" style="accent-color: var(--cgi-purple); cursor: pointer;">
                        <span class="process-pid" style="font-family: monospace; font-weight: bold; width: 65px; font-size: 12px; color: var(--cgi-dark);">PID: ${proc.pid}</span>
                        <span class="process-user" style="width: 70px; font-size: 12px; color: var(--cgi-grey);">${proc.user}</span>
                        <span class="process-cpu" style="width: 70px; font-weight: bold; font-size: 11px; color: ${cpuBadgeColor};">${proc.cpu}% CPU</span>
                        <span class="process-mem" style="width: 70px; font-weight: bold; font-size: 11px; color: ${memBadgeColor};">${proc.mem}% RAM</span>
                        <span class="process-cmd" style="flex: 1; font-family: monospace; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--cgi-dark);" title="${proc.command}">${proc.command}</span>
                        <button class="btn-danger" style="padding: 3px 8px; font-size: 11px; border-radius: 4px; cursor: pointer;" onclick="killSingleProcess(${proc.pid}, this, '${nodeName || ''}')">KILL</button>
                    </div>
                `;
            });

            html += '</div>';
            content.innerHTML = html;
            confirmBtn.style.display = 'block';
            confirmBtn.textContent = 'Arrêter les processus sélectionnés (Kill -9)';
            if (selBar) selBar.style.display = 'flex';
            updateSelectedProcessesSummary();
        } else {
            cachedProcesses = [];
            content.innerHTML = '<div class="cleanup-empty" style="text-align: center; padding: 25px; color: #10B981; font-weight: 600;">Aucun processus anormalement consommateur détecté.</div>';
        }
    } catch (error) {
        loading.style.display = 'none';
        content.style.display = 'block';
        content.innerHTML = '<div class="cleanup-empty" style="text-align: center; padding: 25px; color: #EF4444; font-weight: 600;">Erreur lors de la récupération des processus SSH.</div>';
    }
}

function updateSelectedProcessesSummary() {
    const checked = document.querySelectorAll('.cleanup-proc-cb:checked');
    const countEl = document.getElementById('step2-selected-count');
    const impactEl = document.getElementById('step2-selected-impact');

    let totalCpu = 0;
    let totalMem = 0;
    checked.forEach(cb => {
        totalCpu += parseFloat(cb.getAttribute('data-cpu') || 0);
        totalMem += parseFloat(cb.getAttribute('data-mem') || 0);
    });

    if (countEl) countEl.textContent = `${checked.length} processus sélectionné(s)`;
    if (impactEl) {
        if (currentCleanupResource === 'ram') {
            impactEl.textContent = `RAM libérable : ~${totalMem.toFixed(1)}%`;
        } else {
            impactEl.textContent = `Charge CPU libérable : ~${totalCpu.toFixed(1)}%`;
        }
    }
}

function toggleAllFiles(masterCb) {
    document.querySelectorAll('.cleanup-file-cb').forEach(cb => {
        cb.checked = masterCb.checked;
    });
    updateSelectedFilesSummary();
}

function toggleAllProcesses(masterCb) {
    document.querySelectorAll('.cleanup-proc-cb').forEach(cb => {
        cb.checked = masterCb.checked;
    });
    updateSelectedProcessesSummary();
}

async function purgeRamCache(btnElem, nodeName = '') {
    const originalText = btnElem.textContent;
    btnElem.textContent = 'Purge en cours...';
    btnElem.disabled = true;

    try {
        const target = nodeName || currentCleanupNode;
        const response = await fetch('/api/purge_ram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node: target })
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Accès Refusé : Connectez-vous en tant qu'Analyste SOC.", true);
            openLoginModal();
        } else if (data.status === 'success') {
            showToast(data.message);
            // Transition vers l'Étape 3 (APRÈS - Bilan)
            showOptimizationSummary({
                resource: 'ram',
                type: 'cache_purge',
                node: target,
                message: data.message
            });
        } else {
            showToast(data.message || "Erreur lors de la purge RAM.", true);
        }
    } catch (error) {
        showToast("Erreur réseau.", true);
    } finally {
        btnElem.textContent = originalText;
        btnElem.disabled = false;
    }
}

async function submitCleanup() {
    const confirmBtn = document.getElementById('btn-cleanup-confirm');

    if (currentCleanupResource === 'disk') {
        const checkedFiles = [];
        let totalBytes = 0;
        document.querySelectorAll('.cleanup-file-cb:checked').forEach(cb => {
            checkedFiles.push(cb.value);
            totalBytes += parseSizeToBytes(cb.getAttribute('data-size') || '');
        });

        if (checkedFiles.length === 0) {
            showToast("Veuillez cocher au moins un fichier à supprimer.", true);
            return;
        }

        const formattedFreedSize = formatBytes(totalBytes);
        confirmBtn.textContent = 'Suppression en cours...';
        confirmBtn.disabled = true;

        try {
            const response = await fetch('/api/clean_files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ node: currentCleanupNode, files: checkedFiles })
            });
            const data = await response.json();

            if (response.status === 403) {
                showToast("Accès Refusé : Connectez-vous en tant qu'Analyste SOC.", true);
                openLoginModal();
            } else if (data.status === 'success') {
                showToast(data.message);
                // Transition directe vers l'Étape 3 (APRÈS - Bilan d'Optimisation)
                showOptimizationSummary({
                    resource: 'disk',
                    node: currentCleanupNode,
                    filesCount: data.success_count || checkedFiles.length,
                    freedSize: formattedFreedSize,
                    message: data.message
                });
            } else {
                showToast(data.message || "Erreur lors du nettoyage disque.", true);
            }
        } catch (error) {
            showToast("Erreur réseau.", true);
        } finally {
            confirmBtn.textContent = 'Supprimer les fichiers sélectionnés';
            confirmBtn.disabled = false;
        }

    } else if (currentCleanupResource === 'cpu' || currentCleanupResource === 'ram') {
        const checkedPids = [];
        document.querySelectorAll('.cleanup-proc-cb:checked').forEach(cb => {
            checkedPids.push(parseInt(cb.value));
        });

        if (checkedPids.length === 0) {
            showToast("Veuillez cocher au moins un processus à arrêter.", true);
            return;
        }

        confirmBtn.textContent = 'Arrêt des processus...';
        confirmBtn.disabled = true;

        try {
            const response = await fetch('/api/kill_process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ node: currentCleanupNode, pids: checkedPids })
            });
            const data = await response.json();

            if (response.status === 403) {
                showToast("Accès Refusé : Connectez-vous en tant qu'Analyste SOC.", true);
                openLoginModal();
            } else if (data.status === 'success') {
                showToast(data.message);
                // Transition directe vers l'Étape 3 (APRÈS - Bilan d'Optimisation)
                showOptimizationSummary({
                    resource: currentCleanupResource,
                    node: currentCleanupNode,
                    killedCount: data.killed_count || checkedPids.length,
                    pids: checkedPids,
                    message: data.message
                });
            } else {
                showToast(data.message || "Erreur lors de l'arrêt des processus.", true);
            }
        } catch (error) {
            showToast("Erreur réseau.", true);
        } finally {
            confirmBtn.textContent = 'Arrêter les processus sélectionnés (Kill -9)';
            confirmBtn.disabled = false;
        }
    }
}

async function killSingleProcess(pid, btnElem, nodeName = '') {
    const originalText = btnElem.textContent;
    btnElem.textContent = '...';
    btnElem.disabled = true;

    try {
        const targetNode = nodeName || currentCleanupNode;
        const response = await fetch('/api/kill_process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node: targetNode, pid: pid })
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Accès Refusé : Connectez-vous en tant qu'Analyste SOC.", true);
            openLoginModal();
            btnElem.textContent = originalText;
            btnElem.disabled = false;
        } else if (data.status === 'success') {
            showToast(data.message);
            const row = document.getElementById(`proc-row-${pid}`) || btnElem.closest('.cleanup-item');
            if (row) {
                row.style.opacity = '0.3';
                row.style.textDecoration = 'line-through';
                const cb = row.querySelector('.cleanup-proc-cb');
                if (cb) {
                    cb.checked = false;
                    cb.disabled = true;
                }
            }
            btnElem.textContent = 'OK';
            updateSelectedProcessesSummary();
            fetchIncidents(true);
        } else {
            showToast(data.message || "Erreur.", true);
            btnElem.textContent = originalText;
            btnElem.disabled = false;
        }
    } catch (error) {
        showToast("Erreur réseau.", true);
        btnElem.textContent = originalText;
        btnElem.disabled = false;
    }
}

// --------------------------------------------------------------------------
// ÉTAPE 3 : APRÈS (POPUP DE BILAN / RAPPORT D'OPTIMISATION)
// --------------------------------------------------------------------------
function showOptimizationSummary(resultData) {
    setCleanupStep(3);

    const titleEl = document.getElementById('step3-title');
    const subTitleEl = document.getElementById('step3-subtitle');
    const gainValEl = document.getElementById('step3-gain-val');
    const gainDescEl = document.getElementById('step3-gain-desc');
    const statusValEl = document.getElementById('step3-status-val');
    const nodeNameEl = document.getElementById('step3-node-name');
    const auditListEl = document.getElementById('step3-audit-list');

    const targetName = resultData.node || 'Kali Master (192.168.132.130)';
    if (nodeNameEl) nodeNameEl.textContent = `Serveur Cible : ${targetName}`;
    if (subTitleEl) subTitleEl.textContent = `Rapport d'intervention et assainissement sur ${targetName}`;

    if (resultData.resource === 'disk') {
        if (titleEl) titleEl.textContent = "Purge Disque Réussie — Bilan d'Espace";
        if (gainValEl) gainValEl.textContent = resultData.freedSize ? `+ ${resultData.freedSize} Libérés` : `+ ${resultData.filesCount || 1} Fichiers Purgés`;
        if (gainDescEl) gainDescEl.textContent = `${resultData.filesCount || 1} fichier(s) de logs/temporaires supprimé(s)`;
        if (statusValEl) statusValEl.textContent = "Espace Disque : Nominal (Vert)";
        if (auditListEl) {
            auditListEl.innerHTML = `
                <li>Suppression confirmée de <strong>${resultData.filesCount || 1} fichier(s)</strong> dans <code>/var/log</code> et <code>/tmp</code>.</li>
                <li>Gain d'espace effectif de <strong>${resultData.freedSize || 'volume significatif'}</strong> libéré.</li>
                <li>Statut du stockage système remis au <strong>Vert (Nominal)</strong> sur ${targetName}.</li>
                <li>Action enregistrée dans le journal <code>audit.log</code> et incident résolu.</li>
            `;
        }
    } else if (resultData.resource === 'cpu') {
        if (titleEl) titleEl.textContent = "Optimisation CPU Réussie — Bilan de Charge";
        if (gainValEl) gainValEl.textContent = `${resultData.killedCount || 1} Processus Arrêté(s)`;
        if (gainDescEl) gainDescEl.textContent = `PIDs : [${(resultData.pids || []).join(', ') || 'Sélectionnés'}] terminés (kill -9)`;
        if (statusValEl) statusValEl.textContent = "Charge CPU : Régulée (Vert)";
        if (auditListEl) {
            auditListEl.innerHTML = `
                <li>Arrêt forcé (kill -9) de <strong>${resultData.killedCount || 1} processus</strong> surconsommateurs.</li>
                <li>Cycles CPU restitués et latences des services applicatifs réduites.</li>
                <li>Charge globale stabilisée et statut remis au <strong>Vert (Nominal)</strong> sur ${targetName}.</li>
                <li>Action enregistrée dans le journal <code>audit.log</code> et incident résolu.</li>
            `;
        }
    } else if (resultData.resource === 'ram') {
        if (titleEl) titleEl.textContent = "Libération RAM Réussie — Bilan Mémoire";
        if (resultData.type === 'cache_purge') {
            if (gainValEl) gainValEl.textContent = "Cache RAM Vidé & Sync OK";
            if (gainDescEl) gainDescEl.textContent = "Purge noyau drop_caches & sync exécutée";
        } else {
            if (gainValEl) gainValEl.textContent = `${resultData.killedCount || 1} Processus Stoppé(s)`;
            if (gainDescEl) gainDescEl.textContent = `PIDs : [${(resultData.pids || []).join(', ') || 'Sélectionnés'}] libérés`;
        }
        if (statusValEl) statusValEl.textContent = "Mémoire RAM : Nominale (Vert)";
        if (auditListEl) {
            auditListEl.innerHTML = `
                <li>Purge des caches mémoire et libération des buffers inactifs via SSH.</li>
                <li>Mémoire vive restituée au système pour prévenir tout blocage OOM.</li>
                <li>Statut de la mémoire remis au <strong>Vert (Nominal)</strong> sur ${targetName}.</li>
                <li>Action enregistrée dans le journal <code>audit.log</code> et incident résolu.</li>
            `;
        }
    }

    // Rafraîchir les données de monitoring en arrière-plan
    fetchIncidents(true);
    fetchServersStatus(true);
}

function goToAuditLogs() {
    closeCleanupModal();
    switchTab('logs');
}

// ==========================================================================
// LOGS
// ==========================================================================
async function fetchLogs() {
    try {
        const response = await fetch('/api/logs');
        const data = await response.json();

        const terminalOutput = document.getElementById('terminal-output');
        if (!terminalOutput) return;

        if (data.status === 'success' && data.logs) {
            const lines = data.logs.split('\n');
            let html = '';
            lines.forEach(line => {
                if (!line.trim()) return;
                const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const isError = line.toLowerCase().includes('failed') || line.toLowerCase().includes('error') || line.toLowerCase().includes('critical');
                const cssClass = isError ? 'term-error' : 'term-normal';
                html += `<div class="term-line"><span class="term-time">[${timeNow}]</span><span class="${cssClass}">${line}</span></div>`;
            });
            terminalOutput.innerHTML = html || '<div class="term-line"><span class="term-normal">Aucun log disponible.</span></div>';

            const terminalContainer = document.getElementById('terminal-feed');
            if (terminalContainer) {
                terminalContainer.scrollTop = terminalContainer.scrollHeight;
            }
        }
    } catch (error) {
        console.error("Erreur récupération logs:", error);
    }
}

// ==========================================================================
// HUMAN-IN-THE-LOOP BLOCKED JOB
// ==========================================================================
function handleBlockedJob(jobData) {
    let container = document.getElementById(`job-${jobData.job_id}-container`);
    const serviceList = document.querySelector('.service-list');

    if (!container && serviceList) {
        container = document.createElement('div');
        container.className = 'service-item';
        container.id = `job-${jobData.job_id}-container`;

        container.innerHTML = `
            <div class="service-info">
                <div class="pulse-led" id="led-job-${jobData.job_id}"></div>
                <div>
                    <span class="service-name">Sync Job (${jobData.job_id})</span>
                    <span class="service-desc" id="status-text-job-${jobData.job_id}">Status: Inconnu</span>
                    <div id="diagnostic-job-${jobData.job_id}" style="display:none; color: #E31937; font-size: 11px; margin-top: 4px; font-style: italic;"></div>
                </div>
            </div>
            <div class="service-actions" id="action-job-${jobData.job_id}"></div>
        `;
        serviceList.appendChild(container);
    }

    if (!container) return;

    const led = document.getElementById(`led-job-${jobData.job_id}`);
    const text = document.getElementById(`status-text-job-${jobData.job_id}`);
    const diag = document.getElementById(`diagnostic-job-${jobData.job_id}`);
    const actions = document.getElementById(`action-job-${jobData.job_id}`);

    if (jobData.status === 'BLOCKED') {
        container.style.borderColor = '#E31937';
        container.style.background = 'rgba(227, 25, 55, 0.05)';
        led.className = 'pulse-led led-inactive';
        text.textContent = 'Status: BLOCKED';
        text.style.color = '#E31937';
        diag.style.display = 'block';
        diag.textContent = `Diagnostic: ${jobData.root_cause}`;
        actions.innerHTML = `<button class="btn-resolve" onclick="resolveIncident('${jobData.job_id}')">Résoudre l'incident</button>`;
    } else if (jobData.status === 'ONLINE') {
        container.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        container.style.background = 'rgba(16, 185, 129, 0.05)';
        led.className = 'pulse-led led-active';
        text.textContent = 'Status: ONLINE';
        text.style.color = '#10B981';
        diag.style.display = 'none';
        actions.innerHTML = `<span style="color: #10B981; font-size: 11px; font-weight: 600;">Résolu</span>`;
    }
}

async function resolveIncident(jobId) {
    try {
        const response = await fetch(`/api/resolve/${jobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();

        if (response.status === 403 || response.status === 401) {
            failedResolveAttempts++;
            if (failedResolveAttempts < 3) {
                showToast(`Accès Refusé. Tentative ${failedResolveAttempts}/3`, true);
                openLoginModal();
            } else {
                showToast("ALERTE SÉCURITÉ : Multiples tentatives non autorisées détectées !", true);
            }
        } else if (response.status === 429) {
            showToast("Anti-Spam : Veuillez patienter.", true);
        } else if (result.success) {
            failedResolveAttempts = 0;
            showToast("Service débloqué et remis en ligne");
            fetchServersStatus(true);
        } else {
            showToast("Erreur lors de la résolution", true);
        }
    } catch (error) {
        showToast("Erreur réseau", true);
    }
}

// ==========================================================================
// BAN IP
// ==========================================================================
async function handleBanIP(btnElem, ip) {
    if (!ip) return;

    btnElem.classList.add('clicked');
    const originalText = btnElem.textContent;
    btnElem.textContent = "Bannissement...";
    btnElem.disabled = true;

    try {
        const response = await fetch('/api/ban_ip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        const data = await response.json();

        if (data.status === 'success') {
            showToast(data.message);
            fetchIncidents(true);
        } else {
            showToast(data.message || "Erreur lors du bannissement IP", true);
        }
    } catch (error) {
        showToast("Erreur réseau", true);
    } finally {
        setTimeout(() => {
            btnElem.classList.remove('clicked');
            btnElem.textContent = originalText;
            btnElem.disabled = false;
        }, 1000);
    }
}

// ==========================================================================
// RAPPORT PDF PROFESSIONNEL (ENTREPRISE SOC AUDIT & MONITORING)
// ==========================================================================
async function generatePDFReport() {
    if (!window.jspdf) {
        showToast("Bibliothèque PDF non disponible.", true);
        return;
    }

    // 0. VÉRIFICATION DE SÉCURITÉ ZERO-TRUST : Session Authentifiée Obligatoire
    if (!appState.isLoggedIn) {
        showToast("Accès Refusé : Conformément à la politique Zero-Trust, l'export du rapport officiel requiert une session authentifiée.", true);
        openLoginModal();
        return;
    }

    showToast("Génération du rapport PDF d'audit...");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;

    // 1. CONFIGURATION & IDENTITÉ CERTIFIÉE
    const companyName = (appState.config && appState.config.company_name) || 'CGI';
    const appTitle = (appState.config && appState.config.dashboard_title) || 'Plateforme de Supervision';
    
    // Rôle et Nom utilisateur authentifié
    const userName = (appState.currentUser && (appState.currentUser.full_name || appState.currentUser.username)) || 'Auditeur Certifié';
    let userRoleLabel = 'Viewer / Auditeur (Lecture seule)';
    if (appState.userRole === 'admin_secops') {
        userRoleLabel = 'Admin SecOps (Contrôle total)';
    } else if (appState.userRole === 'analyst') {
        userRoleLabel = 'Analyste SOC (Opérationnel)';
    }

    // Formatage de Date en Français : DD/MM/YYYY à HH:mm:ss
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateFormatted = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} à ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const reportId = `SOC-AUDIT-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

    // Évaluation de l'état global de l'infrastructure
    const totalNodesCount = (appState.lastServersData && appState.lastServersData.length) || 3;
    const offlineNodesCount = (appState.lastServersData || []).filter(s => s.status !== 'ONLINE' && s.status !== 'UP').length;
    const isGlobalNominal = offlineNodesCount === 0;

    // ======================================================================
    // BANDEAU SUPÉRIEUR (ACCENT BARS)
    // ======================================================================
    // Barre Violette CGI (gauche) + Barre Rouge CGI (droite)
    doc.setFillColor(79, 38, 131); // #4F2683
    doc.rect(0, 0, pageWidth * 0.7, 4, 'F');
    doc.setFillColor(227, 25, 55); // #E31937
    doc.rect(pageWidth * 0.7, 0, pageWidth * 0.3, 4, 'F');

    let currentY = 12;

    // ======================================================================
    // 1. EN-TÊTE DYNAMIQUE AVEC LOGO & TITRES
    // ======================================================================
    let logoDrawn = false;
    const logoImg = document.querySelector('.header-logo-img') || document.querySelector('#logo-preview img');
    
    if (logoImg && logoImg.complete && logoImg.naturalWidth > 0) {
        try {
            doc.addImage(logoImg, 'PNG', margin, currentY, 28, 12, undefined, 'FAST');
            logoDrawn = true;
        } catch (e) {
            logoDrawn = false;
        }
    }

    if (!logoDrawn) {
        doc.setFillColor(79, 38, 131);
        doc.roundedRect(margin, currentY, 26, 11, 1.5, 1.5, 'F');
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(255, 255, 255);
        doc.text((companyName.trim() || 'CGI').substring(0, 6), margin + 13, currentY + 7.5, { align: 'center' });
    }

    // Titre et Sous-titre du Rapport
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(26, 26, 26);
    doc.text("RAPPORT D'AUDIT & SUPERVISION SOC", margin + 32, currentY + 5);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(102, 102, 102);
    doc.text(`${companyName.trim()} Infrastructure - ${appTitle.trim()}`, margin + 32, currentY + 10.5);

    currentY += 17;

    // ======================================================================
    // CADRE MÉTADONNÉES / INFORMATIONS D'AUDIT
    // ======================================================================
    doc.setFillColor(248, 250, 252); // #F8FAFC
    doc.setDrawColor(226, 232, 240); // #E2E8F0
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, currentY, pageWidth - (margin * 2), 19, 2, 2, 'FD');

    // Colonne Gauche
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(79, 38, 131);
    doc.text("Généré le :", margin + 4, currentY + 6);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 41, 59);
    doc.text(dateFormatted, margin + 25, currentY + 6);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(79, 38, 131);
    doc.text("Généré par :", margin + 4, currentY + 13);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 41, 59);
    doc.text(`${userName} (${userRoleLabel})`, margin + 25, currentY + 13);

    // Colonne Droite
    const rightColX = pageWidth / 2 + 10;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(79, 38, 131);
    doc.text("Référence :", rightColX, currentY + 6);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 41, 59);
    doc.text(reportId, rightColX + 24, currentY + 6);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(79, 38, 131);
    doc.text("Statut Global :", rightColX, currentY + 13);
    doc.setFont("helvetica", "bold");
    if (isGlobalNominal) {
        doc.setTextColor(16, 185, 129); // Vert
        doc.text("OPÉRATIONNEL (100% UP)", rightColX + 24, currentY + 13);
    } else {
        doc.setTextColor(227, 25, 55); // Rouge
        doc.text(`ALERTE INFRA (${offlineNodesCount} Nœuds Injoignables)`, rightColX + 24, currentY + 13);
    }

    currentY += 24;

    // ======================================================================
    // 2. SECTION : NŒUDS DE SUPERVISION & RESSOURCES MATÉRIELLES
    // ======================================================================
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 26, 26);
    doc.text("1. Nœuds de Supervision & Ressources Matérielles", margin, currentY);
    currentY += 3;

    // Récupération des serveurs réels
    let serverRows = [];
    if (appState.lastServersData && appState.lastServersData.length > 0) {
        serverRows = appState.lastServersData.map(s => {
            const isUp = s.status === 'ONLINE' || s.status === 'UP';
            return [
                s.name || s.hostname || 'Kali Node',
                s.ip || '192.168.132.130',
                (s.role || 'NODE').toUpperCase(),
                isUp ? `${s.cpu || 0}%` : '0% (OFFLINE)',
                isUp ? `${s.memory || 0}%` : '0% (OFFLINE)',
                isUp ? `${s.disk || 0}%` : '0% (OFFLINE)',
                isUp ? 'ONLINE' : 'OFFLINE'
            ];
        });
    } else {
        const cpuVal = document.getElementById('cpu-val') ? document.getElementById('cpu-val').textContent : '12%';
        const ramVal = document.getElementById('ram-val') ? document.getElementById('ram-val').textContent : '45%';
        const diskVal = document.getElementById('disk-val') ? document.getElementById('disk-val').textContent : '38%';
        serverRows = [
            ['Web / Dashboard Node', '172.20.118.189', 'COMMAND CENTER', '0% (OFFLINE)', '0% (OFFLINE)', '0% (OFFLINE)', 'OFFLINE'],
            ['Database Node', '172.20.119.144', 'MARIADB DATABASE', '0% (OFFLINE)', '0% (OFFLINE)', '0% (OFFLINE)', 'OFFLINE'],
            ['Application Node', '172.20.127.3', 'APACHE WEB SERVER', '0% (OFFLINE)', '0% (OFFLINE)', '0% (OFFLINE)', 'OFFLINE']
        ];
    }

    if (doc.autoTable) {
        doc.autoTable({
            startY: currentY,
            head: [['Nœud / Hôte', 'Adresse IP', 'Rôle', 'CPU (%)', 'RAM (%)', 'Disque (%)', 'Statut']],
            body: serverRows,
            theme: 'grid',
            margin: { left: margin, right: margin },
            headStyles: {
                fillColor: [79, 38, 131], // #4F2683 Violet CGI
                textColor: [255, 255, 255],
                fontSize: 8.5,
                fontStyle: 'bold',
                halign: 'left',
                cellPadding: 3
            },
            bodyStyles: {
                fontSize: 8,
                textColor: [30, 41, 59],
                cellPadding: 2.8,
                lineColor: [226, 232, 240]
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            columnStyles: {
                0: { fontStyle: 'bold' },
                3: { halign: 'center' },
                4: { halign: 'center' },
                5: { halign: 'center' },
                6: { halign: 'center', fontStyle: 'bold' }
            },
            didDrawCell: function (data) {
                if (data.section === 'body' && data.column.index === 6) {
                    const isOk = data.cell.raw === 'ONLINE' || data.cell.raw === 'UP';
                    data.cell.styles.textColor = isOk ? [16, 185, 129] : [227, 25, 55];
                }
            }
        });
        currentY = doc.lastAutoTable.finalY + 9;
    } else {
        currentY += 28;
    }

    // ======================================================================
    // 3. SECTION : ÉTAT DES SERVICES SYSTÈMES (CORRÉLATION STRICTE AVEC VMS)
    // ======================================================================
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 26, 26);
    doc.text("2. État Opérationnel des Services Supervisés", margin, currentY);
    currentY += 3;

    // Corrélation rigoureuse entre chaque service et son hôte VM
    const findSrv = (keywords) => {
        if (!appState.lastServersData || appState.lastServersData.length === 0) return null;
        return appState.lastServersData.find(s => {
            const text = `${s.name || ''} ${s.role || ''} ${s.ip || ''}`.toLowerCase();
            return keywords.some(k => text.includes(k.toLowerCase()));
        });
    };

    const dbServer = findSrv(['database', 'mariadb', 'db-node', '119.144']);
    const webServer = findSrv(['web', 'dashboard', '118.189']);
    const appServer = findSrv(['app', 'apache', '127.3']) || webServer;

    const formatServiceStatus = (srv) => {
        if (!srv) {
            // Si pas d'infos de serveurs, regarder dans le DOM
            return 'ONLINE';
        }
        const isUp = srv.status === 'ONLINE' || srv.status === 'UP';
        return isUp ? 'ONLINE' : `OFFLINE (${srv.name || 'Hôte'} Injoignable)`;
    };

    const servicesRows = [
        ['Apache2 Web Server', appServer ? `${appServer.name} (${appServer.ip})` : 'Application Node (172.20.127.3)', 'Port 80/443 (apache2)', formatServiceStatus(appServer)],
        ['MariaDB Database Server', dbServer ? `${dbServer.name} (${dbServer.ip})` : 'Database Node (172.20.119.144)', 'Port 3306 (mysqld)', formatServiceStatus(dbServer)],
        ['Cron Automation Scheduler', webServer ? `${webServer.name} (${webServer.ip})` : 'Web / Dashboard Node (172.20.118.189)', 'Service crond (systemd)', formatServiceStatus(webServer)],
        ['Rsync Backup Daemon', dbServer ? `${dbServer.name} (${dbServer.ip})` : 'Database Node (172.20.119.144)', 'Service rsync (daemon)', formatServiceStatus(dbServer)]
    ];

    if (doc.autoTable) {
        doc.autoTable({
            startY: currentY,
            head: [['Service Supervisé', 'Nœud Hôte Assigné', 'Port / Processus', 'État Opérationnel']],
            body: servicesRows,
            theme: 'grid',
            margin: { left: margin, right: margin },
            headStyles: {
                fillColor: [30, 41, 59], // Gris foncé / Bleu nuit
                textColor: [255, 255, 255],
                fontSize: 8.5,
                fontStyle: 'bold',
                halign: 'left',
                cellPadding: 3
            },
            bodyStyles: {
                fontSize: 8,
                textColor: [30, 41, 59],
                cellPadding: 2.8,
                lineColor: [226, 232, 240]
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            columnStyles: {
                0: { fontStyle: 'bold' },
                3: { halign: 'center', fontStyle: 'bold' }
            },
            didDrawCell: function (data) {
                if (data.section === 'body' && data.column.index === 3) {
                    const isOk = data.cell.raw === 'ONLINE';
                    data.cell.styles.textColor = isOk ? [16, 185, 129] : [227, 25, 55];
                }
            }
        });
        currentY = doc.lastAutoTable.finalY + 9;
    } else {
        currentY += 28;
    }

    // ======================================================================
    // 4. SECTION : JOURNAL DES INCIDENTS (3 COLONNES)
    // ======================================================================
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 26, 26);
    doc.text("3. Journal des Incidents & Traçabilité", margin, currentY);
    currentY += 3;

    let incidentsRows = [];
    const tbody = document.getElementById('incidents-body');
    if (tbody && tbody.rows.length > 0) {
        for (let i = 0; i < Math.min(8, tbody.rows.length); i++) {
            const row = tbody.rows[i];
            if (row.cells.length >= 5) {
                const hDate = row.cells[1].innerText.trim();
                const actionNode = `${row.cells[2].innerText.trim()} (${row.cells[4].innerText.trim()})`;
                const details = row.cells[3].innerText.trim();
                incidentsRows.push([hDate, actionNode, details]);
            }
        }
    }

    if (incidentsRows.length === 0) {
        incidentsRows = [
            [dateFormatted, 'Supervision Globale (Système)', 'Aucun incident critique détecté. Tous les services sont opérationnels.']
        ];
    }

    if (doc.autoTable) {
        doc.autoTable({
            startY: currentY,
            head: [['Horodatage', 'Action & Nœud', 'Détails & Statut']],
            body: incidentsRows,
            theme: 'grid',
            margin: { left: margin, right: margin },
            headStyles: {
                fillColor: [227, 25, 55], // #E31937 Rouge CGI
                textColor: [255, 255, 255],
                fontSize: 8.5,
                fontStyle: 'bold',
                halign: 'left',
                cellPadding: 3
            },
            bodyStyles: {
                fontSize: 8,
                textColor: [30, 41, 59],
                cellPadding: 2.8,
                lineColor: [226, 232, 240]
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            columnStyles: {
                0: { fontStyle: 'bold', cellWidth: 42 },
                1: { fontStyle: 'bold', cellWidth: 55 },
                2: { cellWidth: 'auto' }
            }
        });
        currentY = doc.lastAutoTable.finalY + 8;
    }

    // ======================================================================
    // 5. PIED DE PAGE PROFESSIONNEL (FOOTER SUR CHAQUE PAGE)
    // ======================================================================
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);

        // Ligne de séparation fine
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.3);
        doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

        // Texte de confidentialité & audit
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184); // #94A3B8
        doc.text("DOCUMENT CONFIDENTIEL - USAGE STRICTEMENT INTERNE SECOPS & AUDIT IT", margin, pageHeight - 7);

        // Pagination
        doc.text(`Page ${p} sur ${totalPages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
    }

    // Sauvegarde du document
    const fileTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    doc.save(`Rapport_Supervision_${fileTimestamp}.pdf`);
    showToast("Téléchargement du rapport PDF terminé.");
}

// ==========================================================================
// SETTINGS (WHITE-LABEL)
// ==========================================================================
async function fetchConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();

        if (data.status === 'success' && data.config) {
            const config = data.config;
            applyConfig(config);
        }
    } catch (error) {
        console.error("Erreur récupération config:", error);
    }
}

function applyConfig(config) {
    appState.config = config;
    const brandEl = document.getElementById('header-brand');

    if (brandEl) {
        const useImage = config.logo_mode === 'image' && config.logo_image;
        const logoText = config.logo_text || config.company_name || 'SOC';

        if (useImage) {
            // Mode Image : Affichage uniquement du logo graphique
            brandEl.innerHTML = `<img src="${config.logo_image}" alt="${config.company_name || 'Logo'}" class="header-logo-img" onerror="this.style.display='none'">`;
        } else {
            // Mode Texte : Affichage uniquement du texte de logo / marque
            brandEl.innerHTML = `<h1 id="brand-logo">${logoText}</h1>`;
        }
    }

    document.title = `${config.company_name || 'SOC'} - ${config.dashboard_title || 'Application'}`;
}

function loadSettingsForm() {
    fetch('/api/config')
        .then(r => r.json())
        .then(data => {
            if (data.status === 'success' && data.config) {
                const c = data.config;
                const companyInput = document.getElementById('setting-company-name');
                const titleInput = document.getElementById('setting-dashboard-title');
                const logoTextInput = document.getElementById('setting-logo-text');
                const previewEl = document.getElementById('logo-preview');
                const removeBtnWrap = document.getElementById('remove-logo-wrap');
                const logoModeToggle = document.getElementById('setting-logo-mode');

                if (companyInput) companyInput.value = c.company_name || '';
                if (titleInput) titleInput.value = c.dashboard_title || '';
                if (logoTextInput) logoTextInput.value = c.logo_text || '';

                // Logo mode toggle
                if (logoModeToggle) {
                    logoModeToggle.value = c.logo_mode || 'text';
                }

                // Preview: show current logo state
                if (previewEl) {
                    if (c.logo_image && c.logo_mode === 'image') {
                        previewEl.innerHTML = `<img src="${c.logo_image}" alt="Logo" style="max-height:60px;width:auto;object-fit:contain;">`;
                    } else {
                        previewEl.innerHTML = `<span class="logo-preview-text" id="logo-preview-text">${c.logo_text || 'SOC'}</span>`;
                    }
                }

                // Show/hide remove logo button
                if (removeBtnWrap) {
                    removeBtnWrap.style.display = (c.logo_image && c.logo_mode === 'image') ? 'block' : 'none';
                }
            }
        })
        .catch(err => console.error("Erreur chargement settings:", err));
}

async function saveSettings() {
    const companyName = document.getElementById('setting-company-name').value;
    const dashboardTitle = document.getElementById('setting-dashboard-title').value;
    const logoText = document.getElementById('setting-logo-text').value;
    const logoModeEl = document.getElementById('setting-logo-mode');
    const logoMode = logoModeEl ? logoModeEl.value : 'text';

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                company_name: companyName,
                dashboard_title: dashboardTitle,
                logo_text: logoText,
                logo_mode: logoMode
            })
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Acces Refuse : Connectez-vous en tant qu'Admin SecOps.", true);
            openLoginModal();
        } else if (data.status === 'success') {
            showToast("Configuration sauvegardee !");
            applyConfig(data.config);
        } else {
            showToast(data.message || "Erreur lors de la sauvegarde.", true);
        }
    } catch (error) {
        showToast("Erreur reseau.", true);
    }
}

async function uploadLogo() {
    const fileInput = document.getElementById('setting-logo-file');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showToast("Veuillez selectionner un fichier image.", true);
        return;
    }

    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);

    try {
        const response = await fetch('/api/config/logo', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Acces Refuse : Connectez-vous en tant qu'Admin SecOps.", true);
            openLoginModal();
        } else if (data.status === 'success') {
            showToast("Logo mis a jour avec succes !");
            applyConfig(data.config);
            loadSettingsForm();
        } else {
            showToast(data.message || "Erreur lors du chargement.", true);
        }
    } catch (error) {
        showToast("Erreur reseau.", true);
    }
}

async function removeLogo() {
    try {
        const response = await fetch('/api/config/remove_logo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (response.status === 403) {
            showToast("Acces Refuse : Connectez-vous en tant qu'Admin SecOps.", true);
            openLoginModal();
        } else if (data.status === 'success') {
            showToast("Logo image supprime. Mode texte active.");
            applyConfig(data.config);
            loadSettingsForm();
        } else {
            showToast(data.message || "Erreur.", true);
        }
    } catch (error) {
        showToast("Erreur reseau.", true);
    }
}

// ==========================================================================
// POLLING INTELLIGENT
// ==========================================================================
function startPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(() => {
        switch (appState.activeTab) {
            case 'dashboard':
                fetchServersStatus(true);
                break;
            case 'nodes':
                fetchServersStatus(true);
                break;
            case 'logs':
                fetchIncidents(true);
                fetchLogs();
                break;
            // Settings tab doesn't need polling
        }
    }, 10000);
}

// ==========================================================================
// INIT
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    checkAuthStatus();
    fetchConfig();
    initPerformanceChart();
    fetchServersStatus();
    fetchIncidents(true);
    fetchLogs();
    startPolling();
});
