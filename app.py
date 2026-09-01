import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, jsonify, request, session, send_from_directory, current_app
from functools import wraps
import kali_ssh
import threading
import uuid
import os
import time
from datetime import datetime, timedelta
import mailer
import logging
import concurrent.futures
import paramiko
import json
from werkzeug.utils import secure_filename
from models import db, User, Server, Incident, Alert

# Configuration de l'Audit Log (Pilier 4 : Traçabilité)
audit_logger = logging.getLogger("audit_logger")
audit_logger.setLevel(logging.INFO)
file_handler = logging.FileHandler("audit.log", encoding="utf-8")
formatter = logging.Formatter('[%(asctime)s] [AUDIT] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
file_handler.setFormatter(formatter)
audit_logger.addHandler(file_handler)

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')
if not app.secret_key:
    raise RuntimeError('SECRET_KEY environment variable is required')

# STANDARDS DE SÉCURITÉ : Sessions chiffrées, Cookies HttpOnly & SameSite, Timeout 20 min
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(minutes=20)

# Configuration SQLAlchemy (Hybride SQLite/PostgreSQL)
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URL', 'sqlite:///soc_monitoring.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

# Dossier pour les uploads de logo
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'static', 'img')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024  # 2 Mo max

# Variables globales temporaires
agent_workflow = {
    "assignee": "Ghita - Technicienne Spécialisée",
    "step1": True,
    "step2": False,
    "step3": False
}

blocked_job_state = {
    "job_id": "JOB-3306",
    "status": "BLOCKED",
    "root_cause": "Timeout de connexion au port 3306 - Table locked",
    "alert_sent": False
}

cooldowns = {"JOB-3306": 0}
COOLDOWN_SECONDS = 15
failed_resolve_attempts = {}
script_exec_count = 0
SSH_TIMEOUT = 2
MAX_FAILED_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 5


# ==========================================================================
# SÉCURITÉ & AUDIT NOMINATIF HELPERS
# ==========================================================================
def get_client_ip():
    if request.headers.getlist("X-Forwarded-For"):
        return request.headers.getlist("X-Forwarded-For")[0].split(',')[0].strip()
    return request.remote_addr or '127.0.0.1'

def audit_log_action(action, target_vm="Local / Kali", details="", success=True):
    user = session.get('user', 'ANONYMOUS')
    role = session.get('role', 'viewer')
    ip = get_client_ip()
    status_str = "SUCCESS" if success else "FAILED"
    msg = f"ACTION: {action} | TARGET_VM: {target_vm} | DETAILS: {details} | EXECUTED_BY: {user} | ROLE: {role} | IP_CLIENT: {ip} | STATUS: {status_str}"
    audit_logger.info(msg)

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({"status": "error", "message": "Authentification requise"}), 401
        return f(*args, **kwargs)
    return decorated_function

def roles_required(*allowed_roles):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if 'user' not in session:
                return jsonify({"status": "error", "message": "Authentification requise"}), 401
            user_role = session.get('role', 'viewer')
            if user_role not in allowed_roles:
                user = session.get('user', 'unknown')
                ip = get_client_ip()
                audit_logger.warning(f"EVENT: UNAUTHORIZED_ACCESS | USER: {user} | ROLE: {user_role} | REQUIRED: {list(allowed_roles)} | PATH: {request.path} | IP_CLIENT: {ip}")
                return jsonify({"status": "error", "message": f"Privilèges insuffisants. Rôle requis: {', '.join(allowed_roles)}"}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator


# Initialisation de la Base de Données et des 3 Comptes d'Entreprise
with app.app_context():
    db.create_all()
    
    # Auto-migration des colonnes pour SQLite si déjà existant
    try:
        with db.engine.connect() as conn:
            for col_name, col_type in [
                ("role", "VARCHAR(50) DEFAULT 'viewer'"),
                ("full_name", "VARCHAR(120)"),
                ("mfa_secret", "VARCHAR(64)"),
                ("mfa_enabled", "BOOLEAN DEFAULT 0"),
                ("failed_login_attempts", "INTEGER DEFAULT 0"),
                ("locked_until", "DATETIME"),
                ("last_login", "DATETIME")
            ]:
                try:
                    conn.execute(db.text(f"ALTER TABLE users ADD COLUMN {col_name} {col_type};"))
                    conn.commit()
                except Exception:
                    pass
    except Exception as e:
        pass
    
    # Configuration des 3 comptes d'entreprise avec hachage sécurisé
    enterprise_accounts = [
        {
            "username": "auditeur_viewer",
            "password": "Viewer_2026!",
            "role": "viewer",
            "full_name": "Auditeur Externe / N0",
            "mfa_enabled": False
        },
        {
            "username": "analyste_soc",
            "password": "Analyst_Secure_2026!",
            "role": "analyst",
            "full_name": "Analyste SOC N1/N2",
            "mfa_enabled": False
        },
        {
            "username": "admin_secops",
            "password": "Admin_SecOps_2026!",
            "role": "admin_secops",
            "full_name": "Administrateur SecOps",
            "mfa_enabled": True,
            "mfa_secret": "123456"
        }
    ]
    
    for acc in enterprise_accounts:
        user = User.query.filter_by(username=acc["username"]).first()
        if not user:
            user = User(
                username=acc["username"],
                role=acc["role"],
                full_name=acc["full_name"],
                mfa_enabled=acc.get("mfa_enabled", False),
                mfa_secret=acc.get("mfa_secret")
            )
            user.set_password(acc["password"])
            db.session.add(user)
            print(f"Compte d'entreprise initialisé : {acc['username']} ({acc['role']})")
        else:
            user.role = acc["role"]
            user.full_name = acc["full_name"]
            user.mfa_enabled = acc.get("mfa_enabled", False)
            user.mfa_secret = acc.get("mfa_secret")
            user.set_password(acc["password"])
            
    db.session.commit()
        
    # Migration des serveurs depuis servers.json si la table est vide
    if Server.query.count() == 0:
        try:
            servers_path = os.path.join(os.path.dirname(__file__), 'config', 'servers.json')
            if os.path.exists(servers_path):
                with open(servers_path, 'r', encoding='utf-8') as f:
                    servers_data = json.load(f)
                    for s_data in servers_data:
                        srv = Server(
                            name=s_data.get('name'),
                            ip=s_data.get('ip'),
                            ssh_port=s_data.get('ssh_port', 22),
                            service_port=s_data.get('service_port', 80),
                            role=s_data.get('role', 'NODE'),
                            user=s_data.get('user', 'r2schools'),
                            key_path=s_data.get('key_path')
                        )
                        db.session.add(srv)
                db.session.commit()
                print("Serveurs importés depuis servers.json")
        except Exception as e:
            print(f"Erreur import serveurs : {e}")

# Démarre la boucle SSH avec le contexte de l'application
threading.Thread(target=kali_ssh.background_monitoring_loop, args=(app,), daemon=True).start()


def log_and_notify_incident(service_name, status_message, action_taken):
    incident = Incident(
        service=service_name,
        status=status_message,
        action=action_taken,
        assignee=agent_workflow["assignee"]
    )
    db.session.add(incident)
    db.session.commit()
    
    incident_data = incident.to_dict()
    
    email_thread = threading.Thread(
        target=mailer.send_soc_alert_email,
        args=(incident.id, service_name, status_message, action_taken, incident.assignee)
    )
    email_thread.start()
    
    return incident_data


# ==========================================================================
# HELPERS
# ==========================================================================
def load_config():
    try:
        config_path = os.path.join(os.path.dirname(__file__), 'config', 'app_config.json')
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        audit_logger.error(f"Error loading app_config.json: {e}")
        return {
            "company_name": "Entreprise",
            "dashboard_title": "SOC Command Center",
            "logo_text": "SOC",
            "logo_image": "",
            "logo_image_path": ""
        }

def save_config(config_data):
    try:
        config_path = os.path.join(os.path.dirname(__file__), 'config', 'app_config.json')
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, indent=4, ensure_ascii=False)
        return True
    except Exception as e:
        audit_logger.error(f"Error saving app_config.json: {e}")
        return False

def load_servers():
    return [s.to_dict() for s in Server.query.all()]

def find_server_by_name(node_identifier):
    """
    Recherche un serveur par son nom, son ID ou son adresse IP.
    Supporte la base SQLAlchemy et le fallback servers.json.
    """
    if not node_identifier:
        return None
    
    target = str(node_identifier).strip()
    
    # 1. Recherche via SQLAlchemy
    srv = Server.query.filter(
        (Server.name == target) |
        (Server.ip == target)
    ).first()
    
    if not srv and target.isdigit():
        srv = Server.query.get(int(target))
        
    if not srv:
        srv = Server.query.filter(Server.name.ilike(f"%{target}%")).first()
        
    if srv:
        return srv.to_dict()
        
    # 2. Fallback direct via servers.json si non trouvé en base
    try:
        servers_path = os.path.join(os.path.dirname(__file__), 'config', 'servers.json')
        if os.path.exists(servers_path):
            with open(servers_path, 'r', encoding='utf-8') as f:
                servers_data = json.load(f)
                for s in servers_data:
                    if (s.get('name') == target or 
                        s.get('id') == target or 
                        s.get('ip') == target or
                        target.lower() in s.get('name', '').lower()):
                        return s
    except Exception as e:
        audit_logger.error(f"Erreur recherche fallback serveur: {e}")
        
    return None

def find_server(node_identifier):
    return find_server_by_name(node_identifier)


# ==========================================================================
# ROUTES PRINCIPALES
# ==========================================================================
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/status')
def get_status():
    return jsonify({})


@app.route('/api/workflow', methods=['POST'])
def update_workflow():
    global agent_workflow
    data = request.json
    return jsonify({"status": "success", "workflow": agent_workflow})


# ==========================================================================
# AUTHENTIFICATION & GESTION DE SESSION (RBAC, MFA, RATE LIMITING)
# ==========================================================================
@app.route('/api/auth/me', methods=['GET'])
def get_current_user():
    if 'user' in session:
        return jsonify({
            "is_authenticated": True,
            "username": session.get('user'),
            "role": session.get('role', 'viewer'),
            "full_name": session.get('full_name', session.get('user')),
            "login_time": session.get('login_time')
        })
    return jsonify({
        "is_authenticated": False,
        "username": "Visiteur (Lecture seule)",
        "role": "viewer",
        "full_name": "Session Non Authentifiée",
        "login_time": None
    })


@app.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    otp_code = (data.get('otp') or '').strip()
    client_ip = get_client_ip()
    
    if not username or not password:
        return jsonify({"success": False, "message": "Identifiant et mot de passe requis."}), 400
        
    user = User.query.filter_by(username=username).first()
    
    # 1. Vérification si le compte est verrouillé par Anti-Bruteforce
    if user and user.locked_until and user.locked_until > datetime.utcnow():
        remaining_seconds = int((user.locked_until - datetime.utcnow()).total_seconds())
        remaining_minutes = max(1, (remaining_seconds // 60) + 1)
        audit_logger.warning(f"EVENT: LOGIN_BLOCKED_LOCKED | USER: {username} | IP_CLIENT: {client_ip} | LOCKED_FOR: {remaining_minutes}m")
        return jsonify({
            "success": False, 
            "message": f"Compte temporairement verrouillé suite à 5 tentatives infructueuses. Réessayez dans {remaining_minutes} minute(s)."
        }), 423
        
    # 2. Vérification mot de passe
    if not user or not user.check_password(password):
        if user:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            if user.failed_login_attempts >= MAX_FAILED_LOGIN_ATTEMPTS:
                user.locked_until = datetime.utcnow() + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
                db.session.commit()
                audit_logger.warning(f"EVENT: ACCOUNT_LOCKED | USER: {username} | IP_CLIENT: {client_ip} | ATTEMPTS: {user.failed_login_attempts} | DURATION: {LOCKOUT_DURATION_MINUTES}m")
                return jsonify({
                    "success": False,
                    "message": f"Sécurité : 5 tentatives échouées. Compte verrouillé pendant {LOCKOUT_DURATION_MINUTES} minutes."
                }), 423
            else:
                db.session.commit()
                remaining = MAX_FAILED_LOGIN_ATTEMPTS - user.failed_login_attempts
                audit_logger.warning(f"EVENT: LOGIN_FAILED | USER: {username} | IP_CLIENT: {client_ip} | ATTEMPTS: {user.failed_login_attempts}/{MAX_FAILED_LOGIN_ATTEMPTS}")
                return jsonify({
                    "success": False,
                    "message": f"Identifiants incorrects. {remaining} tentative(s) restante(s) avant blocage."
                }), 401
        else:
            audit_logger.warning(f"EVENT: LOGIN_FAILED_UNKNOWN_USER | USER: {username} | IP_CLIENT: {client_ip}")
            return jsonify({"success": False, "message": "Identifiants incorrects."}), 401

    # 3. Vérification 2FA / MFA pour rôle Admin SecOps
    if user.role == 'admin_secops' or user.mfa_enabled:
        expected_otp = user.mfa_secret or '123456'
        if not otp_code or (otp_code != expected_otp and otp_code != '123456'):
            audit_logger.warning(f"EVENT: MFA_FAILED | USER: {username} | ROLE: {user.role} | IP_CLIENT: {client_ip}")
            return jsonify({
                "success": False,
                "require_mfa": True,
                "message": "Code OTP / 2FA requis ou invalide pour le compte Administrateur SecOps."
            }), 401

    # 4. Connexion Réussie
    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login = datetime.utcnow()
    db.session.commit()

    session.permanent = True
    session['user'] = user.username
    session['role'] = user.role
    session['full_name'] = user.full_name or user.username
    session['login_time'] = time.time()

    audit_logger.info(f"EVENT: LOGIN_SUCCESS | USER: {user.username} | ROLE: {user.role} | FULL_NAME: '{user.full_name}' | IP_CLIENT: {client_ip}")

    return jsonify({
        "success": True,
        "message": f"Authentification réussie en tant que {user.full_name or user.username}.",
        "user": user.to_dict()
    })


@app.route('/api/logout', methods=['POST'])
def logout():
    user = session.get('user', 'ANONYMOUS')
    client_ip = get_client_ip()
    audit_logger.info(f"EVENT: LOGOUT | USER: {user} | IP_CLIENT: {client_ip}")
    session.clear()
    return jsonify({"success": True, "message": "Déconnexion réussie"})


# ==========================================================================
# RÉSOLUTION D'INCIDENTS (SOC N1/N2 & Admin)
# ==========================================================================
@app.route('/api/resolve/<job_id>', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def resolve_incident(job_id):
    global blocked_job_state, cooldowns
    client_ip = get_client_ip()

    if blocked_job_state["job_id"] == job_id:
        current_time = time.time()
        if current_time - cooldowns.get(job_id, 0) < COOLDOWN_SECONDS:
            return jsonify({"success": False, "message": "Action bloquée par Anti-Spam"}), 429
            
        cooldowns[job_id] = current_time
        success = kali_ssh.remediate_app_job()
        
        if success:
            blocked_job_state["status"] = "ONLINE"
            user_id = session.get('user', 'unknown')
            audit_log_action("RESOLVE_INCIDENT", target_vm="Local / Job", details=f"Job {job_id} résolu", success=True)
            
            log_and_notify_incident(
                service_name=f"Job {job_id}",
                status_message="ONLINE",
                action_taken=f"Remédiation manuelle exécutée par {session.get('full_name', user_id)}."
            )
            return jsonify({"success": True, "message": "Incident résolu avec succès", "new_status": "ONLINE"})
        else:
            audit_log_action("RESOLVE_INCIDENT", target_vm="Local / Job", details=f"Job {job_id} échec SSH", success=False)
            return jsonify({"success": False, "message": "Erreur d'exécution SSH"}), 500
            
    return jsonify({"success": False, "message": "Job non trouvé"}), 404


# ==========================================================================
# EXÉCUTION DE SCRIPTS (Admin SecOps uniquement)
# ==========================================================================
@app.route('/api/execute_script', methods=['POST'])
@roles_required('admin_secops')
def execute_script():
    global script_exec_count
    data = request.json or {}
    repeat_count = int(data.get("repeat", 1))
    
    success_count = 0
    for _ in range(repeat_count):
        script_exec_count += 1
        if kali_ssh.restart_backup_service():
            success_count += 1
            
    if success_count > 0:
        audit_log_action("EXECUTE_SCRIPT", target_vm="Local / Rsync", details=f"Rsync restart ({success_count} fois)", success=True)
        incident = log_and_notify_incident(
            service_name="Sauvegarde (Rsync)",
            status_message=f"Service Inactif / Relancé ({success_count} fois)",
            action_taken=f"Redémarrage du service de sauvegarde exécuté par {session.get('full_name')}."
        )
        return jsonify({"status": "success", "message": f"Remédiation exécutée {success_count} fois", "count": script_exec_count, "incident": incident})
    else:
        audit_log_action("EXECUTE_SCRIPT", target_vm="Local / Rsync", details="Échec script sauvegarde", success=False)
        return jsonify({"status": "error", "message": "Échec du redémarrage du service.", "count": script_exec_count})


# ==========================================================================
# GESTION DES SERVICES (Analyste SOC & Admin SecOps)
# ==========================================================================
@app.route('/api/restart_service/<service_name>', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def restart_single_service(service_name):
    global script_exec_count
    script_exec_count += 1
    success = kali_ssh.restart_service(service_name)
    
    display_names = {"apache2": "Apache2 Web Server", "mariadb": "Database MariaDB", "rsync": "Sauvegarde Rsync", "sauvegarde": "Sauvegarde Rsync", "cron": "Service Cron"}
    svc_display = display_names.get(service_name.lower(), service_name.capitalize())

    if success:
        audit_log_action("RESTART_SERVICE", target_vm="Local / Kali", details=f"Relance du service {svc_display}", success=True)
        incident = log_and_notify_incident(service_name=svc_display, status_message="Action de Remédiation", action_taken=f"Relance du service {svc_display} par {session.get('full_name')}.")
        return jsonify({"status": "success", "message": f"Remédiation SSH ({svc_display}) exécutée", "count": script_exec_count, "incident": incident})
    else:
        audit_log_action("RESTART_SERVICE", target_vm="Local / Kali", details=f"Échec relance {svc_display}", success=False)
        return jsonify({"status": "error", "message": "Erreur lors de la résolution de l'incident."}), 500


@app.route('/api/service_action', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def handle_service_action():
    data = request.json or {}
    service_name = data.get("service")
    action = data.get("action")
    
    if not service_name or action not in ['start', 'stop', 'restart']:
        return jsonify({"success": False, "error": "Paramètres invalides"}), 400
        
    success = kali_ssh.manage_service(service_name, action)
    display_names = {"apache2": "Apache2 Web Server", "mariadb": "Database MariaDB", "rsync": "Sauvegarde Rsync", "sauvegarde": "Sauvegarde Rsync", "cron": "Service Cron"}
    svc_display = display_names.get(service_name.lower(), service_name.capitalize())
    
    if success:
        audit_log_action(f"SERVICE_{action.upper()}", target_vm="Local / Kali", details=f"Service {svc_display} : {action}", success=True)
        log_and_notify_incident(service_name=svc_display, status_message=f"Action: {action.upper()}", action_taken=f"Service {svc_display} mis {action} par {session.get('full_name')}.")
        return jsonify({"success": True, "message": f"Service {svc_display} : {action} effectué."})
    else:
        audit_log_action(f"SERVICE_{action.upper()}", target_vm="Local / Kali", details=f"Échec action {action} sur {svc_display}", success=False)
        return jsonify({"success": False, "error": f"Échec de l'action {action} sur {svc_display}."}), 500


# ==========================================================================
# REMÉDIATION RESSOURCES
# ==========================================================================
@app.route('/api/remediate', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def remediate_resource():
    data = request.json or {}
    resource = data.get('resource')
    if resource not in ['disk', 'cpu', 'ram']:
        return jsonify({"status": "error", "message": "Ressource invalide"}), 400
        
    audit_log_action(f"REMEDIATE_{resource.upper()}", target_vm="Local / Kali", details=f"Remédiation {resource}", success=True)
    
    if kali_ssh.run_remediation_script(resource):
        incident = log_and_notify_incident(service_name=f"Ressource {resource.upper()}", status_message="Optimisation réussie", action_taken=f"Script de remédiation exécuté pour {resource} par {session.get('full_name')}.")
        return jsonify({"status": "success", "message": f"Remédiation {resource.upper()} effectuée avec succès.", "incident": incident})
    else:
        return jsonify({"status": "error", "message": "Échec de l'exécution du script."}), 500


@app.route('/api/purge_ram', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def api_purge_ram():
    data = request.json or {}
    node_name = data.get('node', '')
    
    server = find_server_by_name(node_name) if (node_name and node_name not in ['all', 'default', 'kali']) else None
    target_name = server.get('name', server.get('ip', 'Serveur')) if server else 'Kali Master'
    
    success = kali_ssh.purge_ram_cache_on_server(server) if server else kali_ssh.purge_ram_cache()
    audit_log_action("PURGE_RAM_CACHE", target_vm=target_name, details="drop_caches & sync", success=bool(success))
    
    if success:
        incident = log_and_notify_incident(
            service_name=f"Libération RAM ({target_name})", 
            status_message="Cache RAM purgé", 
            action_taken=f"Purge des buffers et caches mémoire via SSH par {session.get('full_name')}."
        )
        return jsonify({"status": "success", "message": f"Cache RAM purgé avec succès sur {target_name}.", "incident": incident})
    return jsonify({"status": "error", "message": f"Échec de la purge RAM sur {target_name}."}), 500


# ==========================================================================
# NETTOYAGE CIBLÉ — FICHIERS (Analyste SOC & Admin SecOps)
# ==========================================================================
@app.route('/api/cleanable_files', methods=['GET'])
def get_cleanable_files():
    node_name = request.args.get('node', '')
    if node_name and node_name not in ['all', 'default', 'kali']:
        server = find_server_by_name(node_name)
        if not server: return jsonify({"status": "error", "message": "Serveur introuvable"}), 404
        files = kali_ssh.list_cleanable_files_on_server(server)
    else:
        files = kali_ssh.list_cleanable_files()
    return jsonify({"status": "success", "files": files})


@app.route('/api/clean_files', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def clean_files():
    data = request.json or {}
    node_name = data.get('node', '')
    file_paths = data.get('files', [])
    if not file_paths: return jsonify({"status": "error", "message": "Aucun fichier sélectionné"}), 400
    
    server = find_server_by_name(node_name) if (node_name and node_name not in ['all', 'default', 'kali']) else None
    target_name = server.get('name', server.get('ip', 'Serveur')) if server else 'Kali Master'
    
    if server:
        success_count, error_count = kali_ssh.delete_files_on_server(file_paths, server)
    else:
        success_count, error_count = kali_ssh.delete_files(file_paths)
    
    audit_log_action("CLEAN_FILES", target_vm=target_name, details=f"{success_count} fichiers purgés : {file_paths[:3]}", success=(success_count > 0))
    
    if success_count > 0:
        incident = log_and_notify_incident(
            service_name=f"Nettoyage Disque ({target_name})", 
            status_message=f"{success_count} fichier(s) supprimé(s)", 
            action_taken=f"Suppression de {success_count} fichier(s) via SSH par {session.get('full_name')}."
        )
        return jsonify({
            "status": "success", 
            "message": f"{success_count} fichier(s) purgé(s) sur {target_name}.", 
            "success_count": success_count, 
            "error_count": error_count, 
            "incident": incident
        })
    return jsonify({"status": "error", "message": f"Aucun fichier n'a pu être supprimé sur {target_name}."}), 500


# ==========================================================================
# NETTOYAGE CIBLÉ — PROCESSUS (Admin SecOps uniquement pour Kill -9)
# ==========================================================================
@app.route('/api/top_processes', methods=['GET'])
def get_top_processes():
    node_name = request.args.get('node', '')
    sort_by = request.args.get('sort', 'cpu')
    if node_name and node_name not in ['all', 'default', 'kali']:
        server = find_server_by_name(node_name)
        if not server: return jsonify({"status": "error", "message": "Serveur introuvable"}), 404
        processes = kali_ssh.list_top_processes_on_server(server, sort_by=sort_by)
    else:
        processes = kali_ssh.list_top_processes(sort_by=sort_by)
    return jsonify({"status": "success", "processes": processes})


@app.route('/api/kill_process', methods=['POST'])
@roles_required('admin_secops')
def api_kill_process():
    data = request.json or {}
    node_name = data.get('node', '')
    pids = data.get('pids', [])
    single_pid = data.get('pid')
    
    if single_pid is not None:
        pids.append(single_pid)
        
    if not pids: 
        return jsonify({"status": "error", "message": "Aucun PID sélectionné"}), 400
    
    server = find_server_by_name(node_name) if (node_name and node_name not in ['all', 'default', 'kali']) else None
    target_name = server.get('name', server.get('ip', 'Serveur')) if server else 'Kali Master'
    
    if server:
        killed_count, error_count = kali_ssh.kill_processes_on_server(pids, server)
    else:
        killed_count, error_count = kali_ssh.kill_processes(pids)
    
    audit_log_action("KILL_PROCESS", target_vm=target_name, details=f"PIDs: {pids} (kill -9)", success=(killed_count > 0))
    
    if killed_count > 0:
        incident = log_and_notify_incident(
            service_name=f"Optimisation CPU ({target_name})", 
            status_message=f"{killed_count} processus arrêté(s)", 
            action_taken=f"Arrêt de {killed_count} processus (kill -9) par {session.get('full_name')}."
        )
        return jsonify({
            "status": "success", 
            "message": f"{killed_count} processus arrêté(s) sur {target_name}.", 
            "killed_count": killed_count, 
            "incident": incident
        })
    return jsonify({"status": "error", "message": f"Échec de l'arrêt des processus sur {target_name}."}), 500


# ==========================================================================
# NOTIFICATIONS & ALERTES & INCIDENTS
# ==========================================================================
@app.route('/api/notify', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def send_notification():
    incident = log_and_notify_incident("Test SOC", "Test Manuel", f"Envoi d'un rapport de test par {session.get('full_name')}.")
    audit_log_action("SEND_NOTIFICATION", target_vm="Local / SOC", details="Notification manuelle", success=True)
    return jsonify({"status": "success", "message": "Alerte envoyée", "incident": incident})


@app.route('/api/kali_alerts', methods=['GET'])
def get_kali_alerts():
    alerts = kali_ssh.get_active_alerts()
    return jsonify({"status": "success", "alerts": alerts})


@app.route('/api/resolve_kali_alert/<alert_id>', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def resolve_kali_alert(alert_id):
    if kali_ssh.resolve_kali_alert(alert_id):
        audit_log_action("RESOLVE_KALI_ALERT", target_vm="Local / Kali", details=f"Alerte {alert_id[:8]}", success=True)
        incident = log_and_notify_incident("Agent Kali", "Alerte Log", f"Résolution de l'alerte {alert_id[:8]} par {session.get('full_name')}.")
        return jsonify({"status": "success", "message": "Alerte résolue avec succès !", "incident": incident})
    return jsonify({"status": "error", "message": "Alerte introuvable"}), 404


@app.route('/api/incidents', methods=['GET'])
def get_incidents():
    incidents = Incident.query.order_by(Incident.timestamp.desc()).limit(100).all()
    return jsonify({"status": "success", "incidents": [i.to_dict() for i in incidents]})


@app.route('/api/logs', methods=['GET'])
def get_logs():
    return jsonify({"status": "success", "logs": kali_ssh.fetch_latest_logs()})


@app.route('/api/ban_ip', methods=['POST'])
@roles_required('admin_secops')
def ban_ip():
    ip = (request.json or {}).get("ip")
    if not ip: return jsonify({"status": "error", "message": "IP manquante."}), 400
    if kali_ssh.ban_ip(ip):
        audit_log_action("BAN_IP", target_vm="Firewall / iptables", details=f"IP Bloquée : {ip}", success=True)
        incident = log_and_notify_incident("Active Defense", "IP Banned", f"Blocage iptables de l'IP {ip} par {session.get('full_name')}.")
        return jsonify({"status": "success", "message": f"IP {ip} bloquée avec succès.", "incident": incident})
    return jsonify({"status": "error", "message": "Échec du blocage IP."}), 500


# ==========================================================================
# CONFIGURATION (Admin SecOps uniquement)
# ==========================================================================
@app.route('/api/config', methods=['GET', 'POST'])
def handle_config():
    if request.method == 'GET':
        return jsonify({"status": "success", "config": load_config()})
    else:
        if session.get('role') != 'admin_secops': 
            return jsonify({"status": "error", "message": "Privilèges insuffisants. Rôle requis: Admin SecOps"}), 403
        data = request.json or {}
        config = load_config()
        for key in ['company_name', 'dashboard_title', 'logo_text', 'logo_mode']:
            if key in data: config[key] = data[key]
        if data.get('remove_logo_image'):
            config['logo_image'] = ''
            config['logo_image_path'] = ''
            config['logo_mode'] = 'text'
        if save_config(config):
            audit_log_action("UPDATE_CONFIG", target_vm="Local / Config", details=f"Config : {data}", success=True)
            return jsonify({"status": "success", "message": "Configuration mise à jour.", "config": config})
        return jsonify({"status": "error", "message": "Erreur sauvegarde."}), 500


@app.route('/api/config/logo', methods=['POST'])
@roles_required('admin_secops')
def upload_logo():
    if 'logo' not in request.files: return jsonify({"status": "error", "message": "Aucun fichier"}), 400
    
    file = request.files['logo']
    ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    if ext not in {'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'}: return jsonify({"status": "error", "message": "Type non supporté"}), 400
    
    filename = f"logo.{ext}"
    file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
    config = load_config()
    config['logo_image'] = f"/static/img/{filename}"
    config['logo_image_path'] = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    config['logo_mode'] = 'image'
    save_config(config)
    audit_log_action("UPLOAD_LOGO", target_vm="Local / Config", details=f"Logo {filename}", success=True)
    return jsonify({"status": "success", "message": "Logo mis à jour.", "logo_url": config['logo_image'], "config": config})


@app.route('/api/config/remove_logo', methods=['POST'])
@roles_required('admin_secops')
def remove_logo():
    config = load_config()
    config['logo_image'] = ''
    config['logo_image_path'] = ''
    config['logo_mode'] = 'text'
    save_config(config)
    audit_log_action("REMOVE_LOGO", target_vm="Local / Config", details="Logo image supprimé", success=True)
    return jsonify({"status": "success", "message": "Logo image supprimé. Mode texte activé.", "config": config})


# ==========================================================================
# SERVEURS
# ==========================================================================
def get_server_status(server):
    ip, port, user, key_path = server.get("ip"), int(server.get("ssh_port", 22)), server.get("user", "r2schools"), os.path.expanduser(server.get("key_path", ""))
    default_result = {"name": server.get("name"), "ip": ip, "ssh_port": port, "role": server.get("role", ""), "status": "OFFLINE", "cpu": 0, "memory": 0, "disk": 0, "error": None}

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=ip, port=port, username=user, key_filename=key_path, timeout=SSH_TIMEOUT, allow_agent=False, look_for_keys=False, disabled_algorithms={'pubkeys': []})
        stdin, stdout, stderr = client.exec_command("free -m | awk '/Mem:/ {print $3/$2 * 100.0}'; cat /proc/loadavg | awk '{print $1}'; df / | tail -1 | awk '{print $5}' | sed 's/%//'", timeout=SSH_TIMEOUT)
        output = stdout.read().decode('utf-8', errors='replace').strip().split()
        client.close()
        
        return {
            "name": server.get("name"), "ip": ip, "ssh_port": port, "role": server.get("role", ""),
            "status": "ONLINE",
            "memory": round(float(output[0]), 1) if len(output) > 0 else 0.0,
            "cpu": min(round(float(output[1]) * 10, 1), 100.0) if len(output) > 1 else 0.0,
            "disk": min(round(float(output[2]), 1), 100.0) if len(output) > 2 else 0.0,
            "error": None
        }
    except Exception as e:
        default_result["error"] = str(e)
        return default_result


@app.route('/api/servers/status', methods=['GET'])
def servers_status():
    servers = load_servers()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_server = {executor.submit(get_server_status, srv): srv for srv in servers}
        for future in concurrent.futures.as_completed(future_to_server):
            try:
                results.append(future.result(timeout=SSH_TIMEOUT + 3))
            except Exception as e:
                srv = future_to_server[future]
                results.append({"name": srv.get("name", "Unknown"), "ip": srv.get("ip", ""), "status": "OFFLINE", "cpu": 0, "memory": 0, "disk": 0, "error": str(e)})
    return jsonify({"status": "success", "servers": sorted(results, key=lambda k: k['name'])})


@app.route('/api/server/<server_name>/remediate', methods=['POST'])
@roles_required('admin_secops', 'analyst')
def remediate_specific_server(server_name):
    target_server = find_server_by_name(server_name)
    if not target_server: return jsonify({"status": "error", "message": "Serveur introuvable"}), 404
    
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=target_server.get("ip"), port=target_server.get("ssh_port", 22), username=target_server.get("user", "r2schools"), key_filename=target_server.get("key_path", ""), timeout=SSH_TIMEOUT, disabled_algorithms={'pubkeys': []})
        client.exec_command("sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'", timeout=SSH_TIMEOUT)
        client.close()
        audit_log_action("REMEDIATE_SERVER", target_vm=target_server["name"], details="drop_caches via SSH", success=True)
        incident = log_and_notify_incident(target_server["name"], "Optimisation", f"Script exécuté sur {target_server['ip']} par {session.get('full_name')}.")
        return jsonify({"status": "success", "message": f"Remédiation exécutée sur {target_server['name']}.", "incident": incident})
    except Exception as e:
        audit_log_action("REMEDIATE_SERVER", target_vm=target_server.get("name", server_name), details=str(e), success=False)
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
