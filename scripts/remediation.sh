#!/bin/bash
# SOC Command Center - System Resource Remediation Script
# Usage: ./remediation.sh <resource>
# Supported resources: disk, cpu, ram

RESOURCE=$1

if [ -z "$RESOURCE" ]; then
    echo "Error: Missing resource parameter. Use 'disk', 'cpu', or 'ram'."
    exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting remediation for: $RESOURCE"

case "$RESOURCE" in
    "disk")
        echo "--> Clearing /tmp directory..."
        rm -rf /tmp/* 2>/dev/null
        
        echo "--> Purging apt cache..."
        apt-get clean 2>/dev/null
        
        echo "--> Truncating non-essential log files..."
        truncate -s 0 /var/log/syslog 2>/dev/null
        truncate -s 0 /var/log/auth.log 2>/dev/null
        
        echo "Disk remediation complete."
        ;;
    "cpu")
        echo "--> Identifying highest non-system CPU consumer..."
        # Finds the highest CPU consumer ignoring common system services
        TOP_PID=$(ps -eo pid,pcpu,comm --sort=-pcpu | awk 'NR>1 && $3 !~ /sshd|systemd|kworker|root|Xorg|bash/ {if ($2 > 10.0) print $1; exit}')
        
        if [ ! -z "$TOP_PID" ]; then
            echo "--> Terminating PID $TOP_PID..."
            kill -15 $TOP_PID 2>/dev/null
            sleep 2
            kill -9 $TOP_PID 2>/dev/null
            echo "CPU remediation complete."
        else
            echo "No non-system process consuming high CPU found. No action taken."
        fi
        ;;
    "ram")
        echo "--> Purging RAM cache (drop_caches)..."
        sync
        echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
        
        echo "--> Identifying highest non-system RAM consumer..."
        TOP_RAM_PID=$(ps -eo pid,pmem,comm --sort=-pmem | awk 'NR>1 && $3 !~ /sshd|systemd|kworker|root|Xorg|bash|dockerd/ {if ($2 > 10.0) print $1; exit}')
        
        if [ ! -z "$TOP_RAM_PID" ]; then
            echo "--> Terminating high RAM PID $TOP_RAM_PID..."
            kill -15 $TOP_RAM_PID 2>/dev/null
            sleep 2
            kill -9 $TOP_RAM_PID 2>/dev/null
        fi
        echo "RAM remediation complete."
        ;;
    *)
        echo "Error: Unknown resource '$RESOURCE'. Use 'disk', 'cpu', or 'ram'."
        exit 1
        ;;
esac

exit 0
