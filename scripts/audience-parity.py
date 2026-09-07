#!/usr/bin/env python3
"""Rigenera `tests/fixtures/audience-parity.json` e verifica la parità.

    python3 scripts/audience-parity.py [--auth-server ../qmates-auth-server]

La fixture da sola non può accorgersi che `canonical_resource` dell'auth server
è cambiato: la colonna `urlsplit` è congelata. Questo script è il cancello vero
— esegue le DUE implementazioni sullo stesso corpus e rifiuta tre condizioni:

  DIVERGENZA   le due coniano forme diverse e non-nulle;
  COLLASSO     due URI che Python distingue si riducono alla stessa forma TS,
               cioè un token coniato per una resource entrerebbe con un'altra;
  TS PIÙ LASSO  il TypeScript conia dove Python solleva.

Va rieseguito quando cambia `qmates_auth_server/audience.py`, quando cambia
`src/fleet/audience.ts`, e quando si aggiorna il Node (il corpus interroga il
parser, e i parser cambiano).
"""

from __future__ import annotations

import argparse
import collections
import itertools
import json
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tests" / "fixtures" / "audience-parity.json"

# Il seme è fisso perché il corpus deve essere lo stesso a ogni giro: una
# fixture che cambia di riga a ogni rigenerazione non è rivedibile.
SEED = 20260907
SAMPLE = 6000

SCHEMES = ["https:", "HTTPS:", "http:", "HtTp:", "ftp:", ""]
USERINFO = ["", "u@", "u:p@", "a@b@"]
HOSTS = [
    "h", "H", "mcp-linkedin.qmates.tech", "MCP-LinkedIn.QMates.Tech", "[::1]", "[::1",
    "::1]", "[v1.x]", "пример.рф", "xn--e1afmkfd.xn--p1ai", "", "h.", "localhost",
    "h\\@evil.com",
]
PORTS = ["", ":", ":0", ":00", ":443", ":0443", ":8443", ":65535", ":65536", ":99999",
         ":+443", ":1:2", ":abc"]
PATHS = ["", "/", "///", "/mcp", "/MCP", "/mcp/", "/a/../b", "/..", "/./a", "/%2e%2e/",
         "/a b", "/a%20b", "//a//", "/mcp\x00", "/a/b/../.."]
SUFFIXES = ["", "?a=1", "#f", "?a=1#f", "#a?b"]
# Spazi, tab, newline e controlli C0 in testa e in coda: sono ciò che sopravvive
# a un copia-incolla in una env var, ed è lì che nasce la classe di guasti che
# questa funzione esiste per chiudere.
WRAPPERS = ["{}", " {} ", "\t{}", "\n{}", "\x00{}", "  {}  ", "{}\t"]


def corpus() -> list[str]:
    combinations = list(itertools.product(SCHEMES, USERINFO, HOSTS, PORTS, PATHS, SUFFIXES, WRAPPERS))
    random.Random(SEED).shuffle(combinations)
    uris: list[str] = []
    seen: set[str] = set()
    for scheme, userinfo, host, port, path, suffix, wrapper in combinations[:SAMPLE]:
        authority = f"//{userinfo}{host}{port}" if (scheme or host) else ""
        uri = wrapper.format(f"{scheme}{authority}{path}{suffix}")
        if uri not in seen:
            seen.add(uri)
            uris.append(uri)
    return uris


def coined_by_python(uris: list[str], auth_server: Path) -> list[str | None]:
    sys.path.insert(0, str(auth_server / "src"))
    from qmates_auth_server.audience import canonical_resource  # noqa: PLC0415

    coined: list[str | None] = []
    for uri in uris:
        try:
            coined.append(canonical_resource(uri))
        except ValueError:
            coined.append(None)
    return coined


def coined_by_typescript(uris: list[str]) -> list[str | None]:
    with tempfile.TemporaryDirectory() as scratch:
        inputs = Path(scratch) / "uris.json"
        outputs = Path(scratch) / "coined.json"
        runner = Path(scratch) / "run.mts"
        inputs.write_text(json.dumps(uris))
        runner.write_text(
            "import { readFileSync, writeFileSync } from 'node:fs';\n"
            f"import {{ canonicalResource }} from '{REPO / 'src' / 'fleet' / 'audience.js'}';\n"
            f"const uris = JSON.parse(readFileSync({json.dumps(str(inputs))}, 'utf8'));\n"
            f"writeFileSync({json.dumps(str(outputs))}, JSON.stringify(uris.map(canonicalResource)));\n"
        )
        subprocess.run(["npx", "tsx", str(runner)], cwd=REPO, check=True)
        return json.loads(outputs.read_text())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth-server", type=Path, default=REPO.parent / "qmates-auth-server")
    args = parser.parse_args()
    if not (args.auth_server / "src" / "qmates_auth_server" / "audience.py").exists():
        print(f"non trovo canonical_resource sotto {args.auth_server}", file=sys.stderr)
        return 2

    uris = corpus()
    python = coined_by_python(uris, args.auth_server)
    typescript = coined_by_typescript(uris)
    raised = {uri for uri, coined in zip(uris, python) if coined is None}

    divergences = [
        (uri, was, now)
        for uri, was, now in zip(uris, python, typescript)
        if was is not None and now is not None and was != now
    ]
    looser = [(uri, now) for uri, now in zip(uris, typescript) if uri in raised and now is not None]

    origins: dict[str, set[str | None]] = collections.defaultdict(set)
    for uri, was, now in zip(uris, python, typescript):
        if now is not None:
            origins[now].add(was)
    collapses = {form: sources for form, sources in origins.items() if len(sources) > 1}

    print(f"corpus {len(uris)}")
    print(f"  parità              {sum(1 for w, n in zip(python, typescript) if w is not None and w == n)}")
    print(f"  rifiuti in accordo  {sum(1 for u, n in zip(uris, typescript) if u in raised and n is None)}")
    print(f"  rifiuti deliberati  {sum(1 for u, w, n in zip(uris, python, typescript) if u not in raised and n is None)}")
    print(f"  DIVERGENZE          {len(divergences)}")
    print(f"  COLLASSI            {len(collapses)}")
    print(f"  TS PIÙ LASSO        {len(looser)}")
    for uri, was, now in divergences[:20]:
        print(f"    divergenza {uri!r}: python {was!r}, typescript {now!r}")
    for form, sources in list(collapses.items())[:20]:
        print(f"    collasso {form!r} <- {sorted(map(repr, sources))}")
    for uri, now in looser[:20]:
        print(f"    più lasso {uri!r}: python solleva, typescript conia {now!r}")
    if divergences or collapses or looser:
        return 1

    written = write_fixture(uris, python, typescript, raised)
    print(f"scritti {written} rappresentanti in {FIXTURE.relative_to(REPO)}")
    return 0


def write_fixture(
    uris: list[str], python: list[str | None], typescript: list[str | None], raised: set[str]
) -> int:
    """Un rappresentante per comportamento osservato, non il corpus intero.

    Per la classe che `urlsplit` rifiuta la coppia (python, typescript) è sempre
    la stessa, quindi lì il rappresentante lo sceglie l'authority: sono le
    authority a essere illegali, e ognuna è un caso diverso.
    """
    first: dict[tuple, str] = {}
    for uri, was, now in zip(uris, python, typescript):
        key = (was, now, authority_of(uri)) if uri in raised else (was, now)
        first.setdefault(key, uri)

    cases = [
        {
            "uri": uri,
            "urlsplit": None if uri in raised else key[0],
            "raises": uri in raised,
            "expected": key[1],
        }
        for key, uri in first.items()
    ]
    cases.sort(key=lambda case: (case["expected"] is None, case["raises"], case["uri"]))
    FIXTURE.write_text(json.dumps(cases, ensure_ascii=False, indent=0))
    return len(cases)


def authority_of(uri: str) -> str:
    uniform = uri.strip().translate({9: None, 10: None, 13: None}).lstrip("\x00 \x01")
    found = re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://([^/?#]*)", uniform)
    return found.group(1) if found else ""


if __name__ == "__main__":
    sys.exit(main())
