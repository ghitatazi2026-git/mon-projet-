import os
import smtplib
from email.mime.text import MIMEText

def load_env_manual():
    """Charge le .env manuellement sans dependance externe."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    val = val.strip().strip('"').strip("'")
                    os.environ[key.strip()] = val

def test_gmail_ssl():
    load_env_manual()
    sender = os.getenv("EMAIL_SENDER")
    password = os.getenv("EMAIL_PASSWORD")
    receiver = os.getenv("EMAIL_RECEIVER")
    
    print(f"[*] Expediteur : {sender}")
    print(f"[*] Destinataire : {receiver}")
    print(f"[*] Mot de passe (longueur) : {len(password) if password else 0} caracteres")
    
    msg = MIMEText("Test de connexion SSL depuis le projet KALI SOC Command Center.")
    msg['Subject'] = "Test Gmail SSL (Port 465)"
    msg['From'] = sender
    msg['To'] = receiver
    
    try:
        print("[*] Connexion a smtp.gmail.com sur le port 465...")
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            print("[*] Authentification...")
            server.login(sender, password)
            print("[*] Envoi de l'email...")
            server.send_message(msg)
            
        print("SUCCESS : Email de test envoye avec succes. Configuration SSL OK.")
    except Exception as e:
        print(f"ERREUR : Impossible de se connecter ou d'envoyer l'email : {str(e)}")

if __name__ == "__main__":
    test_gmail_ssl()
                                                                                                                            