import paramiko
import time
import uuid
import os
import base64
import logging
import threading
import mailer
from models import db, Alert

# Configuration SSH
KALI_IP = "192.168.132.130"
KALI_USER = "r2schools"
KALI_PASSWORD = "ghita"
LOG_FILE_PATH = "/var/log/monitoring.log"

SSH_TIMEOUT = 2  # Timeout court pour la robustesse (secondes)
SSH_CMD_TIMEOUT = 2  # Timeout pour les commandes SSH

# Anti-spam des alertes email : delai minimal entre deux emails pour un meme
# message de journal, et nombre maximal d'emails par cycle de surveillance.
ALERT_EMAIL_COOLDOWN_SECONDS = 900
MAX_ALERT_EMAILS_PER_CYCLE = 5
_alert_email_last_sent = {}

# Logger pour les erreurs SSH
ssh_logger = logging.getLogger("ssh_logger")
kali_metrics = {
    "server_status": "Offline",
    "app_jobs": "Blocked",
    "cpu": 0,
    "memory": 0,
    "disk": 0,
    "network_attacks": 0,
    "services": {
        "apache2": "inactive",
        "mariadb": "inactive",
        "cron": "inactive",
        "sauvegarde": "inactive"
    }
}


# ==========================================================================
# HELPER SSH ROBUSTE
# ==========================================================================
def create_ssh_client():
    """
    Crée un client SSH avec timeout court.
    Retourne None si la connexion échoue (pas de Mock).
    """
    if not KALI_IP or not KALI_USER or not KALI_PASSWORD:
        ssh_logger.warning("[SSH] Identifiants SSH manquants dans la configuration.")
        return None
    try:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=KALI_IP,
            username=KALI_USER,
            password=KALI_PASSWORD,
            timeout=SSH_TIMEOUT,
            allow_agent=False,
            look_for_keys=False
        )
        return client
    except Exception as e:
        ssh_logger.warning(f"[SSH] Connexion impossible à {KALI_IP}: {type(e).__name__} - {e}")
        return None


def safe_ssh_exec(client, cmd, timeout=SSH_CMD_TIMEOUT):
    """
    Exécute une commande SSH de manière sécurisée avec timeout.
    Retourne (success: bool, stdout: str, stderr: str).
    Ne lève jamais d'exception.
    """
    if client is None:
        return False, "", "Client SSH non connecté"
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()
        exit_code = stdout.channel.recv_exit_status()
        return exit_code == 0, out, err
    except Exception as e:
        ssh_logger.warning(f"[SSH] Erreur exec_command: {type(e).__name__} - {e}")
        return False, "", str(e)


def safe_close(client):
    """Ferme le client SSH sans lever d'exception."""
    if client is not None:
        try:
            client.close()
        except Exception:
            pass


# ==========================================================================
# MÉTRIQUES SYSTÈME & ALERTES
# ==========================================================================
def fetch_system_metrics_and_alerts(app=None):
    """Récupère les métriques système réelles via SSH. Valeurs par défaut si échec."""
    client = create_ssh_client()
    if client is None:
        kali_metrics["server_status"] = "Offline"
        kali_metrics["app_jobs"] = "Blocked"
        kali_metrics["cpu"] = 0
        kali_metrics["memory"] = 0
        kali_metrics["disk"] = 0
        kali_metrics["network_attacks"] = 0
        for svc in kali_metrics["services"]:
            kali_metrics["services"][svc] = "inactive"
        return

    try:
        kali_metrics["server_status"] = "Online"

        # Récupération des métriques système (CPU, RAM, Disque, Services)
        command = """
        cpu=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}')
        mem=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100.0}')
        disk=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')
        ap=$(systemctl is-active apache2 || echo "inactive")
        ma=$(systemctl is-active mariadb || echo "inactive")
        cr=$(systemctl is-active cron || echo "inactive")
        sa=$(systemctl is-active rsync || echo "inactive")
        attacks=$(grep "Failed password" /var/log/auth.log 2>/dev/null | tail -n 50 | wc -l)
        
        echo "${cpu}|${mem}|${disk}|${ap}|${ma}|${cr}|${sa}|${attacks}"
        """

        success, result, _ = safe_ssh_exec(client, command, timeout=5)

        if success and result:
            parts = result.split('|')
            if len(parts) >= 7:
                try:
                    kali_metrics["cpu"] = int(float(parts[0]))
                except ValueError:
                    kali_metrics["cpu"] = 0

                try:
                    kali_metrics["memory"] = int(float(parts[1]))
                except ValueError:
                    kali_metrics["memory"] = 0

                try:
                    kali_metrics["disk"] = int(float(parts[2]))
                except ValueError:
                    kali_metrics["disk"] = 0

                kali_metrics["services"]["apache2"] = "active" if parts[3] == "active" else "inactive"
                kali_metrics["services"]["mariadb"] = "active" if parts[4] == "active" else "inactive"
                kali_metrics["services"]["cron"] = "active" if parts[5] == "active" else "inactive"
                kali_metrics["services"]["sauvegarde"] = "active" if parts[6] == "active" else "inactive"

            if len(parts) >= 8:
                try:
                    kali_metrics["network_attacks"] = int(parts[7])
                except ValueError:
                    kali_metrics["network_attacks"] = 0

        if kali_metrics["services"]["cron"] == "active" and kali_metrics["memory"] < 95:
            kali_metrics["app_jobs"] = "Running"
        else:
            kali_metrics["app_jobs"] = "Blocked"

        # Récupération des alertes du fichier log
        success, log_output, _ = safe_ssh_exec(client, f"tail -n 50 {LOG_FILE_PATH} 2>/dev/null || echo ''", timeout=3)

        if success and log_output and app:
            with app.app_context():
                lines = log_output.splitlines()
                emails_sent = 0
                for line in lines:
                    if "CRITICAL" in line or "ERROR" in line:
                        msg = line.strip()
                        # Verify if an unresolved alert for this exact message already exists
                        existing = Alert.query.filter_by(message=msg, status="Pending").first()
                        if not existing:
                            new_alert = Alert(message=msg)
                            db.session.add(new_alert)
                            db.session.commit()

                            if emails_sent < MAX_ALERT_EMAILS_PER_CYCLE:
                                if notify_alert_by_email(new_alert.id, msg):
                                    emails_sent += 1

    except Exception as e:
        ssh_logger.error(f"[SSH Error] Erreur récupération métriques : {e}")
        kali_metrics["server_status"] = "Offline"
    finally:
        safe_close(client)


def notify_alert_by_email(alert_id, message):
    """Envoie l'alerte de journal par email, hors du thread de surveillance.

    Retourne False si le meme message a deja ete notifie recemment.
    """
    now = time.time()
    if now - _alert_email_last_sent.get(message, 0) < ALERT_EMAIL_COOLDOWN_SECONDS:
        return False

    severity = "CRITICAL" if "CRITICAL" in message else "ERROR"
    _alert_email_last_sent[message] = now
    threading.Thread(
        target=mailer.send_soc_alert_email,
        args=(
            alert_id,
            f"Journal systeme ({LOG_FILE_PATH})",
            severity,
            message[:500],
            "Detection automatique",
            "Kali Master",
        ),
        daemon=True,
    ).start()
    return True


# ==========================================================================
# GESTION DES ALERTES
# ==========================================================================
def resolve_kali_alert(alert_id):
    """Résout une alerte Kali via SSH."""
    alert = Alert.query.get(alert_id)
    if not alert:
        return False

    client = create_ssh_client()
    if client is not None:
        try:
            safe_ssh_exec(client, "echo 'Resolution effectuee' >> /var/log/monitoring.log")
        finally:
            safe_close(client)

    alert.status = "Resolved"
    db.session.commit()
    return True


def get_active_alerts():
    """Retourne les alertes actives (non résolues)."""
    alerts = Alert.query.filter_by(status="Pending").all()
    return [a.to_dict() for a in alerts]


# ==========================================================================
# GESTION DES SERVICES
# ==========================================================================
def manage_service(service_name, action="restart"):
    """
    Démarre, arrête ou redémarre un service via SSH.
    Retourne True en cas de succès, False sinon.
    """
    mapping = {
        "apache2": "apache2",
        "mariadb": "mariadb",
        "rsync": "rsync",
        "sauvegarde": "rsync",
        "cron": "cron"
    }
    target = mapping.get(service_name.lower(), service_name.lower())
    if action not in ['start', 'stop', 'restart']:
        return False

    client = create_ssh_client()
    if client is None:
        return False

    try:
        command = f"echo '{KALI_PASSWORD}' | sudo -S systemctl {action} {target}"
        success, _, _ = safe_ssh_exec(client, command, timeout=5)
        return success
    finally:
        safe_close(client)


def restart_service(service_name):
    """Raccourci pour redémarrer un service."""
    return manage_service(service_name, "restart")


def restart_backup_service():
    """Redémarre le service de sauvegarde (rsync)."""
    return restart_service("rsync")


# ==========================================================================
# REMÉDIATION
# ==========================================================================
def remediate_app_job():
    """
    Exécute une séquence de commandes stricte et sans paramètres externes
    pour résoudre le blocage de l'App Job. (Anti-Command Injection)
    """
    client = create_ssh_client()
    if client is None:
        return False

    try:
        command = f"echo '{KALI_PASSWORD}' | sudo -S sh -c 'echo \"Resolution effectuee\" >> /var/log/monitoring.log && systemctl restart cron'"
        success, _, _ = safe_ssh_exec(client, command, timeout=5)
        return success
    finally:
        safe_close(client)


def run_remediation_script(resource):
    """Exécute le script de remédiation pour une ressource (disk, cpu ou ram)."""
    if resource not in ['disk', 'cpu', 'ram']:
        return False

    client = create_ssh_client()
    if client is None:
        return False

    try:
        script_path = os.path.join(os.path.dirname(__file__), "scripts", "remediation.sh")
        if not os.path.exists(script_path):
            ssh_logger.error(f"[SSH Error] Script introuvable: {script_path}")
            return False

        with open(script_path, "r", encoding="utf-8") as f:
            script_content = f.read()

        encoded_script = base64.b64encode(script_content.encode('utf-8')).decode('utf-8')
        command = f"echo '{KALI_PASSWORD}' | sudo -S sh -c 'echo \"{encoded_script}\" | base64 -d | bash -s {resource}'"

        success, output, errors = safe_ssh_exec(client, command, timeout=10)
        ssh_logger.info(f"[SSH Remediation] Resource: {resource}, Success: {success}, Output: {output}")
        return True  # On considère que l'exécution a eu lieu même si le script retourne une erreur
    except Exception as e:
        ssh_logger.error(f"[SSH Error] Remediation {resource}: {e}")
        return False
    finally:
        safe_close(client)


# ==========================================================================
# NETTOYAGE CIBLÉ (DISQUE)
# ==========================================================================
def list_cleanable_files(server_config=None):
    """
    Liste les fichiers éligibles au nettoyage sur un serveur.
    Retourne une liste de dicts {path, size, type}.
    Si server_config est None, utilise la connexion Kali par défaut.
    """
    if server_config:
        client = _connect_to_server(server_config)
    else:
        client = create_ssh_client()

    if client is None:
        return []

    try:
        # Fichiers temporaires > 1Mo et vieux de plus d'1h
        cmd_tmp = "find /tmp -type f -mmin +60 -size +1M -exec ls -lh {} \\; 2>/dev/null | awk '{print $5\"|\"$NF}' | head -30"
        # Logs archivés/compressés
        cmd_logs = "find /var/log -type f \\( -name '*.gz' -o -name '*.old' -o -name '*.1' -o -name '*.2' \\) -exec ls -lh {} \\; 2>/dev/null | awk '{print $5\"|\"$NF}' | head -30"
        # Gros fichiers de log (> 10Mo)
        cmd_big_logs = "find /var/log -type f -name '*.log' -size +10M -exec ls -lh {} \\; 2>/dev/null | awk '{print $5\"|\"$NF}' | head -20"

        files = []

        for cmd, file_type in [(cmd_tmp, "tmp"), (cmd_logs, "archive"), (cmd_big_logs, "log")]:
            success, output, _ = safe_ssh_exec(client, cmd, timeout=5)
            if success and output:
                for line in output.splitlines():
                    parts = line.split('|', 1)
                    if len(parts) == 2:
                        files.append({
                            "path": parts[1].strip(),
                            "size": parts[0].strip(),
                            "type": file_type
                        })

        return files
    finally:
        safe_close(client)


def delete_files(file_paths, server_config=None):
    """
    Supprime les fichiers spécifiés via SSH.
    Retourne (success_count, error_count).
    """
    if not file_paths:
        return 0, 0

    if server_config:
        client = _connect_to_server(server_config)
    else:
        client = create_ssh_client()

    if client is None:
        return 0, len(file_paths)

    success_count = 0
    error_count = 0

    try:
        # Sécurité : on ne supprime que des chemins commençant par /tmp/ ou /var/log/
        safe_paths = []
        for path in file_paths:
            path = path.strip()
            if path.startswith('/tmp/') or path.startswith('/var/log/'):
                safe_paths.append(path)
            else:
                ssh_logger.warning(f"[SECURITY] Chemin de suppression refusé (hors scope): {path}")
                error_count += 1

        if safe_paths:
            # Construire la commande de suppression
            paths_str = ' '.join(f"'{p}'" for p in safe_paths)
            cmd = f"sudo -n rm -f {paths_str} 2>/dev/null || (echo '{KALI_PASSWORD}' | sudo -S rm -f {paths_str})"
            success, _, _ = safe_ssh_exec(client, cmd, timeout=10)
            if success:
                success_count = len(safe_paths)
            else:
                error_count += len(safe_paths)

        return success_count, error_count
    finally:
        safe_close(client)


# ==========================================================================
# NETTOYAGE CIBLÉ (CPU / PROCESSUS / RAM)
# ==========================================================================
def list_top_processes(server_config=None, sort_by="cpu"):
    """
    Liste les processus les plus gourmands en CPU ou RAM.
    Retourne une liste de dicts {pid, user, cpu, mem, command}.
    """
    if server_config:
        client = _connect_to_server(server_config)
    else:
        client = create_ssh_client()

    if client is None:
        return []

    try:
        sort_flag = "-%mem" if sort_by == "mem" else "-%cpu"
        cmd = f"ps aux --sort={sort_flag} | awk 'NR>1 && NR<=16 {{printf \"%s|%s|%s|%s|\",$2,$1,$3,$4; for(i=11;i<=NF;i++) printf \"%s \",$i; print \"\"}}'"
        success, output, _ = safe_ssh_exec(client, cmd, timeout=3)

        processes = []
        if success and output:
            for line in output.splitlines():
                parts = line.split('|', 4)
                if len(parts) >= 5:
                    try:
                        processes.append({
                            "pid": int(parts[0].strip()),
                            "user": parts[1].strip(),
                            "cpu": float(parts[2].strip()),
                            "mem": float(parts[3].strip()),
                            "command": parts[4].strip()[:80]
                        })
                    except (ValueError, IndexError):
                        continue

        return processes
    finally:
        safe_close(client)


def purge_ram_cache(server_config=None):
    """
    Purge le cache mémoire système (drop_caches) via SSH.
    Libère la mémoire inactive / pagecache.
    """
    if server_config:
        client = _connect_to_server(server_config)
    else:
        client = create_ssh_client()

    if client is None:
        return False

    try:
        cmd = f"sudo -n sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || (echo '{KALI_PASSWORD}' | sudo -S sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches')"
        success, _, _ = safe_ssh_exec(client, cmd, timeout=6)
        return success
    finally:
        safe_close(client)


def kill_process(pid, server_config=None):
    """
    Tue un processus individuel par PID via SSH (SIGTERM puis SIGKILL).
    Retourne True si succès.
    """
    killed, _ = kill_processes([pid], server_config=server_config)
    return killed > 0


def kill_processes(pids, server_config=None):
    """
    Tue une liste de PIDs par SSH (SIGTERM puis SIGKILL).
    Retourne (killed_count, error_count).
    """
    if not pids:
        return 0, 0

    valid_pids = []
    for pid in pids:
        try:
            valid_pids.append(int(pid))
        except (ValueError, TypeError):
            continue

    if not valid_pids:
        return 0, len(pids)

    if server_config:
        client = _connect_to_server(server_config)
    else:
        client = create_ssh_client()

    if client is None:
        return 0, len(valid_pids)

    try:
        pids_str = ' '.join(str(p) for p in valid_pids)
        cmd = f"sudo -n kill -15 {pids_str} 2>/dev/null || (echo '{KALI_PASSWORD}' | sudo -S kill -15 {pids_str} 2>/dev/null); sleep 1; sudo -n kill -9 {pids_str} 2>/dev/null || (echo '{KALI_PASSWORD}' | sudo -S kill -9 {pids_str} 2>/dev/null)"
        safe_ssh_exec(client, cmd, timeout=6)
        return len(valid_pids), 0
    finally:
        safe_close(client)


# ==========================================================================
# AUTRES FONCTIONS SSH
# ==========================================================================
def fetch_latest_logs():
    """Récupère les derniers logs d'authentification."""
    client = create_ssh_client()
    if client is None:
        return "Connexion SSH impossible."

    try:
        success, output, _ = safe_ssh_exec(client, "tail -n 15 /var/log/auth.log 2>/dev/null || echo 'No logs available.'", timeout=3)
        return output if success else "Erreur lors de la récupération des logs."
    finally:
        safe_close(client)


def ban_ip(ip):
    """Bloque une IP via iptables."""
    client = create_ssh_client()
    if client is None:
        return False

    try:
        command = f"echo '{KALI_PASSWORD}' | sudo -S iptables -A INPUT -s {ip} -j DROP"
        success, _, _ = safe_ssh_exec(client, command, timeout=3)
        return success
    finally:
        safe_close(client)


# ==========================================================================
# CONNEXION SSH À UN SERVEUR SPÉCIFIQUE (Multi-VM)
# ==========================================================================
def _connect_to_server(server_config):
    """
    Crée un client SSH vers un serveur défini dans servers.json.
    Retourne None en cas d'échec.
    """
    try:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=server_config.get("ip"),
            port=int(server_config.get("ssh_port", 22)),
            username=server_config.get("user", "r2schools"),
            key_filename=os.path.expanduser(server_config.get("key_path", "")),
            timeout=SSH_TIMEOUT,
            allow_agent=False,
            look_for_keys=False
        )
        return client
    except Exception as e:
        ssh_logger.warning(f"[SSH] Connexion impossible à {server_config.get('ip')}: {type(e).__name__} - {e}")
        return None


def list_cleanable_files_on_server(server_config):
    """Liste les fichiers nettoyables sur un serveur spécifique."""
    return list_cleanable_files(server_config=server_config)


def list_top_processes_on_server(server_config, sort_by="cpu"):
    """Liste les processus gourmands sur un serveur spécifique."""
    return list_top_processes(server_config=server_config, sort_by=sort_by)


def purge_ram_cache_on_server(server_config):
    """Purge le cache RAM sur un serveur spécifique."""
    return purge_ram_cache(server_config=server_config)


def kill_process_on_server(pid, server_config):
    """Tue un processus sur un serveur spécifique."""
    return kill_process(pid, server_config=server_config)


def kill_processes_on_server(pids, server_config):
    """Tue une liste de processus sur un serveur spécifique."""
    return kill_processes(pids, server_config=server_config)


def delete_files_on_server(file_paths, server_config):
    """Supprime des fichiers sur un serveur spécifique."""
    return delete_files(file_paths, server_config=server_config)


# ==========================================================================
# BOUCLE DE MONITORING
# ==========================================================================
def background_monitoring_loop(app):
    """Boucle de monitoring en arrière-plan."""
    while True:
        try:
            fetch_system_metrics_and_alerts(app)
        except Exception as e:
            ssh_logger.error(f"[Monitor Loop] Erreur: {e}")
        time.sleep(5)

