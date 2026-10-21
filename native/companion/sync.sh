cd /mnt/us/kindlespouse || exit 1
if [ -f pause.requested ] && [ "$1" != "titles" ] && [ "$1" != "profile" ] && [ "$1" != "books" ]; then exit 0; fi
if [ -f sync.lock ]; then
    command -v readlink > /dev/null 2>&1 || exit 1
    for process in /proc/[0-9]*/exe; do
        target=$(readlink "$process" 2>/dev/null)
        case "$target" in
            */kindlespouse/kindlespouse-sync*) exit 0 ;;
        esac
    done
    modified=$(stat -c %Y sync.lock 2>/dev/null)
    now=$(date +%s)
    case "$modified" in
        ''|*[!0-9]*) exit 1 ;;
    esac
    if [ "$((now - modified))" -lt 10 ]; then exit 0; fi
    mv -f sync.lock sync.lock.interrupted || exit 1
fi
if [ -f kindlespouse-sync-next ]; then
    chmod 700 kindlespouse-sync-next || exit 1
    mv -f kindlespouse-sync-next kindlespouse-sync || exit 1
fi
chmod 700 kindlespouse-sync rclone || exit 1
chmod 600 rclone.conf config.json || exit 1
started=$(date +%s)
export GOMAXPROCS=1
if [ "$1" != "profile" ] && [ "$1" != "books" ] && [ "$1" != "updates" ] && ! sh /mnt/us/kindlespouse/catalog.sh > /dev/null 2>&1; then
    printf '{"state":"failed","stage":"syncing_titles","error":"Cannot refresh notebook titles. Try Collect notebook titles.","startedAt":%s,"updatedAt":%s}\n' "$started" "$(date +%s)" > progress.json.launch
    mv -f progress.json.launch progress.json
    exit 1
fi
if [ "$1" = "profile" ]; then
    set -- --profile-only
elif [ "$1" = "titles" ]; then
    set -- --titles-only
elif [ "$1" = "books" ]; then
    set -- --books-only
elif [ "$1" = "updates" ]; then
    set -- --updates-only
else
    set --
fi
if command -v nice > /dev/null 2>&1; then
    nice -n 10 ./kindlespouse-sync --config /mnt/us/kindlespouse/config.json "$@" > /dev/null 2> /dev/null
else
    ./kindlespouse-sync --config /mnt/us/kindlespouse/config.json "$@" > /dev/null 2> /dev/null
fi
result=$?
if [ "$result" -ne 0 ] && [ ! -f sync.lock ]; then
    modified=$(stat -c %Y progress.json 2>/dev/null)
    case "$modified" in
        ''|*[!0-9]*) modified=0 ;;
    esac
    if [ "$modified" -lt "$started" ]; then
        printf '{"state":"failed","stage":"starting","error":"Cannot start sync component. Reinstall the component from KindleSpouse.","updatedAt":%s}\n' "$(date +%s)" > progress.json.launch
        mv -f progress.json.launch progress.json
    fi
fi
exit "$result"
