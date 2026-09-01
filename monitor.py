import subprocess
import sys
import psutil

def check_service(service_name):
    """Vérifie si un service ou un processus est actif."""
    # 1. Vérification via psutil (cross-platform, vérifie les processus en cours)
    try:
        # Mapping de noms de services courants vers noms de processus
        process_mapping = {
            "apache2": ["apache2", "httpd"],
            "mariadb": ["mariadbd", "mysqld"],
            "cron": ["cron", "crond"],
            "backups": ["rsync", "tar", "backup"]
        }
        
        target_names = process_mapping.get(service_name.lower(), [service_name.lower()])
        
        for proc in psutil.process_iter(['name']):
            try:
                proc_name = proc.info['name'].lower()
                if any(target in proc_name for target in target_names):
                    return "active"
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
    except Exception:
        pass

    # 2. Vérification via systemctl (Uniquement sous Linux)
    if sys.platform == "linux":
        try:
            result = subprocess.run(
                ["systemctl", "is-active", "--quiet", service_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            return "active" if result.returncode == 0 else "inactive"
        except FileNotFoundError:
            return "inactive"
            
    return "inactive"

def get_cpu_usage():
    """Récupère la charge CPU actuelle."""
    try:
        return int(psutil.cpu_percent(interval=0.1))
    except Exception:
        return None

def get_memory_usage():
    """Récupère l'utilisation de la mémoire RAM en pourcentage."""
    try:
        return int(psutil.virtual_memory().percent)
    except Exception:
        return None

def get_disk_usage():
    """Récupère l'utilisation du disque principal en pourcentage."""
    try:
        return int(psutil.disk_usage('/').percent)
    except Exception:
        return None