cd /mnt/us/kindlespouse || exit 1
umask 077
catalog_result() {
    result=$?
    if [ "$result" -ne 0 ]; then
        printf '{"ok":false,"error":"Cannot read notebook title database.","completedAt":%s}\n' "$(date +%s)" > catalog-result.json.partial
        mv -f catalog-result.json.partial catalog-result.json
    fi
}
trap catalog_result EXIT
set -e
mkdir -p catalog
count=0
for database in ksdk.content.db cc.db; do
    if [ -f "/var/local/$database" ]; then
        sqlite3 -readonly "/var/local/$database" ".backup '/mnt/us/kindlespouse/catalog/$database.partial'"
        mv -f "catalog/$database.partial" "catalog/$database"
        count=$((count + 1))
    fi
done
if [ "$count" -eq 0 ]; then exit 1; fi
printf '{"ok":true,"files":%s,"completedAt":%s}\n' "$count" "$(date +%s)" > catalog-result.json.partial
mv -f catalog-result.json.partial catalog-result.json
