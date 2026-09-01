import smtplib
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# ============================================================================
# CONFIGURATION EMAIL
# ============================================================================
SENDER_EMAIL = os.getenv("EMAIL_SENDER")
SENDER_PASSWORD = os.getenv("EMAIL_PASSWORD")
RECEIVER_EMAIL = os.getenv("EMAIL_RECEIVER", "ghita.soc.test@gmail.com")

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


def _build_soc_email_body(ticket_id, service_name, status_message, action_taken, assignee):
    """Construit le corps HTML de l'email d'alerte SOC."""
    timestamp = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    
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
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Service Impacté</td>
                    <td style="padding: 8px 0; color: #E31937; font-weight: 600; border-top: 1px solid #F0F0F0;">{service_name}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Statut</td>
                    <td style="padding: 8px 0; color: #1A1A1A; border-top: 1px solid #F0F0F0;">{status_message}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666666; border-top: 1px solid #F0F0F0;">Action Requise</td>
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


def _build_soc_email_plain(ticket_id, service_name, status_message, action_taken, assignee):
    """Construit le corps texte brut de l'email d'alerte SOC."""
    timestamp = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    
    body = f"""
=== NOTIFICATION SYSTÈME - CGI IT OPERATIONS ===

Ticket ID     : {ticket_id}
Horodatage    : {timestamp}
Service       : {service_name}
Statut        : {status_message}
Action        : {action_taken}
Intervenant   : {assignee}

---
Ce message est généré automatiquement par le portail de supervision.
CGI IT Operations
"""
    return body


def send_soc_alert_email(ticket_id, service_name, status_message, action_taken, assignee):
    """
    Envoie un email d'alerte SOC via Gmail SMTP SSL.
    Appelé depuis app.py dans un thread de fond.
    """
    if not SENDER_EMAIL or not SENDER_PASSWORD or not RECEIVER_EMAIL:
        print("❌ [MAILER] Identifiants email manquants dans le .env")
        return False
    
    try:
        msg = MIMEMultipart("alternative")
        msg['From'] = SENDER_EMAIL
        msg['To'] = RECEIVER_EMAIL
        msg['Subject'] = f"🚨 ALERTE SOC {ticket_id} - {service_name}"
        
        # Attach plain text version
        plain_body = _build_soc_email_plain(
            ticket_id, service_name, status_message, action_taken, assignee
        )
        msg.attach(MIMEText(plain_body, 'plain'))
        
        # Attach HTML version
        html_body = _build_soc_email_body(
            ticket_id, service_name, status_message, action_taken, assignee
        )
        msg.attach(MIMEText(html_body, 'html'))
        
        print(f"🟢 [MAILER] Envoi de l'alerte {ticket_id} à {RECEIVER_EMAIL}...")
        
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.send_message(msg)
        
        print(f"✅ [MAILER SUCCÈS] Email envoyé à {RECEIVER_EMAIL}")
        return True
        
    except Exception as e:
        print(f"❌ [MAILER ERREUR] {str(e)}")
        return False
