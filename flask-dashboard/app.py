import socket
from flask import Flask, render_template

app = Flask(__name__)

# Liste des nœuds de l'infrastructure GTO à superviser
NODES = [
    {"name": "Web Node (Apache2)", "host": "127.0.0.1", "port": 80},
    {"name": "DB Node (MariaDB)", "host": "gto-db-srv01", "port": 3306},
    {"name": "App Node (Cron / SSH)", "host": "gto-app-srv01", "port": 22}
]

def check_tcp_port(host, port, timeout=2.0):
    """Vérifie si le port TCP est ouvert sur l'hôte spécifié."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect((host, port))
        return "ONLINE"
    except Exception:
        return "OFFLINE"

@app.route('/')
def index():
    # Vérifie le statut de chaque nœud
    services = []
    for node in NODES:
        status = check_tcp_port(node["host"], node["port"])
        services.append({
            "name": node["name"],
            "host": node["host"],
            "port": node["port"],
            "status": status
        })
    
    # Passe la liste de services et statuts au template index.html
    return render_template('index.html', services=services)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
