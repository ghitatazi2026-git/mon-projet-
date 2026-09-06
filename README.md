 KALI SOC - Command Center 

Bienvenue dans le dépôt du **KALI SOC Command Center**, un tableau de bord (Dashboard) interactif développé en Python (Flask) et JavaScript (Chart.js) permettant de superviser en temps réel une machine Kali Linux, d'intervenir en cas d'incident et de générer des rapports.

----Aperçu du Dashboard :

![Aperçu du Dashboard](docs/screenshot_dashboard.png)
*Vue principale du Dashboard avec les métriques en temps réel et les services.*

![Active Defense & Logs](docs/screenshot_active_defense.png)
*Défense active (Bannissement IP) et Terminal de Logs en direct.*

----Fonctionnalités Principales : 

Télémétrie en Temps Réel : Graphiques dynamiques (CPU, RAM, Attaques/min) propulsés par Chart.js avec un design néon/rouge.
Active Defense (Blocage IP) : Détection d'IPs suspectes et bouton "BAN IP" permettant d'exécuter une règle `iptables` sur la machine distante.
Gestion des Services : Boutons interactifs (ON/OFF) pour piloter directement les services critiques de Kali (Apache2, MariaDB, Rsync, Cron) via SSH.
Console de Logs en Direct : Affichage continu style "Terminal" des dernières entrées de `/var/log/auth.log`.
Alertes Automatisées : Envoi d'emails automatiques vers `ghita.soc.test@gmail.com` lors d'actions de remédiation (Blocage IP, Start/Stop de service).
Génération de Rapports PDF : Exportation en 1 clic d'un rapport officiel d'incident SOC récapitulant l'état du système et signé numériquement.

---Contrôle & Sécurité (Les 4 Piliers) :

Ce Dashboard SOC n'est pas seulement un outil de visualisation, il intègre des mécanismes de contrôle stricts pour garantir des interventions sécurisées :

1. Contrôle des Accès (Qui peut agir ?)
Dans un véritable SOC, les actions de remédiation sont restreintes. 
   Gestion des rôles : Un utilisateur classique peut uniquement consulter le dashboard.
   Authentification : Seul un analyste ou administrateur authentifié (`analyst_soc`) possède les droits pour cliquer sur "Résoudre l'incident" ou "Optimiser". L'interface présente une Modale de Connexion (Dark Theme) si l'utilisateur tente une action critique sans être connecté. En arrière-plan, Flask vérifie la session HTTP sécurisée (`session['role'] == 'analyst'`).

2. Contrôle d'Exécution & Anti-Spam (Rate Limiting / Cooldown)
Pour éviter les fausses manœuvres (ex: un double-clic involontaire) ou la saturation du réseau :
   Verrouillage côté client : Le bouton de résolution se désactive pendant l'exécution et ne déclenche l'action qu'une fois.
   Cooldown serveur : Flask applique un délai (Cooldown) sur les routes d'API critiques pour éviter qu'une requête répétée n'envoie 10 requêtes simultanées ou ne spamme la boîte mail d'alertes.
   Intrusion Detection : Un compteur bloque l'interface pendant 10s après 3 tentatives de résolution échouées/non autorisées.

3. Contrôle des Commandes (Sécurité du Code)
Toute action système exécutée depuis le backend Flask vers la machine Linux est hautement sécurisée.
    Anti-Command Injection : Les commandes exécutées sont strictement définies (statiques ou via des paramètres validés strictement comme `disk`, `ram`, `cpu`).
    Isolation : Pour les actions complexes, le backend n'injecte pas de code dans le shell cible. Il transmet le script de remédiation encodé en Base64, qui est ensuite décodé et exécuté de manière sécurisée via SSH, évitant ainsi toute compromission par injection de caractères spéciaux.

4. Traçabilité (Audit Log & Main Courante)
    Log Serveur : Toute tentative de remédiation (réussie ou bloquée) est consignée dans un fichier local `audit.log` formaté (`[AUDIT] Action 'RESOLVE' exécutée par l'utilisateur...`).
    Tableau de bord : La carte "Main Courante" affiche en temps réel le suivi des incidents, l'action prise, le statut et l'intervenant pour une visibilité totale sur l'activité du SOC.


---Prérequis

- Python 3.8+
- Une machine (VM ou physique) sous **Kali Linux** accessible en réseau local via SSH.
- Les identifiants SSH de la machine cible (configurables dans `kali_ssh.py`).

---Installation & Lancement

1. Cloner le dépôt :
```bash
git clone https://github.com/ghitatazi2026-git/kali-soc-dashboard.git
cd kali-soc-dashboard
```

2. Installer les dépendances Python :
```bash
pip install -r requirements.txt
```

3. Configuration de l'environnement :
Vérifions que le fichier `.env` est correctement configuré à la racine du projet avec mes identifiants SMTP :
```env
EMAIL_SENDER="ghita.tazi2026@gmail.com"
EMAIL_PASSWORD="egos psek lvhn gnqq"
EMAIL_RECEIVER="ghita.tazi@etu.uae.ac.ma"
```

4. Configuration de l'hôte Kali (SSH) :
Dans le fichier `kali_ssh.py`, mettez à jour l'IP et les identifiants de votre machine Kali si nécessaire :
```python
KALI_IP = "192.168.132.10"
KALI_USER = "r2schools"
KALI_PASSWORD = "ghita"
```

5. Lancer l'application :
```bash
python app.py
```
Le tableau de bord sera ensuite accessible via le navigateur à l'adresse : [http://127.0.0.1:5000]( http://127.0.0.1:5000).

---Structure du Projet

```text
📁 kali-soc-dashboard/
├── 📄 app.py              # Backend Flask (Routes API et Web)
├── 📄 kali_ssh.py         # Module de connexion SSH (Paramiko) et Commandes système
├── 📄 mailer.py           # Module d'envoi d'emails SMTP (Alerte SOC)
├── 📄 requirements.txt    # Dépendances Python (Flask, paramiko, python-dotenv)
├── 📁 templates/
│   └── 📄 index.html      # Structure HTML du Dashboard (Bento Grid)
└── 📁 static/
    ├── 📁 css/
    │   └── 📄 style.css   # Styles (Design Glassmorphism, Thème Néon Rouge)
    └── 📁 js/
        └── 📄 main.js     # Logique Frontend (Charts, API Fetch, jsPDF)
```

---Auteur

Ghita - Technicienne Spécialisée SOC  
Projet réalisé dans le cadre de la supervision et de la sécurisation des environnements Linux.
