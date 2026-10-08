id    := "5l69cr5dp7"
title := "ARCHIVI & COMPUTER. AUTOMAZIONE E BENI CULTURALI, anno V, fascicolo 1/1995"
pages := "https://atomotic.github.io/swiiifz"

# list recipes
default:
    @just --list

# PDF -> IIIF level 0 tree (build/<id>) -> zip/<id>.zip; sw.js rewrites base to wherever the site is served
build base=pages:
    rm -rf build zip/{{id}}.zip
    mkdir -p build
    mkiiif -source zip/{{id}}.pdf -id {{id}} -title "{{title}}" -base {{base}} -destination build -tiles
    cd build && zip -0 -r -q -X -D ../zip/{{id}}.zip {{id}} -x '*.DS_Store'
    @unzip -l zip/{{id}}.zip | tail -1

# serve on http://localhost:8080/swiiifz/
serve:
    caddy run --config Caddyfile --adapter caddyfile
