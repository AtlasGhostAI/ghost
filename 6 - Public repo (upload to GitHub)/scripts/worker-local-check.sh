#!/usr/bin/env bash
# Probes a locally running `wrangler dev` (default http://127.0.0.1:8787) with
# real HTTP requests. Start it first:  cd worker && npx wrangler dev --port 8787
# with worker/.dev.vars containing ALLOWED_ORIGINS=http://localhost:8080 and any HELIUS_API_KEY.
set -u
U=${1:-http://127.0.0.1:8787}; O=http://localhost:8080
A=86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { local want=$1 got=$2 name=$3; if [ "$want" = "$got" ]; then echo "PASS $name ($got)"; else echo "FAIL $name (want $want, got $got)"; FAILED=1; fi; }
FAILED=0
check 200 "$(code $U/health)" health
check 204 "$(code -X OPTIONS -H "Origin: $O" $U/api/analyze)" preflight-allowed
check 403 "$(code -X OPTIONS -H 'Origin: https://evil.example' $U/api/analyze)" preflight-evil
check 403 "$(code -X POST -H 'Content-Type: application/json' -d "{\"address\":\"$A\"}" $U/api/analyze)" no-origin
check 415 "$(code -X POST -H "Origin: $O" -H 'Content-Type: text/plain' -d "{\"address\":\"$A\"}" $U/api/analyze)" text-plain
check 413 "$(head -c 5000 /dev/zero | tr '\0' a | code -X POST -H "Origin: $O" -H 'Content-Type: application/json' -H 'Transfer-Encoding: chunked' --data-binary @- $U/api/analyze)" chunked-too-large
check 400 "$(code -X POST -H "Origin: $O" -H 'Content-Type: application/json' -d '{"address":"nope"}' $U/api/analyze)" bad-address
echo "-- 7 live requests (limit is 5/min per client; expect 429 by the end):"
for i in 1 2 3 4 5 6 7; do echo "  $i: $(curl -s -w ' [%{http_code}]' -X POST -H "Origin: $O" -H 'Content-Type: application/json' -d "{\"address\":\"$A\"}" $U/api/analyze | cut -c1-150)"; done
exit $FAILED
