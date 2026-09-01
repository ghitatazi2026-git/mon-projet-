import sys

with open('static/js/main.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace fetchMetrics with fetchServersStatus
fetch_metrics_str = """async function fetchMetrics() {
    try {
        setSpinner(true);
        const response = await fetch('/api/status');
        const data = await response.json();

        // Service Updates
        updateServiceState('apache2', data.services.apache2);
        updateServiceState('mariadb', data.services.mariadb);
        updateServiceState('cron', data.services.cron);
        updateServiceState('sauvegarde', data.services.sauvegarde);

        // Hardware Gauges
        updateGauge('cpu', data.cpu || 0);
        updateGauge('mem', data.memory || 0);
        updateGauge('disk', data.disk || 0);
        
        // Human-in-the-Loop Job
        if (data.blocked_job) {
            handleBlockedJob(data.blocked_job);
        }

        // Chart Update
        pushChartData(data.cpu || 0, data.memory || 0, data.network_attacks || 0, data.disk || 0);

        // Update Script Executions Count
        const scriptCountEl = document.getElementById('total-script-execs');
        if (scriptCountEl) {
            scriptCountEl.textContent = data.script_exec_count || 0;
        }

        // Update IP suspicious if attacks > 0
        if (data.network_attacks > 0) {
            document.getElementById('suspicious-ip').innerText = `192.168.1.${Math.floor(Math.random() * 255)}`;
        }

    } catch (error) {
        console.error("Erreur de télémétrie:", error);
    } finally {
        setTimeout(() => setSpinner(false), 500); // keep spinner visible shortly
    }
}"""

new_fetch_servers_str = """async function fetchServersStatus() {
    try {
        setSpinner(true);
        const response = await fetch('/api/servers/status');
        const data = await response.json();
        
        const container = document.getElementById('servers-container');
        if (!container) return;
        
        if (data.status === 'success' && data.servers) {
            let html = '';
            data.servers.forEach(srv => {
                const isUp = srv.status === 'UP';
                const statusColor = isUp ? '#10B981' : '#EF4444'; // Green : Red
                const ledClass = isUp ? 'pulse-led led-active' : 'pulse-led led-inactive';
                
                html += `
                <div class="service-item" style="flex-direction: column; align-items: stretch; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; padding: 15px; position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <div class="${ledClass}"></div>
                            <div>
                                <h3 style="margin: 0; font-size: 16px; color: var(--text-main); font-family: var(--font-main);">${srv.hostname}</h3>
                                <span style="font-size: 12px; color: var(--text-muted); font-family: var(--font-mono);">${srv.ip} | Role: ${srv.role.toUpperCase()}</span>
                            </div>
                        </div>
                        <span style="background: ${statusColor}20; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">
                            ${srv.status}
                        </span>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                        <div style="background: var(--bg-body); padding: 10px; border-radius: 6px; text-align: center;">
                            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">CPU Usage</div>
                            <div style="font-size: 18px; font-weight: bold; color: ${srv.cpu > 80 ? '#EF4444' : 'var(--text-main)'};">${srv.cpu}%</div>
                        </div>
                        <div style="background: var(--bg-body); padding: 10px; border-radius: 6px; text-align: center;">
                            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">RAM Usage</div>
                            <div style="font-size: 18px; font-weight: bold; color: ${srv.memory > 80 ? '#EF4444' : 'var(--text-main)'};">${srv.memory}%</div>
                        </div>
                    </div>
                    
                    <button class="btn-primary" style="width: 100%; padding: 8px; border-radius: 4px; font-weight: 600;" onclick="remediateServer(this, '${srv.id}')">Gérer / Corriger</button>
                </div>
                `;
            });
            container.innerHTML = html;
        }
    } catch (error) {
        console.error("Erreur de récupération des serveurs:", error);
    } finally {
        setTimeout(() => setSpinner(false), 500);
    }
}

async function remediateServer(btnElem, serverId) {
    btnElem.classList.add('clicked');
    const originalText = btnElem.textContent;
    btnElem.textContent = "Exécution...";
    btnElem.disabled = true;
    
    try {
        const response = await fetch(`/api/server/${serverId}/remediate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        
        if (response.status === 403) {
            showToast("Accès Refusé : Vous devez être connecté en tant qu'Analyste SOC.", true);
            openLoginModal();
        } else if (data.status === 'success' || data.success) {
            showToast(data.message || "Remédiation réussie");
            fetchIncidents(); // Refresh logs
            fetchServersStatus(); // Refresh status immediately
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
"""

content = content.replace(fetch_metrics_str, new_fetch_servers_str)

init_str = """document.addEventListener('DOMContentLoaded', () => {
    initPerformanceChart();
    fetchMetrics();
    fetchIncidents();
    fetchLogs();

    // Poll every 5 seconds
    setInterval(() => {
        fetchMetrics();
        fetchIncidents();
        fetchLogs();
    }, 5000);
});"""

new_init_str = """document.addEventListener('DOMContentLoaded', () => {
    fetchServersStatus();
    fetchIncidents();
    fetchLogs();

    // Poll every 5 seconds
    setInterval(() => {
        fetchServersStatus();
        fetchIncidents();
        fetchLogs();
    }, 5000);
});"""

content = content.replace(init_str, new_init_str)

with open('static/js/main.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Successfully updated main.js")
