# L'immagine di mcp-linkedin: la costruisce la CI, il deploy la mette in opera.
#
# Multi-stage per un motivo preciso: `better-sqlite3` è un modulo nativo e per
# installarlo servono python3, make e un compilatore C++. Quella toolchain non
# deve restare nell'immagine che gira in produzione — un resource server è la
# superficie più esposta della flotta (parla con LinkedIn, e il suo disco tiene
# i token di ogni QMate), e un compilatore a bordo è ciò che trasforma una
# lettura arbitraria in esecuzione arbitraria.
#
# Le tre stage condividono la STESSA immagine base, e non è un dettaglio di
# stile: il binding `.node` che si compila qui viene caricato nell'immagine
# finale, quindi glibc e architettura devono combaciare. Cambiare base solo
# nell'ultima stage dà un `Error: /app/node_modules/better-sqlite3/... invalid
# ELF header` al primo avvio, con la causa in un'altra riga di questo file.

FROM node:22-bookworm-slim AS toolchain
# Le stage che installano dipendenze partono da qui: la toolchain nativa si
# monta una volta e serve a entrambe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app


FROM toolchain AS build
# `npm ci` e non `npm install`: la lockfile è il contratto. Un install
# risolverebbe versioni nuove al build successivo, e a parità di commit
# l'immagine non sarebbe più la stessa — che è esattamente la proprietà su cui
# si regge il deploy per sha.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc


FROM toolchain AS production-dependencies
# Un secondo `npm ci`, con `--omit=dev`, invece di un `npm prune` sull'albero
# della stage di build: l'albero che finisce in produzione viene da
# un'installazione esatta dalla lockfile, non dal residuo di una potatura. Costa
# un paio di minuti di CI e togliere quel "residuo" dalle ipotesi vale di più.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:22-bookworm-slim
# `production` è anche una proprietà di sicurezza, non solo una scelta di
# performance: senza, express risponde con lo stack trace a chiunque riceva un
# 500 (vedi `hideInternalFailures` in src/service.ts).
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Serve a runtime, non è un residuo del build: senza il `"type": "module"` che
# dichiara, Node legge `dist/index.js` come CommonJS e muore sul primo `import`.
COPY package.json ./
# L'immagine `node` porta già l'utente `node` (uid 1000). La directory dei dati
# sul box deve appartenere a QUELLO uid — vedi deploy/README.md: se resta di
# root, SQLite apre in sola lettura e il servizio muore al primo collegamento.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
