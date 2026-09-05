# KALI SOC - Command Center

Tableau de bord de supervision développé en Python (Flask) et JavaScript (Chart.js). Il permet de superviser en temps réel une machine Kali Linux, d'intervenir en cas d'incident et de générer des rapports.

**Note :** ce projet est conçu à des fins éducatives et de démonstration SOC (Security Operations Center).

---

## Aperçu du Dashboard

*(Ajoutez ici vos captures d'écran en remplaçant les liens)*

![Aperçu du Dashboard](docs/screenshot_dashboard.png)
*Vue principale du Dashboard avec les métriques en temps réel et les services.*

![Active Defense & Logs](docs/screenshot_active_defense.png)
*Défense active (Bannissement IP) et Terminal de Logs en direct.*

---

## Fonctionnalités Principales

* **Télémétrie en Temps Réel** : graphiques dynamiques (CPU, RAM, Attaques/min) propulsés par Chart.js.
* **Active Defense (Blocage IP)** : détection d'IPs suspectes et bouton "BAN IP" permettant d'exécuter une règle `iptables` sur la machine distante.
* **Gestion des Services** : boutons interactifs (ON/OFF) pour piloter directement les services critiques de Kali (Apache2, MariaDB, Rsync, Cron) via SSH.
* **Console de Logs en Direct** : affichage continu des dernières entrées de `/var/log/auth.log`.
* **Alertes Automatisées** : envoi d'emails automatiques vers `ghita.tazi@etu.uae.ac.ma` lors d'actions de remédiation (blocage IP, start/stop de service).
* **Génération de Rapports PDF** : exportation en un clic d'un rapport d'incident SOC récapitulant l'état du système.

---

## Contrôle & Sécurité (Les 4 Piliers)

Ce dashboard SOC n'est pas seulement un outil de visualisation : il intègre des mécanismes de contrôle stricts pour garantir des interventions sécurisées.

### 1. Contrôle des Accès (Qui peut agir ?)
Dans un véritable SOC, les actions de remédiation sont restreintes.
* **Gestion des rôles :** un utilisateur classique peut uniquement consulter le dashboard.
* **Authentification :** seul un analyste ou administrateur authentifié (`analyst_soc`) possède les droits pour cliquer sur "Résoudre l'incident" ou "Optimiser". L'interface présente une modale de connexion si l'utilisateur tente une action critique sans être connecté. En arrière-plan, Flask vérifie la session HTTP sécurisée (`session['role'] == 'analyst'`).

### 2. Contrôle d'Exécution & Anti-Spam (Rate Limiting / Cooldown)
Pour éviter les fausses manœuvres (par exemple un double-clic involontaire) ou la saturation du réseau :
* **Verrouillage côté client :** le bouton de résolution se désactive pendant l'exécution et ne déclenche l'action qu'une fois.
* **Cooldown serveur :** Flask applique un délai sur les routes d'API critiques pour éviter qu'une requête répétée n'envoie plusieurs requêtes simultanées ou ne sature la boîte mail d'alertes.
* **Intrusion Detection :** un compteur bloque l'interface pendant 10 secondes après 3 tentatives de résolution échouées ou non autorisées.

### 3. Contrôle des Commandes (Sécurité du Code)
Toute action système exécutée depuis le backend Flask vers la machine Linux est sécurisée.
* **Anti-Command Injection :** les commandes exécutées sont strictement définies (statiques ou via des paramètres validés tels que `disk`, `ram`, `cpu`).
* **Isolation :** pour les actions complexes, le backend n'injecte pas de code dans le shell cible. Il transmet le script de remédiation encodé en Base64, qui est ensuite décodé et exécuté via SSH, évitant toute compromission par injection de caractères spéciaux.

### 4. Traçabilité (Audit Log & Main Courante)
* **Log Serveur :** toute tentative de remédiation (réussie ou bloquée) est consignée dans un fichier local `audit.log` formaté (`[AUDIT] Action 'RESOLVE' exécutée par l'utilisateur...`).
* **Tableau de bord :** la carte "Main Courante" affiche en temps réel le suivi des incidents, l'action prise, le statut et l'intervenant.

---

## Prérequis

- Python 3.8+
- Une machine (VM ou physique) sous **Kali Linux** accessible en réseau local via SSH.
- Les identifiants SSH de la machine cible (configurables dans `kali_ssh.py`).

---

## Installation & Lancement

**1. Cloner le dépôt :**
```bash
git clone https://github.com/VOTRE_NOM/kali-soc-dashboard.git
cd kali-soc-dashboard
```

**2. Installer les dépendances Python :**
```bash
pip install -r requirements.txt
```

**3. Configuration de l'environnement :**
Copiez `.env.example` en `.env` à la racine du projet et renseignez vos identifiants SMTP :
```env
EMAIL_SENDER="ghita.tazi2026@gmail.com"
EMAIL_PASSWORD="mot_de_passe_application_16_caracteres"
EMAIL_RECEIVER="ghita.tazi@etu.uae.ac.ma"
```

`EMAIL_PASSWORD` doit être un **mot de passe d'application** Gmail (16 caractères, généré sur https://myaccount.google.com/apppasswords après activation de la validation en deux étapes). Le mot de passe habituel du compte est refusé par Gmail (`534 5.7.9 Application-specific password required`).

Vérifiez la configuration avant de lancer le dashboard :
```bash
python test_email.py
```

**4. Configuration de l'hôte Kali (SSH) :**
Dans le fichier `kali_ssh.py`, mettez à jour l'IP et les identifiants de votre machine Kali si nécessaire :
```python
KALI_IP = "192.168.132.130"
KALI_USER = "r2schools"
KALI_PASSWORD = "votremotdepasse"
```

**5. Lancer l'application :**
```bash
python app.py
```
Le tableau de bord est ensuite accessible à l'adresse [http://localhost:5000](http://localhost:5000).

---

## Structure du Projet

```text
kali-soc-dashboard/
├── app.py              # Backend Flask (routes API et web)
├── kali_ssh.py         # Module de connexion SSH (Paramiko) et commandes système
├── mailer.py           # Module d'envoi d'emails SMTP (alertes SOC)
├── test_email.py       # Diagnostic de la configuration email
├── requirements.txt    # Dépendances Python (Flask, paramiko, python-dotenv)
├── templates/
│   └── index.html      # Structure HTML du dashboard
└── static/
    ├── css/
    │   └── style.css   # Feuilles de style
    └── js/
        └── main.js     # Logique frontend (Chart.js, API Fetch, jsPDF)
```

---

## Auteur

**Ghita - Technicienne Spécialisée SOC**
Projet réalisé dans le cadre de la supervision et de la sécurisation des environnements Linux.
