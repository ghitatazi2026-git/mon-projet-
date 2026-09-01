#!/bin/bash

# ==============================================================================
# Script de Simulation de Crise (Stress Test)
# Usage: ./stress_test.sh <resource>
# ==============================================================================

RESOURCE=$1

if [ -z "$RESOURCE" ]; then
    echo "Erreur : Spécifiez une ressource à saturer (disk, ram, cpu)."
    exit 1
fi

case $RESOURCE in
    disk)
        echo "[*] Simulation Saturation Disque..."
        # Création d'un fichier factice lourd (environ 3 Go si l'espace le permet)
        # On utilise dd pour générer un fichier rempli de zéros.
        # Ce fichier sera supprimé par le script de remédiation.
        dd if=/dev/zero of=/tmp/test_heavy_file.tmp bs=1M count=3000 2>/dev/null &
        echo "Saturation DISK lancée en arrière-plan."
        ;;
    
    ram)
        echo "[*] Simulation Saturation RAM..."
        # Lancement d'un processus Python qui alloue ~1.5 Go de RAM en arrière-plan.
        # Il se terminera automatiquement après 120 secondes.
        python3 -c "a = 'X' * (1024 * 1024 * 1500); import time; time.sleep(120)" &
        echo "Saturation RAM lancée en arrière-plan."
        ;;
        
    cpu)
        echo "[*] Simulation Saturation CPU..."
        # Boucle infinie pour pousser l'usage CPU d'un cœur à 100%.
        python3 -c "while True: pass" &
        echo "Saturation CPU lancée en arrière-plan."
        ;;
        
    *)
        echo "Ressource inconnue: $RESOURCE"
        exit 1
        ;;
esac

exit 0
