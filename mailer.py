import smtplib
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, formatdate, make_msgid

from models import local_now

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv absent : lecture manuelle du .env
    def load_dotenv():
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        if not os.path.exists(env_path):
            return False
        with open(env_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return True

load_dotenv()

# ============================================================================
# CONFIGURATION EMAIL
# ============================================================================
DEFAULT_SENDER = "ghita.tazi2026@gmail.com"
DEFAULT_RECEIVER = "ghita.soc.test@gmail.com"


def _clean(value):
    return value.strip().strip('"').strip("'") if value else value


SENDER_EMAIL = _clean(os.getenv("EMAIL_SENDER")) or DEFAULT_SENDER
# Gmail affiche les mots de passe d'application par groupes de 4 : les espaces
# doivent être retirés avant l'authentification SMTP.
SENDER_PASSWORD = (_clean(os.getenv("EMAIL_PASSWORD")) or "").replace(" ", "")
RECEIVER_EMAIL = _clean(os.getenv("EMAIL_RECEIVER")) or DEFAULT_RECEIVER

SMTP_HOST = _clean(os.getenv("SMTP_HOST")) or "smtp.gmail.com"
SMTP_PORT = int(os.getenv("SMTP_PORT") or 465)
SMTP_TIMEOUT = 20

# Machine affichee quand l'appelant ne precise pas le serveur cible.
DEFAULT_MACHINE = "Kali Master"


def print_email_config_status():
    """Diagnostic affiche au demarrage : sans mot de passe, aucune alerte ne part."""
    if not SENDER_PASSWORD:
        print(
            "[MAILER] ALERTES DESACTIVEES : EMAIL_PASSWORD absent du .env. "
            f"Creez un mot de passe d'application Gmail (16 caracteres) pour {SENDER_EMAIL} "
            "sur https://myaccount.google.com/apppasswords"
        )
    else:
        print(
            f"[MAILER] Alertes email actives : {SENDER_EMAIL} -> {RECEIVER_EMAIL} "
            f"via {SMTP_HOST}:{SMTP_PORT}"
        )


def _build_soc_email_body(ticket_id, service_name, status_message, action_taken, assignee, machine):
    """Construit le corps HTML de l'email d'alerte SOC."""
    timestamp = local_now().strftime("%d/%m/%Y %H:%M:%S")
    
    html = f"""
    <html>
    <body style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #F4F4F4; color: #1A1A1A; padding: 20px;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E0E0E0; border-top: 4px solid #E31937; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
            <h1 style="color: #4F2683; font-size: 18px; margin-top: 0; margin-bottom: 20px; font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #E0E0E0; padding-bottom: 10px;">
                Notification Système
            </h1>
            
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <tr>
                    <td style="padding: 8px 0; color: #666666; width: 120px;">Ticket ID</td>
                    <td style="padding: 8px 0; color: #1A1A1A; font-weight: 600;">{ticket_id}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Horodatage</td>
                    <td style="padding: 8px 0; color: #1A1A1A; border-top: 1px solid #F0F0F0;">{timestamp}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Serveur / VM</td>
                    <td style="padding: 8px 0; color: #1A1A1A; font-weight: 600; border-top: 1px solid #F0F0F0;">{machine}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Service Impacté</td>
                    <td style="padding: 8px 0; color: #E31937; font-weight: 600; border-top: 1px solid #F0F0F0;">{service_name}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Statut</td>
                    <td style="padding: 8px 0; color: #1A1A1A; border-top: 1px solid #F0F0F0;">{status_message}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Detail / Action</td>
                    <td style="padding: 8px 0; color: #1A1A1A; border-top: 1px solid #F0F0F0;">{action_taken}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Intervenant</td>
                    <td style="padding: 8px 0; color: #1A1A1A; font-weight: 600; border-top: 1px solid #F0F0F0;">{assignee}</td>
                </tr>
            </table>
            
            <div style="margin-top: 25px; padding-top: 15px; border-top: 1px solid #E0E0E0; font-size: 11px; color: #8D8D8D; text-align: center;">
                Ce message est généré automatiquement par le portail de supervision informatique.<br>
                CGI IT Operations
            </div>
        </div>
    </body>
    </html>
    """
    return html


def _build_soc_email_plain(ticket_id, service_name, status_message, action_taken, assignee, machine):
    """Construit le corps texte brut de l'email d'alerte SOC."""
    timestamp = local_now().strftime("%d/%m/%Y %H:%M:%S")
    
    body = f"""
=== NOTIFICATION SYSTÈME - CGI IT OPERATIONS ===

Ticket ID     : {ticket_id}
Horodatage    : {timestamp}
Serveur / VM  : {machine}
Service       : {service_name}
Statut        : {status_message}
Detail        : {action_taken}
Intervenant   : {assignee}

---
Ce message est généré automatiquement par le portail de supervision.
CGI IT Operations
"""
    return body


def _send_message(msg):
    """Envoie le message en SSL (465) avec repli STARTTLS (587) si le port est bloqué."""
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, 465, timeout=SMTP_TIMEOUT) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.send_message(msg)
        return

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as server:
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.send_message(msg)


def send_soc_alert_email(ticket_id, service_name, status_message, action_taken, assignee, machine=None):
    """
    Envoie un email d'alerte SOC via Gmail SMTP SSL.
    Appelé depuis app.py dans un thread de fond.
    """
    if not SENDER_PASSWORD:
        print(
            "[MAILER] EMAIL_PASSWORD absent du .env : créez un mot de passe "
            f"d'application Gmail (16 caractères) pour {SENDER_EMAIL} sur "
            "https://myaccount.google.com/apppasswords"
        )
        return False
    
    try:
        msg = MIMEMultipart("alternative")
        msg['From'] = formataddr(("SOC Command Center", SENDER_EMAIL))
        msg['To'] = RECEIVER_EMAIL
        msg['Reply-To'] = SENDER_EMAIL
        machine = machine or DEFAULT_MACHINE
        msg['Subject'] = f"[ALERTE SOC] Ticket {ticket_id} - {service_name} - {status_message}"
        # En-tetes standards : sans Date ni Message-ID, Gmail classe le message en spam.
        msg['Date'] = formatdate(localtime=True)
        msg['Message-ID'] = make_msgid(domain=SENDER_EMAIL.split("@")[-1])
        msg['Auto-Submitted'] = 'auto-generated'
        
        # Attach plain text version
        plain_body = _build_soc_email_plain(
            ticket_id, service_name, status_message, action_taken, assignee, machine
        )
        msg.attach(MIMEText(plain_body, 'plain'))
        
        # Attach HTML version
        html_body = _build_soc_email_body(
            ticket_id, service_name, status_message, action_taken, assignee, machine
        )
        msg.attach(MIMEText(html_body, 'html'))
        
        print(f"[MAILER] Envoi de l'alerte {ticket_id} à {RECEIVER_EMAIL}...")
        
        _send_message(msg)
        
        print(f"[MAILER] Email envoyé à {RECEIVER_EMAIL}")
        return True
        
    except smtplib.SMTPAuthenticationError as e:
        print(
            f"[MAILER] Erreur d'authentification : Gmail refuse {SENDER_EMAIL} : {e}. "
            "Vérifiez que la validation en deux étapes est active et que "
            "EMAIL_PASSWORD est un mot de passe d'application, pas le mot de passe du compte."
        )
        return False
    except Exception as e:
        print(f"[MAILER] Erreur d'envoi - {type(e).__name__}: {e}")
        return False
