"""Diagnostic de la configuration d'envoi des alertes SOC.

Usage : python test_email.py
Utilise exactement la meme configuration que les alertes automatiques (mailer.py).
"""
import mailer


def main():
    print(f"[*] Expediteur   : {mailer.SENDER_EMAIL}")
    print(f"[*] Destinataire : {mailer.RECEIVER_EMAIL}")
    print(f"[*] Serveur SMTP : {mailer.SMTP_HOST}:{mailer.SMTP_PORT}")
    print(f"[*] Mot de passe : {len(mailer.SENDER_PASSWORD)} caracteres")

    if len(mailer.SENDER_PASSWORD) != 16:
        print(
            "[!] Un mot de passe d'application Gmail fait 16 caracteres. "
            "Generez-en un sur https://myaccount.google.com/apppasswords"
        )

    ok = mailer.send_soc_alert_email(
        ticket_id="TEST-001",
        service_name="Test SMTP",
        status_message="Diagnostic de configuration",
        action_taken="Envoi d'un email de test",
        assignee="Script de diagnostic",
    )
    print("SUCCESS : configuration email operationnelle." if ok else "ECHEC : voir l'erreur ci-dessus.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
