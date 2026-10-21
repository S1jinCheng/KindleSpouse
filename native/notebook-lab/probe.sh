umask 077
KS_LAB_DIRECTORY="${KS_LAB_DIRECTORY:-/mnt/us/kindlespouse/notebook-lab}"
KS_LAB_TICKS="${KS_LAB_TICKS:-180}"
case "$KS_LAB_DIRECTORY" in /*) ;; *) exit 2 ;; esac
case "$KS_LAB_DIRECTORY" in *[!A-Za-z0-9_./-]*|*/../*|*/..) exit 2 ;; esac
case "$KS_LAB_TICKS" in ''|*[!0-9]*) exit 2 ;; esac
[ "$KS_LAB_TICKS" -ge 1 ] && [ "$KS_LAB_TICKS" -le 180 ] || exit 2

ks_command() {
    if command -v timeout >/dev/null 2>&1; then timeout 3 "$@"; else "$@"; fi
}

ks_process_stamp() {
    awk 'sub(/^.*\) /, "") { print $20 }' "/proc/$1/stat" 2>/dev/null
}

ks_handoff() {
    case "$1" in ''|*[!0-9]*) exit 2 ;; esac
    case "$2" in ''|*[!0-9]*) exit 2 ;; esac
    [ "$1" -gt 1 ] && [ -n "$2" ] || exit 2
    KS_LAB_PARENT="$1"
    KS_LAB_STAMP="$2"
    KS_LAB_WAIT=0
    while [ -e "/proc/$KS_LAB_PARENT/stat" ]; do
        [ "$(ks_process_stamp "$KS_LAB_PARENT")" = "$KS_LAB_STAMP" ] || exit 4
        [ "$KS_LAB_WAIT" -lt 30 ] || exit 5
        sleep 1
        KS_LAB_WAIT=$((KS_LAB_WAIT + 1))
    done
    ks_capture start
}

ks_capture() {
    mkdir -p "$KS_LAB_DIRECTORY" || exit 1
    mkdir "$KS_LAB_DIRECTORY/running" 2>/dev/null || exit 3
    trap 'rmdir "$KS_LAB_DIRECTORY/running" 2>/dev/null' EXIT
    trap 'exit 130' INT TERM HUP
    KS_LAB_RUN="$KS_LAB_DIRECTORY/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mkdir "$KS_LAB_RUN" || exit 1
    printf '%s\n' "capture_started" > "$KS_LAB_RUN/status.txt"
    {
        cat /etc/prettyversion.txt 2>/dev/null
        printf '\nKOReader: '
        cat /mnt/us/koreader/git-rev 2>/dev/null
        printf '\nApplication manager properties:\n'
        ks_command lipc-probe -v com.lab126.appmgrd 2>&1
        printf '\nLIPC sources:\n'
        ks_command lipc-probe -l 2>&1
        printf '\nNotebook app files:\n'
        for KS_LAB_APP in /app/*[Nn]otebook* /app/*[Ss]crib* /opt/amazon/*[Nn]otebook*; do
            [ -e "$KS_LAB_APP" ] && printf '%s\n' "$KS_LAB_APP"
        done
    } > "$KS_LAB_RUN/capabilities.txt"
    if command -v sqlite3 >/dev/null 2>&1 && [ -f /var/local/appreg.db ]; then
        ks_command sqlite3 -readonly /var/local/appreg.db '.schema' > "$KS_LAB_RUN/appreg-schema.txt" 2>&1
        ks_command sqlite3 -readonly /var/local/appreg.db ".backup '$KS_LAB_RUN/appreg.db'" 2> "$KS_LAB_RUN/appreg-backup-error.txt"
    fi
    KS_LAB_TICK=0
    KS_LAB_LAST=''
    while [ "$KS_LAB_TICK" -lt "$KS_LAB_TICKS" ]; do
        KS_LAB_VIEW="$(ks_command lipc-get-prop com.lab126.appmgrd activeView 2>&1)"
        KS_LAB_CONTEXT="$(ks_command lipc-get-prop com.lab126.appmgrd ActiveContext 2>&1)"
        KS_LAB_STATE="$KS_LAB_VIEW
$KS_LAB_CONTEXT"
        if [ "$KS_LAB_STATE" != "$KS_LAB_LAST" ]; then
            {
                printf '\nTIME %s TICK %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$KS_LAB_TICK"
                printf 'activeView: %s\nActiveContext: %s\n' "$KS_LAB_VIEW" "$KS_LAB_CONTEXT"
            } >> "$KS_LAB_RUN/navigation.txt"
            KS_LAB_LAST="$KS_LAB_STATE"
        fi
        if [ "$KS_LAB_TICK" -eq 0 ] && [ "$1" = start ]; then
            ks_command lipc-set-prop com.lab126.appmgrd start 'app://com.lab126.KPPMainApp?view=KPP_NOTEBOOK' > "$KS_LAB_RUN/launch-result.txt" 2>&1
            printf 'exit_code=%s\n' "$?" >> "$KS_LAB_RUN/launch-result.txt"
        fi
        KS_LAB_TICK=$((KS_LAB_TICK + 1))
        sleep 1
    done
    printf '%s\n' "capture_completed" > "$KS_LAB_RUN/status.txt"
}

case "$1" in
    start|record)
        sh "$0" capture "$1" < /dev/null > /dev/null 2>&1 &
        ;;
    capture)
        case "$2" in start|record) ks_capture "$2" ;; *) exit 2 ;; esac
        ;;
    handoff)
        ks_handoff "$2" "$3"
        ;;
    *) exit 2 ;;
esac
